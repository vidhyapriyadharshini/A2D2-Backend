// Posts fake ESP32 telemetry to the ingestion endpoint every 2s.
// Usage:
//   DEVICE_INGEST_KEY=... node server/scripts/simulate-telemetry.js
// Optional env: SERVER_URL (default http://localhost:5000), DEVICE_ID, VEHICLE_ID, INTERVAL_MS

require('dotenv').config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:5000';
const DEVICE_KEY = process.env.DEVICE_INGEST_KEY;
const DEVICE_ID  = process.env.DEVICE_ID || 'sim-device-01';
const VEHICLE_ID = process.env.VEHICLE_ID ? Number(process.env.VEHICLE_ID) : null;
const INTERVAL   = Number(process.env.INTERVAL_MS) || 2000;

if (!DEVICE_KEY) {
  console.error('Missing DEVICE_INGEST_KEY. Set it in .env or as an env var.');
  process.exit(1);
}

let km = 12000 + Math.random() * 5000;

function nextSample() {
  km += 0.02;
  return {
    vehicle_id: VEHICLE_ID,
    device_id: DEVICE_ID,
    vin: 12.4 + (Math.random() - 0.5) * 0.6,
    rpm: Math.round(800 + Math.random() * 3000),
    temperature: 70 + Math.random() * 25,
    km,
    recorded_at: new Date().toISOString(),
  };
}

async function post(sample) {
  const res = await fetch(`${SERVER_URL}/api/ingest/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': DEVICE_KEY },
    body: JSON.stringify(sample),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text;
}

(async () => {
  console.log(`Simulating telemetry → ${SERVER_URL}/api/ingest/telemetry every ${INTERVAL}ms`);
  console.log(`device_id=${DEVICE_ID} vehicle_id=${VEHICLE_ID ?? 'none'}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = nextSample();
    try {
      await post(s);
      process.stdout.write(`✓ ${s.rpm} RPM, ${s.temperature.toFixed(1)}°C, ${s.km.toFixed(1)} km\n`);
    } catch (err) {
      console.error('✗', err.message);
    }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
})();
