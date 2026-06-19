// Vercel cron — emails oliver@catholicnave.com + mychal@catholicnave.com for
// every new Nave signup. Triggered by the schedule in vercel.json (every 5
// min). Each user is notified at most once: after we send, we stamp
// `signupNotifiedAt` on the user doc, and we skip any user that already has
// it. The 24-hour `createdAt` cutoff prevents the first deploy from blasting
// a backlog of historical users — anything older is treated as "already
// known."
//
// Required Vercel env vars:
//   FIREBASE_SERVICE_ACCOUNT  — already set (used by /api/dashboard-data)
//   GMAIL_USER                — e.g. oliver@catholicnave.com
//   GMAIL_APP_PASSWORD        — 16-char Google app password (NOT your login pw)
//   CRON_SECRET               — random string; Vercel auto-attaches it as a
//                               Bearer token on cron requests
//
// To send mail FROM a Workspace address you must generate an App Password at
// https://myaccount.google.com/apppasswords (requires 2FA enabled).

const nodemailer = require('nodemailer');
const { admin, adminDb } = require('./_lib/firebase-admin');

const RECIPIENTS = ['oliver@catholicnave.com', 'mychal@catholicnave.com'];
const LOOKBACK_HOURS = 24;
const MAX_PER_RUN = 50; // Cap so a backflood can't blow past Vercel timeouts.

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return cachedTransporter;
}

function fmtDate(d) {
  if (!d) return '(unknown)';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function buildEmail(user) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim()
    || user.username
    || user.email
    || user.uid;
  const lines = [
    `Name:     ${name}`,
    `Email:    ${user.email || '(none)'}`,
    `Username: ${user.username || '(none)'}`,
    `UID:      ${user.uid}`,
    `City:     ${[user.city, user.state, user.country].filter(Boolean).join(', ') || '(not set)'}`,
    `Created:  ${fmtDate(user.createdAt)}`,
    `Interests: ${Array.isArray(user.interests) && user.interests.length ? user.interests.join(', ') : '(none)'}`,
  ];
  return {
    subject: `New Nave signup: ${name}`,
    text: lines.join('\n') + '\n',
  };
}

module.exports = async (req, res) => {
  // Reject hits that aren't Vercel's cron runner (or a manual curl with the
  // secret). Vercel attaches `Authorization: Bearer ${CRON_SECRET}` for cron
  // jobs when the env var is set.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: 'Gmail credentials not configured' });
  }

  try {
    const cutoffMs = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
    const cutoffTs = admin.firestore.Timestamp.fromMillis(cutoffMs);

    // Pull recent users; filter unnotified ones client-side. We can't query
    // `where signupNotifiedAt == null` directly without a composite index,
    // and the result set is tiny (≤ a few hundred per day in practice).
    const snap = await adminDb.collection('users')
      .where('createdAt', '>=', cutoffTs)
      .orderBy('createdAt', 'desc')
      .limit(MAX_PER_RUN)
      .get();

    const toNotify = [];
    snap.docs.forEach((d) => {
      const x = d.data();
      if (x.signupNotifiedAt) return;
      toNotify.push({
        uid: d.id,
        email: x.email || null,
        firstName: x.firstName || null,
        lastName: x.lastName || null,
        username: x.username || null,
        city: x.city || null,
        state: x.state || null,
        country: x.country || null,
        interests: x.interests || null,
        createdAt: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate() : null,
      });
    });

    if (!toNotify.length) {
      return res.status(200).json({ ok: true, sent: 0, scanned: snap.size });
    }

    const transporter = getTransporter();
    const fromAddress = `Nave Signups <${process.env.GMAIL_USER}>`;
    const sent = [];
    const failed = [];

    for (const user of toNotify) {
      const { subject, text } = buildEmail(user);
      try {
        await transporter.sendMail({
          from: fromAddress,
          to: RECIPIENTS.join(', '),
          subject,
          text,
        });
        // Stamp AFTER successful send so a transient SMTP failure leaves the
        // user eligible for the next cron tick.
        await adminDb.collection('users').doc(user.uid).set(
          { signupNotifiedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        sent.push(user.uid);
      } catch (e) {
        console.error(`[notify-new-signups] send failed for ${user.uid}:`, e.message);
        failed.push({ uid: user.uid, error: e.message });
      }
    }

    return res.status(200).json({
      ok: true,
      scanned: snap.size,
      sent: sent.length,
      failed: failed.length,
      failures: failed,
    });
  } catch (err) {
    console.error('[notify-new-signups] error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};
