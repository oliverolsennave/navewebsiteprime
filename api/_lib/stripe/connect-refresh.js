const Stripe = require('stripe');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const adminDb = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  const uid = req.query.uid;
  if (!uid) {
    return res.status(400).json({ error: 'Missing uid parameter' });
  }

  try {
    const userDoc = await adminDb.collection('users').doc(uid).get();
    const accountId = userDoc.data()?.stripeConnectAccountId;

    if (!accountId) {
      return res.status(404).json({ error: 'No Connect account found' });
    }

    const origin = getOrigin(req);

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/api/connect-refresh?uid=${uid}`,
      return_url: 'thenave://stripe-connect-return',
      type: 'account_onboarding',
    });

    return res.redirect(303, accountLink.url);
  } catch (err) {
    console.error('Error refreshing Connect link:', err);
    return res.status(500).json({ error: 'Failed to refresh onboarding link' });
  }
};

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
