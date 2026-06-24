// Posts-feed ingest. Reads active `feedSources`, routes each by `kind` to the
// right parser + collection, and upserts (by slug id) with the source's
// denormalized publisher fields:
//   articles -> RSS/Atom (or JSON-LD Article)  -> feedPosts (type:"article")
//   events   -> iCal (or schema.org Event)      -> feedEvents
//   jobs     -> schema.org JobPosting           -> feedRecruitment
// Each source is processed in its own try/catch so one bad feed can't fail the
// run. Reachable at /api/ingest-feed (vercel.json rewrite) — GET (cron) or POST.

const { admin, adminDb } = require('../firebase-admin');
const TS = admin.firestore.Timestamp;
const FieldValue = admin.firestore.FieldValue;

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110);
const MAX_PER_SOURCE = 30;
// Rolling window: only auto-ingest blog posts published within this many days,
// and hide auto-ingested posts once they age past it. Curated seed posts
// (source:"seed") are never aged out. Events/jobs have their own lifecycle.
const MAX_AGE_DAYS = 30;

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NaveFeedBot/1.0 (+https://catholicnave.com)', Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const decode = (s) => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? m[1] : '';
};
const attr = (block, name, a) => {
  const m = block.match(new RegExp(`<${name}[^>]*\\b${a}=["']([^"']+)["']`, 'i'));
  return m ? m[1] : '';
};

function excerpt(text, words = 60) {
  const w = decode(text).split(' ');
  return w.length <= words ? w.join(' ') : w.slice(0, words).join(' ') + '…';
}
function readingTime(text) {
  const n = decode(text).split(' ').filter(Boolean).length;
  return n ? `${Math.max(1, Math.round(n / 200))} min read` : '';
}

// ── Parsers ────────────────────────────────────────────────────────────────

function parseRSS(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const title = decode(tag(b, 'title'));
    const link = isAtom ? (attr(b, 'link', 'href') || decode(tag(b, 'id'))) : decode(tag(b, 'link'));
    const content = tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary');
    const dateStr = decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const image = attr(b, 'enclosure', 'url') || attr(b, 'media:content', 'url') ||
      attr(b, 'media:thumbnail', 'url') || (content.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || null;
    return { title, link, body: excerpt(content), readingTime: readingTime(content),
      publishedAt: dateStr ? new Date(dateStr) : null, image };
  }).filter((x) => x.title && x.link);
}

// Pulls all schema.org JSON-LD objects of a given @type from an HTML page.
function parseJSONLD(html, type) {
  const out = [];
  const scripts = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const s of scripts) {
    const json = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(json); } catch { continue; }
    const arr = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
    for (const node of arr) {
      const t = node && node['@type'];
      const types = Array.isArray(t) ? t : [t];
      if (types.includes(type)) out.push(node);
    }
  }
  return out;
}

function parseICal(text) {
  if (!/BEGIN:VCALENDAR/i.test(text)) return [];
  const unfold = text.replace(/\r?\n[ \t]/g, '');
  const blocks = unfold.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) || [];
  const get = (b, k) => { const m = b.match(new RegExp(`^${k}[^:]*:(.*)$`, 'im')); return m ? m[1].trim() : ''; };
  const dt = (v) => {
    if (!v) return null;
    const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  };
  return blocks.map((b) => ({
    title: get(b, 'SUMMARY'), start: dt(get(b, 'DTSTART')), end: dt(get(b, 'DTEND')),
    location: get(b, 'LOCATION'), url: get(b, 'URL'),
  })).filter((e) => e.title && e.start);
}

const monthLabel = (d) => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';

// ── Per-kind ingest ──────────────────────────────────────────────────────

function pubFields(src) {
  return {
    publisherName: src.publisherName, publisherAccentHex: src.publisherAccentHex,
    publisherSymbol: src.publisherSymbol, publisherLogoURL: src.publisherLogoURL || null,
    publisherId: src.publisherId || null, category: src.defaultCategory || 'mission', isActive: true,
  };
}

