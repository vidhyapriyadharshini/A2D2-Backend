const express = require('express');
const router = express.Router();
const pool = require('../db/connection');

// GET /api/utilization/summary
router.get('/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [totalVehicles, activeToday, totalKmMonth, avgTripsPerVehicle] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM vehicles'),
      pool.query('SELECT COUNT(DISTINCT vehicle_number) as count FROM trip_assignments WHERE assignment_date = $1', [today]),
      pool.query(`SELECT COALESCE(SUM(
          (CASE WHEN end_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN end_odometer::NUMERIC END)
          - (CASE WHEN start_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN start_odometer::NUMERIC END)
        ), 0) as total_km FROM trip_assignments
        WHERE end_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' AND start_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$'
        AND assignment_date >= date_trunc('month', CURRENT_DATE)`),
      pool.query(`SELECT ROUND(AVG(trip_count), 1) as avg_trips FROM (
        SELECT vehicle_number, COUNT(*) as trip_count FROM trip_assignments
        WHERE assignment_date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY vehicle_number
      ) sub`),
    ]);

    const total = parseInt(totalVehicles.rows[0].count);
    const active = parseInt(activeToday.rows[0].count);

    res.json({
      totalVehicles: total,
      activeToday: active,
      utilizationRate: total > 0 ? Math.round((active / total) * 100) : 0,
      totalKmThisMonth: Math.round(parseFloat(totalKmMonth.rows[0].total_km)),
      avgTripsPerVehicle: parseFloat(avgTripsPerVehicle.rows[0].avg_trips) || 0,
    });
  } catch (err) {
    console.error('Error fetching utilization summary:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/utilization/vehicles
router.get('/vehicles', async (req, res) => {
  try {
    const { type, days } = req.query;
    const range = parseInt(days) || 30;

    let query = `
      SELECT
        v.registration_number, v.vehicle_type, v.total_odometer AS total_mileage,
        COUNT(t.id) as trip_count,
        COALESCE(SUM(
          (CASE WHEN t.end_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN t.end_odometer::NUMERIC END)
          - (CASE WHEN t.start_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN t.start_odometer::NUMERIC END)
        ) FILTER (WHERE t.end_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' AND t.start_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$'), 0) as total_km,
        COUNT(DISTINCT t.assignment_date) as days_active
      FROM vehicles v
      LEFT JOIN trip_assignments t ON t.vehicle_number = v.registration_number
        AND t.assignment_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      WHERE 1=1
    `;
    const params = [range];

    if (type) {
      params.push(type);
      query += ` AND v.vehicle_type = $${params.length}`;
    }

    query += ` GROUP BY v.id, v.registration_number, v.vehicle_type, v.total_odometer ORDER BY trip_count DESC`;

    const result = await pool.query(query, params);
    res.json(result.rows.map(row => ({
      registration_number: row.registration_number,
      vehicle_type: row.vehicle_type,
      total_mileage: Math.round(parseFloat(row.total_mileage)),
      trip_count: parseInt(row.trip_count),
      total_km: Math.round(parseFloat(row.total_km)),
      days_active: parseInt(row.days_active),
      days_idle: range - parseInt(row.days_active),
      utilization_rate: Math.round((parseInt(row.days_active) / range) * 100),
    })));
  } catch (err) {
    console.error('Error fetching vehicle utilization:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/utilization/recent-trips
router.get('/recent-trips', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await pool.query(
      `SELECT t.id, t.assignment_date, t.vehicle_number, t.vehicle_type,
              t.driver_name, t.source, t.destination, t.trip_time, t.end_time,
              t.start_odometer, t.end_odometer, t.start_battery, t.end_battery,
              t.status, t.completion_comment,
              v.confluence_page_id,
              CASE
                WHEN t.start_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$'
                 AND t.end_odometer   ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN ROUND((t.end_odometer::NUMERIC - t.start_odometer::NUMERIC)::NUMERIC, 1)
              END AS km_covered
         FROM trip_assignments t
         LEFT JOIN vehicles v ON v.registration_number = t.vehicle_number
        WHERE t.status IN ('Completed', 'In Progress')
        ORDER BY
          CASE WHEN t.status = 'In Progress' THEN 0 ELSE 1 END,
          t.assignment_date DESC,
          t.id DESC
        LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching recent trips:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/utilization/chart-data
router.get('/chart-data', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await pool.query(`
      SELECT
        assignment_date as date,
        COUNT(DISTINCT vehicle_number) as active_vehicles,
        COUNT(*) as trips_count,
        COALESCE(SUM(
          (CASE WHEN end_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN end_odometer::NUMERIC END)
          - (CASE WHEN start_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN start_odometer::NUMERIC END)
        ) FILTER (WHERE end_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$' AND start_odometer ~ '^-?[0-9]+(\\.[0-9]+)?$'), 0) as total_km
      FROM trip_assignments
      WHERE assignment_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      GROUP BY assignment_date
      ORDER BY assignment_date
    `, [days]);

    res.json(result.rows.map(row => ({
      date: row.date,
      active_vehicles: parseInt(row.active_vehicles),
      trips_count: parseInt(row.trips_count),
      total_km: Math.round(parseFloat(row.total_km)),
    })));
  } catch (err) {
    console.error('Error fetching chart data:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
