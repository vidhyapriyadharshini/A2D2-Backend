const pool = require('../db/connection');

const BASE_URL = (process.env.CONFLUENCE_BASE_URL || 'https://inmotion.atlassian.net').replace(/\/$/, '');
const PARENT_PAGE_ID = process.env.CONFLUENCE_PARENT_PAGE_ID || '3090907137';
const EMAIL = process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL;
const TOKEN = process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN;

const isConfigured = () => Boolean(EMAIL && TOKEN && PARENT_PAGE_ID);

const pageUrl = (pageId) =>
  pageId ? `${BASE_URL}/wiki/pages/viewpage.action?pageId=${pageId}` : null;

const authHeader = () => 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtDate = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  return Number.isNaN(date.getTime())
    ? String(d)
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const fmtKm = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1)} km` : '—';
};

const fmtRawKm = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(1)} km` : '—';
};

const fmtPct = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}%` : '—';
};

const fmtTime = (t) => {
  if (!t) return '—';
  const m = String(t).match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : String(t);
};

const tripDistance = (t) => {
  const s = Number(t.start_odometer);
  const e = Number(t.end_odometer);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  return e - s;
};

const tripBatteryUsed = (t) => {
  const s = Number(t.start_battery);
  const e = Number(t.end_battery);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return s - e;
};

async function apiFetch(path, init = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Confluence ${init.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

const getPage = (id) => apiFetch(`/wiki/api/v2/pages/${id}?body-format=storage`);

async function createChildPage({ parentId, title, value, spaceId }) {
  return apiFetch(`/wiki/api/v2/pages`, {
    method: 'POST',
    body: JSON.stringify({
      spaceId,
      status: 'current',
      title,
      parentId,
      body: { representation: 'storage', value },
    }),
  });
}

async function updatePage({ id, title, value, currentVersion, spaceId, isDraft }) {
  const versionNumber = isDraft ? 1 : currentVersion + 1;
  return apiFetch(`/wiki/api/v2/pages/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      id,
      status: 'current',
      title,
      spaceId,
      body: { representation: 'storage', value },
      version: { number: versionNumber, message: 'Auto-sync from Driver Trip Management System' },
    }),
  });
}

