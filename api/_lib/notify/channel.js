// Push when a message is posted in a channel.
//  - @mentioned users ALWAYS get a push (high signal), regardless of channel
//    size.
//  - All other channel members get a push only for "quiet" channels
//    (member count <= QUIET_THRESHOLD) so busy channels don't spam everyone.
// The iOS app calls this after writing the channel message; this handler reads
// the member list authoritatively and applies the gate server-side.
//
// External URL: POST /api/send-channel-notification (rewritten to
// /api/notify?action=channel).
//
// Body: { workspaceId, channelId, senderId, senderName, preview, channelName, mentionedUserIds }

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

// Above this member count, only @mentions push (not every message). Tunable.
const QUIET_THRESHOLD = 20;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { workspaceId, channelId, senderId, senderName, preview, channelName, mentionedUserIds } = req.body || {};
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

    // Members: private channel → its members; public channel → all workspace members.
    let members = [];
    if (ch.isPublic === false && Array.isArray(ch.memberIds)) {
      members = ch.memberIds;
    } else {
      const wsSnap = await db.collection('messageWorkspaces').doc(workspaceId).get();
      members = (wsSnap.exists && Array.isArray(wsSnap.data().memberIds)) ? wsSnap.data().memberIds : [];
    }
    members = [...new Set(members)].filter((id) => id && id !== senderId);

    const mentioned = new Set(
      (Array.isArray(mentionedUserIds) ? mentionedUserIds : []).filter((id) => id && id !== senderId)
    );
    const quiet = members.length > 0 && members.length <= QUIET_THRESHOLD;

    const mentionTitle = channelName ? `${senderName || 'Someone'} mentioned you in #${channelName}` : `${senderName || 'Someone'} mentioned you`;
    const genericTitle = channelName ? `${senderName || 'Someone'} in #${channelName}` : (senderName || 'New message');
    const body = preview.length > 140 ? preview.substring(0, 140) + '…' : preview;

    // Build the target set: mentioned users always (mention title); other
    // members only when the channel is quiet (generic title).
    const targets = new Map(); // uid -> title
    for (const uid of mentioned) targets.set(uid, mentionTitle);
    if (quiet) {
      for (const uid of members) if (!targets.has(uid)) targets.set(uid, genericTitle);
    }

    if (targets.size === 0) {
      return res.status(200).json({ skipped: true, reason: quiet ? 'no recipients' : 'channel too busy, no mentions', members: members.length });
    }

    const uids = [...targets.keys()];
    const userDocs = await db.getAll(...uids.map((id) => db.collection('users').doc(id)));
    const sends = userDocs.map(async (doc) => {
      const token = doc.exists ? doc.data().fcmToken : null;
      if (!token) return { id: doc.id, push: false };
      try {
        await messaging.send({
          token,
          notification: { title: targets.get(doc.id) || genericTitle, body },
          data: { type: 'channel_message', workspaceId: String(workspaceId), channelId: String(channelId) },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        });
        return { id: doc.id, push: true };
      } catch (err) {
        return { id: doc.id, push: false, error: err.code };
      }
    });
    const results = await Promise.all(sends);
    return res.status(200).json({ success: true, targets: targets.size, pushed: results.filter((r) => r.push).length });
  } catch (error) {
    console.error('channel notify error:', error.code, error.message);
    return res.status(500).json({ error: error.message, code: error.code });
  }
};
