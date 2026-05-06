const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const confluence = require('../services/confluenceService');

// GET /api/vehicles - List all vehicles sorted by vehicle_type, registration_number
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM vehicles ORDER BY vehicle_type ASC, registration_number ASC'
    );
    const rows = result.rows.map((v) => ({
      ...v,
      confluence_url: confluence.pageUrl(v.confluence_page_id),
    }));
    res.json(rows);
  } catch (err) {
    console.error('Error fetching vehicles:', err);
    res.status(500).json({ error: 'Failed to fetch vehicles' });
  }
});

module.exports = router;