function buildVehiclePageHtml(vehicle, trips) {
  const updatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const distances = trips.map(tripDistance).filter((d) => d !== null);
  const totalDistance = distances.reduce((a, b) => a + b, 0);
  const avgDistance = distances.length ? totalDistance / distances.length : null;
  const batteryDeltas = trips.map(tripBatteryUsed).filter((d) => d !== null);
  const avgBattery = batteryDeltas.length
    ? batteryDeltas.reduce((a, b) => a + b, 0) / batteryDeltas.length
    : null;
  const lastTripDate = trips.length ? fmtDate(trips[0].assignment_date) : '—';

  const intro =
    `<p><em>Auto-synced from the Driver Trip Management System. Last updated: ${escapeHtml(updatedAt)} IST. ` +
    `<strong>This page is the single source of truth for this vehicle's trip history.</strong></em></p>`;

  const detailsTable =
    `<h2>Vehicle Details</h2>` +
    `<table><tbody>` +
      `<tr><th>Registration Number</th><td>${escapeHtml(vehicle.registration_number)}</td></tr>` +
      `<tr><th>Type</th><td>${escapeHtml(vehicle.vehicle_type || '—')}</td></tr>` +
      `<tr><th>VIN</th><td>${escapeHtml(vehicle.vin_number || '—')}</td></tr>` +
      `<tr><th>Lifetime Odometer</th><td>${fmtRawKm(vehicle.total_odometer)}</td></tr>` +
    `</tbody></table>`;

  const summaryTable =
    `<h2>Lifetime Summary</h2>` +
    `<table><tbody>` +
      `<tr><th>Completed Trips</th><td>${trips.length}</td></tr>` +
      `<tr><th>Total Distance Travelled</th><td>${fmtKm(totalDistance)}</td></tr>` +
      `<tr><th>Average Distance per Trip</th><td>${avgDistance != null ? fmtKm(avgDistance) : '—'}</td></tr>` +
      `<tr><th>Average Battery Consumed per Trip</th><td>${avgBattery != null ? `${avgBattery.toFixed(1)}%` : '—'}</td></tr>` +
      `<tr><th>Last Trip</th><td>${escapeHtml(lastTripDate)}</td></tr>` +
    `</tbody></table>`;

  if (!trips.length) {
    return intro + detailsTable + summaryTable + `<h2>Trip Log</h2><p><em>No completed trips yet.</em></p>`;
  }

  const tripRows = trips.map((t) => {
    const dist = tripDistance(t);
    const batt = tripBatteryUsed(t);
    return `
      <tr>
        <td>${escapeHtml(fmtDate(t.assignment_date))}</td>
        <td>${escapeHtml(t.driver_name || '—')}</td>
        <td>${escapeHtml(t.source || '—')} &rarr; ${escapeHtml(t.destination || '—')}</td>
        <td>${escapeHtml(fmtTime(t.trip_time))} – ${escapeHtml(fmtTime(t.end_time))}</td>
        <td>${fmtRawKm(t.start_odometer)}</td>
        <td>${fmtRawKm(t.end_odometer)}</td>
        <td>${dist != null ? fmtKm(dist) : '—'}</td>
        <td>${fmtPct(t.start_battery)}</td>
        <td>${fmtPct(t.end_battery)}</td>
        <td>${batt != null ? `${batt.toFixed(0)}%` : '—'}</td>
        <td>${escapeHtml((t.completion_comment || '').trim() || '—')}</td>
      </tr>`;
  }).join('');

  const tripLog =
    `<h2>Trip Log</h2>` +
    `<table data-layout="wide">` +
      `<colgroup>` +
        `<col style="width: 110px"/>` +
        `<col style="width: 160px"/>` +
        `<col style="width: 240px"/>` +
        `<col style="width: 130px"/>` +
        `<col style="width: 110px"/>` +
        `<col style="width: 110px"/>` +
        `<col style="width: 110px"/>` +
        `<col style="width: 120px"/>` +
        `<col style="width: 120px"/>` +
        `<col style="width: 120px"/>` +
        `<col style="width: 320px"/>` +
      `</colgroup>` +
      `<thead><tr>` +
        `<th>Date</th><th>Engineer</th><th>Route</th><th>Time</th>` +
        `<th>Start KM</th><th>End KM</th><th>Distance</th>` +
        `<th>Start Battery</th><th>End Battery</th><th>Battery Used</th>` +
        `<th>Comment</th>` +
      `</tr></thead>` +
      `<tbody>${tripRows}</tbody>` +
    `</table>`;

  return intro + detailsTable + summaryTable + tripLog;
}

function buildIndexPageHtml(rows) {
  const updatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const intro =
    `<p><strong>Fleet Vehicles — Trip History Index</strong></p>` +
    `<p><em>Each vehicle has its own page with full trip details (start/end KM, distance, battery, route, comment). ` +
    `Auto-synced from the Driver Trip Management System. Last updated: ${escapeHtml(updatedAt)} IST. ` +
    `<strong>Confluence is the single source of truth for the fleet's trip history.</strong></em></p>`;

  if (!rows.length) return intro + `<p><em>No vehicles available.</em></p>`;

  const tableRows = rows.map((r) => {
    const pageId = r.id || r.confluence_page_id;
    const linkCell = pageId
      ? `<a href="${BASE_URL}/wiki/pages/viewpage.action?pageId=${escapeHtml(pageId)}">${escapeHtml(r.registration_number)}</a>`
      : escapeHtml(r.registration_number);
    return `
      <tr>
        <td>${linkCell}</td>
        <td>${escapeHtml(r.vehicle_type || '—')}</td>
        <td>${r.trip_count}</td>
        <td>${fmtKm(r.total_distance || 0)}</td>
      </tr>`;
  }).join('');

  return intro + `
    <table>
      <thead>
        <tr><th>Vehicle</th><th>Type</th><th>Trips</th><th>Total Distance</th></tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>`;
}

async function loadVehicles() {
  const r = await pool.query(
    `SELECT id, registration_number, vehicle_type, vin_number, total_odometer, confluence_page_id
       FROM vehicles
      ORDER BY registration_number`
  );
  return r.rows;
}

