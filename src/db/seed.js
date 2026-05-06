const pool = require('./connection');
const bcrypt = require('bcryptjs');

async function seed() {
  try {
    // ========== SEED ADMIN USERS ONLY ==========
    // Engineers/drivers are now synced from Jira on server startup
    const existingUsers = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(existingUsers.rows[0].count) === 0) {
      const salt = await bcrypt.genSalt(10);
      const admins = [
        { name: 'Admin User',    email: 'admin@fleetplanner.com',   password: 'admin123',  role: 'admin' },
        { name: 'Fleet Manager', email: 'manager@fleetplanner.com', password: 'admin123',  role: 'admin' },
      ];

      for (const u of admins) {
        const hash = await bcrypt.hash(u.password, salt);
        await pool.query(
          'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
          [u.name, u.email.toLowerCase(), hash, u.role]
        );
      }
      console.log('2 admin users seeded. Engineers will be synced from Jira.');
    }

    // ========== SEED 55 VEHICLES ==========
    const existingVehicles = await pool.query('SELECT COUNT(*) FROM vehicles');
    if (parseInt(existingVehicles.rows[0].count) === 0) {
      const vehicles = [];
      for (let i = 1; i <= 25; i++) vehicles.push(['2 Ton Truck', `CA${String(1000 + i).padStart(5, '0')}A`]);
      for (let i = 1; i <= 15; i++) vehicles.push(['4 Ton Truck', `CA${String(2000 + i).padStart(5, '0')}B`]);
      for (let i = 1; i <= 10; i++) vehicles.push(['8 Ton Truck', `CA${String(3000 + i).padStart(5, '0')}C`]);
      for (let i = 1; i <= 5; i++) vehicles.push(['12 Ton Truck', `CA${String(4000 + i).padStart(5, '0')}D`]);

      for (const [type, reg] of vehicles) {
        await pool.query('INSERT INTO vehicles (vehicle_type, registration_number) VALUES ($1, $2)', [type, reg]);
      }
      console.log(`${vehicles.length} vehicles seeded.`);
    } else {
      console.log('Vehicles already exist. Skipping.');
    }

    // ========== VEHICLE STATUSES ==========
    // Under Maintenance: 3x 2Ton, 2x 4Ton, 1x 8Ton = 6 total
    const maintenanceVehicles = ['CA01021A', 'CA01022A', 'CA01023A', 'CA02013B', 'CA02014B', 'CA03009C'];
    for (const reg of maintenanceVehicles) {
      await pool.query(`UPDATE vehicles SET status = 'Under Maintenance', maintenance_flag = true WHERE registration_number = $1`, [reg]);
    }
    console.log('Vehicle statuses updated.');

    // ========== VEHICLE TOTAL ODOMETER ==========
    const allVehicles = await pool.query('SELECT id, registration_number, maintenance_flag FROM vehicles');
    for (const v of allVehicles.rows) {
      const totalMi = Math.floor(Math.random() * 25000) + 5000;
      await pool.query('UPDATE vehicles SET total_odometer = $1 WHERE id = $2', [totalMi, v.id]);
    }
    console.log('Vehicle odometer readings updated.');

    // ========== VEHICLE HEALTH (Simulated OBD Data) ==========
    await pool.query('DELETE FROM vehicle_health');
    for (const v of allVehicles.rows) {
      let battery, engine, fuel, tire, lastService, nextService;

      if (v.maintenance_flag) {
        // Maintenance vehicles get degraded health
        battery = Math.floor(Math.random() * 30) + 20; // 20-50%
        engine = ['Warning', 'Critical'][Math.floor(Math.random() * 2)];
        fuel = Math.floor(Math.random() * 20) + 5; // 5-25%
        tire = ['Poor', 'Replace'][Math.floor(Math.random() * 2)];
        lastService = '2025-08-15';
        nextService = '2025-12-15'; // overdue
      } else {
        // Healthy vehicles
        battery = Math.floor(Math.random() * 25) + 75; // 75-100%
        engine = Math.random() > 0.9 ? 'Warning' : 'Normal';
        fuel = Math.floor(Math.random() * 40) + 60; // 60-100%
        tire = Math.random() > 0.85 ? 'Fair' : 'Good';
        lastService = '2026-01-' + String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
        nextService = '2026-07-' + String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
      }

      await pool.query(
        `INSERT INTO vehicle_health (vehicle_id, battery_percentage, engine_status, fuel_level, tire_condition, last_service_date, next_service_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [v.id, battery, engine, fuel, tire, lastService, nextService]
      );
    }
    console.log('Vehicle health data seeded (55 vehicles).');

  } catch (err) {
    console.error('Seed error:', err);
  } finally {
    await pool.end();
  }
}

seed();
