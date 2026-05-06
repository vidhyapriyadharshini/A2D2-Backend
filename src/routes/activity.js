const express = require('express');
const router = express.Router();
const pool = require('../db/connection');

// GET /api/activity/drivers - list all drivers with trip count
router.get('/drivers', async (req, res) => {
  try {
    const { search, minAge, maxAge, minTrips, hasAccidents } = req.query;

    let query = `
      SELECT d.id, d.name, d.mobile_number, d.age, d.license_number, d.status, d.accident_count,
        (SELECT COUNT(*) FROM trip_assignments t WHERE LOWER(TRIM(t.driver_name)) = LOWER(TRIM(d.name))) AS total_trips
      FROM drivers d
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (d.name ILIKE $${params.length} OR d.mobile_number ILIKE $${params.length})`;
    }
    if (minAge) {
      params.push(parseInt(minAge));
      query += ` AND d.age >= $${params.length}`;
    }
    if (maxAge) {
      params.push(parseInt(maxAge));
      query += ` AND d.age <= $${params.length}`;
    }
    if (minTrips) {
      params.push(parseInt(minTrips));
      query += ` AND (SELECT COUNT(*) FROM trip_assignments t WHERE LOWER(TRIM(t.driver_name)) = LOWER(TRIM(d.name))) >= $${params.length}`;
    }
    if (hasAccidents === 'yes') {
      query += ` AND d.accident_count > 0`;
    } else if (hasAccidents === 'no') {
      query += ` AND d.accident_count = 0`;
    }

    query += ` ORDER BY d.name`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching driver activity:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/activity/drivers/:id/trips - trip history for a driver
router.get('/drivers/:id/trips', async (req, res) => {
  try {
    const driver = await pool.query('SELECT name FROM drivers WHERE id = $1', [req.params.id]);
    if (driver.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    const result = await pool.query(
      `SELECT assignment_date, vehicle_number, vehicle_type, source, destination,
              trip_time, end_time, start_odometer, end_odometer, status
       FROM trip_assignments
       WHERE LOWER(TRIM(driver_name)) = LOWER(TRIM($1))
       ORDER BY assignment_date DESC, trip_time DESC`,
      [driver.rows[0].name]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching driver trips:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/activity/drivers/:id/accidents - accident history for a driver
router.get('/drivers/:id/accidents', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT accident_date, description FROM accident_history WHERE driver_id = $1 ORDER BY accident_date DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching accident history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
