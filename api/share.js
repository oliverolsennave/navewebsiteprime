// Shared share-page generator for catholicnave.com universal links.
//
// Vercel rewrites (see vercel.json):
//   /apostolate/:id      → /api/share?type=apostolate&id=:id
//   /parish/:id          → /api/share?type=parish&id=:id
//   /business/:id        → /api/share?type=business&id=:id
//   /school/:id          → /api/share?type=school&id=:id
//   /campusministry/:id  → /api/share?type=campusministry&id=:id
//   /vocation/:id        → /api/share?type=vocation&id=:id
//   /retreat/:id         → /api/share?type=retreat&id=:id
//   /missionary/:id      → /api/share?type=missionary&id=:id
//   /pilgrimage/:id      → /api/share?type=pilgrimage&id=:id
//
// What it renders:
//   1. <head> with OpenGraph + Twitter card meta tags so iMessage,
//      Slack, Twitter, Mail, etc. show a rich preview card.
//   2. <body> with a minimal landing page that auto-deep-links into
//      the iOS app via the matching `https://catholicnave.com/...`
//      URL (universal-link routing) and falls back to a "Get the
//      app" CTA when the visitor is on web/desktop or the app
//      isn't installed.
//
// The path map is the source of truth shared with `iOS/NaveShareLink.swift`
// and `.well-known/apple-app-site-association`. Keep all three in sync
// when adding or renaming a key type.

const { adminDb } = require('./_lib/firebase-admin');

const TYPE_CONFIG = {
  apostolate: {
    label: 'Apostolate',
    collection: 'organizations',
    nameField: 'name',
    descriptionField: 'description',
    taglineField: 'tagline',
    imageFields: ['logoURL', 'bannerImageURL', 'cardImageURL'],
  },
  parish: {
    label: 'Parish',
    collection: 'parishesprime',
    nameField: 'name',
    descriptionField: 'description',
    taglineField: null,
    imageFields: ['latestBulletinURLs.0', 'imageNames.0'],
  },
  business: {
    label: 'Business',
    collection: 'businesses',
    nameField: 'name',
    descriptionField: 'description',
    taglineField: 'tagline',
    imageFields: ['heroImageURL', 'images.0'],
  },
  school: {
    label: 'School',
    collection: 'schools',
    nameField: 'name',
    descriptionField: 'description',
    taglineField: null,
    imageFields: ['heroImageURL', 'imageNames.0'],
  },
  campusministry: {
    label: 'Campus Ministry',
    collection: 'bibleStudies',
    nameField: 'title',
    descriptionField: 'description',
    taglineField: 'tagline',
    imageFields: ['heroPrimaryImage', 'image'],
  },
  vocation: {
    label: 'Vocation',
    collection: 'vocations',
    nameField: 'name',
    descriptionField: 'introduction',
    taglineField: null,
    imageFields: ['profileImageURL', 'photoURL'],
  },
  retreat: {
    label: 'Retreat',
    collection: 'retreats',
    nameField: 'name',
    descriptionField: 'description',
    taglineField: 'tagline',
    imageFields: ['heroImageURL', 'imageNames.0'],
  },
  missionary: {
    label: 'Missionary',
    collection: 'missionaries',
    nameField: 'name',
    descriptionField: 'introduction',
    taglineField: null,
    imageFields: ['profileImageURL', 'photoURL'],
  },
  pilgrimage: {
    label: 'Pilgrimage',
    collection: 'pilgrimageSites',
    nameField: 'name',
    descriptionField: 'description',
    taglineField: null,
    imageFields: ['heroImageURL', 'imageNames.0'],
  },
  // Network (a public messageWorkspace). Unlike the detail types, tapping this
  // link JOINS the workspace in-app. Its canonical path is /join/{id} (see
  // `pathSegment`), which the iOS app intercepts via the AASA `/join/*` rule.
  network: {
    label: 'Network',
    collection: 'messageWorkspaces',
    nameField: 'name',
    descriptionField: null,
    taglineField: null,
    imageFields: ['imageURL'],
    pathSegment: 'join',
    isJoin: true,
  },
};

// Branded per-type share cards: each key's real map icon (graduation cap, open
// book, church, …) in white on the key's map color, with the type label baked
// in. Mirrors `SelectedObjectPreviewCard.swift` — including the school↔campus-
// ministry color swap (school = dark green, campus ministry = purple). Used as
// the og:image so the link preview is cohesive and on-brand (the listing NAME
// renders as the og:title directly under the pic). Static 1200×630 JPEGs in
// assets/og-keys/; regenerate via the qlmanage/sips pipeline if colors change.
const KEY_CARD_BASE = 'https://catholicnave.com/assets/og-keys';
const KEY_CARD_TYPES = ['parish', 'business', 'school', 'campusministry', 'vocation', 'retreat', 'missionary', 'pilgrimage'];
for (const k of KEY_CARD_TYPES) {
  if (TYPE_CONFIG[k]) TYPE_CONFIG[k].cardImage = `${KEY_CARD_BASE}/og-${k}.jpg`;
}

