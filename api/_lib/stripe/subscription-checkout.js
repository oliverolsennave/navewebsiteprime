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

  const { firebaseIdToken, plan, platform } = req.body || {};

  if (!firebaseIdToken) {
    return res.status(401).json({ error: 'Missing Firebase ID token' });
  }

  // iOS native flow: return a clientSecret for PaymentSheet instead of a redirect URL
  if (platform === 'ios') {
    return handleiOSSubscription(req, res, firebaseIdToken);
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

    // Nave+ — $0.99/month recurring price (matches iOS Apple IAP).
    // Set STRIPE_SUBSCRIPTION_PRICE_ID in Vercel env to the Stripe price_... for
    // the $0.99/mo plan. 30-day free trial is applied at checkout.
    const priceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID;
    if (!priceId) {
      return res.status(500).json({ error: 'Stripe subscription price not configured' });
    }

    const lineItems = [{ price: priceId, quantity: 1 }];

    const sessionParams = {
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: lineItems,
      subscription_data: {
        trial_period_days: 30,
        metadata: { firebaseUserId: userId, plan: 'monthly' },
      },
      metadata: { firebaseUserId: userId, plan: 'monthly' },
      success_url: `${getOrigin(req)}/join?session_id={CHECKOUT_SESSION_ID}&step=form`,
      cancel_url: `${getOrigin(req)}/join?canceled=true`,
    };

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({ sessionUrl: session.url });
  } catch (err) {
    console.error('Error creating subscription checkout:', err);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
};

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

async function handleiOSSubscription(req, res, firebaseIdToken) {
  const { action, paymentMethodId } = req.body || {};

  let decodedToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(firebaseIdToken);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Firebase ID token' });
  }

  const userId = decodedToken.uid;
  const userEmail = decodedToken.email || null;

  try {
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

    // Step 1: Create a SetupIntent for PaymentSheet to collect payment method
    if (action === 'setup') {
      const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: stripeCustomerId },
        { apiVersion: '2024-06-20' }
      );

      const setupIntent = await stripe.setupIntents.create({
        customer: stripeCustomerId,
        automatic_payment_methods: { enabled: true },
        metadata: { firebaseUserId: userId },
      });

      return res.status(200).json({
        setupIntentClientSecret: setupIntent.client_secret,
        ephemeralKey: ephemeralKey.secret,
        customerId: stripeCustomerId,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      });
    }

    // Step 2: After payment method is saved, create the subscription
    if (action === 'activate') {
      const priceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID;
      if (!priceId) {
        return res.status(500).json({ error: 'Stripe subscription price not configured' });
      }

      // Get the customer's default payment method (set by SetupIntent)
      const customer = await stripe.customers.retrieve(stripeCustomerId);
      const pmId = paymentMethodId || customer.invoice_settings?.default_payment_method;

      // If a paymentMethodId was provided, attach and set as default
      if (paymentMethodId) {
        try {
          await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
        } catch (e) {
          // Already attached — that's fine
        }
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: { default_payment_method: paymentMethodId },
        });
      }

      const subscription = await stripe.subscriptions.create({
        customer: stripeCustomerId,
        items: [{ price: priceId }],
        default_payment_method: pmId || paymentMethodId,
        metadata: { firebaseUserId: userId },
      });

      // Update user doc with subscription info
      await userRef.set({
        subscription: {
          status: subscription.status,
          stripeSubscriptionId: subscription.id,
          stripePriceId: priceId,
          plan: 'business_monthly',
          currentPeriodEnd: new Date(subscription.current_period_end * 1000),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          updatedAt: new Date(),
        },
      }, { merge: true });

      return res.status(200).json({
        subscriptionId: subscription.id,
        status: subscription.status,
      });
    }

    return res.status(400).json({ error: 'Invalid action. Must be "setup" or "activate".' });
  } catch (err) {
    console.error('Error in iOS subscription flow:', err);
    return res.status(500).json({ error: err.message || 'Failed to process subscription' });
  }
}
