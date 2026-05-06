const express = require('express');
const pool = require('../db/connection');
const { mirrorLatestTelemetry } = require('../services/firebase');

// Three routers:
//   - ingestRouter: device ingestion (X-Device-Key)
//   - readRouter:   authenticated web reads (JWT)
//   - publicRouter: unauthenticated reads exposed for the public live-telemetry page
const ingestRouter = express.Router();
const readRouter = express.Router();
const publicRouter = express.Router();

// ---- Ingestion (device-auth) ------------------------------------------------

function parseSample(s) {
  if (!s || typeof s !== 'object') return { ok: false, error: 'sample must be an object' };

  const hasAny = ['vin', 'rpm', 'temperature', 'km'].some(k => s[k] !== undefined && s[k] !== null);
  if (!hasAny) return { ok: false, error: 'sample must include at least one of vin/rpm/temperature/km' };

  const recordedAt = s.recorded_at ? new Date(s.recorded_at) : new Date();
  if (isNaN(recordedAt.getTime())) return { ok: false, error: 'invalid recorded_at' };

  const vehicleId = s.vehicle_id != null ? Number(s.vehicle_id) : null;
  if (s.vehicle_id != null && !Number.isFinite(vehicleId)) {
    return { ok: false, error: 'vehicle_id must be numeric' };
  }

  return {
    ok: true,
    value: {
      vehicle_id: vehicleId,
      device_id: s.device_id ? String(s.device_id).slice(0, 50) : null,
      vin: s.vin != null ? Number(s.vin) : null,
      rpm: s.rpm != null ? Math.trunc(Number(s.rpm)) : null,
      temperature: s.temperature != null ? Number(s.temperature) : null,
      km: s.km != null ? Number(s.km) : null,
      recorded_at: recordedAt,
    },
  };
}

// POST /api/ingest/telemetry — single sample or array of samples
ingestRouter.post('/telemetry', async (req, res) => {
  console.log('[INGEST] received telemetry from', req.ip);
  const body = req.body;
  const raw = Array.isArray(body) ? body : [body];
  if (raw.length === 0) return res.status(400).json({ error: 'body is empty' });
  if (raw.length > 500) return res.status(413).json({ error: 'batch too large (max 500)' });

  const samples = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseSample(raw[i]);
    if (!parsed.ok) return res.status(400).json({ error: `sample[${i}]: ${parsed.error}` });
    samples.push(parsed.value);
  }

  // Bulk insert via a single parameterized statement.
  const cols = ['vehicle_id', 'device_id', 'vin', 'rpm', 'temperature', 'km', 'recorded_at'];
  const values = [];
  const placeholders = samples.map((s, i) => {
    const base = i * cols.length;
    values.push(s.vehicle_id, s.device_id, s.vin, s.rpm, s.temperature, s.km, s.recorded_at);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  }).join(', ');

  try {
    const result = await pool.query(
      `INSERT INTO vehicle_telemetry (${cols.join(', ')}) VALUES ${placeholders} RETURNING id`,
      values
    );

    // Mirror the most recent sample of this batch to Firebase RTDB so the
    // live-telemetry page receives it in real time. Fire-and-forget — the
    // mirror helper swallows its own errors.
    const latest = samples.reduce((a, b) =>
      (a.recorded_at > b.recorded_at ? a : b)
    );
    mirrorLatestTelemetry(latest);

    res.status(201).json({ inserted: result.rowCount });
  } catch (err) {
    console.error('Telemetry insert failed:', err);
    res.status(500).json({ error: 'Failed to insert telemetry', details: err.message });
  }
});

// ---- Reads (JWT-auth) -------------------------------------------------------

