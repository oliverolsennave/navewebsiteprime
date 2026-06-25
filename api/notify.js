// Router for notification/email endpoints. Consolidated to stay under
// Vercel Hobby's 12-Serverless-Function limit. Underlying handlers live
// unchanged in api/_lib/notify/*. External URLs preserved via vercel.json
// rewrites; the cron path is rewritten too:
//
//   /api/notify-feedback        -> /api/notify?action=feedback
//   /api/send-reply-notification-> /api/notify?action=reply
//   /api/notify-new-signups     -> /api/notify?action=new-signups   (cron)
//
// Thunks with LITERAL require paths: the literal lets Vercel's file tracer
// bundle each file, the thunk defers execution so only the matched action
// loads (per-function isolation preserved).

const handlers = {
  'feedback': () => require('./_lib/notify/feedback.js'),
  'reply': () => require('./_lib/notify/reply.js'),
  'message': () => require('./_lib/notify/message.js'),
  'channel': () => require('./_lib/notify/channel.js'),
  'added': () => require('./_lib/notify/added.js'),
  'new-signups': () => require('./_lib/notify/new-signups.js'),
  'call-token': () => require('./_lib/notify/call-token.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const load = handlers[action];
  if (!load) {
    res.status(404).json({ error: `Unknown notify action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = load();
  } catch (err) {
    console.error(`notify router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'Notify handler failed to load' });
    return;
  }
  return handler(req, res);
};
