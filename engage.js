import { auth, db, googleProvider, appleProvider } from './firebase-config.js';
import {
    GoogleAuthProvider,
    OAuthProvider,
    signInWithPopup,
    sendSignInLinkToEmail,
    isSignInWithEmailLink,
    signInWithEmailLink,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    addDoc,
    setDoc,
    updateDoc,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
    serverTimestamp,
    Timestamp
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// ==========================================================================
// State
// ==========================================================================
const state = {
    currentUser: null,
    currentSection: 'home',
    organizations: [],
    threads: [],
    invitations: [],
    suggestions: [],
    activeOrgId: null,
    activeOrg: null,
    activeThreadId: null,
    activeChannelId: null,
    listeners: [],
    userProfile: null,       // Firestore user document
    userPhotoURL: null,      // Resolved profile photo URL
    photoCache: {},          // userId → photoURL cache
    // Mentorship
    mentorProfile: null,     // Current user's MentorProfile (or null)
    mentorConfig: null,      // MentorshipConfig doc
    mentorMatches: [],       // Computed matches from API
    mentorOnboardingStep: 0, // 0=role, 1=resume, 2=form
    mentorSelectedRole: null,// 'Mentor' | 'Mentee' | 'Both'
    mentorParsedProfile: null, // AI-parsed resume fields
    mentorConnectTarget: null  // Profile being connected to
};

// ==========================================================================
// DOM References
// ==========================================================================
const $ = (id) => document.getElementById(id);
const authGate = $('eg-auth-gate');
const app = $('eg-app');
const sidebar = $('eg-sidebar');
const sidebarToggle = $('eg-sidebar-toggle');
const sidebarBackdrop = $('eg-sidebar-backdrop');

// ==========================================================================
// Auth
// ==========================================================================
function setAuthStatus(msg, isError = false) {
    const el = $('eg-auth-status');
    el.textContent = msg;
    el.classList.toggle('error', isError);
}

$('eg-btn-google').addEventListener('click', async () => {
    try {
        googleProvider.setCustomParameters({ prompt: 'select_account' });
        await signInWithPopup(auth, googleProvider);
    } catch (err) {
        setAuthStatus(err.message, true);
    }
});

$('eg-btn-apple').addEventListener('click', async () => {
    try {
        appleProvider.addScope('email');
        await signInWithPopup(auth, appleProvider);
    } catch (err) {
        setAuthStatus(err.message, true);
    }
});

$('eg-btn-email').addEventListener('click', () => {
    $('eg-email-form').classList.toggle('hidden');
});

$('eg-email-send').addEventListener('click', async () => {
    const email = $('eg-email-input').value.trim();
    if (!email) return setAuthStatus('Enter a valid email.', true);
    const actionCodeSettings = {
        url: `${window.location.origin}/engage.html?emailSignIn=1`,
        handleCodeInApp: true
    };
    try {
        await sendSignInLinkToEmail(auth, email, actionCodeSettings);
        window.localStorage.setItem('engageEmailForSignIn', email);
        setAuthStatus('Check your email for the sign-in link.');
    } catch (err) {
        setAuthStatus(err.message, true);
    }
});

// Handle email link sign-in redirect
if (isSignInWithEmailLink(auth, window.location.href)) {
    const storedEmail = window.localStorage.getItem('engageEmailForSignIn');
    const email = storedEmail || window.prompt('Confirm your email');
    if (email) {
        signInWithEmailLink(auth, email, window.location.href)
            .then(() => {
                window.localStorage.removeItem('engageEmailForSignIn');
                window.history.replaceState({}, document.title, window.location.pathname);
            })
            .catch(err => setAuthStatus(err.message, true));
    }
}

onAuthStateChanged(auth, async (user) => {
    state.currentUser = user;
    if (user) {
        // Load profile + preload photo BEFORE showing the app (no flash)
        await loadUserProfile();
        const name = user.displayName || state.userProfile?.displayName || user.email || 'User';
        $('eg-user-name').textContent = name;
        setAvatarPhoto($('eg-user-avatar'), state.userPhotoURL, name);

        authGate.classList.add('hidden');
        app.classList.remove('hidden');
        loadAllData();
    } else {
        authGate.classList.remove('hidden');
        app.classList.add('hidden');
        cleanupListeners();
    }
});

// Strip :443 port from Firebase Storage URLs (iOS SDK writes them this way, breaks browser loading)
const cleanURL = (url) => url ? url.replace(':443/', '/') : null;

function setAvatarPhoto(el, photoURL, fallbackName) {
    if (photoURL) {
        const img = document.createElement('img');
        img.src = photoURL;
        img.alt = '';
        img.onerror = () => { el.textContent = (fallbackName || '?').charAt(0).toUpperCase(); };
        el.innerHTML = '';
        el.appendChild(img);
    } else {
        el.textContent = (fallbackName || '?').charAt(0).toUpperCase();
    }
}

// Preload an image and resolve when loaded (or on error)
function preloadImage(url) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(url);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

// Load user profile from Firestore
async function loadUserProfile() {
    if (!state.currentUser) return;
    try {
        const userDoc = await getDoc(doc(db, 'users', state.currentUser.uid));
        if (userDoc.exists()) {
            state.userProfile = userDoc.data();
            const photoURL = cleanURL(state.userProfile.photoURL) || cleanURL(state.currentUser.photoURL);
            if (photoURL) {
                await preloadImage(photoURL);
                state.userPhotoURL = photoURL;
                state.photoCache[state.currentUser.uid] = photoURL;
            }
        }
    } catch (err) {
        console.error('Error loading user profile:', err);
    }
}

// Load photo URL for another user (with cache)
async function getUserPhotoURL(userId) {
    if (state.photoCache[userId] !== undefined) return state.photoCache[userId];
    try {
        const userDoc = await getDoc(doc(db, 'users', userId));
        if (userDoc.exists()) {
            const url = cleanURL(userDoc.data().photoURL);
            state.photoCache[userId] = url;
            return url;
        }
    } catch (err) {
        // Silently fail — will show initial instead
    }
    state.photoCache[userId] = null;
    return null;
}

// Render profile section
async function renderProfileSection() {
    const user = state.currentUser;
    if (!user) return;
    const profile = state.userProfile || {};
    const name = user.displayName || profile.displayName || user.email || 'User';
    const photoURL = state.userPhotoURL || user.photoURL;

    // Photo
    setAvatarPhoto($('eg-profile-photo'), photoURL, name);

    // Name and username
    $('eg-profile-name').textContent = name;
    $('eg-profile-username').textContent = profile.username ? `@${profile.username}` : 'Nave Member';

    // Friends count — query subcollection
    const friendCount = await loadFriendsCount(user.uid);
    $('eg-profile-friends').textContent = friendCount;

    // Networks count
    $('eg-profile-networks').textContent = state.organizations.length;

    // Keys count — deduplicate by objectId (matches iOS behavior)
    const uniqueIds = new Set();
    if (profile.associatedObjects) {
        for (const [, arr] of Object.entries(profile.associatedObjects)) {
            if (Array.isArray(arr)) {
                for (const a of arr) {
                    if (a.isActive !== false && a.objectId) uniqueIds.add(a.objectId);
                }
            }
        }
    }
    $('eg-profile-keys').textContent = uniqueIds.size;

    // Home parish and campus
    loadProfileParish(profile.homeParishId);
    loadProfileCampus(profile.homeCampusMinistryId);
}

async function loadFriendsCount(userId) {
    try {
        // Try newer "connections" subcollection first (matches iOS ConnectionService)
        const connectionsSnap = await getDocs(collection(db, 'users', userId, 'connections'));
        if (connectionsSnap.size > 0) return connectionsSnap.size;

        // Fallback: legacy "friends" subcollection with status == "active"
        const friendsQ = query(
            collection(db, 'users', userId, 'friends'),
            where('status', '==', 'active')
        );
        const friendsSnap = await getDocs(friendsQ);
        return friendsSnap.size;
    } catch (err) {
        console.error('Error loading friends count:', err);
        return 0;
    }
}

async function loadProfileParish(parishId) {
    const el = $('eg-profile-parish');
    if (!parishId) { el.textContent = 'Not set'; return; }
    try {
        const d = await getDoc(doc(db, 'Churches', parishId));
        el.textContent = d.exists() ? d.data().name : 'Not set';
    } catch { el.textContent = 'Not set'; }
}

async function loadProfileCampus(campusId) {
    const el = $('eg-profile-campus');
    if (!campusId) { el.textContent = 'Not set'; return; }
    try {
        const d = await getDoc(doc(db, 'bibleStudies', campusId));
        el.textContent = d.exists() ? d.data().name : 'Not set';
    } catch { el.textContent = 'Not set'; }
}

// ==========================================================================
// Navigation — Sidebar + Sections
// ==========================================================================
document.querySelectorAll('.eg-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        navigateTo(btn.dataset.section);
    });
});

document.querySelectorAll('.eg-card-link').forEach(btn => {
    btn.addEventListener('click', () => {
        navigateTo(btn.dataset.goto);
    });
});

function navigateTo(section) {
    state.currentSection = section;

    // Update sidebar active state
    document.querySelectorAll('.eg-nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === section);
    });

    // Update mobile tab active state
    document.querySelectorAll('.eg-mobile-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.section === section);
    });

    // Highlight user-info button when profile is active
    $('eg-user-info').classList.toggle('eg-user-info-active', section === 'profile');

    // Show active section
    document.querySelectorAll('.eg-section').forEach(sec => {
        sec.classList.toggle('active', sec.id === `eg-section-${section}`);
    });

    // Close mobile sidebar
    sidebar.classList.remove('open');
    sidebarBackdrop.classList.remove('visible');
}

// Mobile sidebar toggle
sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    sidebarBackdrop.classList.toggle('visible');
});

sidebarBackdrop.addEventListener('click', () => {
    sidebar.classList.remove('open');
    sidebarBackdrop.classList.remove('visible');
});

