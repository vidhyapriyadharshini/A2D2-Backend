const { Pool } = require('pg');
require('dotenv').config();

async function initDatabase() {
  // Connect to default postgres database to create app database
  const adminPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: 'postgres',
  });

  try {
    const dbName = process.env.DB_NAME || 'driver_trip_mgmt';
    const res = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    if (res.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      console.log(`Database "${dbName}" created.`);
    } else {
      console.log(`Database "${dbName}" already exists.`);
    }
  } finally {
    await adminPool.end();
  }

  // Connect to the app database
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'driver_trip_mgmt',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  try {
    // Drop old tables if they exist
    await pool.query(`
      DROP TABLE IF EXISTS reservations CASCADE;
      DROP TABLE IF EXISTS vehicle_health CASCADE;
      DROP TABLE IF EXISTS accident_history CASCADE;
      DROP TABLE IF EXISTS trip_events CASCADE;
      DROP TABLE IF EXISTS otp_logs CASCADE;
      DROP TABLE IF EXISTS trips CASCADE;
      DROP TABLE IF EXISTS trip_assignments CASCADE;
      DROP TABLE IF EXISTS drivers CASCADE;
      DROP TABLE IF EXISTS vehicles CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);
    console.log('Old tables dropped (if they existed).');

    // Create users table for authentication
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('admin', 'engineer')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Users table created.');

    // Create new tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS vehicles (
        id SERIAL PRIMARY KEY,
        vehicle_type VARCHAR(50) NOT NULL,
        registration_number VARCHAR(20) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trip_assignments (
        id SERIAL PRIMARY KEY,
        assignment_date DATE NOT NULL,
        vehicle_number VARCHAR(20) NOT NULL,
        vehicle_type VARCHAR(50) NOT NULL,
        driver_name VARCHAR(100) NOT NULL,
        source VARCHAR(255) NOT NULL,
        destination VARCHAR(255) NOT NULL,
        trip_time TIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('All tables created successfully.');

    // Add new columns if they don't exist
    await pool.query(`
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Available';
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_trip_time TIMESTAMP;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(15);
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS age INTEGER;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS license_number VARCHAR(20);
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS accident_count INTEGER DEFAULT 0;
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS jira_account_id VARCHAR(100);
      ALTER TABLE drivers ADD COLUMN IF NOT EXISTS email VARCHAR(255);

      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Available';
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS maintenance_flag BOOLEAN DEFAULT false;
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS total_odometer NUMERIC(10,1) DEFAULT 0;
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vin_number VARCHAR(20);
      ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS confluence_page_id VARCHAR(50);

      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Assigned';
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS end_time TIME;
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS start_odometer VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS end_odometer VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS start_battery VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS end_battery VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS start_lat VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS start_lng VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS end_lat VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS end_lng VARCHAR(50);
      ALTER TABLE trip_assignments ADD COLUMN IF NOT EXISTS completion_comment TEXT;
    `);

    // Create accident_history table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accident_history (
        id SERIAL PRIMARY KEY,
        driver_id INTEGER REFERENCES drivers(id),
        accident_date DATE NOT NULL,
        description VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create vehicle_health table (simulated OBD data)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_health (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE UNIQUE,
        battery_percentage INTEGER DEFAULT 100,
        engine_status VARCHAR(20) DEFAULT 'Normal',
        fuel_level INTEGER DEFAULT 100,
        tire_condition VARCHAR(20) DEFAULT 'Good',
        last_service_date DATE,
        next_service_date DATE,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create reservations table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
        start_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_date DATE NOT NULL,
        end_time TIME NOT NULL,
        source VARCHAR(255) NOT NULL,
        destination VARCHAR(255) NOT NULL,
        purpose VARCHAR(255),
        status VARCHAR(20) DEFAULT 'Pending'
          CHECK (status IN ('Pending', 'Approved', 'Scheduled', 'Active', 'Completed', 'Cancelled', 'Rejected')),
        approved_by VARCHAR(100),
        approved_at TIMESTAMP,
        trip_assignment_id INTEGER REFERENCES trip_assignments(id),
        jira_ticket_key VARCHAR(20),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS device_id VARCHAR(50);
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS device_paired_at TIMESTAMP;
    `);

    // Raw ESP32 telemetry samples (Vin/RPM/Temperature/KM)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vehicle_telemetry (
        id BIGSERIAL PRIMARY KEY,
        vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
        device_id VARCHAR(50),
        vin NUMERIC(6,2),
        rpm TEXT,
        temperature NUMERIC(6,2),
        km NUMERIC(10,2),
        recorded_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_vehicle_recorded
        ON vehicle_telemetry (vehicle_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_device_recorded
        ON vehicle_telemetry (device_id, recorded_at DESC);
      ALTER TABLE vehicle_telemetry ALTER COLUMN rpm TYPE TEXT USING rpm::text;
    `);

    console.log('New columns and tables added successfully.');
  } finally {
    await pool.end();
  }
}

initDatabase().catch(console.error);