const APP_STORE_URL = 'https://apps.apple.com/us/app/nave-catholic-neighborhoods/id6753827903';
// `og-image.png` is the purpose-built 1200×630 share card (white Nave sail
// on black) — Apple's recommended OG aspect, and it fills the 16:9 hero
// cleanly instead of cropping a square logo. Used whenever a listing has no
// image of its own so iMessage / Slack / the join page show clean Nave
// branding rather than a broken-image placeholder or an awkward crop.
const FALLBACK_OG_IMAGE = 'https://catholicnave.com/assets/og-image.png';

// Reads "imageNames.0" or "logoURL" from a Firestore doc dict.
function readNested(obj, path) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return null;
    if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[parseInt(key, 10)];
    return acc[key];
  }, obj);
}

function pickImage(data, imageFields) {
  for (const field of imageFields || []) {
    const value = readNested(data, field);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return FALLBACK_OG_IMAGE;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trimTo(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderPage({ title, description, image, canonicalUrl, label, appUrl }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(trimTo(description, 200));
  const safeImage = escapeHtml(image);
  const safeUrl = escapeHtml(canonicalUrl);
  const safeLabel = escapeHtml(label);
  // The "Open in app" target. A same-domain https link tapped from inside
  // Safari does NOT trigger the universal link, so for the join flow we hand
  // the button a `thenave://` custom-scheme URL (passed in as appUrl), which
  // opens the app directly. Falls back to the canonical https URL otherwise.
  const safeAppUrl = escapeHtml(appUrl || canonicalUrl);

  // The page itself is a thin landing page. Universal links open
  // the app directly when iOS recognizes the domain; this body is
  // the fallback rendered in the browser if the user is on
  // desktop, Android, or doesn't have the app yet.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle} on Nave</title>
  <meta name="description" content="${safeDesc}" />
  <link rel="canonical" href="${safeUrl}" />

  <!-- OpenGraph (iMessage / Slack / Mail / Discord / Facebook) -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Nave" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${safeImage}" />
  <meta property="og:url" content="${safeUrl}" />

  <!-- Twitter / X -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeImage}" />

  <!-- iOS Smart App Banner — surfaces a "VIEW"/"OPEN" button at the top
       of mobile Safari, and deep-links into the app when installed. -->
  <meta name="apple-itunes-app" content="app-id=6753827903" />

  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #f5f5f5; }
    .wrap { max-width: 560px; margin: 0 auto; padding: 32px 20px 80px; text-align: center; }
    .hero { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 16px; background: #222; }
    h1 { font-size: 28px; margin: 24px 0 8px; line-height: 1.2; }
    .label { color: #d4af37; font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; margin: 0 0 8px; }
    p.desc { color: #c8c8c8; font-size: 16px; line-height: 1.5; margin: 0 0 32px; }
    .cta { display: inline-block; background: #d4af37; color: #0a0a0a; padding: 14px 28px; border-radius: 999px; font-weight: 600; text-decoration: none; }
    .cta + .cta { margin-left: 12px; background: transparent; color: #f5f5f5; border: 1px solid #444; }
  </style>
</head>
<body>
  <div class="wrap">
    <img class="hero" src="${safeImage}" alt="${safeTitle}" />
    <p class="label">${safeLabel}</p>
    <h1>${safeTitle}</h1>
    <p class="desc">${safeDesc}</p>
    <a class="cta" href="${APP_STORE_URL}">Get Nave</a>
    <a class="cta" href="${safeAppUrl}">Open in app</a>
  </div>
</body>
</html>`;
}

// Celebret send-ahead links are a two-hop: the id is a presentation that
// points to a priest. We render the priest's ID-card image as the OG preview
// and redirect the actual visitor to the interactive confirm page.
async function renderCelebret(res, { id, pid }) {
  let priest = null;
  try {
    if (pid) {
      // Physical card / stable priest link.
      const pr = await adminDb.collection('celebret_priests').doc(String(pid)).get();
      if (pr.exists) priest = pr.data();
    } else if (id) {
      // Send-ahead presentation → priest (two-hop).
      const presSnap = await adminDb.collection('celebret_presentations').doc(String(id)).get();
      if (presSnap.exists && presSnap.data().priestId) {
        const pr = await adminDb.collection('celebret_priests').doc(presSnap.data().priestId).get();
        if (pr.exists) priest = pr.data();
      }
    }
  } catch (e) { console.error('celebret lookup', e); }

  const name = (priest && priest.name) || 'A visiting celebrant';
  const diocese = (priest && priest.dioceseName) || '';
  const image = (priest && priest.cardImageURL) || FALLBACK_OG_IMAGE;
  const title = `${name} — Celebret`;
  const description = priest
    ? (pid ? `Approved by ${diocese}.` : `Approved by ${diocese}. Confirm his upcoming visit to your parish.`)
    : 'This Celebret link is no longer available.';
  const target = pid
    ? `https://catholicnave.com/celebret.html?pid=${encodeURIComponent(pid)}`
    : `https://catholicnave.com/celebret.html?id=${encodeURIComponent(id)}`;
  const ogUrl = pid
    ? `https://catholicnave.com/celebret/p/${escapeHtml(String(pid))}`
    : `https://catholicnave.com/celebret/${escapeHtml(String(id))}`;

  const html = `<!doctype html><html lang="en"><head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Celebrat" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(image)}" />
  <meta property="og:url" content="${ogUrl}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(image)}" />
  <meta http-equiv="refresh" content="0; url=${target}" />
  <script>location.replace(${JSON.stringify(target)});</script>
</head><body style="background:#000;color:#fff;font-family:-apple-system,sans-serif">
  <p style="text-align:center;padding:40px">Opening Celebret…</p>
</body></html>`;
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
}

module.exports = async (req, res) => {
  try {
    const { type, id, pid } = req.query;
    if (!type) {
      res.status(400).send('Missing type');
      return;
    }
    if (String(type).toLowerCase() === 'celebret') {
      return await renderCelebret(res, { id: id || null, pid: pid || null });
    }
    if (!id) {
      res.status(400).send('Missing id');
      return;
    }
    const cfg = TYPE_CONFIG[String(type).toLowerCase()];
    if (!cfg) {
      res.status(404).send('Unknown share type');
      return;
    }

    // Channel-scoped network invites arrive as /join/{id}?c={channelId}. The
    // universal link carries that query into the app natively; forward it into
    // the custom-scheme "Open in app" handoff too so both paths land the joiner
    // in the right channel.
    const channelId = req.query.c ? String(req.query.c) : null;
    const joinAppUrl = `thenave://join/${id}${channelId ? `?c=${encodeURIComponent(channelId)}` : ''}`;

    const docRef = adminDb.collection(cfg.collection).doc(String(id));
    const snap = await docRef.get();
    if (!snap.exists) {
      // Render a generic fallback page — still sets OG tags so the
      // recipient sees something meaningful in iMessage even if the
      // listing was deleted between when the link was sent and
      // when it was clicked.
      const html = renderPage({
        title: cfg.label,
        description: 'This listing isn\'t available — open Nave to find more.',
        image: cfg.cardImage || FALLBACK_OG_IMAGE,
        canonicalUrl: `https://catholicnave.com/${cfg.pathSegment || cfg.label.toLowerCase()}/${escapeHtml(id)}`,
        label: cfg.label,
        appUrl: cfg.isJoin ? joinAppUrl : undefined,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
      return;
    }

    const data = snap.data() || {};
    const baseTitle = data[cfg.nameField] || cfg.label;
    const tagline = cfg.taglineField ? data[cfg.taglineField] : null;
    // The join page is an invite: "Join {name}" with invite copy. Detail types
    // keep their listing name + description.
    const title = cfg.isJoin ? `Join ${baseTitle}` : baseTitle;
    const description = cfg.isJoin
      ? `You've been invited to join the ${baseTitle} network on Nave — a Catholic community app. Download Nave to join the conversation.`
      : (tagline || (cfg.descriptionField ? data[cfg.descriptionField] : null) || `Find ${cfg.label.toLowerCase()}s and more on Nave.`);
    const label = cfg.isJoin ? 'You\'re invited' : cfg.label;
    // Key types (parish, business, …) show the branded color/icon card so every
    // share is cohesive; the listing name is the og:title under it. Apostolate +
    // network keep their own logo/image.
    const image = cfg.cardImage || pickImage(data, cfg.imageFields);
    // Canonical = the path the iOS app intercepts (/join/{id} for networks).
    const canonicalUrl = `https://catholicnave.com/${cfg.pathSegment || String(type).toLowerCase()}/${id}`;

    const html = renderPage({
      title,
      description,
      image,
      canonicalUrl,
      label,
      // For joins, "Open in app" uses the custom scheme so it opens the app
      // even when tapped from inside Safari on catholicnave.com.
      appUrl: cfg.isJoin ? `thenave://join/${id}` : undefined,
    });

    // Cache for 5 minutes at the edge — long enough that an
    // iMessage "fetch the OG tags" request hits the cache, short
    // enough that an owner edit lands within ~5 min.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    console.error('share.js error', err);
    res.status(500).send('Error rendering share page');
  }
};