// Mobile tab bar navigation
document.querySelectorAll('.eg-mobile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        navigateTo(tab.dataset.section);
    });
});

// Profile section navigation
$('eg-user-info').addEventListener('click', () => {
    navigateTo('profile');
    renderProfileSection();
});

// ==========================================================================
// Filter Tabs (Inbox)
// ==========================================================================
$('eg-inbox-filters').addEventListener('click', (e) => {
    const tab = e.target.closest('.eg-filter-tab');
    if (!tab) return;
    document.querySelectorAll('.eg-filter-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderThreads(tab.dataset.filter);
});

// ==========================================================================
// Data Loading
// ==========================================================================
async function loadAllData() {
    await Promise.all([
        loadOrganizations(),
        loadThreads(),
        loadInvitations(),
        loadSuggestions()
    ]);
    renderHomePreview();
    renderProfileSection();
}

// ── Organizations ──────────────────────────────────────────────────────
async function loadOrganizations() {
    try {
        // First try to load orgs user is a member of
        const memberQ = query(
            collection(db, 'organizationMembers'),
            where('userId', '==', state.currentUser.uid)
        );
        const memberSnap = await getDocs(memberQ);
        const orgIds = memberSnap.docs.map(d => d.data().organizationId).filter(Boolean);

        if (orgIds.length > 0) {
            const orgs = [];
            for (const orgId of orgIds) {
                const orgDoc = await getDoc(doc(db, 'organizations', orgId));
                if (orgDoc.exists()) {
                    orgs.push({ id: orgDoc.id, ...orgDoc.data() });
                }
            }
            state.organizations = orgs;
        } else {
            // Fallback: load all organizations (for users who aren't members yet)
            const orgSnap = await getDocs(collection(db, 'organizations'));
            state.organizations = orgSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }
        renderOrganizations();
    } catch (err) {
        console.error('Error loading organizations:', err);
        state.organizations = [];
        renderOrganizations();
    }
}

// ── Threads (real-time) ────────────────────────────────────────────────
async function loadThreads() {
    try {
        const threadsQ = query(
            collection(db, 'messages_threads'),
            where('participantIds', 'array-contains', state.currentUser.uid),
            orderBy('lastMessageAt', 'desc'),
            limit(50)
        );

        const unsub = onSnapshot(threadsQ, (snap) => {
            state.threads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderThreads();
            renderHomePreview();
            updateInboxBadge();
        }, (err) => {
            console.error('Thread listener error:', err);
            // Fallback: try without orderBy (index may not exist)
            loadThreadsFallback();
        });

        state.listeners.push(unsub);
    } catch (err) {
        console.error('Error loading threads:', err);
        loadThreadsFallback();
    }
}

async function loadThreadsFallback() {
    try {
        const threadsQ = query(
            collection(db, 'messages_threads'),
            where('participantIds', 'array-contains', state.currentUser.uid)
        );
        const snap = await getDocs(threadsQ);
        state.threads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        state.threads.sort((a, b) => {
            const aTime = a.lastMessageAt?.toMillis?.() || 0;
            const bTime = b.lastMessageAt?.toMillis?.() || 0;
            return bTime - aTime;
        });
        renderThreads();
        renderHomePreview();
        updateInboxBadge();
    } catch (err) {
        console.error('Fallback thread load error:', err);
    }
}

// ── Invitations ────────────────────────────────────────────────────────
async function loadInvitations() {
    try {
        const invQ = query(
            collection(db, 'invitations'),
            where('userId', '==', state.currentUser.uid),
            where('status', '==', 'pending')
        );
        const snap = await getDocs(invQ);
        state.invitations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderInvitations();
        updateDiscoveryBadge();
    } catch (err) {
        console.error('Error loading invitations:', err);
    }
}

// ── Suggestions (orgs user is NOT a member of) ─────────────────────────
async function loadSuggestions() {
    try {
        const allOrgsSnap = await getDocs(collection(db, 'organizations'));
        const allOrgs = allOrgsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const memberOrgIds = new Set(state.organizations.map(o => o.id));
        state.suggestions = allOrgs.filter(o => !memberOrgIds.has(o.id));
        renderSuggestions();
    } catch (err) {
        console.error('Error loading suggestions:', err);
    }
}

// ==========================================================================
// Rendering
// ==========================================================================

// ── Utility ────────────────────────────────────────────────────────────
function getOrgColor(org) {
    if (org.accentColorHex) return org.accentColorHex;
    const colors = ['#4C8BF5', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#5AC8FA'];
    let hash = 0;
    for (const ch of (org.name || '')) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
    return colors[Math.abs(hash) % colors.length];
}

function getOrgInitials(org) {
    const name = org.name || '?';
    const words = name.split(/\s+/);
    return words.length >= 2
        ? (words[0][0] + words[1][0]).toUpperCase()
        : name.substring(0, 2).toUpperCase();
}

// Logo asset mapping: Firestore logoURL/logoAssetName → web asset path
const logoAssetMap = {
    'sentdove': 'assets/logo-sentdove.png',
    'navewhitelogo': 'assets/whitenavelogo.png',
    'clilogofinal': 'assets/logo-clilogofinal.png',
    'focuslogo': 'assets/logo-focus.png',
};

function getOrgLogoSrc(org) {
    // Check logoAssetName first, then logoURL
    const key = org.logoAssetName || org.logoURL;
    if (key && logoAssetMap[key]) return logoAssetMap[key];
    // If logoURL looks like an actual URL, use it directly
    if (org.logoURL && (org.logoURL.startsWith('http://') || org.logoURL.startsWith('https://'))) {
        return org.logoURL;
    }
    return null;
}

function renderOrgAvatar(org, sizeClass = '') {
    const logoSrc = getOrgLogoSrc(org);
    const bgColor = org.backgroundColorHex || getOrgColor(org);
    if (logoSrc) {
        return `<div class="eg-org-avatar ${sizeClass}" style="background:${bgColor}"><img src="${logoSrc}" alt="" class="eg-org-logo-img"></div>`;
    }
    return `<div class="eg-org-avatar ${sizeClass}" style="background:${bgColor}">${getOrgInitials(org)}</div>`;
}

function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatFullTime(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ── Organizations ──────────────────────────────────────────────────────
function renderOrganizations(filter = '') {
    const container = $('eg-org-list');
    const orgs = filter
        ? state.organizations.filter(o => o.name?.toLowerCase().includes(filter.toLowerCase()))
        : state.organizations;

    if (orgs.length === 0) {
        container.innerHTML = `<div class="eg-empty-state">${filter ? 'No matches found' : 'No organizations yet'}</div>`;
        return;
    }

    container.innerHTML = orgs.map(org => `
        <div class="eg-org-row" data-org-id="${org.id}">
            ${renderOrgAvatar(org)}
            <div class="eg-org-info">
                <div class="eg-org-name">${escapeHtml(org.name || 'Unnamed')}</div>
                <div class="eg-org-tagline">${escapeHtml(org.tagline || org.description || '')}</div>
            </div>
            <span class="eg-org-arrow">&rsaquo;</span>
        </div>
    `).join('');

    container.querySelectorAll('.eg-org-row').forEach(row => {
        row.addEventListener('click', () => openOrgModal(row.dataset.orgId));
    });
}

// Search handler
$('eg-org-search').addEventListener('input', (e) => {
    renderOrganizations(e.target.value);
});

// ── Threads ────────────────────────────────────────────────────────────
function getThreadOtherPhotoURL(thread) {
    // Use denormalized participantPhotoURLs when available (no extra reads)
    if (thread.participantPhotoURLs) {
        const uid = state.currentUser.uid;
        for (const [id, url] of Object.entries(thread.participantPhotoURLs)) {
            if (id !== uid && url) return cleanURL(url);
        }
    }
    return null;
}

function renderThreads(filter = 'all') {
    const container = $('eg-thread-list');
    let threads = state.threads;

    if (filter !== 'all') {
        threads = threads.filter(t => (t.category || 'direct').toLowerCase() === filter);
    }

    if (threads.length === 0) {
        container.innerHTML = '<div class="eg-empty-state">No message threads</div>';
        return;
    }

    // Seed photo cache from thread data to avoid extra Firestore reads
    for (const t of threads) {
        if (t.participantPhotoURLs) {
            for (const [id, url] of Object.entries(t.participantPhotoURLs)) {
                if (url && state.photoCache[id] === undefined) {
                    state.photoCache[id] = cleanURL(url);
                }
            }
        }
    }

    container.innerHTML = threads.map(t => {
        const otherName = getThreadDisplayName(t);
        const initial = otherName.charAt(0).toUpperCase();
        const otherId = getThreadOtherUserId(t);
        const inlinePhoto = getThreadOtherPhotoURL(t) || state.photoCache[otherId];
        const isUnread = t.unreadCount?.[state.currentUser.uid] > 0;
        const avatarContent = inlinePhoto
            ? `<img src="${escapeHtml(inlinePhoto)}" alt="" onerror="this.replaceWith(document.createTextNode('${initial}'))">`
            : initial;
        return `
            <div class="eg-thread-row" data-thread-id="${t.id}" data-other-id="${otherId || ''}">
                <div class="eg-thread-avatar" data-uid="${otherId || ''}">${avatarContent}</div>
                <div class="eg-thread-info">
                    <div class="eg-thread-name">${escapeHtml(otherName)}</div>
                    <div class="eg-thread-preview">${escapeHtml(t.lastMessage || '')}</div>
                </div>
                <div class="eg-thread-meta">
                    <span class="eg-thread-time">${formatTime(t.lastMessageAt)}</span>
                    ${isUnread ? '<div class="eg-thread-unread"></div>' : ''}
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.eg-thread-row').forEach(row => {
        row.addEventListener('click', () => openDmChat(row.dataset.threadId));
    });

    // Only fetch photos for avatars that don't already have an image
    loadThreadAvatarPhotos(container);
}

function getThreadDisplayName(thread) {
    if (thread.participantNames) {
        const names = thread.participantNames;
        const uid = state.currentUser.uid;
        for (const [id, name] of Object.entries(names)) {
            if (id !== uid) return name;
        }
    }
    return thread.title || 'Conversation';
}

function getThreadOtherUserId(thread) {
    if (thread.participantIds) {
        const uid = state.currentUser.uid;
        return thread.participantIds.find(id => id !== uid) || null;
    }
    return null;
}

async function loadThreadAvatarPhotos(container) {
    const avatars = container.querySelectorAll('.eg-thread-avatar[data-uid]');
    const pending = [];
    for (const el of avatars) {
        const uid = el.dataset.uid;
        if (!uid || el.querySelector('img')) continue; // skip if already has photo
        pending.push(
            getUserPhotoURL(uid).then(photoURL => {
                if (photoURL) setAvatarPhoto(el, photoURL, el.textContent);
            })
        );
    }
    await Promise.all(pending);
}

function updateInboxBadge() {
    const count = state.threads.reduce((sum, t) => {
        return sum + (t.unreadCount?.[state.currentUser.uid] || 0);
    }, 0);
    const badge = $('eg-inbox-badge');
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// ── Invitations ────────────────────────────────────────────────────────
function renderInvitations() {
    const container = $('eg-invitations-list');
    if (state.invitations.length === 0) {
        container.innerHTML = '<div class="eg-empty-state">No pending invitations</div>';
        return;
    }

    container.innerHTML = state.invitations.map(inv => {
        // Try to find the org to get its logo
        const invOrg = state.organizations.find(o => o.id === inv.organizationId)
            || state.suggestions.find(o => o.id === inv.organizationId);
        const avatarHtml = invOrg ? renderOrgAvatar(invOrg) : `<div class="eg-org-avatar" style="background:#4C8BF5">${(inv.organizationName || '?')[0].toUpperCase()}</div>`;
        return `
        <div class="eg-invitation-row" data-inv-id="${inv.id}">
            ${avatarHtml}
            <div class="eg-invitation-info">
                <div class="eg-invitation-name">${escapeHtml(inv.organizationName || 'Organization')}</div>
                <div class="eg-invitation-from">Invited by ${escapeHtml(inv.invitedByName || 'someone')}</div>
            </div>
            <div class="eg-invitation-actions">
                <button class="eg-btn-accept" data-inv-id="${inv.id}">Accept</button>
                <button class="eg-btn-decline" data-inv-id="${inv.id}">Decline</button>
            </div>
        </div>
    `; }).join('');

    container.querySelectorAll('.eg-btn-accept').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleInvitation(btn.dataset.invId, 'accepted');
        });
    });

    container.querySelectorAll('.eg-btn-decline').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleInvitation(btn.dataset.invId, 'declined');
        });
    });
}

// ── Suggestions ────────────────────────────────────────────────────────
function renderSuggestions() {
    const container = $('eg-suggestions-list');
    if (state.suggestions.length === 0) {
        container.innerHTML = '<div class="eg-empty-state">No suggestions available</div>';
        return;
    }

    container.innerHTML = state.suggestions.map(org => `
        <div class="eg-suggestion-row" data-org-id="${org.id}">
            ${renderOrgAvatar(org)}
            <div class="eg-suggestion-info">
                <div class="eg-suggestion-name">${escapeHtml(org.name || 'Organization')}</div>
                <div class="eg-suggestion-desc">${escapeHtml(org.tagline || org.description || '')}</div>
            </div>
            <button class="eg-btn-interest" data-org-id="${org.id}">Express Interest</button>
        </div>
    `).join('');

    container.querySelectorAll('.eg-btn-interest').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            expressInterest(btn.dataset.orgId, btn);
        });
    });
}

function updateDiscoveryBadge() {
    const count = state.invitations.length;
    const badge = $('eg-discovery-badge');
    if (count > 0) {
        badge.textContent = count;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// ── Home Preview ───────────────────────────────────────────────────────
function renderHomePreview() {
    // Inbox preview (first 2 threads)
    const inboxContainer = $('eg-home-inbox');
    if (state.threads.length > 0) {
        const preview = state.threads.slice(0, 2);
        inboxContainer.innerHTML = preview.map(t => {
            const name = getThreadDisplayName(t);
            const otherId = getThreadOtherUserId(t);
            const initial = name.charAt(0).toUpperCase();
            const inlinePhoto = getThreadOtherPhotoURL(t) || state.photoCache[otherId];
            const avatarContent = inlinePhoto
                ? `<img src="${escapeHtml(inlinePhoto)}" alt="" onerror="this.replaceWith(document.createTextNode('${initial}'))">`
                : initial;
            return `
                <div class="eg-thread-row" data-thread-id="${t.id}">
                    <div class="eg-thread-avatar" data-uid="${otherId || ''}">${avatarContent}</div>
                    <div class="eg-thread-info">
                        <div class="eg-thread-name">${escapeHtml(name)}</div>
                        <div class="eg-thread-preview">${escapeHtml(t.lastMessage || '')}</div>
                    </div>
                    <div class="eg-thread-meta">
                        <span class="eg-thread-time">${formatTime(t.lastMessageAt)}</span>
                    </div>
                </div>
            `;
        }).join('');
        inboxContainer.querySelectorAll('.eg-thread-row').forEach(row => {
            row.addEventListener('click', () => openDmChat(row.dataset.threadId));
        });
        loadThreadAvatarPhotos(inboxContainer);
    } else {
        inboxContainer.innerHTML = '<div class="eg-empty-state">No messages yet</div>';
    }

    // Network preview (first 5 orgs)
    const networkContainer = $('eg-home-network');
    if (state.organizations.length > 0) {
        const preview = state.organizations.slice(0, 5);
        networkContainer.innerHTML = preview.map(org => `
            <div class="eg-org-row" data-org-id="${org.id}">
                ${renderOrgAvatar(org)}
                <div class="eg-org-info">
                    <div class="eg-org-name">${escapeHtml(org.name || 'Unnamed')}</div>
                    <div class="eg-org-tagline">${escapeHtml(org.tagline || '')}</div>
                </div>
                <span class="eg-org-arrow">&rsaquo;</span>
            </div>
        `).join('');
        networkContainer.querySelectorAll('.eg-org-row').forEach(row => {
            row.addEventListener('click', () => openOrgModal(row.dataset.orgId));
        });
    } else {
        networkContainer.innerHTML = '<div class="eg-empty-state">No organizations yet</div>';
    }

    // Discovery preview (top 3 suggestions)
    const discoveryContainer = $('eg-home-discovery');
    let discoveryHtml = '';
    if (state.invitations.length > 0) {
        discoveryHtml += `<div style="padding:0.5rem;color:var(--color-text-muted);font-size:0.85rem">${state.invitations.length} pending invitation${state.invitations.length > 1 ? 's' : ''}</div>`;
    }
    if (state.suggestions.length > 0) {
        discoveryHtml += state.suggestions.slice(0, 3).map(org => `
            <div class="eg-org-row" data-org-id="${org.id}">
                ${renderOrgAvatar(org)}
                <div class="eg-org-info">
                    <div class="eg-org-name">${escapeHtml(org.name || 'Organization')}</div>
                    <div class="eg-org-tagline">${escapeHtml(org.tagline || org.description || '')}</div>
                </div>
                <span class="eg-org-arrow">&rsaquo;</span>
            </div>
        `).join('');
    }
    if (discoveryHtml) {
        discoveryContainer.innerHTML = discoveryHtml;
        discoveryContainer.querySelectorAll('.eg-org-row').forEach(row => {
            row.addEventListener('click', () => openOrgModal(row.dataset.orgId));
        });
    } else {
        discoveryContainer.innerHTML = '<div class="eg-empty-state">No suggestions yet</div>';
    }
}

// ==========================================================================
// Organization Detail Modal
// ==========================================================================
async function openOrgModal(orgId) {
    const org = state.organizations.find(o => o.id === orgId)
        || state.suggestions.find(o => o.id === orgId);
    if (!org) return;

    state.activeOrgId = orgId;
    state.activeOrg = org;

    // Set header
    const avatarEl = $('eg-org-avatar-lg');
    const logoSrc = getOrgLogoSrc(org);
    const bgColor = org.backgroundColorHex || getOrgColor(org);
    avatarEl.style.background = bgColor;
    if (logoSrc) {
        avatarEl.innerHTML = `<img src="${logoSrc}" alt="" class="eg-org-logo-img">`;
    } else {
        avatarEl.textContent = getOrgInitials(org);
    }
    $('eg-org-modal-name').textContent = org.name || 'Organization';
    $('eg-org-modal-desc').textContent = org.tagline || org.description || '';

    // Build tabs dynamically based on org
    const tabsContainer = document.querySelector('.eg-org-tabs');
    const features = org.features || [];
    const isSent = orgId === 'sent-ventures';
    const hasMentorship = features.includes('mentorship') || isSent;
    const hasForums = features.includes('forums');

    let tabsHtml = '';
    let defaultTab = 'channels';

    if (isSent) {
        // SENT Ventures: Home + Mentorship only
        tabsHtml = '<button class="eg-org-tab active" data-tab="sent-home">Home</button>';
        tabsHtml += '<button class="eg-org-tab" data-tab="mentorship">Mentorship</button>';
        defaultTab = 'sent-home';
    } else {
        tabsHtml = '<button class="eg-org-tab active" data-tab="channels">Channels</button>';
        if (hasMentorship) {
            tabsHtml += '<button class="eg-org-tab" data-tab="mentorship">Mentorship</button>';
        }
        if (hasForums) {
            tabsHtml += '<button class="eg-org-tab" data-tab="forums">Forums</button>';
        }
        tabsHtml += '<button class="eg-org-tab" data-tab="resources">Resources</button>';
    }
    tabsContainer.innerHTML = tabsHtml;

    // Re-bind tab click listeners
    tabsContainer.querySelectorAll('.eg-org-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            tabsContainer.querySelectorAll('.eg-org-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            loadOrgTabContent(tab.dataset.tab);
        });
    });

    // Load default tab
    await loadOrgTabContent(defaultTab);

    // Show modal
    $('eg-org-modal').classList.remove('hidden');
}

async function loadOrgTabContent(tabName) {
    const container = $('eg-org-tab-content');
    container.innerHTML = '<div class="eg-loading">Loading</div>';

    const orgId = state.activeOrgId;

    try {
        if (tabName === 'sent-home') {
            renderSentHome(container);
            return;

        } else if (tabName === 'channels') {
            const snap = await getDocs(collection(db, 'organizations', orgId, 'channels'));
            const channels = snap.docs.map(d => ({ id: d.id, ...d.data() }));

            if (channels.length === 0) {
                container.innerHTML = '<div class="eg-empty-state">No channels yet</div>';
                return;
            }

            container.innerHTML = channels.map(ch => `
                <div class="eg-channel-row" data-channel-id="${ch.id}" data-org-id="${orgId}">
                    <span class="eg-channel-icon">#</span>
                    <span class="eg-channel-name">${escapeHtml(ch.name || 'channel')}</span>
                </div>
            `).join('');

            container.querySelectorAll('.eg-channel-row').forEach(row => {
                row.addEventListener('click', () => {
                    openChannelChat(row.dataset.orgId, row.dataset.channelId, row.querySelector('.eg-channel-name').textContent);
                });
            });

        } else if (tabName === 'forums') {
            const snap = await getDocs(collection(db, 'organizations', orgId, 'forumPosts'));
            const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));

            if (posts.length === 0) {
                container.innerHTML = '<div class="eg-empty-state">No forum posts yet</div>';
                return;
            }

            container.innerHTML = posts.map(p => `
                <div class="eg-forum-row" data-post-id="${p.id}" data-org-id="${orgId}">
                    <div class="eg-forum-title">${escapeHtml(p.title || 'Untitled')}</div>
                    <div class="eg-forum-meta">By ${escapeHtml(p.authorName || 'Anonymous')} &middot; ${formatTime(p.createdAt)}</div>
                </div>
            `).join('');

            container.querySelectorAll('.eg-forum-row').forEach(row => {
                row.addEventListener('click', () => {
                    openForumPost(row.dataset.orgId, row.dataset.postId);
                });
            });

        } else if (tabName === 'mentorship') {
            await loadMentorshipTab(container);

        } else if (tabName === 'resources') {
            // Resources are stored as a subcollection or array on the org doc
            const org = state.activeOrg;
            const resources = org.resources || [];

            if (resources.length === 0) {
                container.innerHTML = '<div class="eg-empty-state">No resources shared yet</div>';
                return;
            }

            container.innerHTML = resources.map(r => `
                <div class="eg-resource-row">
                    <div class="eg-resource-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    </div>
                    <div class="eg-resource-info">
                        <div class="eg-resource-name">${escapeHtml(r.name || r.title || 'Resource')}</div>
                        <div class="eg-resource-type">${escapeHtml(r.type || 'File')}</div>
                    </div>
                </div>
            `).join('');
        }
    } catch (err) {
        console.error(`Error loading ${tabName}:`, err);
        container.innerHTML = `<div class="eg-empty-state">Could not load ${tabName}</div>`;
    }
}

// Close org modal
$('eg-org-modal-close').addEventListener('click', () => {
    $('eg-org-modal').classList.add('hidden');
});

$('eg-org-modal').addEventListener('click', (e) => {
    if (e.target.id === 'eg-org-modal') $('eg-org-modal').classList.add('hidden');
});

// ==========================================================================
// Channel Chat Modal
// ==========================================================================
let channelMessageUnsub = null;

function openChannelChat(orgId, channelId, channelName) {
    state.activeChannelId = channelId;
    $('eg-channel-name').textContent = `#${channelName}`;
    $('eg-channel-messages').innerHTML = '<div class="eg-loading">Loading</div>';
    $('eg-channel-input').value = '';

    // Show modal
    $('eg-channel-modal').classList.remove('hidden');

    // Real-time listener for channel messages
    if (channelMessageUnsub) channelMessageUnsub();

    const messagesRef = collection(db, 'organizations', orgId, 'channels', channelId, 'messages');
    const messagesQ = query(messagesRef, orderBy('createdAt', 'asc'), limit(100));

    channelMessageUnsub = onSnapshot(messagesQ, (snap) => {
        const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderChatMessages($('eg-channel-messages'), messages);
    }, (err) => {
        console.error('Channel messages error:', err);
        // Fallback without orderBy
        getDocs(messagesRef).then(snap => {
            const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            messages.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
            renderChatMessages($('eg-channel-messages'), messages);
        });
    });
}

// Send channel message
$('eg-channel-send').addEventListener('click', () => sendChannelMessage());
$('eg-channel-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChannelMessage();
    }
});

async function sendChannelMessage() {
    const input = $('eg-channel-input');
    const text = input.value.trim();
    if (!text || !state.activeOrgId || !state.activeChannelId) return;

    input.value = '';

    try {
        const messagesRef = collection(db, 'organizations', state.activeOrgId, 'channels', state.activeChannelId, 'messages');
        await addDoc(messagesRef, {
            text: text,
            senderId: state.currentUser.uid,
            senderName: state.currentUser.displayName || state.currentUser.email || 'User',
            createdAt: serverTimestamp()
        });
    } catch (err) {
        console.error('Send channel message error:', err);
        input.value = text;
    }
}

// Close/back channel modal
$('eg-channel-back').addEventListener('click', () => {
    $('eg-channel-modal').classList.add('hidden');
    if (channelMessageUnsub) { channelMessageUnsub(); channelMessageUnsub = null; }
});

$('eg-channel-modal').addEventListener('click', (e) => {
    if (e.target.id === 'eg-channel-modal') {
        $('eg-channel-modal').classList.add('hidden');
        if (channelMessageUnsub) { channelMessageUnsub(); channelMessageUnsub = null; }
    }
});

// ==========================================================================
// DM Chat Modal
// ==========================================================================
let dmMessageUnsub = null;

function openDmChat(threadId) {
    state.activeThreadId = threadId;
    const thread = state.threads.find(t => t.id === threadId);
    $('eg-dm-name').textContent = thread ? getThreadDisplayName(thread) : 'Conversation';
    $('eg-dm-messages').innerHTML = '<div class="eg-loading">Loading</div>';
    $('eg-dm-input').value = '';

    $('eg-dm-modal').classList.remove('hidden');

    // Real-time listener for DM messages
    if (dmMessageUnsub) dmMessageUnsub();

    const messagesRef = collection(db, 'messages_threads', threadId, 'messages');
    const messagesQ = query(messagesRef, orderBy('createdAt', 'asc'), limit(100));

    dmMessageUnsub = onSnapshot(messagesQ, (snap) => {
        const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderChatMessages($('eg-dm-messages'), messages);
    }, (err) => {
        console.error('DM messages error:', err);
        getDocs(messagesRef).then(snap => {
            const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            messages.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
            renderChatMessages($('eg-dm-messages'), messages);
        });
    });
}

// Send DM
$('eg-dm-send').addEventListener('click', () => sendDmMessage());
$('eg-dm-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendDmMessage();
    }
});

async function sendDmMessage() {
    const input = $('eg-dm-input');
    const text = input.value.trim();
    if (!text || !state.activeThreadId) return;

    input.value = '';

    try {
        const messagesRef = collection(db, 'messages_threads', state.activeThreadId, 'messages');
        await addDoc(messagesRef, {
            text: text,
            senderId: state.currentUser.uid,
            senderName: state.currentUser.displayName || state.currentUser.email || 'User',
            createdAt: serverTimestamp()
        });

        // Update thread's lastMessage
        await updateDoc(doc(db, 'messages_threads', state.activeThreadId), {
            lastMessage: text,
            lastMessageAt: serverTimestamp()
        });
    } catch (err) {
        console.error('Send DM error:', err);
        input.value = text;
    }
}

// Close DM modal
$('eg-dm-back').addEventListener('click', () => {
    $('eg-dm-modal').classList.add('hidden');
    if (dmMessageUnsub) { dmMessageUnsub(); dmMessageUnsub = null; }
});

$('eg-dm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'eg-dm-modal') {
        $('eg-dm-modal').classList.add('hidden');
        if (dmMessageUnsub) { dmMessageUnsub(); dmMessageUnsub = null; }
    }
});

