// Mints a short-lived LiveKit access token so an iOS client can join a call
// room (1:1 DM call or a channel "huddle"). Reachable at /api/call-token
// (vercel.json rewrite -> /api/notify?action=call-token), so it lives under the
// notify router and doesn't add a 13th Vercel function (Hobby cap is 12).
//
// Required Vercel env vars (set these in the project dashboard):
//   LIVEKIT_API_KEY     — from your LiveKit Cloud project (or self-host)
//   LIVEKIT_API_SECRET  — same
//   LIVEKIT_URL         — wss://<your-project>.livekit.cloud (or your server)
//
// livekit-server-sdk v2 is ESM-only, so we dynamic-import it from this CJS
// handler. `toJwt()` is async in v2.

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const b = req.body || {};
    const room = String(q.room || b.room || '').trim();
    const identity = String(q.identity || b.identity || '').trim();
    const name = String(q.name || b.name || identity).trim();

    if (!room || !identity) {
      return res.status(400).json({ error: 'room and identity are required' });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
      return res.status(500).json({ error: 'LiveKit env not configured (LIVEKIT_API_KEY/SECRET/URL)' });
    }

    const { AccessToken } = await import('livekit-server-sdk');
    const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: '2h' });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();

    res.status(200).json({ token, url, room, identity });
  } catch (err) {
    console.error('call-token error:', err);
    res.status(500).json({ error: 'Failed to mint LiveKit token' });
  }
};
