// Router for app-lifecycle endpoints. Consolidated to stay under Vercel
// Hobby's 12-Serverless-Function limit. Underlying handlers live unchanged
// in api/_lib/app/*. External URLs preserved via vercel.json rewrites; the
// cron path is rewritten too:
//
//   /api/register-install         -> /api/app?action=register-install
//   /api/check-app-store-version  -> /api/app?action=check-version   (cron)
//
// Handlers are required LAZILY (only the matched action loads), so each
// handler keeps the same isolation it had as a standalone function.

const handlers = {
  'register-install': './_lib/app/register-install.js',
  'check-version': './_lib/app/check-version.js',
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const modPath = handlers[action];
  if (!modPath) {
    res.status(404).json({ error: `Unknown app action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = require(modPath);
  } catch (err) {
    console.error(`app router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'App handler failed to load' });
    return;
  }
  return handler(req, res);
};
