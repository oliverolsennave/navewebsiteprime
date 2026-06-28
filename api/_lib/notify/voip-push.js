// Sends an APNs VoIP push to a call's invited users so their phones ring
// natively (CallKit) even when the app is closed. Reachable at /api/voip-push
// (vercel.json rewrite -> /api/notify?action=voip-push). Under the notify router
// so it doesn't add a Vercel function.
//
// VoIP pushes MUST go directly through APNs (FCM can't send them), so this uses
// token-based APNs auth (.p8 key). Required Vercel env vars:
//   APNS_AUTH_KEY   — contents of your AuthKey_XXXX.p8 (with real newlines or \n)
//   APNS_KEY_ID     — the key's 10-char Key ID
//   APNS_TEAM_ID    — your Apple Developer Team ID
//   APNS_BUNDLE_ID  — the app bundle id (topic becomes "<bundle>.voip")
//   APNS_PRODUCTION — "false" to target the APNs sandbox (dev/debug builds);
//                     defaults to production.
//
// Body: { "callId": "dm_<threadId>" }. We read the call doc + each invited
// user's users/{uid}.voipToken from Firestore.

const { adminDb } = require('../firebase-admin');

module.exports = async (req, res) => {
  try {
    const callId = String((req.body && req.body.callId) || (req.query && req.query.callId) || '').trim();
    if (!callId) return res.status(400).json({ error: 'callId required' });

    const callSnap = await adminDb.collection('calls').doc(callId).get();
    if (!callSnap.exists) return res.status(404).json({ error: 'call not found' });
    const call = callSnap.data();

    const invited = (call.invitedUserIds || []).filter((id) => id !== call.hostId);
    if (!invited.length) return res.status(200).json({ ok: true, sent: 0 });

    // Resolve VoIP tokens.
    const tokens = [];
    for (const uid of invited) {
      const u = await adminDb.collection('users').doc(uid).get();
      const t = u.exists && u.data().voipToken;
      if (t) tokens.push(t);
    }
    if (!tokens.length) return res.status(200).json({ ok: true, sent: 0, note: 'no voip tokens' });

    const key = process.env.APNS_AUTH_KEY;
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const bundleId = process.env.APNS_BUNDLE_ID;
    if (!key || !keyId || !teamId || !bundleId) {
      return res.status(500).json({ error: 'APNs env not configured (APNS_AUTH_KEY/KEY_ID/TEAM_ID/BUNDLE_ID)' });
    }

    const apn = require('@parse/node-apn');
    const provider = new apn.Provider({
      token: { key: key.replace(/\\n/g, '\n'), keyId, teamId },
      production: process.env.APNS_PRODUCTION !== 'false',
    });

    const note = new apn.Notification();
    note.topic = `${bundleId}.voip`;
    note.pushType = 'voip';
    note.priority = 10;
    note.expiry = Math.floor(Date.now() / 1000) + 30; // ring window
    // Group huddles show the channel context on the native call screen, e.g.
    // "Maria · #general"; DMs just show the caller's name.
    const displayName = call.type === 'huddle'
      ? `${call.hostName || 'Someone'} · ${call.title || 'Huddle'}`
      : (call.hostName || 'Nave call');
    note.payload = {
      callId,
      hostName: displayName,
      type: call.type || 'dm',
      // So the native incoming-call screen shows the video affordance.
      isVideo: call.isVideo === true,
    };

    const result = await provider.send(note, tokens);
    provider.shutdown();

    res.status(200).json({ ok: true, sent: result.sent.length, failed: result.failed.length });
  } catch (err) {
    console.error('voip-push error:', err);
    res.status(500).json({ error: 'voip push failed' });
  }
};
