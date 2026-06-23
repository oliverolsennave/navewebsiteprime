// Push + in-app notification when a user receives a direct message (or a reply
// in any messages_thread). Called by the iOS app right after it writes the
// message to Firestore. Mirrors reply.js: writes an in-app activity record
// (so it shows in the notification feed even with no FCM token) and, if the
// recipient has a token, sends an FCM push.
//
// External URL: POST /api/send-message-notification  (rewritten to
// /api/notify?action=message in vercel.json).
//
// Body: { recipientId, senderName, messagePreview, senderId, threadId }

const admin = require('firebase-admin');

// Standalone init — reuse the shared 'fcm-sender' app (guard by name).
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
    const { recipientId, senderName, messagePreview, senderId, threadId } = req.body || {};
    if (!recipientId || !messagePreview) {
      return res.status(400).json({ error: 'Missing recipientId or messagePreview' });
    }
    // Never notify yourself.
    if (senderId && senderId === recipientId) {
      return res.status(200).json({ skipped: true, reason: 'self-message' });
    }

    const title = `${senderName || 'Someone'} sent you a message`;
    const body = messagePreview.length > 140 ? messagePreview.substring(0, 140) + '…' : messagePreview;

    // Persist in-app notification (even if the recipient has no FCM token).
    await db.collection('users').doc(recipientId)
      .collection('activity_notifications')
      .add({
        type: 'direct_message',
        title,
        body,
        threadId: threadId || null,
        senderName: senderName || 'Someone',
        senderId: senderId || null,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Send a push if the recipient has an FCM token.
    const userDoc = await db.collection('users').doc(recipientId).get();
    if (!userDoc.exists || !userDoc.data().fcmToken) {
      return res.status(200).json({ success: true, push: false, reason: 'no fcm token' });
    }

    const fcmToken = userDoc.data().fcmToken;
    const result = await messaging.send({
      token: fcmToken,
      notification: { title, body },
      data: threadId ? { type: 'direct_message', threadId: String(threadId) } : { type: 'direct_message' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });

    return res.status(200).json({ success: true, push: true, messageId: result });
  } catch (error) {
    if (error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token') {
      return res.status(200).json({ skipped: true, reason: 'stale token' });
    }
    console.error('FCM error:', error.code, error.message);
    return res.status(500).json({ error: error.message, code: error.code });
  }
};