// ==========================================================================
// Chat Message Rendering (shared)
// ==========================================================================
function renderChatMessages(container, messages) {
    if (messages.length === 0) {
        container.innerHTML = '<div class="eg-empty-state">No messages yet</div>';
        return;
    }

    container.innerHTML = messages.map(msg => {
        const isSent = msg.senderId === state.currentUser.uid;
        return `
            <div class="eg-chat-bubble ${isSent ? 'eg-chat-bubble-sent' : 'eg-chat-bubble-received'}">
                ${!isSent ? `<div class="eg-chat-sender">${escapeHtml(msg.senderName || 'User')}</div>` : ''}
                ${escapeHtml(msg.text || '')}
                <div class="eg-chat-time">${formatFullTime(msg.createdAt)}</div>
            </div>
        `;
    }).join('');

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
}

// ==========================================================================
// SENT Ventures — Home Tab
// ==========================================================================

function renderSentHome(container) {
    container.innerHTML = `
    <div class="eg-sent-home">
        <div class="eg-sent-hero">
            <div class="eg-sent-tagline">Lead with Conviction.<br>Build Faithfully.<br>Succeed Together.</div>
            <h2 class="eg-sent-title">SENT Membership</h2>
            <p class="eg-sent-subtitle">If you want to grow faster, think bigger, and make a lasting impact, you need more than just ambition. You need a network that fuels your growth and keeps you grounded.</p>
        </div>

        <div class="eg-sent-section-label">What you'll gain as a SENT member</div>

        <div class="eg-sent-benefits">
            <div class="eg-sent-benefit">
                <div class="eg-sent-benefit-icon">&#x1F4C8;</div>
                <div class="eg-sent-benefit-text">
                    <strong>Proven Growth Strategies</strong>
                    <span>Learn and apply practices that top Catholic entrepreneurs use to scale effectively.</span>
                </div>
            </div>
            <div class="eg-sent-benefit">
                <div class="eg-sent-benefit-icon">&#x1F91D;</div>
                <div class="eg-sent-benefit-text">
                    <strong>Meaningful Peer Connections</strong>
                    <span>Build trusted relationships with leaders who understand your journey.</span>
                </div>
            </div>
            <div class="eg-sent-benefit">
                <div class="eg-sent-benefit-icon">&#x2B50;</div>
                <div class="eg-sent-benefit-text">
                    <strong>Exclusive Events &amp; Masterminds</strong>
                    <span>Get access to high-level gatherings designed to sharpen your thinking and expand your impact.</span>
                </div>
            </div>
            <div class="eg-sent-benefit">
                <div class="eg-sent-benefit-icon">&#x1F3AF;</div>
                <div class="eg-sent-benefit-text">
                    <strong>Conviction in Every Choice</strong>
                    <span>Make confident decisions that align with your mission and values.</span>
                </div>
            </div>
            <div class="eg-sent-benefit">
                <div class="eg-sent-benefit-icon">&#x1F9D1;&#x200D;&#x1F3EB;</div>
                <div class="eg-sent-benefit-text">
                    <strong>Mentorship from Experienced Leaders</strong>
                    <span>Receive guidance from those who've built lasting success without compromise.</span>
                </div>
            </div>
        </div>

        <div class="eg-sent-section-label">Your Path to Impact Starts Here</div>

        <div class="eg-sent-tiers">
            <div class="eg-sent-tier">
                <div class="eg-sent-tier-badge">Essential</div>
                <h3>SENT Essential</h3>
                <p class="eg-sent-tier-tagline">Strong foundations for lasting growth.</p>
                <p class="eg-sent-tier-desc">For Catholic entrepreneurs who want a trusted community, curated resources, and consistent peer interaction to accelerate their growth in business and faith.</p>
                <ul class="eg-sent-tier-list">
                    <li>Monthly mentor sessions to drive strategy and growth</li>
                    <li>Access to the full SENT community platform and member resources</li>
                    <li>Business and faith formation content to guide decision-making</li>
                    <li>Local community and events across the country, including annual Summit</li>
                </ul>
                <a href="https://sentventures.com" target="_blank" rel="noopener" class="eg-sent-tier-btn">Explore Essential</a>
            </div>

            <div class="eg-sent-tier eg-sent-tier-featured">
                <div class="eg-sent-tier-badge">Fellowship</div>
                <h3>SENT Fellowship</h3>
                <p class="eg-sent-tier-tagline">Your inner circle for transformational growth.</p>
                <p class="eg-sent-tier-desc">For Catholic entrepreneurs seeking deep collaboration, tight accountability, and meaningful relationships with a select group of high-caliber peers.</p>
                <ul class="eg-sent-tier-list">
                    <li>Small peer advisory groups for intimate, high-trust discussions</li>
                    <li>Gain top-tier business strategy guidance</li>
                    <li>1:1 mentoring and executive coaching</li>
                    <li>Advanced business networking and spiritual formation designed for business owners</li>
                </ul>
                <a href="https://sentventures.com" target="_blank" rel="noopener" class="eg-sent-tier-btn eg-sent-tier-btn-primary">Explore Fellowship</a>
            </div>
        </div>

        <div class="eg-sent-cta-section">
            <div class="eg-sent-cta-text">Where your faith is fuel, not friction.</div>
            <p>We unite Catholic entrepreneurs who demand excellence in business and fidelity in faith. In our vetted community, you'll find proven growth strategies, deep formation, and peers who share your mission&mdash;so trust comes built in.</p>
            <p style="margin-top:0.75rem"><strong>Join the ranks of Catholic entrepreneurs shaping the future.</strong></p>
            <a href="https://sentventures.com" target="_blank" rel="noopener" class="eg-sent-apply-btn">APPLY NOW</a>
        </div>
    </div>
    `;
}

