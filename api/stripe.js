// Router for all Stripe endpoints EXCEPT the webhook (which stays a separate
// function — it needs the raw request body for signature verification).
//
// Consolidated to stay under Vercel Hobby's 12-Serverless-Function limit.
// Each underlying handler lives unchanged in api/_lib/stripe/* (underscore
// dirs are not deployed as their own functions). External URLs are preserved
// via rewrites in vercel.json, so iOS/web callers are untouched:
//
//   /api/create-payment-intent        -> /api/stripe?action=payment-intent
//   /api/create-subscription-checkout -> /api/stripe?action=subscription-checkout
//   /api/create-connect-account       -> /api/stripe?action=connect-account
//   /api/connect-refresh              -> /api/stripe?action=connect-refresh
//
// Handlers are required LAZILY (only the matched action loads), so each
// handler keeps the same isolation it had as a standalone function — a
// module-load error in one cannot take down the others or this router.

const handlers = {
  'payment-intent': './_lib/stripe/payment-intent.js',
  'subscription-checkout': './_lib/stripe/subscription-checkout.js',
  'connect-account': './_lib/stripe/connect-account.js',
  'connect-refresh': './_lib/stripe/connect-refresh.js',
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const modPath = handlers[action];
  if (!modPath) {
    res.status(404).json({ error: `Unknown stripe action: ${action || '(none)'}` });
    return;
  }
  let handler;
  try {
    handler = require(modPath);
  } catch (err) {
    console.error(`stripe router: failed to load "${action}":`, err);
    res.status(500).json({ error: 'Stripe handler failed to load' });
    return;
  }
  return handler(req, res);
};
