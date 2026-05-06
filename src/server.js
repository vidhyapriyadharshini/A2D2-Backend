const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { authenticate, authorize, authenticateDevice } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const driversRouter = require('./routes/drivers');
const vehiclesRouter = require('./routes/vehicles');
const tripsRouter = require('./routes/trips');
const dashboardRouter = require('./routes/dashboard');
const unassignedRouter = require('./routes/unassigned');
const activityRouter = require('./routes/activity');
const utilizationRouter = require('./routes/utilization');
const {
  ingestRouter: vehicleHealthIngestRouter,
  readRouter: vehicleHealthReadRouter,
  publicRouter: vehicleHealthPublicRouter,
} = require('./routes/vehicle-health');
const reservationsRouter = require('./routes/reservations');
const syncRouter = require('./routes/sync');
const { startScheduler } = require('./services/scheduler');
const { syncEngineersFromJira } = require('./services/jiraSync');

const app = express();

// Middleware
// Allow any origin during dev/LAN demos so the React app can be opened from
// localhost, the laptop's LAN IP, or a teammate's machine on the same Wi-Fi.
app.use(cors({ origin: true }));
app.use(express.json());

// Public routes
app.use('/api/auth', authRouter);

// Health check (public)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Device ingestion (authenticated via X-Device-Key header, not JWT)
app.use('/api/ingest', authenticateDevice, vehicleHealthIngestRouter);

// Public live-telemetry endpoints — no auth, consumed by the public /live-telemetry page.
// Mounted BEFORE the authenticated /api/vehicle-health below so its routes match first.
app.use('/api/vehicle-health', vehicleHealthPublicRouter);

// Protected routes — require authentication
app.use('/api/drivers', authenticate, driversRouter);
app.use('/api/vehicles', authenticate, vehiclesRouter);
app.use('/api/trips', authenticate, tripsRouter);
app.use('/api/dashboard', authenticate, dashboardRouter);
app.use('/api/unassigned', authenticate, unassignedRouter);
app.use('/api/activity', authenticate, activityRouter);
app.use('/api/utilization', authenticate, utilizationRouter);
app.use('/api/vehicle-health', authenticate, vehicleHealthReadRouter);
app.use('/api/reservations', authenticate, reservationsRouter);
app.use('/api/sync', authenticate, authorize('admin'), syncRouter);

// Admin-only routes (example for future use)
// app.use('/api/admin/users', authenticate, authorize('admin'), adminRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startScheduler();

  // Auto-sync engineers from Jira on startup (non-blocking)
  syncEngineersFromJira();
});
