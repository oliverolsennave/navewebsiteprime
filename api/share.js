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

const APP_STORE_URL = 'https://apps.apple.com/us/app/nave-catholic-neighborhoods/id6753827903';
// `favicon-512.png` is the largest square Nave logo already shipped
// to the website (`/assets/`). Used as the OpenGraph fallback when
// a listing has no image of its own — iMessage / Slack / etc. show
// the Nave brand instead of a broken-image placeholder. Apple's
// recommended OG size is 1200×630 wide; if we ever ship a hero
// graphic at that aspect, swap this URL.
const FALLBACK_OG_IMAGE = 'https://catholicnave.com/assets/favicon-512.png';

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

module.exports = async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) {
      res.status(400).send('Missing type or id');
      return;
    }
    const cfg = TYPE_CONFIG[String(type).toLowerCase()];
    if (!cfg) {
      res.status(404).send('Unknown share type');
      return;
    }

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
        image: FALLBACK_OG_IMAGE,
        canonicalUrl: `https://catholicnave.com/${cfg.pathSegment || cfg.label.toLowerCase()}/${escapeHtml(id)}`,
        label: cfg.label,
        appUrl: cfg.isJoin ? `thenave://join/${id}` : undefined,
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
    const image = pickImage(data, cfg.imageFields);
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
