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

const handlers = {
  'payment-intent': require('./_lib/stripe/payment-intent.js'),
  'subscription-checkout': require('./_lib/stripe/subscription-checkout.js'),
  'connect-account': require('./_lib/stripe/connect-account.js'),
  'connect-refresh': require('./_lib/stripe/connect-refresh.js'),
};

module.exports = async (req, res) => {
  const action = req.query.action;
  const handler = handlers[action];
  if (!handler) {
    res.status(404).json({ error: `Unknown stripe action: ${action || '(none)'}` });
    return;
  }
  return handler(req, res);
};
