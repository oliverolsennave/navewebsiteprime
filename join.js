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
    getDoc,
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
let hasActiveSubscription = false;
let bulletinUrl = null;
let structuredSchedules = null;

// ── Schedule dropdown helpers ────────────────────────────────────────
const SCHEDULE_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Monday-Friday'];
const SCHEDULE_LANGUAGES = ['English', 'Spanish', 'Latin', 'Polish', 'Vietnamese', 'Korean', 'Portuguese', 'French', 'Italian'];

function buildTimeOptions() {
    const opts = [];
    for (let h = 5; h <= 23; h++) {
        for (let m = 0; m < 60; m += 30) {
            if (h === 23 && m > 0) break;
            const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            const ampm = h < 12 ? 'AM' : 'PM';
            opts.push(`${h12}:${m === 0 ? '00' : m} ${ampm}`);
        }
    }
    return opts;
}
const TIME_OPTIONS = buildTimeOptions();

function matchTime(raw) {
    if (!raw) return '';
    const t = raw.trim();
    if (TIME_OPTIONS.includes(t)) return t;
    // Normalize "8am" → "8:00 AM", "12:30pm" → "12:30 PM"
    const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)$/);
    if (m) {
        const normalized = `${parseInt(m[1])}:${m[2] || '00'} ${m[3].toUpperCase()}`;
        if (TIME_OPTIONS.includes(normalized)) return normalized;
    }
    return '';
}

function createSelect(options, selected, cls, placeholder) {
    const sel = document.createElement('select');
    sel.className = cls;
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = placeholder || '—';
    sel.appendChild(blank);
    options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === selected) o.selected = true;
        sel.appendChild(o);
    });
    return sel;
}

function createScheduleRow(type, dayVal, timeVal, endTimeVal, langVal) {
    const row = document.createElement('div');
    row.className = 'bulletin-schedule-row';

    row.appendChild(createSelect(SCHEDULE_DAYS, dayVal || '', 'schedule-day', 'Day'));
    row.appendChild(createSelect(TIME_OPTIONS, matchTime(timeVal), 'schedule-time', 'Time'));

    if (type === 'confession' || type === 'adoration') {
        const dash = document.createElement('span');
        dash.className = 'schedule-dash';
        dash.textContent = '–';
        row.appendChild(dash);
        row.appendChild(createSelect(TIME_OPTIONS, matchTime(endTimeVal), 'schedule-end', 'End'));
    }

    if (type === 'mass' || type === 'confession') {
        row.appendChild(createSelect(SCHEDULE_LANGUAGES, langVal || '', 'schedule-lang', 'Lang'));
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'schedule-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(removeBtn);

    return row;
}

function populateScheduleSection(type, containerId, scheduleData) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    if (!scheduleData || typeof scheduleData !== 'object') return;
    for (const [day, entries] of Object.entries(scheduleData)) {
        if (!Array.isArray(entries)) continue;
        entries.forEach(entry => {
            container.appendChild(createScheduleRow(
                type, day, entry.time, entry.endTime, entry.language
            ));
        });
    }
}

function collectSchedule(type, containerId) {
    const container = document.getElementById(containerId);
    const dict = {};
    container.querySelectorAll('.bulletin-schedule-row').forEach(row => {
        const day = row.querySelector('.schedule-day')?.value;
        const time = row.querySelector('.schedule-time')?.value;
        if (!day || !time) return;
        const entry = { time };
        if (type === 'confession' || type === 'adoration') {
            const end = row.querySelector('.schedule-end')?.value;
            if (end) entry.endTime = end;
        }
        if (type === 'mass' || type === 'confession') {
            entry.language = row.querySelector('.schedule-lang')?.value || '';
        }
        if (!dict[day]) dict[day] = [];
        dict[day].push(entry);
    });
    return dict;
}

