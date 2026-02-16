const Stripe = require('stripe');
const { adminAuth } = require('./_lib/firebase-admin');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    firebaseIdToken,
    entityType,
    entityId,
    offeringId,
    offeringTitle,
    amount,
    currency,
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
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: currency || 'usd',
          product_data: {
            name: offeringTitle,
            metadata: { entityType, entityId, offeringId },
          },
          unit_amount: Math.round(amount),
        },
        quantity: 1,
      }],
      metadata: {
        firebaseUserId: userId,
        entityType: entityType || '',
        entityId: entityId || '',
        offeringId: offeringId || '',
        offeringTitle: offeringTitle || '',
      },
      success_url: `${getOrigin(req)}/map?booking=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${getOrigin(req)}/map?booking=canceled`,
    });

    return res.status(200).json({ sessionUrl: session.url });
  } catch (err) {
    console.error('Error creating booking checkout:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
