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
let maxStepReached = 0;
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
    const dots = indicator.querySelectorAll('.join-step-dot');
    dots.forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
        dot.classList.toggle('done', i <= maxStepReached && i !== index);
        dot.disabled = i > maxStepReached;
    });
}

function requireAuthNext() {
    if (currentUser) {
        maxStepReached = Math.max(maxStepReached, 1);
        showStep(1);
    }
}

function setAuthMessage(msg, isError = false) {
    authStatus.textContent = msg;
    authStatus.classList.toggle('error', isError);
}

// Helper to get trimmed value, returns '' if element missing
function val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
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
    document.getElementById('field-type-readonly').value = btn.textContent.trim();
    document.querySelectorAll('.join-form-group').forEach(group => {
        group.classList.toggle('hidden', group.dataset.keytype !== selectedType);
    });
    toSubscriptionBtn.disabled = !selectedType;
    if (selectedType) {
        maxStepReached = Math.max(maxStepReached, 1);
    }
});

toSubscriptionBtn.addEventListener('click', () => {
    maxStepReached = Math.max(maxStepReached, 2);
    showStep(2);
});
toFormBtn.addEventListener('click', () => {
    maxStepReached = Math.max(maxStepReached, 3);
    showStep(3);
});

// Step indicator navigation (back or reached steps only)
indicator.addEventListener('click', (e) => {
    const btn = e.target.closest('.join-step-dot');
    if (!btn) return;
    const step = Number(btn.dataset.step);
    if (Number.isNaN(step)) return;
    if (step <= maxStepReached) {
        showStep(step);
    }
});

async function geocodeAddress(locationStr) {
    if (!locationStr) {
        throw new Error('Please enter an address so we can place your key on the map.');
    }
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(locationStr)}`;
    const res = await fetch(url, {
        headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
        throw new Error('Address lookup failed. Please double-check the address.');
    }
    const data = await res.json();
    if (!data || data.length === 0) {
        throw new Error('We could not find that address. Please double-check it.');
    }
    return {
        latitude: parseFloat(data[0].lat),
        longitude: parseFloat(data[0].lon)
    };
}

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
        const name = val('field-name');

        let objectData = {
            id: objectId,
            name: name,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            source: 'free_submission',
            createdFromSubmissionId: submissionId,
            createdByUserId: currentUser.uid,
            isActive: true,
            isVerified: false,
            isPremium: false,
            country: 'USA'
        };

        let locationStr = '';

        // ── Parish ──────────────────────────────────────────────
        if (selectedType === 'church') {
            const address = val('field-church-address');
            const city = val('field-church-city');
            const state = val('field-church-state');
            const zip = val('field-church-zip');
            locationStr = [address, city, state, zip].filter(Boolean).join(', ');

            objectData.pastorName = val('field-pastor-name');
            objectData.contactEmail = val('field-church-email');
            objectData.contactPhone = val('field-church-phone');
            objectData.address = address;
            objectData.city = city;
            objectData.state = state;
            objectData.zipCode = zip;
            objectData.description = val('field-church-description') || 'No description provided';

            const website = val('field-church-website');
            if (website) objectData.website = website;
            const memberCount = val('field-member-count');
            if (memberCount) objectData.memberCount = parseInt(memberCount, 10);
            const massTimes = val('field-mass-times');
            if (massTimes) objectData.massTimes = massTimes;
            const confessionTimes = val('field-confession-times');
            if (confessionTimes) objectData.confessionTimes = confessionTimes;
            const adorationTimes = val('field-adoration-times');
            if (adorationTimes) objectData.adorationTimes = adorationTimes;
            const events = val('field-upcoming-events');
            if (events) objectData.upcomingEvents = events;
            const psas = val('field-pastor-psas');
            if (psas) objectData.pastorPSAs = psas;
            const prepUrl = val('field-prep-class-url');
            if (prepUrl) objectData.prepClassSignupUrl = prepUrl;
        }

        // ── Business ────────────────────────────────────────────
        if (selectedType === 'business') {
            locationStr = val('field-business-location');
            objectData.description = val('field-business-description');
            objectData.foundingYear = val('field-business-founding-year');
            objectData.address = locationStr;
        }

        // ── School ──────────────────────────────────────────────
        if (selectedType === 'school') {
            locationStr = val('field-school-location');
            objectData.description = val('field-school-description');
            objectData.foundingYear = val('field-school-founding-year');
            objectData.address = locationStr;
        }

        // ── Pilgrimage ──────────────────────────────────────────
        if (selectedType === 'pilgrimage') {
            locationStr = val('field-pilgrimage-location');
            objectData.description = val('field-pilgrimage-description');
            objectData.foundingYear = val('field-pilgrimage-founding-year');
            objectData.address = locationStr;
        }

        // ── Retreat ─────────────────────────────────────────────
        if (selectedType === 'retreat') {
            locationStr = val('field-retreat-location');
            objectData.description = val('field-retreat-description');
            objectData.foundingYear = val('field-retreat-founding-year');
            objectData.address = locationStr;
        }

        // ── Missionary ──────────────────────────────────────────
        if (selectedType === 'missionary') {
            locationStr = val('field-missionary-address');
            objectData.description = val('field-missionary-intro');
            objectData.address = locationStr;
            objectData.website = val('field-missionary-website');
            const donation = val('field-missionary-donation');
            if (donation) objectData.donationLink = donation;
            const email = val('field-missionary-email');
            if (email) objectData.contactEmail = email;
        }

        // ── Vocation ────────────────────────────────────────────
        if (selectedType === 'vocation') {
            locationStr = val('field-vocation-address');
            objectData.description = val('field-vocation-intro');
            objectData.address = locationStr;
            objectData.website = val('field-vocation-website');
            const email = val('field-vocation-email');
            if (email) objectData.contactEmail = email;
        }

        // ── Campus Ministry ─────────────────────────────────────
        if (selectedType === 'campus') {
            locationStr = val('field-campus-address');
            objectData.description = val('field-campus-intro');
            objectData.address = locationStr;
            objectData.meetingTimes = val('field-campus-meeting-times');
            const email = val('field-campus-email');
            if (email) objectData.contactEmail = email;
        }

        // Geocode
        const { latitude, longitude } = await geocodeAddress(locationStr);
        objectData.latitude = latitude;
        objectData.longitude = longitude;

        // Write to Firestore
        await setDoc(doc(db, config.collection, objectId), objectData);

        const submissionData = {
            id: submissionId,
            objectId: objectId,
            objectName: name,
            objectType: config.objectType,
            submissionStatus: 'approved',
            submittedAt: serverTimestamp(),
            approvedAt: serverTimestamp(),
            description: objectData.description || null,
            contactEmail: objectData.contactEmail || currentUser.email || null,
            contactPhone: objectData.contactPhone || currentUser.phoneNumber || null,
            website: objectData.website || null,
            address: objectData.address || null,
            country: 'USA',
            latitude,
            longitude
        };

        await setDoc(doc(db, 'users', currentUser.uid, 'submissions', submissionId), submissionData);

        submitStatus.textContent = 'Submitted!';
        maxStepReached = Math.max(maxStepReached, 4);
        showStep(4);
    } catch (err) {
        submitStatus.textContent = `Submission failed: ${err.message}`;
        submitStatus.classList.add('error');
    }
});

// Initialize
showStep(0);
