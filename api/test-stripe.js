module.exports = async function handler(req, res) {
  try {
    // Test 1: Can we load stripe?
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Test 2: Can we load firebase-admin?
    const admin = require('firebase-admin');

    // Test 3: Can we parse the service account?
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

    return res.status(200).json({
      stripeLoaded: true,
      firebaseAdminLoaded: true,
      serviceAccountProject: sa.project_id || 'missing',
      envVars: {
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? 'set' : 'missing',
        STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? 'set' : 'missing',
        STRIPE_SUBSCRIPTION_PRICE_ID: process.env.STRIPE_SUBSCRIPTION_PRICE_ID ? 'set' : 'missing',
        FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT ? 'set' : 'missing',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