// ==========================================================================
// Mentorship Tab
// ==========================================================================

async function loadMentorshipTab(container) {
    const orgId = state.activeOrgId;
    const userId = state.currentUser.uid;

    // Load config if not cached
    if (!state.mentorConfig) {
        try {
            const configDoc = await getDoc(doc(db, 'organizations', orgId, 'config', 'mentorship'));
            state.mentorConfig = configDoc.exists() ? configDoc.data() : null;
        } catch {
            state.mentorConfig = null;
        }
    }

    // Use defaults if no config
    const config = state.mentorConfig || {
        title: 'Mentorship',
        subtitle: 'Match with members who complement your journey',
        ctaText: 'Create Mentorship Profile',
        skills: ['Fundraising', 'Product Strategy', 'Engineering', 'Sales & Growth',
                 'Marketing', 'Hiring & Team', 'Operations', 'Legal & Compliance',
                 'Finance & Accounting', 'Design & UX', 'Partnerships', 'Faith Integration'],
        cities: ['Philadelphia', 'Chicago', 'SF', 'Houston', 'Austin', 'NYC',
                 'Boston', 'LA', 'Miami', 'Denver', 'DC', 'Dallas', 'Atlanta'],
        industries: ['EdTech', 'FinTech', 'HealthTech', 'SaaS', 'Media',
                     'E-Commerce', 'Marketplace', 'Non-Profit', 'Consulting',
                     'Food & Beverage', 'Other'],
        stages: ['Side Project', 'Pre-Seed', 'Seed', 'Series A', 'Series B'],
        experienceLevels: ['0-2', '3-5', '6-10', '10+'],
        howItWorks: ['Tell us about your venture', 'We match you with 3 members', 'Connect & schedule meetings']
    };

    // Check if user has a profile
    try {
        const profileDoc = await getDoc(doc(db, 'organizations', orgId, 'mentorProfiles', userId));
        state.mentorProfile = profileDoc.exists() ? { userId, ...profileDoc.data() } : null;
    } catch {
        state.mentorProfile = null;
    }

    if (state.mentorProfile) {
        await renderMentorDashboard(container, config);
    } else {
        state.mentorOnboardingStep = 0;
        state.mentorSelectedRole = null;
        state.mentorParsedProfile = null;
        renderMentorOnboarding(container, config);
    }
}