async function loadTripsForVehicle(registration_number) {
  const r = await pool.query(
    `SELECT id, assignment_date, driver_name, source, destination,
            trip_time, end_time,
            start_odometer, end_odometer,
            start_battery, end_battery,
            start_lat, start_lng, end_lat, end_lng,
            completion_comment
       FROM trip_assignments
      WHERE status = 'Completed'
        AND vehicle_number = $1
      ORDER BY assignment_date DESC, id DESC`,
    [registration_number]
  );
  return r.rows;
}

async function ensureVehiclePage(vehicle, parentMeta) {
  const trips = await loadTripsForVehicle(vehicle.registration_number);
  const value = buildVehiclePageHtml(vehicle, trips);
  const title = `Vehicle ${vehicle.registration_number} — Trip History`;
  const totalDistance = trips.map(tripDistance).filter((d) => d !== null).reduce((a, b) => a + b, 0);
  const summary = {
    registration_number: vehicle.registration_number,
    vehicle_type: vehicle.vehicle_type,
    trip_count: trips.length,
    total_distance: totalDistance,
  };

  if (!vehicle.confluence_page_id) {
    const created = await createChildPage({
      parentId: PARENT_PAGE_ID,
      title,
      value,
      spaceId: parentMeta.spaceId,
    });
    await pool.query(
      'UPDATE vehicles SET confluence_page_id = $1 WHERE id = $2',
      [created.id, vehicle.id]
    );
    return { id: created.id, ...summary, created: true };
  }

  let existing;
  try {
    existing = await getPage(vehicle.confluence_page_id);
  } catch (err) {
    // Stored id no longer valid — recreate.
    console.warn(`[Confluence] Page ${vehicle.confluence_page_id} for ${vehicle.registration_number} unreachable, recreating: ${err.message}`);
    const created = await createChildPage({
      parentId: PARENT_PAGE_ID,
      title,
      value,
      spaceId: parentMeta.spaceId,
    });
    await pool.query(
      'UPDATE vehicles SET confluence_page_id = $1 WHERE id = $2',
      [created.id, vehicle.id]
    );
    return { id: created.id, ...summary, recreated: true };
  }

  await updatePage({
    id: existing.id,
    title: (existing.title && existing.title.trim()) || title,
    value,
    currentVersion: existing.version?.number ?? 1,
    spaceId: existing.spaceId,
    isDraft: existing.status === 'draft',
  });
  return { id: existing.id, ...summary };
}

async function syncIndexPage(rows) {
  const parent = await getPage(PARENT_PAGE_ID);
  const value = buildIndexPageHtml(rows);
  const title = (parent.title && parent.title.trim()) || 'Fleet Vehicles — Trip Notes Index';
  await updatePage({
    id: parent.id,
    title,
    value,
    currentVersion: parent.version?.number ?? 1,
    spaceId: parent.spaceId,
    isDraft: parent.status === 'draft',
  });
}

let inFlight = null;

async function syncFleetPage() {
  if (!isConfigured()) {
    console.warn('[Confluence] Skipping sync — credentials or page id not configured.');
    return { skipped: true };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const parent = await getPage(PARENT_PAGE_ID);
      const vehicles = await loadVehicles();
      const summaries = [];
      for (const v of vehicles) {
        try {
          const summary = await ensureVehiclePage(v, parent);
          summaries.push(summary);
        } catch (err) {
          console.error(`[Confluence] Failed sync for ${v.registration_number}:`, err.message);
        }
      }
      await syncIndexPage(summaries);
      const created = summaries.filter((s) => s.created).length;
      console.log(`[Confluence] Synced ${summaries.length}/${vehicles.length} vehicle pages (${created} created) + index.`);
      return { ok: true };
    } catch (err) {
      console.error('[Confluence] Sync failed:', err.message);
      return { ok: false, error: err.message };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function syncFleetPageInBackground() {
  syncFleetPage().catch((err) => console.error('[Confluence] Background sync error:', err));
}

module.exports = { syncFleetPage, syncFleetPageInBackground, isConfigured, pageUrl };
