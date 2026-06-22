// Vercel cron — every 15 min, polls iTunes Lookup for the live Nave App
// Store version and updates the `appConfig/ios` Firestore policy doc so
// the iOS hard-force gate auto-tracks whatever Apple currently has live.
//
// Behavior:
//   • Reads current `latestVersion` from Firestore.
//   • Hits https://itunes.apple.com/lookup?id={APPLE_APP_ID}&country=us
//   • If iTunes reports a newer version than what we have stored, writes
//     the new value to `latestVersion`.
//   • If `autoEnforceLatest === true`, also writes the new value to
//     `minSupportedVersion` — flipping the hard gate the moment Apple
//     publishes a new build. iOS real-time listeners apply within seconds.
//
// Required Vercel env vars:
//   FIREBASE_SERVICE_ACCOUNT  — already set
//   APPLE_APP_ID              — Nave's App Store numeric id (default below)
//   CRON_SECRET               — same shared bearer the other crons use

const { admin, adminDb } = require('../firebase-admin');

const DEFAULT_APPLE_APP_ID = '6753827903';

function compareVersion(a, b) {
  const parts = (s) => String(s || '').split('-')[0].split('.').map((p) => parseInt(p, 10) || 0);
  const ap = parts(a), bp = parts(b);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const ai = ap[i] || 0;
    const bi = bp[i] || 0;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
}

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const appId = process.env.APPLE_APP_ID || DEFAULT_APPLE_APP_ID;
  try {
    const lookupRes = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=us`);
    if (!lookupRes.ok) {
      return res.status(502).json({ error: `iTunes Lookup HTTP ${lookupRes.status}` });
    }
    const body = await lookupRes.json();
    const result = (body.results || [])[0];
    if (!result || !result.version) {
      return res.status(502).json({ error: 'No version in iTunes Lookup response', body });
    }
    const liveVersion = String(result.version);

    const cfgRef = adminDb.collection('appConfig').doc('ios');
    const cfgSnap = await cfgRef.get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    const storedLatest = cfg.latestVersion || null;
    const autoEnforce = cfg.autoEnforceLatest === true;

    // No change → no write (saves Firestore writes + listener churn).
    if (storedLatest && compareVersion(liveVersion, storedLatest) <= 0) {
      return res.status(200).json({
        ok: true, changed: false, liveVersion, storedLatest,
      });
    }

    const update = {
      latestVersion: liveVersion,
      latestVersionCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (autoEnforce) {
      update.minSupportedVersion = liveVersion;
    }
    await cfgRef.set(update, { merge: true });

    return res.status(200).json({
      ok: true,
      changed: true,
      previous: storedLatest,
      liveVersion,
      enforcedMin: autoEnforce ? liveVersion : (cfg.minSupportedVersion || null),
    });
  } catch (err) {
    console.error('[check-app-store-version] error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};
