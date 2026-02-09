import { auth, db, googleProvider, appleProvider } from './firebase-config.js';
import {
    GoogleAuthProvider,
    OAuthProvider,
    signInWithPopup,
    RecaptchaVerifier,
    signInWithPhoneNumber,
    sendSignInLinkToEmail,
    isSignInWithEmailLink,
    signInWithEmailLink,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    collection,
    doc,
    setDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const steps = ['step-auth', 'step-type', 'step-subscription', 'step-form', 'step-success'];
const indicator = document.getElementById('join-step-indicator');
const authStatus = document.getElementById('auth-status');
const submitStatus = document.getElementById('submit-status');
const keyTypeGrid = document.getElementById('key-type-grid');
const toSubscriptionBtn = document.getElementById('to-subscription');
const toFormBtn = document.getElementById('to-form');
const joinForm = document.getElementById('join-form');

let currentStep = 0;
let selectedType = null;
let phoneConfirmation = null;
let currentUser = null;

const typeConfig = {
    church: { collection: 'Churches', objectType: 'parish' },
    business: { collection: 'businesses', objectType: 'business' },
    school: { collection: 'schools', objectType: 'school' },
    pilgrimage: { collection: 'pilgrimageSites', objectType: 'pilgrimage' },
    retreat: { collection: 'retreats', objectType: 'retreat' },
    vocation: { collection: 'vocations', objectType: 'vocation' },
    missionary: { collection: 'missionaries', objectType: 'missionary' },
    campus: { collection: 'bibleStudies', objectType: 'bibleStudy' }
};

function showStep(index) {
    currentStep = index;
    steps.forEach((id, i) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('hidden', i !== index);
    });
    const spans = indicator.querySelectorAll('span');
    spans.forEach((span, i) => {
        span.classList.toggle('active', i === index);
        span.classList.toggle('done', i < index);
    });
}

function requireAuthNext() {
    if (currentUser) {
        showStep(1);
    }
}

function setAuthMessage(msg, isError = false) {
    authStatus.textContent = msg;
    authStatus.classList.toggle('error', isError);
}

// Auth gate UI
document.getElementById('btn-email-phone').addEventListener('click', () => {
    document.getElementById('email-phone-form').classList.toggle('hidden');
});

document.getElementById('btn-google').addEventListener('click', async () => {
    try {
        googleProvider.setCustomParameters({ prompt: 'select_account' });
        await signInWithPopup(auth, googleProvider);
    } catch (err) {
        setAuthMessage(err.message, true);
    }
});

document.getElementById('btn-apple').addEventListener('click', async () => {
    try {
        appleProvider.addScope('email');
        await signInWithPopup(auth, appleProvider);
    } catch (err) {
        setAuthMessage(err.message, true);
    }
});

// Email link auth
document.getElementById('email-send-link').addEventListener('click', async () => {
    const email = document.getElementById('email-input').value.trim();
    if (!email) return setAuthMessage('Enter a valid email.', true);
    const actionCodeSettings = {
        url: `${window.location.origin}${window.location.pathname}?emailSignIn=1`,
        handleCodeInApp: true
    };
    try {
        await sendSignInLinkToEmail(auth, email, actionCodeSettings);
        window.localStorage.setItem('joinEmailForSignIn', email);
        setAuthMessage('Check your email for the sign-in link.');
    } catch (err) {
        setAuthMessage(err.message, true);
    }
});

// Phone auth
const recaptchaContainer = document.getElementById('recaptcha-container');
let recaptchaVerifier = null;

document.getElementById('phone-send-code').addEventListener('click', async () => {
    const phone = document.getElementById('phone-input').value.trim();
    if (!phone) return setAuthMessage('Enter a valid phone number.', true);
    if (!recaptchaVerifier) {
        recaptchaVerifier = new RecaptchaVerifier(auth, recaptchaContainer, {
            size: 'invisible'
        });
    }
    try {
        phoneConfirmation = await signInWithPhoneNumber(auth, phone, recaptchaVerifier);
        document.getElementById('phone-code-row').classList.remove('hidden');
        setAuthMessage('SMS code sent.');
    } catch (err) {
        setAuthMessage(err.message, true);
    }
});

document.getElementById('phone-verify-code').addEventListener('click', async () => {
    const code = document.getElementById('phone-code-input').value.trim();
    if (!phoneConfirmation || !code) return setAuthMessage('Enter the SMS code.', true);
    try {
        await phoneConfirmation.confirm(code);
    } catch (err) {
        setAuthMessage(err.message, true);
    }
});

