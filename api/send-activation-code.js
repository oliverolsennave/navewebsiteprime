// POST /api/send-activation-code
// Body: { entityCollection, entityId, entityName, email, requesterUid }
//
// Step 1 of the "Discovered by Nave" activation flow. The iOS app posts an
// email tied to the institution's website; we generate a 6-digit code,
// store it under `activationCodes/{entityCollection}__{entityId}` with a
// 15-minute expiry, and mail it to the address. The user enters the code
// in the next screen, which hits /api/verify-activation-code to transfer
// ownership.
//
// Same nodemailer + Gmail SMTP setup as /api/notify-new-signups (reuses
// GMAIL_USER + GMAIL_APP_PASSWORD env vars).

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { admin, adminDb } = require('./_lib/firebase-admin');

const CODE_TTL_MIN = 15;

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

function generateCode() {
  // 6-digit, zero-padded. Reject the first 100k space (000000–099999) so
  // every code is exactly 6 visible digits — easier for users to type and
  // for us to validate.
  return String(100000 + crypto.randomInt(900000));
}

function codeDocId(entityCollection, entityId) {
  return `${entityCollection}__${entityId}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { entityCollection, entityId, entityName, email, website, requesterUid } = req.body || {};
  if (!entityCollection || !entityId || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: 'Email sender not configured' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const code = generateCode();
    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + CODE_TTL_MIN * 60 * 1000);

    // Upsert: each new request invalidates the previous code for this entity.
    await adminDb.collection('activationCodes').doc(codeDocId(entityCollection, entityId)).set({
      entityCollection,
      entityId,
      entityName: entityName || null,
      website: website || null,
      email: cleanEmail,
      requesterUid: requesterUid || null,
      code,
      attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt,
      consumed: false,
    });

    const transporter = getTransporter();
    await transporter.sendMail({
      from: `Nave <${process.env.GMAIL_USER}>`,
      to: cleanEmail,
      subject: `Your Nave activation code: ${code}`,
      text: [
        `Your verification code for activating ${entityName || 'this institution'} on Nave is:`,
        ``,
        `    ${code}`,
        ``,
        `This code expires in ${CODE_TTL_MIN} minutes.`,
        ``,
        `If you didn't request this, you can ignore this email — no changes are made until the code is entered in the Nave app.`,
        ``,
        `— The Nave Team`,
      ].join('\n'),
    });

    return res.status(200).json({ ok: true, expiresInMinutes: CODE_TTL_MIN });
  } catch (err) {
    console.error('[send-activation-code] error:', err);
    return res.status(500).json({ error: 'Failed to send code', message: err.message });
  }
};
