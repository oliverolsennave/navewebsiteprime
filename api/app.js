// Router for app-lifecycle endpoints. Consolidated to stay under Vercel
// Hobby's 12-Serverless-Function limit. Underlying handlers live unchanged
// in api/_lib/app/*. External URLs preserved via vercel.json rewrites; the
// cron path is rewritten too:
//
//   /api/register-install         -> /api/app?action=register-install
//   /api/check-app-store-version  -> /api/app?action=check-version   (cron)
//
// Thunks with LITERAL require paths: the literal lets Vercel's file tracer
// bundle each file, the thunk defers execution so only the matched action
// loads (per-function isolation preserved).

const handlers = {
  'register-install': () => require('./_lib/app/register-install.js'),
  'check-version': () => require('./_lib/app/check-version.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const load = handlers[action];
  if (!load) {
    res.status(404).json({ error: `Unknown app action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = load();
  } catch (err) {
    console.error(`app router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'App handler failed to load' });
    return;
  }
  return handler(req, res);
};
