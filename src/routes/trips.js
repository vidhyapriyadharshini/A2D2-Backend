const express = require('express');
const router = express.Router();
const pool = require('../db/connection');

// POST /api/trips - Create trip assignments
router.post('/', async (req, res) => {
  const { assignments } = req.body;

  if (!assignments || !Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: 'assignments array is required' });
  }

  try {
    const created = [];
    const conflicts = [];

    for (const a of assignments) {
      const { date, vehicleNumber, vehicleType, driverName, source, destination, time } = a;

      if (!date || !vehicleNumber || !vehicleType || !driverName || !source || !destination || !time) {
        return res.status(400).json({ error: 'Missing required fields in assignment' });
      }

      // Check if vehicle is already on any active trip (regardless of date)
      const vehicleConflict = await pool.query(
        `SELECT id, vehicle_number, driver_name, source, destination, status, assignment_date
         FROM trip_assignments
         WHERE vehicle_number = $1 AND status IN ('Assigned', 'In Progress')`,
        [vehicleNumber]
      );

      if (vehicleConflict.rows.length > 0) {
        conflicts.push({
          type: 'vehicle',
          value: vehicleNumber,
          message: `Vehicle ${vehicleNumber} is already on an active trip (${vehicleConflict.rows[0].source} → ${vehicleConflict.rows[0].destination}, Status: ${vehicleConflict.rows[0].status})`
        });
      }

      // Check if driver is already on any active trip (regardless of date)
      const driverConflict = await pool.query(
        `SELECT id, vehicle_number, driver_name, source, destination, status, assignment_date
         FROM trip_assignments
         WHERE driver_name = $1 AND status IN ('Assigned', 'In Progress')`,
        [driverName]
      );

      if (driverConflict.rows.length > 0) {
        conflicts.push({
          type: 'driver',
          value: driverName,
          message: `Driver ${driverName} is already on an active trip (${driverConflict.rows[0].vehicle_number}: ${driverConflict.rows[0].source} → ${driverConflict.rows[0].destination}, Status: ${driverConflict.rows[0].status})`
        });
      }
    }

    // If any conflicts found, return 409
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: 'Cannot assign: some vehicles or drivers are already on active trips',
        conflicts
      });
    }

    for (const a of assignments) {
      const { date, vehicleNumber, vehicleType, driverName, source, destination, time } = a;

      const result = await pool.query(
        `INSERT INTO trip_assignments (assignment_date, vehicle_number, vehicle_type, driver_name, source, destination, trip_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [date, vehicleNumber, vehicleType, driverName, source, destination, time]
      );

      created.push(result.rows[0]);
    }

    res.status(201).json(created);
  } catch (err) {
    console.error('Error creating trip assignments:', err);
    res.status(500).json({ error: 'Failed to create trip assignments' });
  }
});

// GET /api/trips - List trip assignments for a given date
router.get('/', async (req, res) => {
  const { date } = req.query;

  try {
    let query = 'SELECT * FROM trip_assignments';
    const params = [];

    if (date) {
      query += ' WHERE assignment_date = $1';
      params.push(date);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching trip assignments:', err);
    res.status(500).json({ error: 'Failed to fetch trip assignments' });
  }
});

// GET /api/trips/busy - Get vehicles and drivers on active trips or scheduled/active reservations
router.get('/busy', async (req, res) => {
  try {
    // From trip assignments
    const tripsResult = await pool.query(
      `SELECT vehicle_number, driver_name, source, destination, status, assignment_date
       FROM trip_assignments
       WHERE status IN ('Assigned', 'In Progress')`
    );

    // From reservations — match the server-side conflict check in POST /reservations
    const resResult = await pool.query(
      `SELECT v.registration_number AS vehicle_number, d.name AS driver_name, r.source, r.destination, r.status, r.start_date AS assignment_date
       FROM reservations r
       JOIN vehicles v ON r.vehicle_id = v.id
       JOIN drivers d ON r.driver_id = d.id
       WHERE r.status IN ('Pending', 'Approved', 'Scheduled', 'Active')`
    );

    const allRows = [...tripsResult.rows, ...resResult.rows];
    const busyVehicles = allRows.map(r => r.vehicle_number);
    const busyDrivers = allRows.map(r => r.driver_name);

    res.json({
      busyVehicles: [...new Set(busyVehicles)],
      busyDrivers: [...new Set(busyDrivers)],
      details: allRows
    });
  } catch (err) {
    console.error('Error fetching busy resources:', err);
    res.status(500).json({ error: 'Failed to fetch busy resources' });
  }
});

module.exports = router;
