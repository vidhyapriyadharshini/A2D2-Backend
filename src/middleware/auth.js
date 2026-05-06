const jwt = require('jsonwebtoken');

// Verify JWT token
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// Authorize by role(s) — pass one or more role strings
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden. Insufficient permissions.' });
    }
    next();
  };
}

// Device-level auth for ESP32/Android ingestion.
// Validates the X-Device-Key header against DEVICE_INGEST_KEY env var.
function authenticateDevice(req, res, next) {
  const expected = process.env.DEVICE_INGEST_KEY;
  const provided = req.headers['x-device-key'];
  console.log(`[DEVICE-AUTH] ${req.method} ${req.originalUrl} from ${req.ip} | key=${provided ? `"${String(provided).slice(0,4)}…"` : 'MISSING'}`);
  if (!expected) {
    console.warn('[DEVICE-AUTH] DEVICE_INGEST_KEY not set on server');
    return res.status(500).json({ error: 'DEVICE_INGEST_KEY is not configured on the server.' });
  }
  if (!provided || provided !== expected) {
    console.warn('[DEVICE-AUTH] rejected — bad key');
    return res.status(401).json({ error: 'Invalid or missing device key.' });
  }
  next();
}

module.exports = { authenticate, authorize, authenticateDevice };
