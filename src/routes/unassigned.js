const express = require('express');
const router = express.Router();
const pool = require('../db/connection');

// GET /api/unassigned
router.get('/', async (req, res) => {
  try {
    const { type, status } = req.query;

    let query = `
      SELECT
        v.registration_number as vehicle_number,
        v.vehicle_type,
        v.status,
        CASE
          WHEN v.maintenance_flag = true THEN 'Maintenance Scheduled'
          WHEN v.status = 'Engineer Unavailable' THEN 'Engineer on Leave'
          ELSE 'No Trip Assigned'
        END as reason,
        (SELECT MAX(ta.assignment_date) FROM trip_assignments ta WHERE ta.vehicle_number = v.registration_number) as last_assigned_date
      FROM vehicles v
      WHERE v.status != 'Allocated'
    `;

    const params = [];
    let paramIndex = 1;

    if (type) {
      query += ` AND v.vehicle_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (status) {
      query += ` AND v.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ' ORDER BY v.vehicle_type, v.registration_number';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching unassigned vehicles:', err);
    res.status(500).json({ error: 'Failed to fetch unassigned vehicles' });
  }
});

module.exports = router;
