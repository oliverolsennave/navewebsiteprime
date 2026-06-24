// Router for Posts-feed content endpoints. Consolidated under one Serverless
// Function to stay within Vercel Hobby's 12-function limit. External paths are
// preserved via vercel.json rewrites; the daily cron hits the ingest path:
//
//   /api/ingest-feed -> /api/content?action=ingest-feed   (cron)
//
// Thunks with LITERAL require paths so Vercel's file tracer bundles each file
// while only the matched action actually loads.

const handlers = {
  'ingest-feed': () => require('./_lib/content/ingest-feed.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const load = handlers[action];
  if (!load) {
    res.status(404).json({ error: `Unknown content action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = load();
  } catch (err) {
    console.error(`content router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'Content handler failed to load' });
    return;
  }
  return handler(req, res);
};
