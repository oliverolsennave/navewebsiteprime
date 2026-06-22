const admin = require('firebase-admin');

const app = (() => {
  const appName = 'feedback-notifier';
  const existing = admin.apps.find(a => a && a.name === appName);
  if (existing) return existing;

  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(sa) }, appName);
})();

const db = app.firestore();

// Oliver's account
const OLIVER_UID = 'BmBXDNkAy5WypwBzd0vhCR991Rl1';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userName, feedbackType, subject, message } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'Missing message' });
    }

    const title = `${userName || 'Someone'} posted feedback`;
    const body = message.length > 100 ? message.substring(0, 100) + '…' : message;

    // Write in-app notification
    await db.collection('users').doc(OLIVER_UID)
      .collection('activity_notifications')
      .add({
        type: 'feedback_reply',
        title,
        body,
        feedbackId: null,
        replyAuthorName: userName || 'Someone',
        replyAuthorId: null,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Send push if Oliver has an FCM token
    const userDoc = await db.collection('users').doc(OLIVER_UID).get();
    const fcmToken = userDoc.exists && userDoc.data().fcmToken;
    let pushed = false;

    if (fcmToken) {
      try {
        await app.messaging().send({
          token: fcmToken,
          notification: { title, body },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        });
        pushed = true;
      } catch (e) {
        // Push failed, but in-app notification is saved
      }
    }

    return res.status(200).json({ success: true, pushed });
  } catch (error) {
    console.error('Notify error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
