const express = require('express');
const router = express.Router();
const pool = require('../db/connection');

// GET /api/drivers - List all drivers sorted alphabetically by name
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM drivers ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching drivers:', err);
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

module.exports = router;
