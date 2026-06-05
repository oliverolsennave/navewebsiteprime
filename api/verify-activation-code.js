// POST /api/verify-activation-code
// Body: { entityCollection, entityId, email, code, requesterUid }
//
// Step 2 of the "Discovered by Nave" activation flow. Validates the
// 6-digit code stored by /api/send-activation-code; on success, transfers
// ownership of the entity from the seed `nave_system` UID to the
// requesting user — this flips `NaveOwnership.isDiscovered(...)` to false
// on the iOS side, hiding the "Discovered by Nave" card and unlocking
// editing for the new owner.
//
// Limits: 5 wrong attempts per code, 15-minute expiry (set when the code
// was issued).

const { admin, adminDb } = require('./_lib/firebase-admin');

const MAX_ATTEMPTS = 5;
const SEED_UID = 'nave_system';

function codeDocId(entityCollection, entityId) {
  return `${entityCollection}__${entityId}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { entityCollection, entityId, email, code, requesterUid } = req.body || {};
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

    // Code is valid — transfer ownership on the entity doc.
    const entityRef = adminDb.collection(entityCollection).doc(entityId);
    const entitySnap = await entityRef.get();
    if (!entitySnap.exists) {
      return res.status(404).json({ error: 'Listing no longer exists.' });
    }
    const entity = entitySnap.data();
    // Refuse to "transfer" something that isn't actually nave-seeded — the
    // activation flow shouldn't be a backdoor to claim already-owned keys.
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
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      activatedByEmail: cleanEmail,
      previousOwnerUid: currentOwner,
    }, { merge: true });

    // Mark the code consumed so it can't be replayed.
    await codeRef.update({
      consumed: true,
      consumedAt: admin.firestore.FieldValue.serverTimestamp(),
      consumedByUid: requesterUid,
    });

    // Audit log entry for "who claimed what, when".
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
    console.error('[verify-activation-code] error:', err);
    return res.status(500).json({ error: 'Verification failed', message: err.message });
  }
};
