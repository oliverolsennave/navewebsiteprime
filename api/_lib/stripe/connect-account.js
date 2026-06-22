const Stripe = require('stripe');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const adminAuth = admin.auth();
const adminDb = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { firebaseIdToken, platform } = req.body || {};

  if (!firebaseIdToken) {
    return res.status(401).json({ error: 'Missing Firebase ID token' });
  }

  let decodedToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(firebaseIdToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }

  const userId = decodedToken.uid;

  try {
    // Check if user already has a Connect account
    const userDoc = await adminDb.collection('users').doc(userId).get();
    const userData = userDoc.data() || {};
    let accountId = userData.stripeConnectAccountId;

    if (accountId) {
      // Check if onboarding is complete
      const account = await stripe.accounts.retrieve(accountId);
      if (account.details_submitted) {
        return res.status(200).json({ alreadyOnboarded: true, accountId });
      }
    } else {
      // Create new Express account
      const account = await stripe.accounts.create({
        type: 'express',
        metadata: { firebaseUserId: userId },
      });
      accountId = account.id;

      // Save to Firestore
      await adminDb.collection('users').doc(userId).set({
        stripeConnectAccountId: accountId,
      }, { merge: true });
    }

    // Create account link for onboarding
    const isIOS = platform === 'ios';
    const origin = getOrigin(req);

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/api/connect-refresh?uid=${userId}`,
      return_url: isIOS
        ? 'thenave://stripe-connect-return'
        : `${origin}/map?connect=success`,
      type: 'account_onboarding',
    });

    return res.status(200).json({ onboardingUrl: accountLink.url, accountId });
  } catch (err) {
    console.error('Error creating Connect account:', err);
    return res.status(500).json({ error: 'Failed to create Connect account' });
  }
};

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