// GET / — existing VehicleHealth list (stub for now; preserves old contract)
readRouter.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.id, v.registration_number, v.vehicle_type, v.total_odometer AS total_mileage,
             COALESCE(vh.battery_percentage, 100) AS battery_percentage,
             COALESCE(vh.engine_status, 'Normal') AS engine_status,
             COALESCE(vh.fuel_level, 100) AS fuel_level,
             COALESCE(vh.tire_condition, 'Good') AS tire_condition,
             vh.next_service_date,
             CASE
               WHEN vh.battery_percentage < 30 OR vh.fuel_level < 20
                 OR vh.engine_status = 'Critical' OR vh.tire_condition = 'Replace' THEN 'Critical'
               WHEN vh.battery_percentage < 60 OR vh.fuel_level < 50
                 OR vh.engine_status = 'Warning' OR vh.tire_condition IN ('Fair', 'Poor') THEN 'Warning'
               ELSE 'Healthy'
             END AS overall_status
      FROM vehicles v
      LEFT JOIN vehicle_health vh ON vh.vehicle_id = v.id
      ORDER BY v.id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('vehicle-health list failed:', err);
    res.status(500).json({ error: 'Failed to load vehicle health', details: err.message });
  }
});

// GET /summary — counts by overall_status
readRouter.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN status = 'Healthy'  THEN 1 ELSE 0 END)::int AS healthy,
        SUM(CASE WHEN status = 'Warning'  THEN 1 ELSE 0 END)::int AS warning,
        SUM(CASE WHEN status = 'Critical' THEN 1 ELSE 0 END)::int AS critical
      FROM (
        SELECT CASE
          WHEN vh.battery_percentage < 30 OR vh.fuel_level < 20
            OR vh.engine_status = 'Critical' OR vh.tire_condition = 'Replace' THEN 'Critical'
          WHEN vh.battery_percentage < 60 OR vh.fuel_level < 50
            OR vh.engine_status = 'Warning' OR vh.tire_condition IN ('Fair', 'Poor') THEN 'Warning'
          ELSE 'Healthy'
        END AS status
        FROM vehicles v
        LEFT JOIN vehicle_health vh ON vh.vehicle_id = v.id
      ) s
    `);
    res.json(result.rows[0] || { total: 0, healthy: 0, warning: 0, critical: 0 });
  } catch (err) {
    console.error('vehicle-health summary failed:', err);
    res.status(500).json({ error: 'Failed to load summary', details: err.message });
  }
});

// GET /telemetry/latest — most recent sample per vehicle/device
// Mounted publicly (no JWT) so the standalone live-telemetry page can poll it.
publicRouter.get('/telemetry/latest', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (COALESCE(vehicle_id::text, device_id))
        id, vehicle_id, device_id, vin, rpm, temperature, km, recorded_at, received_at
      FROM vehicle_telemetry
      ORDER BY COALESCE(vehicle_id::text, device_id), recorded_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('telemetry latest failed:', err);
    res.status(500).json({ error: 'Failed to load latest telemetry', details: err.message });
  }
});

// GET /telemetry/:vehicleId?from=&to=&limit= — history for a vehicle
readRouter.get('/telemetry/:vehicleId', async (req, res) => {
  const vehicleId = Number(req.params.vehicleId);
  if (!Number.isFinite(vehicleId)) {
    return res.status(400).json({ error: 'vehicleId must be numeric' });
  }
  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const limit = Math.min(Number(req.query.limit) || 500, 5000);

  const clauses = ['vehicle_id = $1'];
  const params = [vehicleId];
  if (from && !isNaN(from.getTime())) { params.push(from); clauses.push(`recorded_at >= $${params.length}`); }
  if (to && !isNaN(to.getTime()))     { params.push(to);   clauses.push(`recorded_at <= $${params.length}`); }
  params.push(limit);

  try {
    const result = await pool.query(
      `SELECT id, vehicle_id, device_id, vin, rpm, temperature, km, recorded_at
       FROM vehicle_telemetry
       WHERE ${clauses.join(' AND ')}
       ORDER BY recorded_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('telemetry history failed:', err);
    res.status(500).json({ error: 'Failed to load telemetry history', details: err.message });
  }
});

module.exports = { ingestRouter, readRouter, publicRouter };
