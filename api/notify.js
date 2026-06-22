// Router for notification/email endpoints. Consolidated to stay under
// Vercel Hobby's 12-Serverless-Function limit. Underlying handlers live
// unchanged in api/_lib/notify/*. External URLs preserved via vercel.json
// rewrites; the cron path is rewritten too:
//
//   /api/notify-feedback        -> /api/notify?action=feedback
//   /api/send-reply-notification-> /api/notify?action=reply
//   /api/notify-new-signups     -> /api/notify?action=new-signups   (cron)

const handlers = {
  'feedback': require('./_lib/notify/feedback.js'),
  'reply': require('./_lib/notify/reply.js'),
  'new-signups': require('./_lib/notify/new-signups.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const handler = handlers[action];
  if (!handler) {
    res.status(404).json({ error: `Unknown notify action: ${action || '(none)'}` });
    return;
  }
  return handler(req, res);
};
