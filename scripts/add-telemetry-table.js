// One-off: adds the vehicle_telemetry table to an existing database
// without dropping anything else. Safe to re-run.
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'driver_trip_mgmt',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_telemetry (
        id BIGSERIAL PRIMARY KEY,
        vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
        device_id VARCHAR(50),
        vin NUMERIC(6,2),
        rpm INTEGER,
        temperature NUMERIC(6,2),
        km NUMERIC(10,2),
        recorded_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle_recorded
        ON vehicle_telemetry (vehicle_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_device_recorded
        ON vehicle_telemetry (device_id, recorded_at DESC);
    `);
    console.log('vehicle_telemetry table is ready.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
