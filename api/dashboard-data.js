// Internal admin analytics dashboard endpoint.
// Aggregates user list, parish keys, apostolates, and Ask-Gabe questions
// for the /dashboard page. Server-side gated by a shared password.
//
// Configure the password by setting DASHBOARD_PASSWORD on Vercel; falls
// back to "thenavepassword" if unset (DO NOT ship to prod without setting
// the env var — the fallback is for first-deploy only).

const { admin, adminDb, adminAuth } = require('./_lib/firebase-admin');

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
    // Only count Auth accounts that also have a Firestore /users/{uid} doc.
    // Without this, dashboard shows orphaned Auth records (test accounts you
    // deleted the Firestore doc for, signups that didn't complete, etc.) that
    // never appear in Discover. Match Discover's source-of-truth.
    const userDocByUid = {};
    userDocs.forEach((d) => { if (d.exists) userDocByUid[d.id] = d.data(); });

    const users = authUsers
      .filter((u) => userDocByUid[u.uid] !== undefined)
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

    // ---------- Keys: every parishesprime doc with isUnlocked==true.
    // The original `user_subscriptions.activatedParishes` source was dead
    // (subscription gate is disabled, nothing's writing there). The actual
    // signal for "this parish got a key" is the `isUnlocked` flag flipped
    // by `linkToParish` when a bulletin is published.
    const unlockedSnap = await adminDb.collection('parishesprime')
      .where('isUnlocked', '==', true)
      .get()
      .catch((e) => { console.error('[dashboard-data] unlocked query failed:', e.message); return null; });
    const parishNameById = {}; // also used by bulletin-uploads section below
    const keys = [];
    if (unlockedSnap) {
      unlockedSnap.docs.forEach((d) => {
        const x = d.data();
        parishNameById[d.id] = x.name || null;
        keys.push({
          parishId: d.id,
          parishName: x.name || null,
          subscriptionId: null,
          // Owner attribution — derived from bulletinUploads (published) later
          // in this handler; left null here, patched below once that data is loaded.
          ownerUid: null,
          ownerName: null,
          ownerUsername: null,
          isActive: true,
          createdAt: x.bulletinSubmittedAt && x.bulletinSubmittedAt.toDate ? x.bulletinSubmittedAt.toDate().toISOString() : null,
          expiresAt: null,
        });
      });
      keys.sort((a, b) => {
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
    }

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

    // ---------- App installs: total first-launch pings + last-7-day count
    let installTotal = 0;
    let installLast7 = 0;
    try {
      const totalAgg = await adminDb.collection('appInstalls').count().get();
      installTotal = totalAgg.data().count || 0;
      const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 24 * 3600 * 1000);
      const recentAgg = await adminDb.collection('appInstalls')
        .where('firstLaunchAt', '>=', cutoff)
        .count().get();
      installLast7 = recentAgg.data().count || 0;
    } catch (e) {
      console.error('[dashboard-data] appInstalls count failed:', e.message);
    }

    // ---------- Bulletin uploads: each doc is one extraction session
    const bulletinsSnap = await adminDb.collection('bulletinUploads')
      .orderBy('startedAt', 'desc')
      .limit(500)
      .get()
      .catch(() => null);
    const bulletinUploads = [];
    if (bulletinsSnap && !bulletinsSnap.empty) {
      const missingParishNames = new Set();
      const parishIdsForUrlFallback = new Set();
      bulletinsSnap.docs.forEach((d) => {
        const x = d.data();
        if (x.parishId && !x.parishName) missingParishNames.add(x.parishId);
        // Pre-instrumentation sessions (or upload-in-progress sessions) won't
        // have bulletinURLs on the telemetry doc; we'll fall back to the
        // parishesprime doc's latestBulletinURLs for those.
        if (x.parishId && !Array.isArray(x.bulletinURLs)) parishIdsForUrlFallback.add(x.parishId);
      });
      // Reuse the Churches lookups we already did for keys; only fetch new ids.
      const newParishIds = Array.from(missingParishNames).filter((id) => !(id in parishNameById));
      await Promise.all(newParishIds.map(async (pid) => {
        try {
          const doc = await adminDb.collection('Churches').doc(pid).get();
          if (doc.exists) parishNameById[pid] = doc.data().name || null;
        } catch (e) { /* skip bad ids */ }
      }));
      // Fetch latestBulletinURLs from parishesprime for fallback. Caveat: this
      // is overwritten on each publish, so a historical session for a parish
      // that's been re-published since will show the newer file. Acceptable
      // for v1 until the iOS write lands on every doc.
      const fallbackUrlsByParish = {};
      await Promise.all(Array.from(parishIdsForUrlFallback).map(async (pid) => {
        try {
          const doc = await adminDb.collection('parishesprime').doc(pid).get();
          if (doc.exists) {
            const urls = doc.data().latestBulletinURLs;
            if (Array.isArray(urls) && urls.length) fallbackUrlsByParish[pid] = urls;
          }
        } catch (e) { /* skip */ }
      }));
      // Map of parishId → most-recent published uploader, used to fill in
      // owner names on the keys list since parishesprime doesn't store the
      // owner uid directly (it's in users/{uid}/associations instead).
      const publishedByParish = {};
      bulletinsSnap.docs.forEach((d) => {
        const x = d.data();
        if (x.status === 'published' && x.parishId && x.uploaderUid) {
          // bulletinsSnap is ordered by startedAt desc, so the first hit per
          // parish is the most recent publish — that's the current owner.
          if (!publishedByParish[x.parishId]) publishedByParish[x.parishId] = x.uploaderUid;
        }
      });
      keys.forEach((k) => {
        const ownerUid = publishedByParish[k.parishId];
        if (ownerUid) {
          k.ownerUid = ownerUid;
          k.ownerName = userNameByUid[ownerUid] || null;
          k.ownerUsername = (userDocByUid[ownerUid] || {}).username || null;
        }
      });

      bulletinsSnap.docs.forEach((d) => {
        const x = d.data();
        const uid = x.uploaderUid || null;
        // Only surface URLs for published sessions. Aborted/extracting rows
        // would otherwise show URLs via the parish-doc fallback that don't
        // actually belong to this session.
        const status = x.status || 'unknown';
        const directUrls = Array.isArray(x.bulletinURLs) ? x.bulletinURLs : [];
        const fallbackUrls = (x.parishId ? fallbackUrlsByParish[x.parishId] : null) || [];
        const urls = directUrls.length
          ? directUrls
          : (status === 'published' ? fallbackUrls : []);
        bulletinUploads.push({
          id: d.id,
          uploaderUid: uid,
          uploaderName: uid ? (userNameByUid[uid] || null) : null,
          uploaderUsername: uid ? ((userDocByUid[uid] || {}).username || null) : null,
          parishId: x.parishId || null,
          parishName: x.parishName || (x.parishId ? (parishNameById[x.parishId] || null) : null),
          status: x.status || 'unknown',
          pageCount: x.pageCount || null,
          flow: x.flow || null,
          bulletinURLs: urls,
          startedAt: x.startedAt && x.startedAt.toDate ? x.startedAt.toDate().toISOString() : null,
          finishedAt: x.finishedAt && x.finishedAt.toDate ? x.finishedAt.toDate().toISOString() : null,
        });
      });
    }

    // ---------- Shared time-bucket helpers (used by both messageActivity
    // and the analytics block below).
    const DAYS = 60;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const dayKey = (d) => d.toISOString().slice(0, 10);
    const buildEmptyDays = () => {
      const out = {};
      for (let i = DAYS - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        out[dayKey(d)] = 0;
      }
      return out;
    };
    const windowStartMs = Date.now() - DAYS * 24 * 3600 * 1000;

    // ---------- DM thread activity (user ↔ key/apostolate messaging).
    // Walk `messages_threads` once for object metadata, then pull every
    // message via collectionGroup. Cheap at current scale (~32 messages,
    // grows linearly). Group by day + extract recent + tokenize for top
    // words.
    let messageActivity = { dailySeries: [], topWords: [], recent: [], total: 0 };
    try {
      const threadsSnap = await adminDb.collection('messages_threads').get();
      const threadById = {};
      threadsSnap.docs.forEach((t) => {
        const td = t.data();
        threadById[t.id] = {
          objectType: td.objectType || null,
          objectName: td.objectName || null,
          objectId: td.objectId || null,
        };
      });

      const msgsSnap = await adminDb.collectionGroup('messages').get();
      const dailyMessages = buildEmptyDays();
      const wordCounts = {};
      const STOPWORDS = new Set([
        'the','a','an','and','or','but','if','then','that','this','those','these','to','of','in','on','at','for','from','by','with','as','is','are','was','were','be','been','being','it','its','i','im','me','my','we','our','you','your','yours','he','she','his','her','they','them','their','will','can','could','would','should','have','has','had','do','does','did','not','no','yes','so','just','like','about','what','which','who','how','when','where','why','any','some','all','more','most','one','two','only','also','out','up','down','over','your','okay','ok','hi','hey','hello','thanks','thank','really','please','very','too','than','here','there','now','well',
      ]);

      const recent = [];
      msgsSnap.docs.forEach((m) => {
        const x = m.data();
        messageActivity.total += 1;

        // Thread is the doc above /messages. e.g.
        // messages_threads/{tid}/messages/{mid}
        const threadId = m.ref.parent.parent ? m.ref.parent.parent.id : null;
        const thread = threadId ? threadById[threadId] : null;

        const sentDate = x.sentAt && x.sentAt.toDate ? x.sentAt.toDate() : null;
        if (sentDate && sentDate.getTime() >= windowStartMs) {
          const k = dayKey(sentDate);
          if (k in dailyMessages) dailyMessages[k] += 1;
        }

        const text = typeof x.text === 'string' ? x.text : '';
        if (text) {
          text.toLowerCase()
            .replace(/[^a-z0-9' ]+/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
            .forEach((w) => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
        }

        const senderUid = x.senderId || null;
        const senderUser = senderUid ? userDocByUid[senderUid] : null;
        const senderKind = senderUser ? 'user'
                        : (senderUid ? 'org-or-system'
                        : 'unknown');
        recent.push({
          text: text.slice(0, 240),
          senderId: senderUid,
          senderName: x.senderName || (senderUid ? (userNameByUid[senderUid] || senderUid) : null),
          senderKind,
          objectType: thread ? thread.objectType : null,
          objectName: thread ? thread.objectName : null,
          objectId: thread ? thread.objectId : null,
          sentAt: sentDate ? sentDate.toISOString() : null,
        });
      });
      recent.sort((a, b) => {
        if (!a.sentAt) return 1;
        if (!b.sentAt) return -1;
        return new Date(b.sentAt) - new Date(a.sentAt);
      });

      messageActivity.dailySeries = Object.entries(dailyMessages).map(([date, count]) => ({ date, count }));
      messageActivity.topWords = Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([word, count]) => ({ word, count }));
      messageActivity.recent = recent.slice(0, 50);
    } catch (e) {
      console.error('[messageActivity] failed:', e.message);
    }

    // ---------- Ask Gabe questions + paired Gabe responses.
    // Each chat doc has a `messages[]` array with alternating user/assistant
    // turns. We walk in order and pair each user message with the FIRST
    // assistant message that follows it in the same chat — that's the
    // model's reply to that question. If Gabe never answered (network
    // failure mid-stream), `answer` stays null.
    const chatsSnap = await adminDb.collection('unified_intelligencia_chats').get();
    const gabeQuestions = [];
    const tsToIso = (t) => {
      if (!t) return null;
      if (t.toDate) return t.toDate().toISOString();
      if (typeof t === 'string') return t;
      return null;
    };
    chatsSnap.docs.forEach((d) => {
      const x = d.data();
      const msgs = Array.isArray(x.messages) ? x.messages : [];
      const uid = x.userId || null;
      msgs.forEach((m, idx) => {
        if (!m || m.role !== 'user') return;
        // Look ahead for the next assistant turn within this chat.
        let answer = null;
        let answerTimestamp = null;
        for (let j = idx + 1; j < msgs.length; j++) {
          const next = msgs[j];
          if (next && next.role === 'assistant') {
            answer = String(next.content || '').slice(0, 1200);
            answerTimestamp = tsToIso(next.timestamp);
            break;
          }
          // If we hit the next user message before finding an assistant,
          // this question went unanswered.
          if (next && next.role === 'user') break;
        }
        gabeQuestions.push({
          chatId: d.id,
          userId: uid,
          userName: uid ? (userNameByUid[uid] || null) : null,
          userUsername: uid ? ((userDocByUid[uid] || {}).username || null) : null,
          question: String(m.content || '').slice(0, 800),
          answer,
          answerTimestamp,
          timestamp: tsToIso(m.timestamp),
        });
      });
    });
    gabeQuestions.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    // ---------- Recent key uploads across every submission type.
    // Each of the 7 user-submittable entity collections has a
    // `createdByUserId` + a `createdAt`; we pull the newest from each in
    // parallel, plus parish unlocks (which don't live in a user-submitted
    // collection — the signal is parishesprime.bulletinSubmittedAt), then
    // merge into one chronological feed.
    const recentKeyConfigs = [
      { collection: 'businesses',       type: 'Business',   nameField: 'name'  },
      { collection: 'schools',          type: 'School',     nameField: 'name'  },
      { collection: 'pilgrimageSites',  type: 'Pilgrimage', nameField: 'name'  },
      { collection: 'retreats',         type: 'Retreat',    nameField: 'name', altNameField: 'title' },
      { collection: 'vocations',        type: 'Vocation',   nameField: 'title' },
      { collection: 'missionaries',     type: 'Missionary', nameField: 'name'  },
      { collection: 'bibleStudies',     type: 'Campus',     nameField: 'title' },
    ];
    let recentKeys = [];
    await Promise.all(recentKeyConfigs.map(async (cfg) => {
      try {
        const snap = await adminDb.collection(cfg.collection)
          .orderBy('createdAt', 'desc')
          .limit(50)
          .get();
        snap.docs.forEach((d) => {
          const x = d.data();
          const uid = x.createdByUserId || null;
          const created = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : null;
          recentKeys.push({
            type: cfg.type,
            id: d.id,
            name: x[cfg.nameField] || (cfg.altNameField ? x[cfg.altNameField] : null) || '(unnamed)',
            ownerUid: uid,
            ownerName: uid ? (userNameByUid[uid] || null) : null,
            ownerUsername: uid ? ((userDocByUid[uid] || {}).username || null) : null,
            createdAt: created,
          });
        });
      } catch (e) {
        console.error(`[recentKeys] ${cfg.collection} failed:`, e.message);
      }
    }));
    // Add parish unlocks (already loaded into `keys` above).
    keys.forEach((k) => {
      recentKeys.push({
        type: 'Parish',
        id: k.parishId,
        name: k.parishName || '(unnamed)',
        ownerUid: k.ownerUid,
        ownerName: k.ownerName,
        ownerUsername: k.ownerUsername,
        createdAt: k.createdAt,
      });
    });
    recentKeys.sort((a, b) => {
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    recentKeys = recentKeys.slice(0, 100);

    // ===========================================================
    // ANALYTICS — time-series + funnel data for the dashboard charts
    // ===========================================================
    // (DAYS / dayKey / buildEmptyDays / windowStartMs declared above the
    // messageActivity block since both sections use them.)

    // 1. Daily new users (signups inside the window).
    // `u.createdAt` is Firebase Auth's RFC2822 creationTime string
    // ("Sat, 25 Oct 2025 01:23:11 GMT"), not ISO — slicing the raw string
    // produces garbage. Reformat through Date → ISO before bucketing.
    const dailyUsers = buildEmptyDays();
    users.forEach((u) => {
      if (!u.createdAt) return;
      const d = new Date(u.createdAt);
      if (isNaN(d.getTime()) || d.getTime() < windowStartMs) return;
      const k = dayKey(d);
      if (k in dailyUsers) dailyUsers[k] += 1;
    });

    // 2. Daily new installs (first-launch pings).
    const dailyInstalls = buildEmptyDays();
    try {
      const cutoffTs = admin.firestore.Timestamp.fromMillis(windowStartMs);
      const recentInstallsSnap = await adminDb.collection('appInstalls')
        .where('firstLaunchAt', '>=', cutoffTs).get();
      recentInstallsSnap.docs.forEach((d) => {
        const ts = d.data().firstLaunchAt;
        if (!ts || !ts.toDate) return;
        const k = dayKey(ts.toDate());
        if (k in dailyInstalls) dailyInstalls[k] += 1;
      });
    } catch (e) { console.error('[analytics] installs by day failed:', e.message); }

    // 3. Bulletin outcomes by day — stacked by status.
    const bulletinByDay = {};
    Object.keys(dailyUsers).forEach((k) => { bulletinByDay[k] = { published: 0, aborted: 0, extracting: 0 }; });
    bulletinUploads.forEach((b) => {
      if (!b.startedAt) return;
      const t = new Date(b.startedAt).getTime();
      if (t < windowStartMs) return;
      const k = b.startedAt.slice(0, 10);
      if (!(k in bulletinByDay)) return;
      const bucket = b.status === 'published' ? 'published'
        : b.status === 'aborted' ? 'aborted'
        : 'extracting';
      bulletinByDay[k][bucket] += 1;
    });

    // 4. Onboarding funnel: install → signup → home parish → activity.
    // "Activity" = uid appears as a bulletin uploader, a Gabe chat user,
    // or an organization member.
    const activityUids = new Set();
    bulletinUploads.forEach((b) => { if (b.uploaderUid) activityUids.add(b.uploaderUid); });
    gabeQuestions.forEach((g) => { if (g.userId) activityUids.add(g.userId); });
    try {
      const membersSnap = await adminDb.collection('organizationMembers').get();
      membersSnap.docs.forEach((m) => {
        const uid = m.data().userId;
        if (uid) activityUids.add(uid);
      });
    } catch (e) { console.error('[analytics] org members fetch failed:', e.message); }

    // Stage order is install → signup → first action → home parish
    // (home parish is a *stricter* subset of "first action" since setting
    // it requires opening the app and tapping through the home-parish
    // picker, which already counts as activity). The funnel renders in
    // that order downstream.
    //
    // Floor installs at the signup count: install tracking only began
    // shipping with iOS 1.1.2, so historical signups have no install
    // record. Every signup logically implies at least one install, so
    // surfacing a lower number would mis-attribute drop-off to the
    // wrong stage.
    const rawSignups = users.length;
    const funnel = {
      installs: Math.max(installTotal, rawSignups),
      signups: rawSignups,
      withActivity: users.filter((u) => activityUids.has(u.uid)).length,
      withHomeParish: users.filter((u) => u.hasHomeParish).length,
    };

    // 5. Apostolate engagement — cumulative follower growth per public org
    // over the 60-day window. Sparkline-friendly: each org gets a series.
    const apostolateSeries = [];
    const publicApos = apostolates.filter((a) => a.isPublic === true);
    try {
      const orgFollowersByOrg = {};
      const followersSnap = await adminDb.collection('organizationFollowers').get();
      followersSnap.docs.forEach((f) => {
        const x = f.data();
        const orgId = x.organizationId;
        if (!orgId) return;
        if (!orgFollowersByOrg[orgId]) orgFollowersByOrg[orgId] = [];
        const ts = x.followedAt;
        const date = ts && ts.toDate ? ts.toDate() : null;
        if (date) orgFollowersByOrg[orgId].push(date);
      });
      publicApos.forEach((apo) => {
        const dates = orgFollowersByOrg[apo.id] || [];
        const series = buildEmptyDays();
        let cumulative = 0;
        // Count joins before the window to seed cumulative.
        dates.forEach((d) => { if (d.getTime() < windowStartMs) cumulative += 1; });
        const seriesEntries = Object.keys(series);
        // For each day in order, count joins on that day, accumulate.
        seriesEntries.forEach((k) => {
          const dayJoins = dates.filter((d) => dayKey(d) === k).length;
          cumulative += dayJoins;
          series[k] = cumulative;
        });
        apostolateSeries.push({
          id: apo.id,
          name: apo.name,
          totalFollowers: apo.followerCount || 0,
          points: seriesEntries.map((k) => ({ date: k, value: series[k] })),
        });
      });
    } catch (e) { console.error('[analytics] org followers fetch failed:', e.message); }

    // 6. Top Gabe questions — at small scale, show top 15 verbatim
    // (most-recent across all chats) instead of word frequency, which is
    // noisy without stopword work.
    const topGabeQuestions = gabeQuestions
      .slice(0, 15)
      .map((q) => ({
        question: q.question,
        answer: q.answer,
        userName: q.userName,
        timestamp: q.timestamp,
      }));

    const analytics = {
      windowDays: DAYS,
      dailyUsers: Object.entries(dailyUsers).map(([date, count]) => ({ date, count })),
      dailyInstalls: Object.entries(dailyInstalls).map(([date, count]) => ({ date, count })),
      bulletinByDay: Object.entries(bulletinByDay).map(([date, v]) => ({ date, ...v })),
      funnel,
      apostolateSeries,
      topGabeQuestions,
      dailyMessages: messageActivity.dailySeries,
      topMessageWords: messageActivity.topWords,
    };

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      stats: {
        totalUsers: users.length,
        usersWithHomeParish: users.filter((u) => u.hasHomeParish).length,
        totalKeys: keys.length,
        totalApostolates: apostolates.filter((a) => a.isPublic === true).length,
        totalGabeQuestions: gabeQuestions.length,
        totalBulletinUploads: bulletinUploads.length,
        bulletinPublished: bulletinUploads.filter((b) => b.status === 'published').length,
        bulletinAborted: bulletinUploads.filter((b) => b.status === 'aborted').length,
        totalInstalls: installTotal,
        installsLast7Days: installLast7,
        totalMessages: messageActivity.total,
      },
      users,
      keys,
      recentKeys,
      apostolates,
      gabeQuestions,
      bulletinUploads,
      messages: messageActivity.recent,
      analytics,
    });
  } catch (err) {
    console.error('[dashboard-data] error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};
