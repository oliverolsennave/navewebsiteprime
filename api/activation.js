// Unified activation endpoint. Three sub-actions dispatched by
// `body.action` so this consumes one Vercel serverless slot instead of
// three (Hobby plan cap = 12 functions).
//
//   POST /api/activation  { action: "send",   entityCollection, entityId, entityName, email, website, requesterUid }
//   POST /api/activation  { action: "verify", entityCollection, entityId, email, code, requesterUid }
//   POST /api/activation  { action: "manual", entityCollection, entityId, entityName, website,
//                            applicantName, applicantRole, applicantContact, justification,
//                            requesterUid }

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { admin, adminDb } = require('./_lib/firebase-admin');

const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const SEED_UID = 'nave_system';
const REVIEW_RECIPIENTS = ['oliver@catholicnave.com', 'mychal@catholicnave.com'];

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
  return String(100000 + crypto.randomInt(900000));
}

function codeDocId(entityCollection, entityId) {
  return `${entityCollection}__${entityId}`;
}

// ----- send -----
async function handleSend(body, res) {
  const { entityCollection, entityId, entityName, email, website, requesterUid } = body;
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
    console.error('[activation/send] error:', err);
    return res.status(500).json({ error: 'Failed to send code', message: err.message });
  }
}

// ----- verify -----
async function handleVerify(body, res) {
  const { entityCollection, entityId, email, code, requesterUid } = body;
  if (!entityCollection || !entityId || !email || !code) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!requesterUid) {
    return res.status(401).json({ error: 'Sign in required to activate' });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const submittedCode = String(code).trim();

  try {
    const codeRef = adminDb.collection('activationCodes').doc(codeDocId(entityCollection, entityId));
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) {
      return res.status(400).json({ error: 'No active code for this listing. Request a new one.' });
    }
    const data = codeSnap.data();

    if (data.consumed) {
      return res.status(400).json({ error: 'Code already used. Request a new one if you need to re-verify.' });
    }
    if (data.email !== cleanEmail) {
      return res.status(400).json({ error: 'Email does not match the address the code was sent to.' });
    }
    const expiresMs = data.expiresAt && data.expiresAt.toMillis ? data.expiresAt.toMillis() : 0;
    if (Date.now() > expiresMs) {
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    }
    if ((data.attempts || 0) >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }

    if (data.code !== submittedCode) {
      await codeRef.update({ attempts: admin.firestore.FieldValue.increment(1) });
      const remaining = MAX_ATTEMPTS - ((data.attempts || 0) + 1);
      return res.status(400).json({
        error: remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'Incorrect code. No attempts remaining — request a new code.',
      });
    }

    const entityRef = adminDb.collection(entityCollection).doc(entityId);
    const entitySnap = await entityRef.get();
    if (!entitySnap.exists) {
      return res.status(404).json({ error: 'Listing no longer exists.' });
    }
    const entity = entitySnap.data();
    const currentOwner = entity.createdByUserId || null;
    const discoveredFlag = entity.naveDiscoveredOverride === true;
    const isNaveDiscovered = discoveredFlag || currentOwner === SEED_UID;
    if (!isNaveDiscovered) {
      return res.status(409).json({ error: 'This listing is already activated and cannot be claimed this way.' });
    }

    await entityRef.set({
      createdByUserId: requesterUid,
      ownerUserId: requesterUid,
      naveDiscoveredOverride: false,
      isNaveDiscovered: false,
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      activatedByEmail: cleanEmail,
      previousOwnerUid: currentOwner,
    }, { merge: true });

    await codeRef.update({
      consumed: true,
      consumedAt: admin.firestore.FieldValue.serverTimestamp(),
      consumedByUid: requesterUid,
    });

    await adminDb.collection('activationLog').add({
      entityCollection,
      entityId,
      entityName: data.entityName || null,
      newOwnerUid: requesterUid,
      previousOwnerUid: currentOwner,
      verifiedEmail: cleanEmail,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[activation/verify] error:', err);
    return res.status(500).json({ error: 'Verification failed', message: err.message });
  }
}

// ----- manual -----
async function handleManual(body, res) {
  const {
    entityCollection, entityId, entityName, website,
    applicantName, applicantRole, applicantContact, justification,
    requesterUid,
  } = body;

  if (!entityCollection || !entityId
      || !applicantName || !applicantRole || !applicantContact || !justification) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const docRef = await adminDb.collection('manualActivationRequests').add({
      entityCollection,
      entityId,
      entityName: entityName || null,
      website: website || null,
      applicantName,
      applicantRole,
      applicantContact,
      justification,
      requesterUid: requesterUid || null,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      try {
        const transporter = getTransporter();
        await transporter.sendMail({
          from: `Nave Activations <${process.env.GMAIL_USER}>`,
          to: REVIEW_RECIPIENTS.join(', '),
          subject: `Manual activation request: ${entityName || entityId}`,
          text: [
            `A new manual activation application was submitted on Nave.`,
            ``,
            `Listing:     ${entityName || '(no name)'}`,
            `Collection:  ${entityCollection}`,
            `Listing ID:  ${entityId}`,
            `Website:     ${website || '(none provided)'}`,
            ``,
            `Applicant:   ${applicantName}`,
            `Role:        ${applicantRole}`,
            `Contact:     ${applicantContact}`,
            `User UID:    ${requesterUid || '(unauthenticated)'}`,
            ``,
            `Why they say they can represent this institution:`,
            justification,
            ``,
            `Review in Firestore: manualActivationRequests/${docRef.id}`,
          ].join('\n'),
        });
      } catch (e) {
        console.error('[activation/manual] email send failed:', e.message);
      }
    }

    return res.status(200).json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error('[activation/manual] error:', err);
    return res.status(500).json({ error: 'Failed to submit', message: err.message });
  }
}

// ----- dispatcher -----
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = req.body || {};
  // Action comes from the request body (new clients) OR the rewritten URL's
  // query string (old iOS binaries calling the legacy paths via the
  // vercel.json rewrites). Body wins if both are present.
  const action = body.action || (req.query && req.query.action);
  switch (action) {
    case 'send':   return handleSend(body, res);
    case 'verify': return handleVerify(body, res);
    case 'manual': return handleManual(body, res);
    default:
      return res.status(400).json({ error: 'Missing or unknown `action` (expected: send | verify | manual)' });
  }
};