function flattenSchedule(dict) {
    if (!dict || Object.keys(dict).length === 0) return '';
    return Object.entries(dict).map(([day, entries]) => {
        const times = entries.map(e => {
            let t = e.time;
            if (e.endTime) t += '-' + e.endTime;
            if (e.language) t += ' (' + e.language + ')';
            return t;
        }).join(', ');
        const label = day === 'Monday-Friday' ? 'Weekday' : day;
        return `${label} ${times}`;
    }).join('; ');
}

// "+" Add buttons for schedule sections
document.getElementById('bulletin-schedules').addEventListener('click', (e) => {
    const btn = e.target.closest('.bulletin-schedule-add');
    if (!btn) return;
    const type = btn.dataset.schedule;
    const containerId = `${type}-schedule-entries`;
    const container = document.getElementById(containerId);
    if (container) container.appendChild(createScheduleRow(type, '', '', '', ''));
});

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
    // Reset bulletin sub-views when returning to step 1
    if (index === 1) {
        const bc = document.getElementById('bulletin-choice');
        const bu = document.getElementById('bulletin-upload');
        if (bc) bc.classList.add('hidden');
        if (bu) bu.classList.add('hidden');
        keyTypeGrid.classList.remove('hidden');
        toSubscriptionBtn.classList.remove('hidden');
    }
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
    // Update disclaimer visibility and list items
    const disclaimer = document.getElementById('join-disclaimer');
    disclaimer.classList.toggle('visible', !!selectedType);
    document.querySelectorAll('#disclaimer-list li').forEach(li => {
        li.classList.toggle('visible', li.dataset.keytype === selectedType);
    });
    toSubscriptionBtn.disabled = !selectedType;
    if (selectedType) {
        maxStepReached = Math.max(maxStepReached, 1);
    }
});

toSubscriptionBtn.addEventListener('click', () => {
    if (selectedType === 'church') {
        // Show bulletin choice instead of going straight to subscribe
        keyTypeGrid.classList.add('hidden');
        toSubscriptionBtn.classList.add('hidden');
        document.getElementById('bulletin-choice').classList.remove('hidden');
        return;
    }
    maxStepReached = Math.max(maxStepReached, 2);
    showStep(2);
});

// ── Bulletin choice routing ──────────────────────────────────────────

const bulletinChoice = document.getElementById('bulletin-choice');
const bulletinUpload = document.getElementById('bulletin-upload');
const bulletinDropzone = document.getElementById('bulletin-dropzone');
const bulletinFileInput = document.getElementById('bulletin-file-input');
const bulletinProgress = document.getElementById('bulletin-progress');
const bulletinStatus = document.getElementById('bulletin-status');

function resetBulletinUI() {
    bulletinChoice.classList.add('hidden');
    bulletinUpload.classList.add('hidden');
    bulletinProgress.classList.add('hidden');
    bulletinDropzone.classList.remove('hidden');
    document.getElementById('bulletin-receipt').classList.add('hidden');
    document.getElementById('bulletin-schedules').classList.add('hidden');
    document.getElementById('bulletin-events').classList.add('hidden');
    bulletinStatus.textContent = '';
    bulletinStatus.className = 'bulletin-status';
    keyTypeGrid.classList.remove('hidden');
    toSubscriptionBtn.classList.remove('hidden');
}

