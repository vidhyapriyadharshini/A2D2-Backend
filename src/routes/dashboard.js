const express = require('express');
const router = express.Router();
const pool = require('../db/connection');

// GET /api/dashboard/summary?date=YYYY-MM-DD
router.get('/summary', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM reservations
           WHERE status = 'Active'
             AND start_date <= $1 AND end_date >= $1)::int AS "activeReservations",
        (SELECT COUNT(*) FROM reservations
           WHERE status IN ('Scheduled', 'Approved')
             AND start_date <= $1 AND end_date >= $1)::int AS "scheduledReservations",
        (SELECT COUNT(*) FROM vehicles
           WHERE COALESCE(maintenance_flag, false) = false
             AND status <> 'Allocated')::int AS "unassignedVehicles",
        (SELECT COUNT(*) FROM vehicles
           WHERE maintenance_flag = true)::int AS "maintenanceVehicles"
      `,
      [date]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching dashboard summary:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard summary' });
  }
});

// GET /api/dashboard/driver-status
router.get('/driver-status', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH active_drivers AS (
        SELECT DISTINCT driver_id FROM reservations
        WHERE status = 'Active'
          AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
          AND driver_id IS NOT NULL
      )
      SELECT
        COUNT(*) FILTER (
          WHERE EXISTS (SELECT 1 FROM active_drivers ad WHERE ad.driver_id = d.id)
        )::int AS active,
        COUNT(*) FILTER (
          WHERE NOT EXISTS (SELECT 1 FROM active_drivers ad WHERE ad.driver_id = d.id)
            AND d.status IN ('Available', 'Active')
        )::int AS available,
        COUNT(*) FILTER (
          WHERE NOT EXISTS (SELECT 1 FROM active_drivers ad WHERE ad.driver_id = d.id)
            AND d.status = 'Resting'
        )::int AS resting,
        COUNT(*) FILTER (
          WHERE NOT EXISTS (SELECT 1 FROM active_drivers ad WHERE ad.driver_id = d.id)
            AND (d.status IN ('Unavailable', 'Engineer Unavailable') OR d.status IS NULL)
        )::int AS unavailable
      FROM drivers d
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching driver status:', err);
    res.status(500).json({ error: 'Failed to fetch driver status' });
  }
});

// GET /api/dashboard/maintenance
router.get('/maintenance', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT vehicle_type, COUNT(*)::int AS count
      FROM vehicles
      WHERE maintenance_flag = true
      GROUP BY vehicle_type
      ORDER BY vehicle_type
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching maintenance data:', err);
    res.status(500).json({ error: 'Failed to fetch maintenance data' });
  }
});

// GET /api/dashboard/fleet-snapshot?date=YYYY-MM-DD
router.get('/fleet-snapshot', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const result = await pool.query(
      `
      WITH active_reservations AS (
        SELECT DISTINCT vehicle_id FROM reservations
        WHERE status = 'Active' AND start_date <= $1 AND end_date >= $1
      ),
      scheduled_reservations AS (
        SELECT DISTINCT vehicle_id FROM reservations
        WHERE status IN ('Scheduled', 'Approved')
          AND start_date <= $1 AND end_date >= $1
      )
      SELECT
        v.vehicle_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE v.maintenance_flag = true)::int AS maintenance,
        COUNT(*) FILTER (
          WHERE COALESCE(v.maintenance_flag, false) = false
            AND v.id IN (SELECT vehicle_id FROM active_reservations)
        )::int AS allocated,
        COUNT(*) FILTER (
          WHERE COALESCE(v.maintenance_flag, false) = false
            AND v.id IN (SELECT vehicle_id FROM scheduled_reservations)
            AND v.id NOT IN (SELECT vehicle_id FROM active_reservations)
        )::int AS reserved,
        COUNT(*) FILTER (
          WHERE COALESCE(v.maintenance_flag, false) = false
            AND v.status = 'Engineer Unavailable'
            AND v.id NOT IN (SELECT vehicle_id FROM active_reservations)
            AND v.id NOT IN (SELECT vehicle_id FROM scheduled_reservations)
        )::int AS driver_unavailable,
        COUNT(*) FILTER (
          WHERE COALESCE(v.maintenance_flag, false) = false
            AND v.status <> 'Engineer Unavailable'
            AND v.id NOT IN (SELECT vehicle_id FROM active_reservations)
            AND v.id NOT IN (SELECT vehicle_id FROM scheduled_reservations)
        )::int AS available
      FROM vehicles v
      GROUP BY v.vehicle_type
      ORDER BY v.vehicle_type
      `,
      [date]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching fleet snapshot:', err);
    res.status(500).json({ error: 'Failed to fetch fleet snapshot' });
  }
});

// GET /api/dashboard/drill/:category?date=YYYY-MM-DD
router.get('/drill/:category', async (req, res) => {
  const { category } = req.params;
  const date = req.query.date || new Date().toISOString().split('T')[0];

  try {
    if (category === 'active' || category === 'scheduled' || category === 'reserved') {
      const statuses = category === 'active'
        ? ['Active']
        : ['Scheduled', 'Approved'];

      const result = await pool.query(
        `
        SELECT
          r.id,
          v.registration_number,
          v.vehicle_type,
          d.name AS driver_name,
          r.start_date, r.start_time,
          r.end_date, r.end_time,
          r.source, r.destination,
          r.status, r.jira_ticket_key
        FROM reservations r
        JOIN vehicles v ON r.vehicle_id = v.id
        JOIN drivers d ON r.driver_id = d.id
        WHERE r.status = ANY($1::text[])
          AND r.start_date <= $2 AND r.end_date >= $2
        ORDER BY r.start_date, r.start_time
        `,
        [statuses, date]
      );
      return res.json(result.rows);
    }

    if (category === 'unassigned') {
      const result = await pool.query(`
        SELECT
          v.id,
          v.registration_number,
          v.vehicle_type,
          v.vin_number,
          v.status,
          v.total_odometer AS total_mileage
        FROM vehicles v
        WHERE COALESCE(v.maintenance_flag, false) = false
          AND v.status <> 'Allocated'
        ORDER BY v.vehicle_type, v.registration_number
      `);
      return res.json(result.rows);
    }

    if (category === 'maintenance') {
      const result = await pool.query(`
        SELECT
          v.id,
          v.registration_number,
          v.vehicle_type,
          v.vin_number,
          v.status,
          v.total_odometer AS total_mileage,
          vh.engine_status,
          vh.battery_percentage,
          vh.last_service_date
        FROM vehicles v
        LEFT JOIN vehicle_health vh ON vh.vehicle_id = v.id
        WHERE v.maintenance_flag = true
        ORDER BY v.vehicle_type, v.registration_number
      `);
      return res.json(result.rows);
    }

    return res.status(400).json({ error: `Unknown category: ${category}` });
  } catch (err) {
    console.error('Error fetching drill-down data:', err);
    res.status(500).json({ error: 'Failed to fetch drill-down data' });
  }
});

module.exports = router;
