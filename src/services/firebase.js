// Lazy-initialized Firebase Admin SDK wrapper used to mirror the latest
// telemetry sample into Realtime Database, so the public live-telemetry page
// can subscribe instead of polling Postgres.
//
// Configure via env vars (any one of the credential options is enough):
//   FIREBASE_DATABASE_URL          e.g. https://<project>-default-rtdb.firebaseio.com
//   FIREBASE_SERVICE_ACCOUNT_PATH  path to a service-account JSON file, OR
//   FIREBASE_SERVICE_ACCOUNT_JSON  raw JSON string of the service account
//
// If FIREBASE_DATABASE_URL is absent, mirroring is silently disabled so local
// dev without Firebase keeps working.

const fs = require('fs');
const path = require('path');

let cachedDb = null;
let initTried = false;
let disabledReason = null;

function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inline) {
    try { return JSON.parse(inline); }
    catch (err) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + err.message); }
  }
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (!fs.existsSync(abs)) throw new Error('Service account file not found: ' + abs);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  return null;
}

function getDb() {
  if (cachedDb) return cachedDb;
  if (initTried) return null;
  initTried = true;

  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!dbUrl) {
    disabledReason = 'FIREBASE_DATABASE_URL not set — telemetry mirroring disabled.';
    console.log('[firebase]', disabledReason);
    return null;
  }

  try {
    const admin = require('firebase-admin');
    const serviceAccount = loadServiceAccount();
    const credential = serviceAccount
      ? admin.credential.cert(serviceAccount)
      : admin.credential.applicationDefault();

    admin.initializeApp({ credential, databaseURL: dbUrl });
    cachedDb = admin.database();
    console.log('[firebase] mirror initialized →', dbUrl);
    return cachedDb;
  } catch (err) {
    disabledReason = err.message;
    console.warn('[firebase] init failed, mirroring disabled:', err.message);
    return null;
  }
}

// Best-effort write of the latest telemetry sample. Never throws — we don't
// want a Firebase outage to break the ingest path that's already saved to
// Postgres successfully.
async function mirrorLatestTelemetry(sample) {
  const db = getDb();
  if (!db || !sample) return;
  try {
    const payload = {
      vehicle_id: sample.vehicle_id ?? null,
      device_id: sample.device_id ?? null,
      vin: sample.vin ?? null,
      rpm: sample.rpm ?? null,
      temperature: sample.temperature ?? null,
      km: sample.km ?? null,
      recorded_at: sample.recorded_at instanceof Date
        ? sample.recorded_at.toISOString()
        : sample.recorded_at,
      received_at: new Date().toISOString(),
    };
    await db.ref('live/telemetry/latest').set(payload);
  } catch (err) {
    console.warn('[firebase] mirror write failed:', err.message);
  }
}

module.exports = { mirrorLatestTelemetry };
