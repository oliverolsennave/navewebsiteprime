const Stripe = require('stripe');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const adminDb = admin.firestore();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Vercel: disable body parsing so we get the raw body for signature verification
module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  // Idempotency: check if we've already processed this event
  const eventRef = adminDb.collection('stripeEvents').doc(event.id);
  const eventSnap = await eventRef.get();
  if (eventSnap.exists) {
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Mark event as processed
    await eventRef.set({
      type: event.type,
      processedAt: new Date(),
      livemode: event.livemode,
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
};

async function handleCheckoutCompleted(session) {
  const metadata = session.metadata || {};

  if (session.mode === 'subscription') {
    // Subscription checkout — update user doc
    const userId = metadata.firebaseUserId;
    if (!userId) return;

    const subscription = await stripe.subscriptions.retrieve(session.subscription);

    const userRef = adminDb.collection('users').doc(userId);
    await userRef.set({
      stripeCustomerId: session.customer,
      subscription: {
        status: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripePriceId: subscription.items.data[0]?.price?.id || null,
        plan: metadata.plan || 'three_months',
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        updatedAt: new Date(),
      },
    }, { merge: true });

  } else if (session.mode === 'payment') {
    // One-time booking payment — create booking record
    const bookingData = {
      userId: metadata.firebaseUserId || null,
      userEmail: session.customer_details?.email || null,
      entityType: metadata.entityType || null,
      entityId: metadata.entityId || null,
      offeringId: metadata.offeringId || null,
      offeringTitle: metadata.offeringTitle || null,
      amount: session.amount_total,
      currency: session.currency,
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent,
      status: 'confirmed',
      createdAt: new Date(),
      confirmedAt: new Date(),
    };

    await adminDb.collection('bookings').add(bookingData);
  }
}

async function handleSubscriptionUpdated(subscription) {
  // Find the user by stripeCustomerId
  const usersSnap = await adminDb.collection('users')
    .where('stripeCustomerId', '==', subscription.customer)
    .limit(1)
    .get();

  if (usersSnap.empty) return;

  const userDoc = usersSnap.docs[0];
  await userDoc.ref.update({
    'subscription.status': subscription.status,
    'subscription.currentPeriodEnd': new Date(subscription.current_period_end * 1000),
    'subscription.trialEnd': subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
    'subscription.updatedAt': new Date(),
  });
}

async function handleSubscriptionDeleted(subscription) {
  const usersSnap = await adminDb.collection('users')
    .where('stripeCustomerId', '==', subscription.customer)
    .limit(1)
    .get();

  if (usersSnap.empty) return;

  const userDoc = usersSnap.docs[0];
  await userDoc.ref.update({
    'subscription.status': 'canceled',
    'subscription.cancelAtPeriodEnd': false,
    'subscription.updatedAt': new Date(),
  });
}

async function handlePaymentFailed(invoice) {
  if (!invoice.subscription) return;

  const usersSnap = await adminDb.collection('users')
    .where('stripeCustomerId', '==', invoice.customer)
    .limit(1)
    .get();

  if (usersSnap.empty) return;

  const userDoc = usersSnap.docs[0];
  await userDoc.ref.update({
    'subscription.status': 'past_due',
    'subscription.updatedAt': new Date(),
  });
}