// Handle email link sign-in if present
if (isSignInWithEmailLink(auth, window.location.href)) {
    const storedEmail = window.localStorage.getItem('joinEmailForSignIn');
    const email = storedEmail || window.prompt('Confirm your email');
    if (email) {
        signInWithEmailLink(auth, email, window.location.href)
            .then(() => {
                window.localStorage.removeItem('joinEmailForSignIn');
                window.history.replaceState({}, document.title, window.location.pathname);
            })
            .catch(err => setAuthMessage(err.message, true));
    }
}

// Auth state listener
onAuthStateChanged(auth, user => {
    currentUser = user;
    if (user) {
        setAuthMessage(`Signed in as ${user.phoneNumber || user.email || 'user'}.`);
        requireAuthNext();
    }
});

// Key type selection
keyTypeGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.join-type-card');
    if (!btn) return;
    selectedType = btn.dataset.type;
    document.querySelectorAll('.join-type-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.type === selectedType);
    });
    toSubscriptionBtn.disabled = !selectedType;
});

toSubscriptionBtn.addEventListener('click', () => showStep(2));
toFormBtn.addEventListener('click', () => showStep(3));

// Submission
joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return showStep(0);
    if (!selectedType) return;
    const config = typeConfig[selectedType];
    if (!config) return;

    submitStatus.textContent = 'Submitting...';
    submitStatus.classList.remove('error');

    try {
        const objectId = doc(collection(db, config.collection)).id;
        const submissionId = crypto.randomUUID();

        const name = document.getElementById('field-name').value.trim();
        const description = document.getElementById('field-description').value.trim();
        const website = document.getElementById('field-website').value.trim();
        const address = document.getElementById('field-address').value.trim();
        const city = document.getElementById('field-city').value.trim();
        const state = document.getElementById('field-state').value.trim();
        const zipCode = document.getElementById('field-zip').value.trim();
        const latitude = parseFloat(document.getElementById('field-latitude').value);
        const longitude = parseFloat(document.getElementById('field-longitude').value);
        const imageUrl = document.getElementById('field-image').value.trim();
        const category = document.getElementById('field-category').value.trim();
        const subcategory = document.getElementById('field-subcategory').value.trim();
        const foundingYear = document.getElementById('field-founding-year').value.trim();

        const objectData = {
            id: objectId,
            name: name,
            description: description || 'No description provided',
            category: category || '',
            subcategory: subcategory || '',
            address: address,
            city: city,
            state: state,
            zipCode: zipCode,
            country: 'USA',
            latitude: Number.isFinite(latitude) ? latitude : null,
            longitude: Number.isFinite(longitude) ? longitude : null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            source: 'free_submission',
            createdFromSubmissionId: submissionId,
            createdByUserId: currentUser.uid,
            isActive: true,
            isVerified: false,
            isPremium: false
        };

        if (website) objectData.website = website;
        if (foundingYear) objectData.foundingYear = foundingYear;
        if (imageUrl) {
            objectData.primaryImage = imageUrl;
            objectData.images = [imageUrl];
        }

        await setDoc(doc(db, config.collection, objectId), objectData);

        const submissionData = {
            id: submissionId,
            objectId: objectId,
            objectName: name,
            objectType: config.objectType,
            submissionStatus: 'approved',
            submittedAt: serverTimestamp(),
            approvedAt: serverTimestamp(),
            notes: null,
            category: category || null,
            subcategory: subcategory || null,
            description: description || null,
            foundingYear: foundingYear || null,
            contactName: null,
            contactEmail: currentUser.email || null,
            contactPhone: currentUser.phoneNumber || null,
            website: website || null,
            address: address || null,
            city: city || null,
            state: state || null,
            zipCode: zipCode || null,
            country: 'USA',
            latitude: Number.isFinite(latitude) ? latitude : null,
            longitude: Number.isFinite(longitude) ? longitude : null
        };

        await setDoc(doc(db, 'users', currentUser.uid, 'submissions', submissionId), submissionData);

        submitStatus.textContent = 'Submitted!';
        showStep(4);
    } catch (err) {
        submitStatus.textContent = `Submission failed: ${err.message}`;
        submitStatus.classList.add('error');
    }
});

// Initialize
showStep(0);
