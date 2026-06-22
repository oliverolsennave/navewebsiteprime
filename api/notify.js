// Router for notification/email endpoints. Consolidated to stay under
// Vercel Hobby's 12-Serverless-Function limit. Underlying handlers live
// unchanged in api/_lib/notify/*. External URLs preserved via vercel.json
// rewrites; the cron path is rewritten too:
//
//   /api/notify-feedback        -> /api/notify?action=feedback
//   /api/send-reply-notification-> /api/notify?action=reply
//   /api/notify-new-signups     -> /api/notify?action=new-signups   (cron)
//
// Handlers are required LAZILY (only the matched action loads), so each
// handler keeps the same isolation it had as a standalone function.

const handlers = {
  'feedback': './_lib/notify/feedback.js',
  'reply': './_lib/notify/reply.js',
  'new-signups': './_lib/notify/new-signups.js',
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const modPath = handlers[action];
  if (!modPath) {
    res.status(404).json({ error: `Unknown notify action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = require(modPath);
  } catch (err) {
    console.error(`notify router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'Notify handler failed to load' });
    return;
  }
  return handler(req, res);
};
