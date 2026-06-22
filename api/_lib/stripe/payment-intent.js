const Stripe = require('stripe');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const adminAuth = admin.auth();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    firebaseIdToken,
    amount,
    currency,
    offeringId,
    offeringTitle,
    entityType,
    entityId,
    providerStripeAccountId,
  } = req.body || {};

  if (!firebaseIdToken) {
    return res.status(401).json({ error: 'Missing Firebase ID token' });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (!offeringTitle) {
    return res.status(400).json({ error: 'Missing offering title' });
  }

  let decodedToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(firebaseIdToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }

  const userId = decodedToken.uid;

  try {
    const intentParams = {
      amount: Math.round(amount),
      currency: currency || 'usd',
      payment_method_types: ['card'],
      metadata: {
        firebaseUserId: userId,
        entityType: entityType || '',
        entityId: entityId || '',
        offeringId: offeringId || '',
        offeringTitle: offeringTitle || '',
      },
    };

    // Stripe Connect: split payment with platform fee
    if (providerStripeAccountId) {
      intentParams.application_fee_amount = Math.round(amount * 0.10); // 10% platform fee
      intentParams.transfer_data = {
        destination: providerStripeAccountId,
      };
      intentParams.metadata.providerStripeAccountId = providerStripeAccountId;
    }

    const paymentIntent = await stripe.paymentIntents.create(intentParams);

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error('Error creating payment intent:', err);
    return res.status(500).json({ error: 'Failed to create payment intent' });
  }
};
