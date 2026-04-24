// Vercel serverless proxy for OpenAI embeddings.
// Same auth + rate-limit pattern as openai-chat.js.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const adminAuth = admin.auth();

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120; // embeddings are cheaper — higher bucket
const uidRequests = new Map();

function isRateLimited(uid) {
  const now = Date.now();
  const record = uidRequests.get(uid);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    uidRequests.set(uid, { windowStart: now, count: 1 });
    return false;
  }
  record.count++;
  return record.count > RATE_LIMIT_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [uid, record] of uidRequests) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      uidRequests.delete(uid);
    }
  }
}, 5 * 60 * 1000);

const MAX_BODY_BYTES = 400 * 1024; // embeddings batches can be larger

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  let decoded;
  try {
    decoded = await adminAuth.verifyIdToken(idToken);
  } catch {
    return res.status(401).json({ error: 'Invalid authorization token' });
  }

  if (isRateLimited(decoded.uid)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
  }

  const body = req.body || {};
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (!body.input || (typeof body.input !== 'string' && !Array.isArray(body.input))) {
    return res.status(400).json({ error: 'Invalid body: input is required' });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(500).json({ error: 'OpenAI key not configured on server' });
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: serialized,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    return res.send(text);
  } catch (err) {
    console.error('[openai-embed] upstream error:', err);
    return res.status(502).json({ error: 'Upstream OpenAI request failed' });
  }
};
