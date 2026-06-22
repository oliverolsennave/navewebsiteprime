const admin = require('firebase-admin');

// Standalone init — don't rely on shared module
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
    const { feedbackId, replyAuthorName, replyContent, replyAuthorId } = req.body || {};
    if (!feedbackId || !replyContent) {
      return res.status(400).json({ error: 'Missing feedbackId or replyContent' });
    }

    const feedbackDoc = await db.collection('user_feedback').doc(feedbackId).get();
    if (!feedbackDoc.exists) {
      return res.status(404).json({ error: 'Feedback not found' });
    }

    const originalUserId = feedbackDoc.data().userId;
    if (replyAuthorId && replyAuthorId === originalUserId) {
      return res.status(200).json({ skipped: true, reason: 'self-reply' });
    }

    const title = `${replyAuthorName || 'Someone'} replied to your feedback`;
    const body = replyContent.length > 100 ? replyContent.substring(0, 100) + '…' : replyContent;

    // Persist in-app notification (even if user has no FCM token)
    await db.collection('users').doc(originalUserId)
      .collection('activity_notifications')
      .add({
        type: 'feedback_reply',
        title,
        body,
        feedbackId,
        replyAuthorName: replyAuthorName || 'Someone',
        replyAuthorId: replyAuthorId || null,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Send push notification if user has FCM token
    const userDoc = await db.collection('users').doc(originalUserId).get();
    if (!userDoc.exists || !userDoc.data().fcmToken) {
      return res.status(200).json({ success: true, push: false, reason: 'no fcm token' });
    }

    const fcmToken = userDoc.data().fcmToken;
    const result = await messaging.send({
      token: fcmToken,
      notification: { title, body },
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
