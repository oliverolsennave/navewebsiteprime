// Internal admin analytics dashboard endpoint.
// Aggregates user list, parish keys, apostolates, and Ask-Gabe questions
// for the /dashboard page. Server-side gated by a shared password.
//
// Configure the password by setting DASHBOARD_PASSWORD on Vercel; falls
// back to "thenavepassword" if unset (DO NOT ship to prod without setting
// the env var — the fallback is for first-deploy only).

const { adminDb, adminAuth } = require('./_lib/firebase-admin');

const FALLBACK_PASSWORD = 'thenavepassword';

function unauthorized(res) {
  // Constant-time delay to soften (not eliminate) password-guessing
  return new Promise((resolve) => {
    setTimeout(() => {
      res.status(401).json({ error: 'Unauthorized' });
      resolve();
    }, 400);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.DASHBOARD_PASSWORD || FALLBACK_PASSWORD;
  const provided = req.headers['x-dashboard-password'] || (req.body && req.body.password) || '';
  if (provided !== expected) return unauthorized(res);

  try {
    // ---------- Users: Auth as source of truth, hydrate from Firestore
    const authUsers = [];
    let pageToken = undefined;
    do {
      const page = await adminAuth.listUsers(1000, pageToken);
      authUsers.push(...page.users);
      pageToken = page.pageToken;
    } while (pageToken);

    const userDocs = await Promise.all(
      authUsers.map((u) => adminDb.collection('users').doc(u.uid).get())
    );
    const userDocByUid = {};
    userDocs.forEach((d) => { userDocByUid[d.id] = d.exists ? d.data() : {}; });

    const users = authUsers
      .map((u) => {
        const d = userDocByUid[u.uid] || {};
        const fsName = [d.firstName, d.lastName].filter(Boolean).join(' ').trim();
        const displayName = (u.displayName || fsName || d.username || '').trim();
        return {
          uid: u.uid,
          displayName: displayName || null,
          username: d.username || null,
          email: u.email || null,
          photoURL: u.photoURL || d.photoURL || null,
          createdAt: u.metadata.creationTime,
          lastSignInAt: u.metadata.lastSignInTime || null,
          hasHomeParish: Boolean(d.homeParishId),
          homeParishId: d.homeParishId || null,
          isAnonymous: u.providerData.length === 0,
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const userNameByUid = {};
    users.forEach((u) => { userNameByUid[u.uid] = u.displayName || u.username || u.email || u.uid; });

    // ---------- Keys: user_subscriptions docs, flatten activatedParishes
    const subsSnap = await adminDb.collection('user_subscriptions').get();
    const keys = [];
    const parishIdsNeeded = new Set();
    subsSnap.docs.forEach((s) => {
      const x = s.data();
      const parishIds = Array.isArray(x.activatedParishes) ? x.activatedParishes : [];
      const createdAt = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : null;
      parishIds.forEach((pid) => {
        // Skip falsy / non-string parish ids — production data has some
        // empty entries that crash Firestore's .doc() validator.
        if (typeof pid !== 'string' || !pid.trim()) return;
        parishIdsNeeded.add(pid);
        keys.push({
          parishId: pid,
          parishName: null, // hydrate below
          subscriptionId: x.subscriptionId || s.id,
          ownerUid: x.userId || null,
          ownerName: x.userId ? (userNameByUid[x.userId] || null) : null,
          ownerUsername: x.userId ? ((userDocByUid[x.userId] || {}).username || null) : null,
          isActive: x.isActive !== false,
          createdAt,
          expiresAt: x.expiresAt && x.expiresAt.toDate ? x.expiresAt.toDate().toISOString() : null,
        });
      });
    });
    // Hydrate parish names from Churches collection (id-aligned with parishesprime)
    const parishNameById = {};
    await Promise.all(
      Array.from(parishIdsNeeded).map(async (pid) => {
        try {
          const doc = await adminDb.collection('Churches').doc(pid).get();
          if (doc.exists) parishNameById[pid] = doc.data().name || null;
        } catch (e) {
          // Skip individual lookup failures so one bad id can't 500 the whole dashboard
        }
      })
    );
    keys.forEach((k) => { k.parishName = parishNameById[k.parishId] || null; });
    keys.sort((a, b) => {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // ---------- Apostolates
    const orgsSnap = await adminDb.collection('organizations').get();
    const apostolates = orgsSnap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        name: x.name,
        type: x.type || null,
        memberCount: x.memberCount || 0,
        followerCount: x.followerCount || 0,
        isPublic: x.isPublic === true,
        featuredOrder: x.featuredOrder || null,
        ownerUid: x.ownerUserId || null,
        ownerName: x.ownerUserId ? (userNameByUid[x.ownerUserId] || null) : null,
        ownerUsername: x.ownerUserId ? ((userDocByUid[x.ownerUserId] || {}).username || null) : null,
        createdAt: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : null,
      };
    }).sort((a, b) => {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    // ---------- Ask Gabe questions: flatten user messages across all chats
    const chatsSnap = await adminDb.collection('unified_intelligencia_chats').get();
    const gabeQuestions = [];
    chatsSnap.docs.forEach((d) => {
      const x = d.data();
      const msgs = Array.isArray(x.messages) ? x.messages : [];
      const uid = x.userId || null;
      msgs.forEach((m) => {
        if (!m || m.role !== 'user') return;
        const ts = m.timestamp && m.timestamp.toDate ? m.timestamp.toDate().toISOString() :
                   (typeof m.timestamp === 'string' ? m.timestamp : null);
        gabeQuestions.push({
          chatId: d.id,
          userId: uid,
          userName: uid ? (userNameByUid[uid] || null) : null,
          userUsername: uid ? ((userDocByUid[uid] || {}).username || null) : null,
          question: String(m.content || '').slice(0, 800),
          timestamp: ts,
        });
      });
    });
    gabeQuestions.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      stats: {
        totalUsers: users.length,
        usersWithHomeParish: users.filter((u) => u.hasHomeParish).length,
        totalKeys: keys.length,
        totalApostolates: apostolates.length,
        totalGabeQuestions: gabeQuestions.length,
      },
      users,
      keys,
      apostolates,
      gabeQuestions,
    });
  } catch (err) {
    console.error('[dashboard-data] error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};