// ── Onboarding ──────────────────────────────────────────────────────

function renderMentorOnboarding(container, config) {
    const step = state.mentorOnboardingStep;

    let stepsHtml = '';
    for (let i = 0; i < 3; i++) {
        stepsHtml += `<div class="eg-mentor-step-dot ${i <= step ? 'active' : ''}"></div>`;
    }

    let contentHtml = '';

    if (step === 0) {
        // Step 1: Role selection
        contentHtml = `
            <div class="eg-mentor-role-cards">
                <div class="eg-mentor-role-card" data-role="Mentor">
                    <div class="eg-mentor-role-icon">&#x1F9D1;&#x200D;&#x1F3EB;</div>
                    <div class="eg-mentor-role-label">Mentor</div>
                    <div class="eg-mentor-role-desc">Guide others with your experience</div>
                </div>
                <div class="eg-mentor-role-card" data-role="Mentee">
                    <div class="eg-mentor-role-icon">&#x1F680;</div>
                    <div class="eg-mentor-role-label">Mentee</div>
                    <div class="eg-mentor-role-desc">Learn from experienced builders</div>
                </div>
                <div class="eg-mentor-role-card" data-role="Both">
                    <div class="eg-mentor-role-icon">&#x1F91D;</div>
                    <div class="eg-mentor-role-label">Both</div>
                    <div class="eg-mentor-role-desc">Mentor and be mentored</div>
                </div>
            </div>`;
    } else if (step === 1) {
        // Step 2: Resume upload
        contentHtml = `
            <div class="eg-mentor-resume-area">
                <div class="eg-mentor-dropzone" id="eg-mentor-dropzone">
                    <div class="eg-mentor-dropzone-icon">&#x1F4C4;</div>
                    <div class="eg-mentor-dropzone-text"><strong>Upload your resume</strong> (PDF)<br>or drag and drop here</div>
                    <input type="file" id="eg-mentor-file-input" accept=".pdf" style="display:none">
                </div>
                <div class="eg-mentor-resume-status" id="eg-mentor-resume-status"></div>
                <button class="eg-mentor-skip-btn" id="eg-mentor-skip-resume">Skip — I'll fill in manually</button>
            </div>`;
    } else if (step === 2) {
        // Step 3: Profile form
        const p = state.mentorParsedProfile || {};
        contentHtml = renderMentorForm(config, p);
    }

    container.innerHTML = `
        <div class="eg-mentor-onboarding">
            <h3>${config.title}</h3>
            <p>${config.subtitle}</p>
            <div class="eg-mentor-steps">${stepsHtml}</div>
            ${contentHtml}
        </div>
    `;

    // Wire up step-specific listeners
    if (step === 0) {
        container.querySelectorAll('.eg-mentor-role-card').forEach(card => {
            card.addEventListener('click', () => {
                state.mentorSelectedRole = card.dataset.role;
                state.mentorOnboardingStep = 1;
                renderMentorOnboarding(container, config);
            });
        });
    } else if (step === 1) {
        const dropzone = container.querySelector('#eg-mentor-dropzone');
        const fileInput = container.querySelector('#eg-mentor-file-input');
        const statusEl = container.querySelector('#eg-mentor-resume-status');

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file && file.type === 'application/pdf') handleResumeFile(file, container, config, statusEl);
        });
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) handleResumeFile(fileInput.files[0], container, config, statusEl);
        });

        container.querySelector('#eg-mentor-skip-resume').addEventListener('click', () => {
            state.mentorParsedProfile = {};
            state.mentorOnboardingStep = 2;
            renderMentorOnboarding(container, config);
        });
    } else if (step === 2) {
        wireMentorFormListeners(container, config);
    }
}

