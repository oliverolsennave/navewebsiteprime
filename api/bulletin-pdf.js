// Combines every page image attached to a bulletinUploads doc into a single
// PDF and streams it back to the dashboard. The dashboard's paperclip click
// hits this endpoint instead of opening a single image — bulletins are
// multi-page so one file is the right UX.
//
// Auth: same shared password as /api/dashboard-data (X-Dashboard-Password
// header). The dashboard's button posts the header, then opens the blob in
// a new tab; password never lands in the URL or browser history.

const { adminDb } = require('./_lib/firebase-admin');
const { PDFDocument } = require('pdf-lib');

const FALLBACK_PASSWORD = 'thenavepassword';

function unauthorized(res) {
  return new Promise((resolve) => {
    setTimeout(() => { res.status(401).json({ error: 'Unauthorized' }); resolve(); }, 400);
  });
}

async function fetchUrlAsBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const expected = process.env.DASHBOARD_PASSWORD || FALLBACK_PASSWORD;
  const provided = req.headers['x-dashboard-password'] || '';
  if (provided !== expected) return unauthorized(res);

  const docId = String(req.query.docId || '').trim();
  if (!docId) return res.status(400).json({ error: 'Missing docId' });

  try {
    const snap = await adminDb.collection('bulletinUploads').doc(docId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Bulletin not found' });
    const data = snap.data();
    let urls = Array.isArray(data.bulletinURLs) ? data.bulletinURLs : null;

    // Fallback to parishesprime.latestBulletinURLs for published sessions
    // that pre-date the direct field write (matches dashboard-data.js logic).
    if ((!urls || !urls.length) && data.status === 'published' && data.parishId) {
      try {
        const parishDoc = await adminDb.collection('parishesprime').doc(data.parishId).get();
        const fallback = parishDoc.exists ? parishDoc.data().latestBulletinURLs : null;
        if (Array.isArray(fallback) && fallback.length) urls = fallback;
      } catch (_) {}
    }
    if (!urls || !urls.length) return res.status(404).json({ error: 'No bulletin files attached' });

    // Pull every page in parallel — total payload is usually a few MB.
    const pages = await Promise.all(urls.map(fetchUrlAsBytes));

    const pdf = await PDFDocument.create();
    for (const bytes of pages) {
      let img;
      // pdf-lib only supports JPG + PNG natively. Almost every bulletin page
      // comes out of iOS as JPEG; try JPG first, fall back to PNG.
      try { img = await pdf.embedJpg(bytes); }
      catch (_) { img = await pdf.embedPng(bytes); }
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const bytes = await pdf.save();
    const filenameParish = (data.parishName || 'bulletin').replace(/[^a-zA-Z0-9_\- ]+/g, '').slice(0, 60);
    const filename = `${filenameParish || 'bulletin'} bulletin.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(Buffer.from(bytes));
  } catch (err) {
    console.error('[bulletin-pdf] error:', err);
    return res.status(500).json({ error: 'Failed to build PDF', message: err.message });
  }
};
