const pool = require('../db/connection');

// Check every 30 seconds for scheduled reservations that should be activated
function startScheduler() {
  console.log('Trip scheduler started - checking every 30 seconds');

  setInterval(async () => {
    try {
      // Find scheduled reservations whose start time has arrived
      const result = await pool.query(`
        SELECT r.*, v.registration_number, v.vehicle_type, d.name AS driver_name
        FROM reservations r
        JOIN vehicles v ON r.vehicle_id = v.id
        JOIN drivers d ON r.driver_id = d.id
        WHERE r.status = 'Scheduled'
          AND (r.start_date + r.start_time) <= NOW()
      `);

      for (const reservation of result.rows) {
        try {
          // Create trip assignment
          const tripResult = await pool.query(`
            INSERT INTO trip_assignments (assignment_date, vehicle_number, vehicle_type, driver_name, source, destination, trip_time, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'In Progress')
            RETURNING id
          `, [
            reservation.start_date,
            reservation.registration_number,
            reservation.vehicle_type,
            reservation.driver_name,
            reservation.source,
            reservation.destination,
            reservation.start_time,
          ]);

          // Update reservation to Active
          await pool.query(
            "UPDATE reservations SET status = 'Active', trip_assignment_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
            [tripResult.rows[0].id, reservation.id]
          );

          // Lock vehicle and engineer
          await pool.query("UPDATE vehicles SET status = 'Allocated' WHERE id = $1", [reservation.vehicle_id]);
          await pool.query("UPDATE drivers SET status = 'Active' WHERE id = $1", [reservation.driver_id]);

          console.log(`[Scheduler] Auto-activated: Reservation #${reservation.id} - ${reservation.driver_name} / ${reservation.registration_number}`);
        } catch (err) {
          console.error(`[Scheduler] Failed to activate reservation #${reservation.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[Scheduler] Error checking scheduled reservations:', err.message);
    }
  }, 30000); // Every 30 seconds
}

module.exports = { startScheduler };
