// Push when a message is posted in a channel — to the channel's members,
// but ONLY for "quiet" channels (member count <= QUIET_THRESHOLD) so busy
// channels don't spam everyone. The iOS app calls this after writing the
// channel message; this handler reads the member list authoritatively and
// applies the quiet gate server-side.
//
// External URL: POST /api/send-channel-notification (rewritten to
// /api/notify?action=channel).
//
// Body: { workspaceId, channelId, senderId, senderName, preview, channelName }

const admin = require('firebase-admin');

const app = (() => {
  const appName = 'fcm-sender';
  const existing = admin.apps.find(a => a && a.name === appName);
  if (existing) return existing;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(sa) }, appName);
})();

const db = app.firestore();
const messaging = app.messaging();

// Channels with more members than this don't get a push per message — they'd
// be too noisy. (@mentions still notify via the mention path.) Tunable.
const QUIET_THRESHOLD = 20;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { workspaceId, channelId, senderId, senderName, preview, channelName } = req.body || {};
    if (!workspaceId || !channelId || !preview) {
      return res.status(400).json({ error: 'Missing workspaceId, channelId or preview' });
    }

    const chRef = db.collection('messageWorkspaces').doc(workspaceId)
      .collection('channels').doc(channelId);
    const chSnap = await chRef.get();
    if (!chSnap.exists) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    const ch = chSnap.data();

    // Recipients: private channel → its members; public channel → all workspace
    // members.
    let recipientIds = [];
    if (ch.isPublic === false && Array.isArray(ch.memberIds)) {
      recipientIds = ch.memberIds;
    } else {
      const wsSnap = await db.collection('messageWorkspaces').doc(workspaceId).get();
      recipientIds = (wsSnap.exists && Array.isArray(wsSnap.data().memberIds))
        ? wsSnap.data().memberIds : [];
    }
    recipientIds = [...new Set(recipientIds)].filter((id) => id && id !== senderId);

    if (recipientIds.length === 0) {
      return res.status(200).json({ skipped: true, reason: 'no recipients' });
    }
    if (recipientIds.length > QUIET_THRESHOLD) {
      // Too busy — rely on @mentions instead of per-message pushes.
      return res.status(200).json({ skipped: true, reason: 'channel too busy', members: recipientIds.length });
    }

    const title = channelName ? `${senderName || 'Someone'} in #${channelName}` : (senderName || 'New message');
    const body = preview.length > 140 ? preview.substring(0, 140) + '…' : preview;

    // Fetch each recipient's token and push.
    const userDocs = await db.getAll(...recipientIds.map((id) => db.collection('users').doc(id)));
    const sends = userDocs.map(async (doc) => {
      const token = doc.exists ? doc.data().fcmToken : null;
      if (!token) return { id: doc.id, push: false };
      try {
        await messaging.send({
          token,
          notification: { title, body },
          data: { type: 'channel_message', workspaceId: String(workspaceId), channelId: String(channelId) },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        });
        return { id: doc.id, push: true };
      } catch (err) {
        return { id: doc.id, push: false, error: err.code };
      }
    });
    const results = await Promise.all(sends);
    const pushed = results.filter((r) => r.push).length;
    return res.status(200).json({ success: true, recipients: recipientIds.length, pushed });
  } catch (error) {
    console.error('channel notify error:', error.code, error.message);
    return res.status(500).json({ error: error.message, code: error.code });
  }
};