// "Looks Good — Continue" on receipt — sync edited values back to form
document.getElementById('btn-bulletin-continue').addEventListener('click', () => {
    const fieldMap = {
        pastorName: 'field-pastor-name',
        email: 'field-church-email',
        phone: 'field-church-phone',
        address: 'field-church-address',
        city: 'field-church-city',
        state: 'field-church-state',
        zipCode: 'field-church-zip',
        website: 'field-church-website',
        description: 'field-church-description',
        pastorPSAs: 'field-pastor-psas',
    };

    // Sync all editable receipt fields back to the form
    const receipt = document.getElementById('bulletin-receipt');
    receipt.querySelectorAll('[data-key]').forEach(input => {
        const key = input.dataset.key;
        const formFieldId = fieldMap[key];
        if (formFieldId) {
            const el = document.getElementById(formFieldId);
            if (el) el.value = input.value;
        }
    });

    // Collect structured schedules from dropdowns and flatten to form textareas
    const massDict = collectSchedule('mass', 'mass-schedule-entries');
    const confessionDict = collectSchedule('confession', 'confession-schedule-entries');
    const adorationDict = collectSchedule('adoration', 'adoration-schedule-entries');
    structuredSchedules = {
        massSchedule: massDict,
        confessionSchedule: confessionDict,
        adorationSchedule: adorationDict,
    };
    const massFld = document.getElementById('field-mass-times');
    if (massFld) massFld.value = flattenSchedule(massDict);
    const confFld = document.getElementById('field-confession-times');
    if (confFld) confFld.value = flattenSchedule(confessionDict);
    const adorFld = document.getElementById('field-adoration-times');
    if (adorFld) adorFld.value = flattenSchedule(adorationDict);

    // Serialize event cards into the upcoming events textarea
    const eventsScroll = document.getElementById('bulletin-events-scroll');
    const eventCards = eventsScroll.querySelectorAll('.bulletin-event-card');
    if (eventCards.length > 0) {
        const lines = [];
        eventCards.forEach(card => {
            const title = card.querySelector('[data-event="title"]')?.value || '';
            const date = card.querySelector('[data-event="date"]')?.value || '';
            const time = card.querySelector('[data-event="time"]')?.value || '';
            const parts = [title, date, time].filter(Boolean);
            if (parts.length) lines.push(parts.join(' — '));
        });
        const eventsField = document.getElementById('field-upcoming-events');
        if (eventsField) eventsField.value = lines.join('\n');
    }

    // Re-trigger geocoding if address fields were edited
    const addrParts = ['field-church-address', 'field-church-city', 'field-church-state', 'field-church-zip']
        .map(id => val(id)).filter(Boolean);
    if (addrParts.length >= 2) {
        previewGeocode(addrParts.join(', '), 'geocode-church');
    }

    resetBulletinUI();
    maxStepReached = Math.max(maxStepReached, 2);
    showStep(2);
});

// "Fill Out Manually" — go straight to subscribe
document.getElementById('btn-manual-entry').addEventListener('click', () => {
    bulletinChoice.classList.add('hidden');
    maxStepReached = Math.max(maxStepReached, 2);
    showStep(2);
});

// "Upload Bulletin" — show drop zone
document.getElementById('btn-upload-bulletin').addEventListener('click', () => {
    bulletinChoice.classList.add('hidden');
    bulletinUpload.classList.remove('hidden');
});

// Back button — return to choice screen
document.getElementById('btn-bulletin-back').addEventListener('click', () => {
    bulletinUpload.classList.add('hidden');
    bulletinChoice.classList.remove('hidden');
});

// Drag & drop events
bulletinDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    bulletinDropzone.classList.add('dragover');
});
bulletinDropzone.addEventListener('dragleave', () => {
    bulletinDropzone.classList.remove('dragover');
});
bulletinDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    bulletinDropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) processBulletinFile(file);
});

// File input change
bulletinFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processBulletinFile(file);
});