async function ingestArticles(src, batch) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const xml = await fetchText(src.feedURL);
  let items = parseRSS(xml);
  if (!items.length) {
    items = parseJSONLD(xml, 'BlogPosting').concat(parseJSONLD(xml, 'NewsArticle'), parseJSONLD(xml, 'Article'))
      .map((n) => ({ title: decode(n.headline || n.name || ''), link: n.url || n.mainEntityOfPage || '',
        body: excerpt(n.description || n.articleBody || ''), readingTime: '',
        publishedAt: n.datePublished ? new Date(n.datePublished) : null,
        image: (n.image && (n.image.url || (Array.isArray(n.image) ? n.image[0] : n.image))) || null }))
      .filter((x) => x.title && x.link);
  }
  // Only keep posts published within the last MAX_AGE_DAYS (undated items pass —
  // they're almost always the newest entries).
  items = items.filter((it) => !it.publishedAt || it.publishedAt.getTime() >= cutoff);
  let n = 0;
  for (const it of items.slice(0, MAX_PER_SOURCE)) {
    const id = slug(`${src.publisherName}-${it.link}`);
    batch.set(adminDb.collection('feedPosts').doc(id), {
      ...pubFields(src), type: 'article', source: 'rss', featured: false,
      title: it.title, deck: '', author: src.publisherName, dateLabel: monthLabel(it.publishedAt),
      imageURL: it.image || null, body: it.body, sourceURL: it.link, readingTime: it.readingTime,
      publishedAt: it.publishedAt ? TS.fromDate(it.publishedAt) : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    n++;
  }
  // Roll the window forward: hide auto-ingested posts that have aged past the cutoff.
  const existing = await adminDb.collection('feedPosts').where('publisherName', '==', src.publisherName).get();
  existing.docs.forEach((d) => {
    const x = d.data();
    const pub = x.publishedAt && x.publishedAt.toMillis ? x.publishedAt.toMillis() : null;
    if (x.source === 'rss' && x.isActive !== false && pub !== null && pub < cutoff) {
      batch.update(d.ref, { isActive: false, updatedAt: FieldValue.serverTimestamp() });
    }
  });
  return n;
}

async function ingestEvents(src, batch) {
  const text = await fetchText(src.feedURL);
  let events = parseICal(text);
  if (!events.length) {
    events = parseJSONLD(text, 'Event').map((n) => ({
      title: decode(n.name || ''), start: n.startDate ? new Date(n.startDate) : null,
      end: n.endDate ? new Date(n.endDate) : null,
      location: decode(typeof n.location === 'object' ? (n.location.name || n.location.address?.addressLocality || '') : (n.location || '')),
      url: n.url || '' })).filter((e) => e.title && e.start);
  }
  const now = Date.now();
  let n = 0;
  for (const ev of events.slice(0, MAX_PER_SOURCE)) {
    if (ev.start && ev.start.getTime() < now - 86400000) continue; // skip past
    const id = slug(`${src.publisherName}-${ev.title}`);
    batch.set(adminDb.collection('feedEvents').doc(id), {
      ...pubFields(src), source: 'ical', title: ev.title,
      startDate: ev.start ? TS.fromDate(ev.start) : null, endDate: ev.end ? TS.fromDate(ev.end) : null,
      dateLabel: monthLabel(ev.start), location: ev.location || '', registrationURL: ev.url || src.feedURL,
      updatedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    n++;
  }
  return n;
}

async function ingestJobs(src, batch) {
  const html = await fetchText(src.feedURL);
  const jobs = parseJSONLD(html, 'JobPosting');
  let n = 0;
  for (const j of jobs.slice(0, MAX_PER_SOURCE)) {
    const role = decode(j.title || j.name || '');
    if (!role) continue;
    const id = slug(`${src.publisherName}-${role}`);
    batch.set(adminDb.collection('feedRecruitment').doc(id), {
      ...pubFields(src), source: 'jobs', role, blurb: excerpt(j.description || '', 40), cta: 'Apply Now',
      applyURL: j.url || j.applicationContact?.url || src.feedURL,
      postedAt: j.datePostedRaw || j.datePosted ? TS.fromDate(new Date(j.datePosted)) : FieldValue.serverTimestamp(),
      closesAt: j.validThrough ? TS.fromDate(new Date(j.validThrough)) : null,
      updatedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    n++;
  }
  return n;
}

const ROUTES = { articles: ingestArticles, events: ingestEvents, jobs: ingestJobs };
const KIND_COLLECTION = { articles: 'feedPosts', events: 'feedEvents', jobs: 'feedRecruitment' };

// A source's `active` flag is the on/off switch for that publisher's auto-feed.
// When OFF we also hide everything auto-ingested for that publisher in the
// matching collection (historical off). Curated seed (source:"seed") is left
// alone — it's deliberate and orthogonal to the auto-feed. Flipping back ON
// re-ingests, and the merge re-activates current items.
async function deactivatePublisher(src, batch) {
  const coll = KIND_COLLECTION[src.kind];
  if (!coll) return 0;
  const q = await adminDb.collection(coll).where('publisherName', '==', src.publisherName).get();
  let n = 0;
  q.docs.forEach((d) => {
    const x = d.data();
    if (x.source !== 'seed' && x.isActive !== false) {
      batch.update(d.ref, { isActive: false, updatedAt: FieldValue.serverTimestamp() });
      n++;
    }
  });
  return n;
}

module.exports = async (req, res) => {
  try {
    const snap = await adminDb.collection('feedSources').get();
    const batch = adminDb.batch();
    const results = [];
    for (const doc of snap.docs) {
      const src = doc.data();
      if (src.active === false) {
        try {
          const off = await deactivatePublisher(src, batch);
          results.push({ source: doc.id, kind: src.kind, active: false, deactivated: off });
        } catch (err) {
          results.push({ source: doc.id, kind: src.kind, error: err.message });
        }
        continue;
      }
      const run = ROUTES[src.kind];
      if (!run) { results.push({ source: doc.id, kind: src.kind, error: 'unknown kind' }); continue; }
      try {
        const count = await run(src, batch);
        results.push({ source: doc.id, kind: src.kind, ingested: count });
      } catch (err) {
        results.push({ source: doc.id, kind: src.kind, error: err.message });
      }
    }
    await batch.commit();
    const total = results.reduce((a, r) => a + (r.ingested || 0), 0);
    const deactivated = results.reduce((a, r) => a + (r.deactivated || 0), 0);
    console.log(`ingest-feed: +${total} ingested, -${deactivated} hidden, ${snap.size} sources`);
    res.status(200).json({ ok: true, total, deactivated, sources: snap.size, results });
  } catch (err) {
    console.error('ingest-feed failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
