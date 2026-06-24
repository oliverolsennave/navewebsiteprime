// Re-hosts a publisher's hero image into our own Firebase Storage bucket and
// returns a tokenized public URL. Why: some publisher CDNs (FOCUS, Christ in
// the City) sit behind Cloudflare bot-management that blocks the iOS app's
// image request by TLS fingerprint — the image 200s in curl but never loads in
// the app. Serving from our bucket (Google CDN, no Cloudflare) loads reliably.
// We download once during ingest (browser UA + Referer to satisfy hotlink
// protection) and store the bytes; the app then only ever hits our bucket.

const { admin } = require('../firebase-admin');
const crypto = require('crypto');

const BUCKET = 'navefirebase.firebasestorage.app';
const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function publicUrl(path, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}

// Downloads sourceUrl and stores it at feed-images/<key>.<ext>. Returns the
// public URL, or null if the source isn't a real, non-trivial image.
async function hostImage(sourceUrl, key) {
  if (!sourceUrl) return null;
  // Already ours — don't re-host (idempotent across cron runs).
  if (sourceUrl.includes('firebasestorage.googleapis.com') || sourceUrl.includes(BUCKET)) return sourceUrl;
  try {
    const origin = new URL(sourceUrl).origin;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(sourceUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*', Referer: `${origin}/` },
      redirect: 'follow', signal: ctrl.signal,
    });
    clearTimeout(t);
    const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !/^image\//.test(ct)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024) return null; // favicon / tracking-pixel guard
    const ext = EXT[ct] || 'jpg';
    const path = `feed-images/${key}.${ext}`;
    const token = crypto.randomUUID();
    await admin.storage().bucket(BUCKET).file(path).save(buf, {
      contentType: ct,
      resumable: false,
      metadata: {
        cacheControl: 'public, max-age=31536000',
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });
    return publicUrl(path, token);
  } catch {
    return null;
  }
}

module.exports = { hostImage, BUCKET, BROWSER_UA };
