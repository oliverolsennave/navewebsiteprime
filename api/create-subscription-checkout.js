const Stripe = require('stripe');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const adminDb = admin.firestore();
const adminAuth = admin.auth();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { firebaseIdToken, plan } = req.body || {};

  if (!firebaseIdToken) {
    return res.status(401).json({ error: 'Missing Firebase ID token' });
  }
  if (!plan || !['trial', 'three_months'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan. Must be "trial" or "three_months".' });
  }

  let decodedToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(firebaseIdToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }

  const userId = decodedToken.uid;
  const userEmail = decodedToken.email || null;

  try {
    // Look up or create Stripe customer
    const userRef = adminDb.collection('users').doc(userId);
    const userSnap = await userRef.get();
    let stripeCustomerId = userSnap.exists ? userSnap.data().stripeCustomerId : null;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { firebaseUserId: userId },
      });
      stripeCustomerId = customer.id;
      await userRef.set({ stripeCustomerId }, { merge: true });
    }

    // The price ID must be set in Stripe Dashboard and stored here.
    // This should match the "Nave Key Owner Pro" $9.99/3mo price.
    const priceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID;
    if (!priceId) {
      return res.status(500).json({ error: 'Stripe subscription price not configured' });
    }

    const sessionParams = {
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 30,
        metadata: { firebaseUserId: userId, plan },
      },
      metadata: { firebaseUserId: userId, plan },
      success_url: `${getOrigin(req)}/join?session_id={CHECKOUT_SESSION_ID}&step=form`,
      cancel_url: `${getOrigin(req)}/join?canceled=true`,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({ sessionUrl: session.url });
  } catch (err) {
    console.error('Error creating subscription checkout:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
