const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const jira = require('../services/jiraService');
const email = require('../services/emailService');
const confluence = require('../services/confluenceService');

// GET /api/reservations - List reservations with filters
router.get('/', async (req, res) => {
  const { status, date, vehicle_id, driver_id } = req.query;

  try {
    let query = `
      SELECT r.*,
        d.name AS driver_name, d.mobile_number AS driver_mobile,
        v.registration_number, v.vehicle_type, v.vin_number, v.confluence_page_id,
        ta.start_odometer, ta.end_odometer,
        ta.start_battery, ta.end_battery,
        ta.start_lat, ta.start_lng, ta.end_lat, ta.end_lng,
        ta.end_time AS trip_end_time
      FROM reservations r
      JOIN drivers d ON r.driver_id = d.id
      JOIN vehicles v ON r.vehicle_id = v.id
      LEFT JOIN trip_assignments ta ON r.trip_assignment_id = ta.id
      WHERE 1=1
    `;
    const params = [];

    // Engineers only see their own reservations
    if (req.user && req.user.role === 'engineer') {
      const driverMatch = await pool.query('SELECT id FROM drivers WHERE name = $1', [req.user.name]);
      if (driverMatch.rows.length > 0) {
        params.push(driverMatch.rows[0].id);
        query += ` AND r.driver_id = $${params.length}`;
      }
    }

    if (status) {
      params.push(status);
      query += ` AND r.status = $${params.length}`;
    }
    if (date) {
      params.push(date);
      query += ` AND r.start_date <= $${params.length} AND r.end_date >= $${params.length}`;
    }
    if (vehicle_id) {
      params.push(vehicle_id);
      query += ` AND r.vehicle_id = $${params.length}`;
    }
    if (driver_id) {
      params.push(driver_id);
      query += ` AND r.driver_id = $${params.length}`;
    }

    query += ' ORDER BY r.start_date DESC, r.start_time DESC';

    const result = await pool.query(query, params);
    const rows = result.rows.map((r) => ({
      ...r,
      confluence_url: confluence.pageUrl(r.confluence_page_id),
    }));
    res.json(rows);
  } catch (err) {
    console.error('Error fetching reservations:', err);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

// GET /api/reservations/available-vehicles - Vehicles available for a time range
router.get('/available-vehicles', async (req, res) => {
  const { start_date, start_time, end_date, end_time } = req.query;

  if (!start_date || !start_time || !end_date || !end_time) {
    return res.status(400).json({ error: 'start_date, start_time, end_date, end_time are required' });
  }

  try {
    const result = await pool.query(`
      SELECT v.* FROM vehicles v
      WHERE v.maintenance_flag = false
        AND v.id NOT IN (
          SELECT r.vehicle_id FROM reservations r
          WHERE r.status IN ('Pending', 'Approved', 'Scheduled', 'Active')
            AND (r.start_date + r.start_time) < ($3::date + $4::time)
            AND (r.end_date + r.end_time) > ($1::date + $2::time)
        )
        AND v.registration_number NOT IN (
          SELECT t.vehicle_number FROM trip_assignments t
          WHERE t.status IN ('Assigned', 'In Progress')
        )
      ORDER BY v.vehicle_type, v.registration_number
    `, [start_date, start_time, end_date, end_time]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching available vehicles:', err);
    res.status(500).json({ error: 'Failed to fetch available vehicles' });
  }
});

// GET /api/reservations/available-drivers - Drivers available for a time range
router.get('/available-drivers', async (req, res) => {
  const { start_date, start_time, end_date, end_time } = req.query;

  if (!start_date || !start_time || !end_date || !end_time) {
    return res.status(400).json({ error: 'start_date, start_time, end_date, end_time are required' });
  }

  try {
    const result = await pool.query(`
      SELECT d.* FROM drivers d
      WHERE d.id NOT IN (
          SELECT r.driver_id FROM reservations r
          WHERE r.status IN ('Approved', 'Scheduled', 'Active')
            AND (r.start_date + r.start_time) < ($3::date + $4::time)
            AND (r.end_date + r.end_time) > ($1::date + $2::time)
        )
        AND d.name NOT IN (
          SELECT t.driver_name FROM trip_assignments t
          WHERE t.status IN ('Assigned', 'In Progress')
        )
      ORDER BY d.name
    `, [start_date, start_time, end_date, end_time]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching available drivers:', err);
    res.status(500).json({ error: 'Failed to fetch available drivers' });
  }
});

// GET /api/reservations/calendar - Calendar data for a date range
router.get('/calendar', async (req, res) => {
  const { start_date, end_date } = req.query;

  try {
    let query = `
      SELECT r.*,
        d.name AS driver_name,
        v.registration_number, v.vehicle_type, v.confluence_page_id
      FROM reservations r
      JOIN drivers d ON r.driver_id = d.id
      JOIN vehicles v ON r.vehicle_id = v.id
      WHERE r.status NOT IN ('Cancelled', 'Rejected')
    `;
    const params = [];

    if (start_date) {
      params.push(start_date);
      query += ` AND r.end_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      query += ` AND r.start_date <= $${params.length}`;
    }

    query += ' ORDER BY r.start_date, r.start_time';
    const result = await pool.query(query, params);
    const rows = result.rows.map((r) => ({
      ...r,
      confluence_url: confluence.pageUrl(r.confluence_page_id),
    }));
    res.json(rows);
  } catch (err) {
    console.error('Error fetching calendar data:', err);
    res.status(500).json({ error: 'Failed to fetch calendar data' });
  }
});

// GET /api/reservations/:id - Single reservation detail
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*,
        d.name AS driver_name, d.mobile_number AS driver_mobile,
        v.registration_number, v.vehicle_type, v.vin_number, v.confluence_page_id
      FROM reservations r
      JOIN drivers d ON r.driver_id = d.id
      JOIN vehicles v ON r.vehicle_id = v.id
      WHERE r.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const row = result.rows[0];
    row.confluence_url = confluence.pageUrl(row.confluence_page_id);
    res.json(row);
  } catch (err) {
    console.error('Error fetching reservation:', err);
    res.status(500).json({ error: 'Failed to fetch reservation' });
  }
});

// POST /api/reservations - Create a new reservation + JIRA ticket
router.post('/', async (req, res) => {
  const { vehicle_id, driver_id, start_date, start_time, end_date, end_time, source, destination, purpose, notes, assignee_email } = req.body;

  if (!vehicle_id || !driver_id || !start_date || !start_time || !end_date || !end_time || !source || !destination) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Vehicle conflict detection - check reservations
    const vehicleConflicts = await pool.query(`
      SELECT r.id, v.registration_number, d.name AS driver_name, r.start_date, r.end_date
      FROM reservations r
      JOIN vehicles v ON r.vehicle_id = v.id
      JOIN drivers d ON r.driver_id = d.id
      WHERE r.vehicle_id = $1
        AND r.status IN ('Pending', 'Approved', 'Scheduled', 'Active')
        AND (r.start_date + r.start_time) < ($4::date + $5::time)
        AND (r.end_date + r.end_time) > ($2::date + $3::time)
    `, [vehicle_id, start_date, start_time, end_date, end_time]);

    if (vehicleConflicts.rows.length > 0) {
      return res.status(409).json({
        error: 'Vehicle is already reserved for this time period',
        conflicts: vehicleConflicts.rows,
      });
    }

    // Vehicle conflict detection - check active trip assignments
    const vehicleLookup = await pool.query('SELECT registration_number FROM vehicles WHERE id = $1', [vehicle_id]);
    if (vehicleLookup.rows.length > 0) {
      const vehicleTripConflict = await pool.query(`
        SELECT id, vehicle_number, driver_name, source, destination, status
        FROM trip_assignments
        WHERE vehicle_number = $1 AND status IN ('Assigned', 'In Progress')
      `, [vehicleLookup.rows[0].registration_number]);

      if (vehicleTripConflict.rows.length > 0) {
        return res.status(409).json({
          error: 'Vehicle is currently on an active trip and cannot be reserved',
          conflicts: vehicleTripConflict.rows.map(r => ({
            registration_number: r.vehicle_number,
            driver_name: r.driver_name,
            message: `${r.vehicle_number} is on an active trip (${r.source} → ${r.destination}, Status: ${r.status})`
          })),
        });
      }
    }

    // Driver/Engineer conflict detection - check reservations
    const driverConflicts = await pool.query(`
      SELECT r.id, v.registration_number, d.name AS driver_name, r.start_date, r.end_date
      FROM reservations r
      JOIN vehicles v ON r.vehicle_id = v.id
      JOIN drivers d ON r.driver_id = d.id
      WHERE r.driver_id = $1
        AND r.status IN ('Approved', 'Scheduled', 'Active')
        AND (r.start_date + r.start_time) < ($4::date + $5::time)
        AND (r.end_date + r.end_time) > ($2::date + $3::time)
    `, [driver_id, start_date, start_time, end_date, end_time]);

    if (driverConflicts.rows.length > 0) {
      return res.status(409).json({
        error: 'Driver/Engineer is already assigned to another task for this time period',
        conflicts: driverConflicts.rows,
      });
    }

    // Driver conflict detection - check active trip assignments
    const driverLookup = await pool.query('SELECT name FROM drivers WHERE id = $1', [driver_id]);
    if (driverLookup.rows.length > 0) {
      const driverTripConflict = await pool.query(`
        SELECT id, vehicle_number, driver_name, source, destination, status
        FROM trip_assignments
        WHERE driver_name = $1 AND status IN ('Assigned', 'In Progress')
      `, [driverLookup.rows[0].name]);

      if (driverTripConflict.rows.length > 0) {
        return res.status(409).json({
          error: 'Driver/Engineer is currently on an active trip and cannot be assigned',
          conflicts: driverTripConflict.rows.map(r => ({
            driver_name: r.driver_name,
            registration_number: r.vehicle_number,
            message: `${r.driver_name} is on an active trip with ${r.vehicle_number} (${r.source} → ${r.destination}, Status: ${r.status})`
          })),
        });
      }
    }

    // Get driver and vehicle info for JIRA
    const driverRes = await pool.query('SELECT * FROM drivers WHERE id = $1', [driver_id]);
    const vehicleRes = await pool.query('SELECT * FROM vehicles WHERE id = $1', [vehicle_id]);

    if (driverRes.rows.length === 0 || vehicleRes.rows.length === 0) {
      return res.status(400).json({ error: 'Driver or vehicle not found' });
    }

    const driver = driverRes.rows[0];
    const vehicle = vehicleRes.rows[0];

    // Find JIRA assignee — prefer jira_account_id from driver record, fallback to email lookup
    let assigneeAccountId = driver.jira_account_id || null;
    if (!assigneeAccountId && assignee_email) {
      try {
        const jiraUser = await jira.findUserByEmail(assignee_email);
        if (jiraUser) assigneeAccountId = jiraUser.accountId;
      } catch (err) {
        console.error('JIRA user lookup failed:', err);
      }
    }

    // Create JIRA ticket
    let jiraKey = null;
    let jiraError = null;
    try {
      const jiraTicket = await jira.createTaskTicket({
        driverName: driver.name,
        vehicleRegNo: vehicle.registration_number,
        vehicleType: vehicle.vehicle_type,
        startDate: start_date,
        startTime: start_time,
        endDate: end_date,
        endTime: end_time,
        source,
        destination,
        purpose,
        assigneeAccountId,
      });
      jiraKey = jiraTicket.key;
    } catch (err) {
      console.error('JIRA ticket creation failed:', err);
      jiraError = 'JIRA ticket creation failed - reservation created without JIRA link';
    }

    // Determine if trip starts now or in the future
    const now = new Date();
    const startDateTime = new Date(`${start_date}T${start_time}`);
    const isFuture = startDateTime > now;
    const initialStatus = isFuture ? 'Scheduled' : 'Active';

    // Insert reservation
    const result = await pool.query(`
      INSERT INTO reservations (vehicle_id, driver_id, start_date, start_time, end_date, end_time, source, destination, purpose, notes, jira_ticket_key, status, approved_by, approved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Fleet Manager', CURRENT_TIMESTAMP)
      RETURNING *
    `, [vehicle_id, driver_id, start_date, start_time, end_date, end_time, source, destination, purpose, notes, jiraKey, initialStatus]);

    const reservation = result.rows[0];
    reservation.driver_name = driver.name;
    reservation.registration_number = vehicle.registration_number;
    reservation.vehicle_type = vehicle.vehicle_type;

    if (!isFuture) {
      // Start now — create trip assignment and lock vehicle/engineer
      const tripResult = await pool.query(`
        INSERT INTO trip_assignments (assignment_date, vehicle_number, vehicle_type, driver_name, source, destination, trip_time, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'In Progress')
        RETURNING id
      `, [start_date, vehicle.registration_number, vehicle.vehicle_type, driver.name, source, destination, start_time]);

      await pool.query('UPDATE reservations SET trip_assignment_id = $1 WHERE id = $2', [tripResult.rows[0].id, reservation.id]);
      await pool.query("UPDATE vehicles SET status = 'Allocated' WHERE id = $1", [vehicle_id]);
      await pool.query("UPDATE drivers SET status = 'Active' WHERE id = $1", [driver_id]);
    }
    // If future (Scheduled), vehicle/engineer stay available until the scheduled time

    // Send email notification to assignee
    let emailError = null;
    if (assignee_email) {
      try {
        await email.sendTaskAssignmentEmail({
          to: assignee_email,
          driverName: driver.name,
          vehicleRegNo: vehicle.registration_number,
          vehicleType: vehicle.vehicle_type,
          startDate: start_date,
          startTime: start_time,
          endDate: end_date,
          endTime: end_time,
          source,
          destination,
          purpose,
          jiraKey,
        });
      } catch (err) {
        console.error('Email notification failed:', err);
        emailError = 'Email notification failed - reservation created without email';
      }
    }

    const jiraSiteUrl = process.env.JIRA_SITE_URL;
    const jira_url = jiraKey && jiraSiteUrl ? `${jiraSiteUrl}/browse/${jiraKey}` : null;

    res.status(201).json({
      ...reservation,
      jira_url,
      jira_warning: jiraError || undefined,
      email_warning: emailError || undefined,
      scheduled_info: isFuture ? `Scheduled to start at ${start_time} on ${start_date}` : null,
    });
  } catch (err) {
    console.error('Error creating reservation:', err);
    res.status(500).json({ error: 'Failed to create reservation', details: err.message });
  }
});

// PATCH /api/reservations/:id/status - Update reservation status
router.patch('/:id/status', async (req, res) => {
  const {
    status, approved_by, notes,
    start_odometer, end_odometer,
    start_battery, end_battery,
    start_lat, start_lng, end_lat, end_lng,
    completion_comment,
  } = req.body;
  const { id } = req.params;

  if (status === 'Completed') {
    const trimmed = (completion_comment ?? '').trim();
    if (trimmed.length < 5) {
      return res.status(400).json({ error: 'Completion comment is required (min 5 characters).' });
    }
    if (trimmed.length > 1000) {
      return res.status(400).json({ error: 'Completion comment must be 1000 characters or fewer.' });
    }
  }

  const validTransitions = {
    'Scheduled': ['Active', 'Cancelled'],
    'Approved': ['Active', 'Cancelled'],
    'Active': ['Completed'],
  };

  try {
    const current = await pool.query(`
      SELECT r.*, v.registration_number, v.vehicle_type, d.name AS driver_name
      FROM reservations r
      JOIN vehicles v ON r.vehicle_id = v.id
      JOIN drivers d ON r.driver_id = d.id
      WHERE r.id = $1
    `, [id]);

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const reservation = current.rows[0];
    const allowed = validTransitions[reservation.status];

    if (!allowed || !allowed.includes(status)) {
      return res.status(400).json({
        error: `Cannot transition from "${reservation.status}" to "${status}"`,
        allowed_transitions: allowed || [],
      });
    }

    let updateFields = 'status = $2, updated_at = CURRENT_TIMESTAMP';
    const params = [id, status];

    await pool.query(`UPDATE reservations SET ${updateFields} WHERE id = $1`, params);

    // When activating: create a trip assignment
    if (status === 'Active') {
      const tripResult = await pool.query(`
        INSERT INTO trip_assignments (
          assignment_date, vehicle_number, vehicle_type, driver_name,
          source, destination, trip_time, status,
          start_odometer, start_battery, start_lat, start_lng
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'In Progress', $8, $9, $10, $11)
        RETURNING id
      `, [
        reservation.start_date,
        reservation.registration_number,
        reservation.vehicle_type,
        reservation.driver_name,
        reservation.source,
        reservation.destination,
        reservation.start_time,
        start_odometer ?? null,
        start_battery ?? null,
        start_lat ?? null,
        start_lng ?? null,
      ]);

      await pool.query('UPDATE reservations SET trip_assignment_id = $1 WHERE id = $2', [tripResult.rows[0].id, id]);
      await pool.query("UPDATE vehicles SET status = 'Allocated' WHERE id = $1", [reservation.vehicle_id]);
      await pool.query("UPDATE drivers SET status = 'Active' WHERE id = $1", [reservation.driver_id]);
    }

    // When completing: update trip + JIRA
    if (status === 'Completed') {
      if (reservation.trip_assignment_id) {
        await pool.query(
          `UPDATE trip_assignments
             SET status = 'Completed',
                 end_odometer = $2,
                 end_battery = $3,
                 end_lat = $4,
                 end_lng = $5,
                 end_time = CURRENT_TIME,
                 completion_comment = $6
           WHERE id = $1`,
          [
            reservation.trip_assignment_id,
            end_odometer ?? null,
            end_battery ?? null,
            end_lat ?? null,
            end_lng ?? null,
            completion_comment.trim(),
          ]
        );
      }
      await pool.query("UPDATE vehicles SET status = 'Available' WHERE id = $1", [reservation.vehicle_id]);
      confluence.syncFleetPageInBackground();
      await pool.query("UPDATE drivers SET status = 'Available' WHERE id = $1", [reservation.driver_id]);

      // Update JIRA ticket with trip data
      if (reservation.jira_ticket_key) {
        try {
          await jira.updateTicketWithTripData(reservation.jira_ticket_key, {
            startOdometer: start_odometer,
            endOdometer: end_odometer,
            actualStartTime: reservation.start_time,
            actualEndTime: new Date().toLocaleTimeString(),
            notes,
            status: 'Completed',
          });
          await jira.transitionIssue(reservation.jira_ticket_key, 'Done');
        } catch (err) {
          console.error('JIRA update failed:', err);
        }
      }
    }

    const updated = await pool.query(`
      SELECT r.*, d.name AS driver_name, v.registration_number, v.vehicle_type
      FROM reservations r
      JOIN drivers d ON r.driver_id = d.id
      JOIN vehicles v ON r.vehicle_id = v.id
      WHERE r.id = $1
    `, [id]);

    res.json(updated.rows[0]);
  } catch (err) {
    console.error('Error updating reservation status:', err);
    res.status(500).json({ error: 'Failed to update reservation status' });
  }
});

// POST /api/reservations/:id/pair-device — record telematics device pairing
router.post('/:id/pair-device', async (req, res) => {
  const { id } = req.params;
  const { device_id } = req.body;

  if (!device_id || !String(device_id).trim()) {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE reservations
         SET device_id = $1, device_paired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, device_id, device_paired_at, status`,
      [String(device_id).trim(), id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error pairing device:', err);
    res.status(500).json({ error: 'Failed to pair device' });
  }
});

module.exports = router;