async function handleResumeFile(file, container, config, statusEl) {
    if (file.size > 5 * 1024 * 1024) {
        statusEl.textContent = 'File too large (max 5MB)';
        return;
    }

    statusEl.textContent = 'Extracting text from PDF...';

    try {
        // Lazy-load pdf.js
        const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

        const arrayBuffer = await file.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

        let fullText = '';
        for (let i = 1; i <= Math.min(pdfDoc.numPages, 10); i++) {
            const page = await pdfDoc.getPage(i);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map(item => item.str).join(' ') + '\n';
        }

        if (fullText.trim().length < 50) {
            statusEl.textContent = 'Could not extract enough text. Try a different PDF or fill in manually.';
            return;
        }

        statusEl.textContent = 'Parsing resume with AI...';

        // Call parse-resume API
        const idToken = await state.currentUser.getIdToken();
        const response = await fetch('/api/parse-resume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resumeText: fullText.slice(0, 20000), firebaseIdToken: idToken })
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            statusEl.textContent = err.error || 'Failed to parse resume. Filling in manually.';
            state.mentorParsedProfile = {};
            state.mentorOnboardingStep = 2;
            renderMentorOnboarding(container, config);
            return;
        }

        const data = await response.json();
        state.mentorParsedProfile = data.profile || {};
        state.mentorParsedProfile._resumeText = fullText;

        statusEl.textContent = 'Resume parsed! Filling in your profile...';
        setTimeout(() => {
            state.mentorOnboardingStep = 2;
            renderMentorOnboarding(container, config);
        }, 600);

    } catch (err) {
        console.error('Resume parse error:', err);
        statusEl.textContent = 'Error processing PDF. Filling in manually.';
        state.mentorParsedProfile = {};
        state.mentorOnboardingStep = 2;
        renderMentorOnboarding(container, config);
    }
}

function renderMentorForm(config, prefill) {
    const userName = state.currentUser.displayName || '';

    const stageOptions = (config.stages || []).map(s =>
        `<option value="${escapeHtml(s)}" ${s === prefill.businessStage ? 'selected' : ''}>${escapeHtml(s)}</option>`
    ).join('');

    const expOptions = (config.experienceLevels || []).map(e =>
        `<option value="${escapeHtml(e)}" ${e === prefill.yearsOfExperience ? 'selected' : ''}>${escapeHtml(e)} years</option>`
    ).join('');

    const cityOptions = (config.cities || []).map(c =>
        `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`
    ).join('');

    const industryPills = (config.industries || []).map(i => {
        const selected = (prefill.industries || []).includes(i) ? 'selected' : '';
        return `<button type="button" class="eg-mentor-pill ${selected}" data-field="industries" data-value="${escapeHtml(i)}">${escapeHtml(i)}</button>`;
    }).join('');

    const skillsOfferedPills = (config.skills || []).map(s => {
        const selected = (prefill.skillsOffered || []).includes(s) ? 'selected' : '';
        return `<button type="button" class="eg-mentor-pill ${selected}" data-field="skillsOffered" data-value="${escapeHtml(s)}">${escapeHtml(s)}</button>`;
    }).join('');

    const skillsNeededPills = (config.skills || []).map(s => {
        const selected = (prefill.skillsNeeded || []).includes(s) ? 'selected' : '';
        return `<button type="button" class="eg-mentor-pill ${selected}" data-field="skillsNeeded" data-value="${escapeHtml(s)}">${escapeHtml(s)}</button>`;
    }).join('');

    return `
        <div class="eg-mentor-form" id="eg-mentor-form">
            <div class="eg-mentor-form-row">
                <div class="eg-mentor-form-group">
                    <label>Display Name</label>
                    <input type="text" id="eg-mentor-displayName" value="${escapeHtml(prefill.displayName || userName)}" placeholder="Your name">
                </div>
                <div class="eg-mentor-form-group">
                    <label>Company</label>
                    <input type="text" id="eg-mentor-companyName" value="${escapeHtml(prefill.companyName || '')}" placeholder="Your company or venture">
                </div>
            </div>
            <div class="eg-mentor-form-group">
                <label>Tagline</label>
                <input type="text" id="eg-mentor-tagline" value="${escapeHtml(prefill.tagline || '')}" placeholder="One-line about your work" maxlength="80">
            </div>
            <div class="eg-mentor-form-row">
                <div class="eg-mentor-form-group">
                    <label>Business Stage</label>
                    <select id="eg-mentor-businessStage">${stageOptions}</select>
                </div>
                <div class="eg-mentor-form-group">
                    <label>Experience</label>
                    <select id="eg-mentor-yearsOfExperience">${expOptions}</select>
                </div>
            </div>
            <div class="eg-mentor-form-row">
                <div class="eg-mentor-form-group">
                    <label>City</label>
                    <select id="eg-mentor-chapterCity">${cityOptions}</select>
                </div>
                <div class="eg-mentor-form-group">
                    <label>Meeting Format</label>
                    <select id="eg-mentor-meetingFormat">
                        <option value="Either">Either</option>
                        <option value="In Person">In Person</option>
                        <option value="Virtual">Virtual</option>
                    </select>
                </div>
            </div>
            <div class="eg-mentor-form-group">
                <label>Industries</label>
                <div class="eg-mentor-multi-select" data-field="industries">${industryPills}</div>
            </div>
            <div class="eg-mentor-form-group">
                <label>Skills You Can Offer</label>
                <div class="eg-mentor-multi-select" data-field="skillsOffered">${skillsOfferedPills}</div>
            </div>
            <div class="eg-mentor-form-group">
                <label>Skills You Need Help With</label>
                <div class="eg-mentor-multi-select" data-field="skillsNeeded">${skillsNeededPills}</div>
            </div>
            <button class="eg-mentor-submit-btn" id="eg-mentor-create-btn">${escapeHtml(config.ctaText || 'Create Profile')}</button>
        </div>
    `;
}

function wireMentorFormListeners(container, config) {
    // Multi-select pill toggles
    container.querySelectorAll('.eg-mentor-pill').forEach(pill => {
        pill.addEventListener('click', () => pill.classList.toggle('selected'));
    });

    // Create profile button
    const createBtn = container.querySelector('#eg-mentor-create-btn');
    if (createBtn) {
        createBtn.addEventListener('click', () => submitMentorProfile(container, config));
    }
}

function getSelectedPills(container, fieldName) {
    return [...container.querySelectorAll(`.eg-mentor-pill.selected[data-field="${fieldName}"]`)]
        .map(p => p.dataset.value);
}

