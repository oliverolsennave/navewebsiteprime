// Router for app-lifecycle endpoints. Consolidated to stay under Vercel
// Hobby's 12-Serverless-Function limit. Underlying handlers live unchanged
// in api/_lib/app/*. External URLs preserved via vercel.json rewrites; the
// cron path is rewritten too:
//
//   /api/register-install         -> /api/app?action=register-install
//   /api/check-app-store-version  -> /api/app?action=check-version   (cron)

const handlers = {
  'register-install': require('./_lib/app/register-install.js'),
  'check-version': require('./_lib/app/check-version.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const handler = handlers[action];
  if (!handler) {
    res.status(404).json({ error: `Unknown app action: ${action || '(none)'}` });
    return;
  }
  return handler(req, res);
};