async function processBulletinFile(file) {
    const validTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (!validTypes.includes(file.type)) {
        bulletinStatus.textContent = 'Please upload a PDF, JPG, or PNG file.';
        bulletinStatus.className = 'bulletin-status error';
        return;
    }

    // Show progress spinner
    bulletinDropzone.classList.add('hidden');
    bulletinProgress.classList.remove('hidden');
    bulletinStatus.textContent = '';
    bulletinStatus.className = 'bulletin-status';

    try {
        if (!currentUser) throw new Error('Please sign in first.');
        const idToken = await currentUser.getIdToken();

        const formData = new FormData();
        formData.append('bulletin', file);

        const resp = await fetch('/api/process-bulletin', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${idToken}` },
            body: formData,
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Upload failed');

        // Store bulletin URL
        if (data.bulletinUrl) {
            bulletinUrl = data.bulletinUrl;
        }

        // Pre-fill form fields and show receipt
        const fieldMap = {
            pastorName: 'field-pastor-name',
            email: 'field-church-email',
            phone: 'field-church-phone',
            address: 'field-church-address',
            city: 'field-church-city',
            state: 'field-church-state',
            zipCode: 'field-church-zip',
            website: 'field-church-website',
            description: 'field-church-description',
            pastorPSAs: 'field-pastor-psas',
        };

        const labelMap = {
            pastorName: 'Pastor',
            email: 'Email',
            phone: 'Phone',
            address: 'Address',
            city: 'City',
            state: 'State',
            zipCode: 'ZIP Code',
            website: 'Website',
            description: 'Description',
            pastorPSAs: 'Pastor PSAs',
        };

        if (data.extractedData) {
            for (const [key, fieldId] of Object.entries(fieldMap)) {
                const value = data.extractedData[key];
                if (value && typeof value === 'string') {
                    const el = document.getElementById(fieldId);
                    if (el) el.value = value;
                }
            }

            // Trigger geocoding on pre-filled address
            const parts = ['field-church-address', 'field-church-city', 'field-church-state', 'field-church-zip']
                .map(id => val(id)).filter(Boolean);
            if (parts.length >= 2) {
                previewGeocode(parts.join(', '), 'geocode-church');
            }

            // Fields that should use textarea (longer content)
            const textareaKeys = new Set(['address', 'description', 'pastorPSAs']);

            // Build editable receipt
            const receiptList = document.getElementById('bulletin-receipt-list');
            receiptList.innerHTML = '';
            for (const [key, label] of Object.entries(labelMap)) {
                const value = data.extractedData[key] || '';
                const row = document.createElement('div');
                row.className = 'bulletin-receipt-row';
                const dt = document.createElement('dt');
                dt.textContent = label;
                const dd = document.createElement('dd');
                let inputEl;
                if (textareaKeys.has(key)) {
                    inputEl = document.createElement('textarea');
                    inputEl.rows = 2;
                } else {
                    inputEl = document.createElement('input');
                    inputEl.type = 'text';
                }
                inputEl.className = 'bulletin-receipt-input';
                inputEl.dataset.key = key;
                inputEl.value = value;
                if (!value) inputEl.placeholder = '—';
                dd.appendChild(inputEl);
                row.appendChild(dt);
                row.appendChild(dd);
                receiptList.appendChild(row);
            }

            // Populate schedule sections with dropdowns
            const ed = data.extractedData;
            const hasMass = ed.massSchedule && typeof ed.massSchedule === 'object' && Object.keys(ed.massSchedule).length > 0;
            const hasConf = ed.confessionSchedule && typeof ed.confessionSchedule === 'object' && Object.keys(ed.confessionSchedule).length > 0;
            const hasAdor = ed.adorationSchedule && typeof ed.adorationSchedule === 'object' && Object.keys(ed.adorationSchedule).length > 0;

            populateScheduleSection('mass', 'mass-schedule-entries', ed.massSchedule);
            populateScheduleSection('confession', 'confession-schedule-entries', ed.confessionSchedule);
            populateScheduleSection('adoration', 'adoration-schedule-entries', ed.adorationSchedule);

            const schedulesContainer = document.getElementById('bulletin-schedules');
            if (hasMass || hasConf || hasAdor) {
                schedulesContainer.classList.remove('hidden');
            } else {
                schedulesContainer.classList.add('hidden');
            }

            // Build event cards
            const eventsContainer = document.getElementById('bulletin-events');
            const eventsScroll = document.getElementById('bulletin-events-scroll');
            eventsScroll.innerHTML = '';
            const events = data.extractedData.upcomingEvents;
            if (Array.isArray(events) && events.length > 0) {
                events.forEach(evt => {
                    const card = document.createElement('div');
                    card.className = 'bulletin-event-card';

                    const titleInput = document.createElement('input');
                    titleInput.type = 'text';
                    titleInput.className = 'bulletin-event-title';
                    titleInput.dataset.event = 'title';
                    titleInput.value = evt.title || '';
                    titleInput.placeholder = 'Event title';
                    card.appendChild(titleInput);

                    // Date row
                    const dateRow = document.createElement('div');
                    dateRow.className = 'bulletin-event-row';
                    dateRow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
                    const dateInput = document.createElement('input');
                    dateInput.type = 'text';
                    dateInput.className = 'bulletin-event-field';
                    dateInput.dataset.event = 'date';
                    dateInput.value = evt.date || '';
                    dateInput.placeholder = 'Date';
                    dateRow.appendChild(dateInput);
                    card.appendChild(dateRow);

                    // Time row
                    const timeRow = document.createElement('div');
                    timeRow.className = 'bulletin-event-row';
                    timeRow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
                    const timeInput = document.createElement('input');
                    timeInput.type = 'text';
                    timeInput.className = 'bulletin-event-field';
                    timeInput.dataset.event = 'time';
                    timeInput.value = evt.time || '';
                    timeInput.placeholder = 'Time';
                    timeRow.appendChild(timeInput);
                    card.appendChild(timeRow);

                    eventsScroll.appendChild(card);
                });
                eventsContainer.classList.remove('hidden');
            } else {
                eventsContainer.classList.add('hidden');
            }

            // Show receipt, hide progress
            bulletinProgress.classList.add('hidden');
            bulletinStatus.textContent = 'Bulletin analyzed successfully.';
            bulletinStatus.className = 'bulletin-status success';
            document.getElementById('bulletin-receipt').classList.remove('hidden');
        } else {
            bulletinProgress.classList.add('hidden');
            bulletinDropzone.classList.remove('hidden');
            bulletinStatus.textContent = "Couldn't extract details — please fill in manually.";
            bulletinStatus.className = 'bulletin-status error';
        }
    } catch (err) {
        bulletinProgress.classList.add('hidden');
        bulletinDropzone.classList.remove('hidden');
        bulletinStatus.textContent = err.message || 'Upload failed. Please try again.';
        bulletinStatus.className = 'bulletin-status error';
    }
}
toFormBtn.addEventListener('click', async () => {
    const selectedPlan = document.querySelector('input[name="plan"]:checked')?.value || 'trial';
    const subStatus = document.getElementById('subscription-status');

    if (selectedPlan === 'three_months') {
        // Paid plan — redirect to Stripe Checkout
        if (!currentUser) return showStep(0);
        subStatus.textContent = 'Redirecting to checkout...';
        subStatus.classList.remove('error');
        try {
            const idToken = await currentUser.getIdToken();
            const resp = await fetch('/api/create-subscription-checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ firebaseIdToken: idToken, plan: selectedPlan }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || 'Checkout failed');
            window.location.href = data.sessionUrl;
        } catch (err) {
            subStatus.textContent = err.message;
            subStatus.classList.add('error');
        }
    } else {
        // Free / trial plan — write trial status to Firestore and proceed to form
        if (currentUser) {
            try {
                await setDoc(doc(db, 'users', currentUser.uid), {
                    subscription: {
                        status: 'trialing',
                        plan: 'trial',
                        trialEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                        updatedAt: new Date(),
                    }
                }, { merge: true });
                hasActiveSubscription = true;
            } catch (err) {
                console.error('Failed to write trial status:', err);
            }
        }
        maxStepReached = Math.max(maxStepReached, 3);
        showStep(3);
    }
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

// ── Live geocode preview on address fields ──────────────────────────
let geocodeTimer = null;

// Single-field location inputs (blur to geocode)
const singleLocationFields = [
    { inputId: 'field-business-location', resultId: 'geocode-business' },
    { inputId: 'field-school-location', resultId: 'geocode-school' },
    { inputId: 'field-pilgrimage-location', resultId: 'geocode-pilgrimage' },
    { inputId: 'field-retreat-location', resultId: 'geocode-retreat' },
    { inputId: 'field-missionary-address', resultId: 'geocode-missionary' },
    { inputId: 'field-vocation-address', resultId: 'geocode-vocation' },
    { inputId: 'field-campus-address', resultId: 'geocode-campus' }
];

singleLocationFields.forEach(({ inputId, resultId }) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener('blur', () => {
        const value = input.value.trim();
        if (value) previewGeocode(value, resultId);
        else clearGeocode(resultId);
    });
});

// Parish: composite address — geocode when any of the 4 fields blur
const churchAddressFields = ['field-church-address', 'field-church-city', 'field-church-state', 'field-church-zip'];
churchAddressFields.forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('blur', () => {
        const parts = churchAddressFields.map(fid => val(fid)).filter(Boolean);
        if (parts.length >= 2) previewGeocode(parts.join(', '), 'geocode-church');
        else clearGeocode('geocode-church');
    });
});

async function previewGeocode(locationStr, resultId) {
    const el = document.getElementById(resultId);
    if (!el) return;
    el.textContent = 'Locating...';
    el.className = 'join-geocode-result loading';
    try {
        const { latitude, longitude } = await geocodeAddress(locationStr);
        el.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        el.className = 'join-geocode-result success';
    } catch {
        el.textContent = 'Could not resolve address';
        el.className = 'join-geocode-result error';
    }
}

function clearGeocode(resultId) {
    const el = document.getElementById(resultId);
    if (!el) return;
    el.textContent = '';
    el.className = 'join-geocode-result';
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
            source: hasActiveSubscription ? 'paid_submission' : 'free_submission',
            createdFromSubmissionId: submissionId,
            createdByUserId: currentUser.uid,
            isActive: true,
            isVerified: false,
            isPremium: hasActiveSubscription,
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

            // Write structured schedules if available
            if (structuredSchedules) {
                if (Object.keys(structuredSchedules.massSchedule).length > 0) {
                    objectData.massSchedule = structuredSchedules.massSchedule;
                }
                if (Object.keys(structuredSchedules.confessionSchedule).length > 0) {
                    objectData.confessionSchedule = structuredSchedules.confessionSchedule;
                }
                if (Object.keys(structuredSchedules.adorationSchedule).length > 0) {
                    objectData.adorationSchedule = structuredSchedules.adorationSchedule;
                }
            }

            // Include bulletin data if uploaded
            if (bulletinUrl) {
                objectData.latestBulletinURLs = [bulletinUrl];
                objectData.bulletinSubmittedAt = serverTimestamp();
            }
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

// Handle return from Stripe Checkout
const urlParams = new URLSearchParams(window.location.search);
const stripeSessionId = urlParams.get('session_id');
const returnStep = urlParams.get('step');

if (stripeSessionId && returnStep === 'form') {
    // User returned from Stripe — mark subscription as active and go to form
    hasActiveSubscription = true;
    // Wait for auth to resolve, then jump to form step
    const unsubReturn = onAuthStateChanged(auth, async (user) => {
        if (!user) return;
        unsubReturn();
        // Check Firestore for subscription status (webhook may have already written it)
        try {
            const userSnap = await getDoc(doc(db, 'users', user.uid));
            if (userSnap.exists() && userSnap.data().subscription?.status) {
                hasActiveSubscription = ['trialing', 'active'].includes(userSnap.data().subscription.status);
            }
        } catch (err) {
            console.error('Failed to check subscription status:', err);
        }
        maxStepReached = 3;
        showStep(3);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
    });
} else if (urlParams.get('canceled') === 'true') {
    // User canceled Stripe checkout
    const subStatus = document.getElementById('subscription-status');
    if (subStatus) {
        subStatus.textContent = 'Checkout was canceled. You can try again or choose the free plan.';
        subStatus.classList.add('error');
    }
    // Wait for auth, then show subscription step
    const unsubCancel = onAuthStateChanged(auth, (user) => {
        if (!user) return;
        unsubCancel();
        maxStepReached = Math.max(maxStepReached, 2);
        showStep(2);
        window.history.replaceState({}, document.title, window.location.pathname);
    });
}

// Initialize
if (!stripeSessionId && urlParams.get('canceled') !== 'true') {
    showStep(0);
}