async function submitMentorProfile(container, config) {
    const btn = container.querySelector('#eg-mentor-create-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const orgId = state.activeOrgId;
    const userId = state.currentUser.uid;

    try {
        const profile = {
            userId,
            displayName: container.querySelector('#eg-mentor-displayName')?.value.trim() || state.currentUser.displayName || 'User',
            photoURL: state.currentUser.photoURL || '',
            companyName: container.querySelector('#eg-mentor-companyName')?.value.trim() || '',
            tagline: container.querySelector('#eg-mentor-tagline')?.value.trim() || '',
            businessStage: container.querySelector('#eg-mentor-businessStage')?.value || 'Side Project',
            industries: getSelectedPills(container, 'industries'),
            yearsOfExperience: container.querySelector('#eg-mentor-yearsOfExperience')?.value || '0-2',
            chapterCity: container.querySelector('#eg-mentor-chapterCity')?.value || '',
            mentorshipRole: state.mentorSelectedRole || 'Mentee',
            skillsOffered: getSelectedPills(container, 'skillsOffered'),
            skillsNeeded: getSelectedPills(container, 'skillsNeeded'),
            maxActiveMatches: 2,
            meetingFormat: container.querySelector('#eg-mentor-meetingFormat')?.value || 'Either',
            meetingDuration: 30,
            isActive: true,
            resumeText: state.mentorParsedProfile?._resumeText || '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        console.log('[Mentorship] Creating profile for', userId, 'in org', orgId);
        await setDoc(doc(db, 'organizations', orgId, 'mentorProfiles', userId), profile);
        console.log('[Mentorship] Profile created successfully');
        state.mentorProfile = { userId, ...profile };

        // Reload the mentorship tab to show dashboard
        const tabContainer = $('eg-org-tab-content');
        tabContainer.innerHTML = '<div class="eg-loading">Loading dashboard</div>';
        await renderMentorDashboard(tabContainer, config);
    } catch (err) {
        console.error('[Mentorship] Error creating profile:', err);
        btn.disabled = false;
        btn.textContent = config.ctaText || 'Create Profile';
        // Show error to user
        const errEl = container.querySelector('.eg-mentor-resume-status') || btn.parentElement;
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'color:#e74c3c;font-size:0.85rem;margin-top:0.5rem;text-align:center';
        errDiv.textContent = 'Error creating profile: ' + (err.message || 'Unknown error');
        errEl.appendChild(errDiv);
    }
}

// ── Match Dashboard ─────────────────────────────────────────────────

async function renderMentorDashboard(container, config) {
    const orgId = state.activeOrgId;
    const userId = state.currentUser.uid;
    const profile = state.mentorProfile;

    container.innerHTML = '<div class="eg-loading">Loading matches</div>';

  try {

    // Fetch matches from API (with timeout to avoid hanging)
    let matches = [];
    try {
        const idToken = await state.currentUser.getIdToken();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const response = await fetch('/api/match-mentors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orgId, firebaseIdToken: idToken }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (response.ok) {
            const data = await response.json();
            matches = data.matches || [];
        } else {
            console.warn('[Mentorship] Match API returned', response.status);
        }
    } catch (err) {
        console.warn('[Mentorship] Match API unavailable:', err.message);
    }

    // Fetch pending requests (incoming)
    let incomingRequests = [];
    let outgoingPending = [];
    let acceptedConnections = [];
    try {
        const matchSnap = await getDocs(
            query(collection(db, 'mentor_matches'), where('participantIds', 'array-contains', userId))
        );
        const allMatches = matchSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        incomingRequests = allMatches.filter(m => m.status === 'pending' && m.requestedByUserId !== userId);
        outgoingPending = allMatches.filter(m => m.status === 'pending' && m.requestedByUserId === userId);
        acceptedConnections = allMatches.filter(m => m.status === 'accepted');
    } catch (err) {
        console.error('Error fetching match status:', err);
    }

    // Load profiles for requests/connections
    const profileCache = {};
    const profilesToLoad = new Set();
    for (const m of [...incomingRequests, ...outgoingPending, ...acceptedConnections]) {
        const otherId = (m.participantIds || []).find(id => id !== userId);
        if (otherId) profilesToLoad.add(otherId);
    }
    for (const pid of profilesToLoad) {
        try {
            const pDoc = await getDoc(doc(db, 'organizations', orgId, 'mentorProfiles', pid));
            if (pDoc.exists()) profileCache[pid] = { userId: pid, ...pDoc.data() };
        } catch { /* skip */ }
    }

    // Build dashboard HTML
    let html = '<div class="eg-mentor-dashboard">';

    // Your role badge
    html += `<button class="eg-mentor-edit-profile" id="eg-mentor-edit-btn">Edit Profile</button>`;
    html += `<div style="font-size:0.85rem;color:var(--color-text-muted);margin-bottom:0.5rem">Signed up as <strong>${escapeHtml(profile.mentorshipRole)}</strong> &middot; ${escapeHtml(profile.chapterCity || '')}</div>`;

    // Incoming requests
    if (incomingRequests.length > 0) {
        html += '<div class="eg-mentor-section-title">Incoming Requests</div>';
        for (const req of incomingRequests) {
            const otherId = (req.participantIds || []).find(id => id !== userId);
            const p = profileCache[otherId] || {};
            html += `
                <div class="eg-mentor-request-row">
                    <div class="eg-mentor-match-photo">${getInitial(p.displayName)}</div>
                    <div class="eg-mentor-request-info">
                        <div class="eg-mentor-request-name">${escapeHtml(p.displayName || 'Unknown')}</div>
                        <div class="eg-mentor-request-sub">${escapeHtml(p.companyName || '')} &middot; ${escapeHtml(p.businessStage || '')}</div>
                    </div>
                    <div class="eg-mentor-request-actions">
                        <button class="eg-mentor-accept-btn" data-match-id="${req.id}">Accept</button>
                        <button class="eg-mentor-decline-btn" data-match-id="${req.id}">Decline</button>
                    </div>
                </div>`;
        }
    }

    // Suggested matches
    if (matches.length > 0) {
        html += '<div class="eg-mentor-section-title">Your Matches</div>';
        for (const m of matches) {
            const p = m.profile;
            const scorePercent = Math.round((m.score || 0) * 100);
            const photoHtml = p.photoURL
                ? `<img src="${escapeHtml(p.photoURL)}" alt="">`
                : getInitial(p.displayName);

            html += `
                <div class="eg-mentor-match-card">
                    <div class="eg-mentor-match-top">
                        <div class="eg-mentor-match-photo">${photoHtml}</div>
                        <div class="eg-mentor-match-info">
                            <div class="eg-mentor-match-name">${escapeHtml(p.displayName || 'Unknown')}</div>
                            <div class="eg-mentor-match-company">${escapeHtml(p.companyName || '')}${p.tagline ? ' — ' + escapeHtml(p.tagline) : ''}</div>
                        </div>
                        <div class="eg-mentor-match-score">${scorePercent}%</div>
                    </div>
                    <div class="eg-mentor-match-meta">
                        <span class="eg-mentor-match-tag">${escapeHtml(p.businessStage || '')}</span>
                        <span class="eg-mentor-match-tag">${escapeHtml(p.chapterCity || '')}</span>
                        <span class="eg-mentor-match-tag">${escapeHtml(p.mentorshipRole || '')}</span>
                    </div>
                    <div class="eg-mentor-match-reasons">
                        ${(m.reasons || []).map(r => `<div class="eg-mentor-match-reason">${escapeHtml(r)}</div>`).join('')}
                    </div>
                    <button class="eg-mentor-connect-action" data-connect-uid="${escapeHtml(p.userId)}"
                        data-connect-name="${escapeHtml(p.displayName || '')}"
                        data-connect-tagline="${escapeHtml(p.tagline || '')}"
                        data-connect-photo="${escapeHtml(p.photoURL || '')}"
                        data-connect-company="${escapeHtml(p.companyName || '')}"
                        data-connect-stage="${escapeHtml(p.businessStage || '')}"
                        data-connect-city="${escapeHtml(p.chapterCity || '')}"
                        data-connect-role="${escapeHtml(p.mentorshipRole || '')}"
                        data-connect-score="${m.score || 0}">Connect</button>
                </div>`;
        }
    } else {
        html += '<div class="eg-mentor-section-title">Your Matches</div>';
        html += '<div class="eg-empty-state">No matches found yet. Check back as more members join.</div>';
    }

    // Outgoing pending
    if (outgoingPending.length > 0) {
        html += '<div class="eg-mentor-section-title">Pending Requests</div>';
        for (const req of outgoingPending) {
            const otherId = (req.participantIds || []).find(id => id !== userId);
            const p = profileCache[otherId] || {};
            html += `
                <div class="eg-mentor-request-row">
                    <div class="eg-mentor-match-photo">${getInitial(p.displayName)}</div>
                    <div class="eg-mentor-request-info">
                        <div class="eg-mentor-request-name">${escapeHtml(p.displayName || 'Unknown')}</div>
                        <div class="eg-mentor-request-sub">Request sent</div>
                    </div>
                </div>`;
        }
    }

    // Active connections
    if (acceptedConnections.length > 0) {
        html += '<div class="eg-mentor-section-title">Active Connections</div>';
        for (const conn of acceptedConnections) {
            const otherId = (conn.participantIds || []).find(id => id !== userId);
            const p = profileCache[otherId] || {};
            html += `
                <div class="eg-mentor-request-row">
                    <div class="eg-mentor-match-photo">${getInitial(p.displayName)}</div>
                    <div class="eg-mentor-request-info">
                        <div class="eg-mentor-request-name">${escapeHtml(p.displayName || 'Unknown')}</div>
                        <div class="eg-mentor-request-sub">${escapeHtml(p.companyName || '')}</div>
                    </div>
                    <button class="eg-mentor-message-btn" data-dm-uid="${otherId}" data-dm-name="${escapeHtml(p.displayName || 'User')}">Message</button>
                </div>`;
        }
    }

    html += '</div>';
    container.innerHTML = html;

    // Wire event listeners
    container.querySelectorAll('.eg-mentor-accept-btn').forEach(btn => {
        btn.addEventListener('click', () => handleMentorRequest(btn.dataset.matchId, 'accepted', container, config));
    });
    container.querySelectorAll('.eg-mentor-decline-btn').forEach(btn => {
        btn.addEventListener('click', () => handleMentorRequest(btn.dataset.matchId, 'declined', container, config));
    });
    container.querySelectorAll('.eg-mentor-connect-action').forEach(btn => {
        btn.addEventListener('click', () => openConnectModal(btn));
    });
    container.querySelectorAll('.eg-mentor-message-btn').forEach(btn => {
        btn.addEventListener('click', () => openOrCreateDm(btn.dataset.dmUid, btn.dataset.dmName));
    });

    const editBtn = container.querySelector('#eg-mentor-edit-btn');
    if (editBtn) {
        editBtn.addEventListener('click', () => {
            state.mentorOnboardingStep = 2;
            state.mentorParsedProfile = state.mentorProfile;
            state.mentorSelectedRole = state.mentorProfile.mentorshipRole;
            renderMentorOnboarding(container, config);
        });
    }

  } catch (err) {
    console.error('[Mentorship] Dashboard render error:', err);
    container.innerHTML = `<div class="eg-mentor-dashboard">
        <div style="text-align:center;padding:2rem">
            <div style="font-size:0.95rem;font-weight:600;margin-bottom:0.5rem">Profile Created!</div>
            <div style="font-size:0.85rem;color:var(--color-text-muted)">Your mentorship profile is active. Matches will appear as more members join.</div>
        </div>
    </div>`;
  }
}

function getInitial(name) {
    return (name || '?').charAt(0).toUpperCase();
}

// ── Connection Request Modal ────────────────────────────────────────

function openConnectModal(btn) {
    const target = {
        userId: btn.dataset.connectUid,
        displayName: btn.dataset.connectName,
        tagline: btn.dataset.connectTagline,
        photoURL: btn.dataset.connectPhoto,
        companyName: btn.dataset.connectCompany,
        businessStage: btn.dataset.connectStage,
        chapterCity: btn.dataset.connectCity,
        mentorshipRole: btn.dataset.connectRole,
        score: parseFloat(btn.dataset.connectScore) || 0
    };
    state.mentorConnectTarget = target;

    const photoEl = $('eg-connect-photo');
    if (target.photoURL) {
        photoEl.innerHTML = `<img src="${escapeHtml(target.photoURL)}" alt="">`;
    } else {
        photoEl.textContent = getInitial(target.displayName);
    }

    $('eg-connect-name').textContent = target.displayName || 'Unknown';
    $('eg-connect-tagline').textContent = target.tagline || '';

    let details = '';
    if (target.companyName) details += `<div><strong>Company:</strong> ${escapeHtml(target.companyName)}</div>`;
    if (target.businessStage) details += `<div><strong>Stage:</strong> ${escapeHtml(target.businessStage)}</div>`;
    if (target.chapterCity) details += `<div><strong>City:</strong> ${escapeHtml(target.chapterCity)}</div>`;
    if (target.mentorshipRole) details += `<div><strong>Role:</strong> ${escapeHtml(target.mentorshipRole)}</div>`;
    $('eg-connect-details').innerHTML = details;

    $('eg-connect-message').value = '';
    $('eg-connect-send-btn').disabled = false;
    $('eg-connect-send-btn').textContent = 'Send Connection Request';

    $('eg-connect-modal').classList.remove('hidden');
}

// Connection request send handler
$('eg-connect-send-btn').addEventListener('click', async () => {
    const target = state.mentorConnectTarget;
    if (!target) return;

    const btn = $('eg-connect-send-btn');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    const userId = state.currentUser.uid;
    const profile = state.mentorProfile;

    // Determine mentor/mentee
    const isMentor = profile.mentorshipRole === 'Mentor' ||
        (profile.mentorshipRole === 'Both' && target.mentorshipRole !== 'Mentor');
    const mentorId = isMentor ? userId : target.userId;
    const menteeId = isMentor ? target.userId : userId;

    const matchDoc = {
        participantIds: [userId, target.userId].sort(),
        mentorId,
        menteeId,
        matchScore: target.score || 0,
        matchReasons: [],
        status: 'pending',
        requestedByUserId: userId,
        introMessage: $('eg-connect-message').value.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

    try {
        await addDoc(collection(db, 'mentor_matches'), matchDoc);
        btn.textContent = 'Request Sent!';

        // Update the Connect button in the dashboard
        const dashBtn = document.querySelector(`.eg-mentor-connect-action[data-connect-uid="${target.userId}"]`);
        if (dashBtn) {
            dashBtn.textContent = 'Sent';
            dashBtn.classList.add('sent');
            dashBtn.disabled = true;
        }

        setTimeout(() => {
            $('eg-connect-modal').classList.add('hidden');
        }, 800);
    } catch (err) {
        console.error('Error sending connection request:', err);
        btn.disabled = false;
        btn.textContent = 'Send Connection Request';
    }
});

// Close connection modal
$('eg-connect-modal-close').addEventListener('click', () => {
    $('eg-connect-modal').classList.add('hidden');
});
$('eg-connect-modal').addEventListener('click', (e) => {
    if (e.target.id === 'eg-connect-modal') $('eg-connect-modal').classList.add('hidden');
});

// ── Accept/Decline Match Request ────────────────────────────────────

async function handleMentorRequest(matchId, newStatus, container, config) {
    try {
        await updateDoc(doc(db, 'mentor_matches', matchId), {
            status: newStatus,
            updatedAt: serverTimestamp()
        });

        // If accepted, create a DM thread
        if (newStatus === 'accepted') {
            const matchDoc = await getDoc(doc(db, 'mentor_matches', matchId));
            if (matchDoc.exists()) {
                const matchData = matchDoc.data();
                const otherId = (matchData.participantIds || []).find(id => id !== state.currentUser.uid);
                if (otherId) {
                    const otherProfile = await getDoc(doc(db, 'organizations', state.activeOrgId, 'mentorProfiles', otherId));
                    const otherName = otherProfile.exists() ? otherProfile.data().displayName : 'User';
                    await createDmThread(otherId, otherName);
                }
            }
        }

        // Refresh the dashboard
        container.innerHTML = '<div class="eg-loading">Loading</div>';
        await renderMentorDashboard(container, config);
    } catch (err) {
        console.error('Error handling mentor request:', err);
    }
}

// ── DM Thread Creation (for accepted matches) ──────────────────────

async function createDmThread(otherUserId, otherName) {
    const userId = state.currentUser.uid;
    const userName = state.currentUser.displayName || state.currentUser.email || 'User';

    // Check if thread already exists
    try {
        const existingSnap = await getDocs(
            query(collection(db, 'messages_threads'),
                where('participantIds', 'array-contains', userId))
        );
        for (const d of existingSnap.docs) {
            const data = d.data();
            if ((data.participantIds || []).includes(otherUserId)) {
                return d.id; // Thread already exists
            }
        }
    } catch { /* proceed to create */ }

    // Create new thread
    const threadDoc = {
        participantIds: [userId, otherUserId].sort(),
        participantNames: { [userId]: userName, [otherUserId]: otherName },
        lastMessage: 'Mentorship connection accepted',
        lastMessageAt: serverTimestamp(),
        createdAt: serverTimestamp()
    };

    const ref = await addDoc(collection(db, 'messages_threads'), threadDoc);
    return ref.id;
}

async function openOrCreateDm(otherUserId, otherName) {
    try {
        const threadId = await createDmThread(otherUserId, otherName);
        // Close org modal and open DM
        $('eg-org-modal').classList.add('hidden');
        openDmChat(threadId);
    } catch (err) {
        console.error('Error opening DM:', err);
    }
}

// ==========================================================================
// Forum Post Detail Modal
// ==========================================================================
async function openForumPost(orgId, postId) {
    $('eg-forum-modal').classList.remove('hidden');
    $('eg-forum-post-title').textContent = 'Loading...';
    $('eg-forum-post-meta').textContent = '';
    $('eg-forum-post-body').textContent = '';
    $('eg-forum-replies').innerHTML = '<h4>Replies</h4><div class="eg-loading">Loading</div>';

    try {
        const postDoc = await getDoc(doc(db, 'organizations', orgId, 'forumPosts', postId));
        if (!postDoc.exists()) {
            $('eg-forum-post-title').textContent = 'Post not found';
            return;
        }

        const post = postDoc.data();
        $('eg-forum-post-title').textContent = post.title || 'Untitled';
        $('eg-forum-post-meta').textContent = `By ${post.authorName || 'Anonymous'} · ${formatTime(post.createdAt)}`;
        $('eg-forum-post-body').textContent = post.body || post.content || '';

        // Load replies
        const repliesSnap = await getDocs(collection(db, 'organizations', orgId, 'forumPosts', postId, 'replies'));
        const replies = repliesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        if (replies.length === 0) {
            $('eg-forum-replies').innerHTML = '<h4>Replies</h4><div class="eg-empty-state">No replies yet</div>';
        } else {
            $('eg-forum-replies').innerHTML = '<h4>Replies</h4>' + replies.map(r => `
                <div class="eg-reply">
                    <div class="eg-reply-author">${escapeHtml(r.authorName || 'Anonymous')}</div>
                    <div class="eg-reply-body">${escapeHtml(r.body || r.text || '')}</div>
                    <div class="eg-reply-time">${formatTime(r.createdAt)}</div>
                </div>
            `).join('');
        }
    } catch (err) {
        console.error('Error loading forum post:', err);
        $('eg-forum-post-title').textContent = 'Error loading post';
    }
}

$('eg-forum-modal-close').addEventListener('click', () => {
    $('eg-forum-modal').classList.add('hidden');
});

$('eg-forum-modal').addEventListener('click', (e) => {
    if (e.target.id === 'eg-forum-modal') $('eg-forum-modal').classList.add('hidden');
});

// ==========================================================================
// Actions
// ==========================================================================
async function handleInvitation(invId, newStatus) {
    try {
        await updateDoc(doc(db, 'invitations', invId), {
            status: newStatus,
            respondedAt: serverTimestamp()
        });
        state.invitations = state.invitations.filter(i => i.id !== invId);
        renderInvitations();
        updateDiscoveryBadge();
        renderHomePreview();

        // Reload orgs if accepted
        if (newStatus === 'accepted') {
            await loadOrganizations();
            await loadSuggestions();
            renderHomePreview();
        }
    } catch (err) {
        console.error('Error handling invitation:', err);
    }
}

async function expressInterest(orgId, btn) {
    try {
        await addDoc(collection(db, 'organizationInterests'), {
            organizationId: orgId,
            userId: state.currentUser.uid,
            userName: state.currentUser.displayName || state.currentUser.email || 'User',
            createdAt: serverTimestamp(),
            status: 'pending'
        });

        btn.textContent = 'Interest Sent';
        btn.classList.add('sent');
    } catch (err) {
        console.error('Error expressing interest:', err);
    }
}

// ==========================================================================
// Keyboard Shortcuts
// ==========================================================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Close modals in order (topmost first)
        if (!$('eg-connect-modal').classList.contains('hidden')) {
            $('eg-connect-modal').classList.add('hidden');
        } else if (!$('eg-profile-modal').classList.contains('hidden')) {
            $('eg-profile-modal').classList.add('hidden');
        } else if (!$('eg-channel-modal').classList.contains('hidden')) {
            $('eg-channel-modal').classList.add('hidden');
            if (channelMessageUnsub) { channelMessageUnsub(); channelMessageUnsub = null; }
        } else if (!$('eg-dm-modal').classList.contains('hidden')) {
            $('eg-dm-modal').classList.add('hidden');
            if (dmMessageUnsub) { dmMessageUnsub(); dmMessageUnsub = null; }
        } else if (!$('eg-forum-modal').classList.contains('hidden')) {
            $('eg-forum-modal').classList.add('hidden');
        } else if (!$('eg-org-modal').classList.contains('hidden')) {
            $('eg-org-modal').classList.add('hidden');
        }
    }
});

// ==========================================================================
// Cleanup
// ==========================================================================
function cleanupListeners() {
    state.listeners.forEach(unsub => unsub());
    state.listeners = [];
    if (channelMessageUnsub) { channelMessageUnsub(); channelMessageUnsub = null; }
    if (dmMessageUnsub) { dmMessageUnsub(); dmMessageUnsub = null; }
}

// ==========================================================================
// Helpers
// ==========================================================================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
