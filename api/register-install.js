// First-launch ping endpoint. The iOS app calls this once per device
// (gated by UserDefaults + IDFV) to register an install. Each unique
// IDFV becomes one doc in `appInstalls/{idfv}`; subsequent calls from
// the same device no-op via Firestore's atomic `.create()`.
//
// Note: this counts "first opens," not literal downloads. Downloads that
// never open won't appear, and a fresh install on a brand-new device by
// the same Apple ID counts again. Good enough as a live install pulse;
// for the authoritative count use App Store Connect's Sales reports.

const { adminDb, admin } = require('./_lib/firebase-admin');

const IDFV_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

module.exports = async (req, res) => {
  // CORS / preflight friendly — useful for testing from browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const idfv = String(body.idfv || '').trim();
    if (!IDFV_RE.test(idfv)) {
      return res.status(400).json({ error: 'Invalid idfv' });
    }
    const payload = {
      idfv,
      appVersion: typeof body.appVersion === 'string' ? body.appVersion.slice(0, 32) : null,
      buildNumber: typeof body.buildNumber === 'string' ? body.buildNumber.slice(0, 32) : null,
      device: typeof body.device === 'string' ? body.device.slice(0, 64) : null,
      systemVersion: typeof body.systemVersion === 'string' ? body.systemVersion.slice(0, 32) : null,
      firstLaunchAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    try {
      await adminDb.collection('appInstalls').doc(idfv).create(payload);
      return res.status(200).json({ status: 'created' });
    } catch (e) {
      // ALREADY_EXISTS = doc was already registered; this is a no-op
      // and we still return 200 so the client can mark itself reported.
      if (e && e.code === 6) {
        return res.status(200).json({ status: 'exists' });
      }
      throw e;
    }
  } catch (err) {
    console.error('[register-install] error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
