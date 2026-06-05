// POST /api/submit-manual-activation
// Body: { entityCollection, entityId, entityName, website, applicantName,
//         applicantRole, applicantContact, justification, requesterUid }
//
// Fallback path for the "Discovered by Nave" activation flow. Used when
// the applicant doesn't have an email on the institution's website domain
// (so the 2FA loop can't run). We store the application in
// `manualActivationRequests` for human review and email the team so
// they see it.

const nodemailer = require('nodemailer');
const { admin, adminDb } = require('./_lib/firebase-admin');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const {
    entityCollection, entityId, entityName, website,
    applicantName, applicantRole, applicantContact, justification,
    requesterUid,
  } = req.body || {};

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

    // Best-effort email — if the SMTP send fails we still keep the Firestore
    // record, so the application isn't lost.
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      const transporter = getTransporter();
      const subject = `Manual activation request: ${entityName || entityId}`;
      const text = [
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
      ].join('\n');
      try {
        await transporter.sendMail({
          from: `Nave Activations <${process.env.GMAIL_USER}>`,
          to: REVIEW_RECIPIENTS.join(', '),
          subject,
          text,
        });
      } catch (e) {
        console.error('[submit-manual-activation] email send failed:', e.message);
      }
    }

    return res.status(200).json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error('[submit-manual-activation] error:', err);
    return res.status(500).json({ error: 'Failed to submit', message: err.message });
  }
};
