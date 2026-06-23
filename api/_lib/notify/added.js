// Push + in-app notification when a user is added to a workspace (group) or a
// private channel. Called by the iOS app after the membership write. Resolves
// the group/channel name server-side so the client doesn't have to pass it.
//
// External URL: POST /api/notify-group-added (rewritten to
// /api/notify?action=added).
//
// Body: { addedUserIds: [..], workspaceId, channelId?, actorId?, actorName? }

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { addedUserIds, workspaceId, channelId, actorId, actorName } = req.body || {};
    if (!Array.isArray(addedUserIds) || addedUserIds.length === 0 || !workspaceId) {
      return res.status(400).json({ error: 'Missing addedUserIds or workspaceId' });
    }

    // Resolve a human label for what they were added to.
    let groupLabel = 'a group';
    if (channelId) {
      const chSnap = await db.collection('messageWorkspaces').doc(workspaceId)
        .collection('channels').doc(channelId).get();
      groupLabel = chSnap.exists ? `#${chSnap.data().name || 'a channel'}` : 'a channel';
    } else {
      const wsSnap = await db.collection('messageWorkspaces').doc(workspaceId).get();
      groupLabel = wsSnap.exists ? (wsSnap.data().name || 'a group') : 'a group';
    }

    const title = `You were added to ${groupLabel}`;
    const body = actorName ? `${actorName} added you` : 'Tap to open';

    const recipients = [...new Set(addedUserIds)].filter((id) => id && id !== actorId);
    const sends = recipients.map(async (uid) => {
      // In-app activity record (shows in the feed even with no token).
      await db.collection('users').doc(uid).collection('activity_notifications').add({
        type: 'added_to_workspace',
        title,
        body,
        workspaceId,
        channelId: channelId || null,
        actorId: actorId || null,
        actorName: actorName || null,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Push if they have a token.
      const userDoc = await db.collection('users').doc(uid).get();
      const token = userDoc.exists ? userDoc.data().fcmToken : null;
      if (!token) return { id: uid, push: false };
      try {
        await messaging.send({
          token,
          notification: { title, body },
          data: { type: 'added_to_workspace', workspaceId: String(workspaceId), channelId: channelId ? String(channelId) : '' },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        });
        return { id: uid, push: true };
      } catch (err) {
        return { id: uid, push: false, error: err.code };
      }
    });
    const results = await Promise.all(sends);
    return res.status(200).json({ success: true, notified: results.length, pushed: results.filter((r) => r.push).length });
  } catch (error) {
    console.error('added notify error:', error.code, error.message);
    return res.status(500).json({ error: error.message, code: error.code });
  }
};
