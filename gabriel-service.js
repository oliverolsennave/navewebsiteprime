// ==========================================================================
// Gabriel AI Service — Web RAG (mirrors iOS UnifiedIntelligenciaService)
// ==========================================================================

import { db } from './firebase-config.js';
import { collection, getDocs, query, where, limit, orderBy } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// ── OpenAI config ──────────────────────────────────────────────────────
// API key is stored server-side as a Vercel env variable.
// Client calls /api/gabriel which proxies to OpenAI.
const GABRIEL_ENDPOINT = '/api/gabriel';

export function hasAPIKey() {
    return true; // key is server-side, always available
}

// ── Entity types (mirrors UnifiedEntityType) ───────────────────────────
const EntityType = {
    CHURCH: 'Church',
    MISSIONARY: 'Missionary',
    PILGRIMAGE: 'Pilgrimage',
    RETREAT: 'Retreat',
    SCHOOL: 'School',
    VOCATION: 'Vocation',
    BUSINESS: 'Business',
    CAMPUS_MINISTRY: 'Campus Ministry'
};

// ── Conversation state ─────────────────────────────────────────────────
let conversationHistory = []; // { role, content }
let lastRecommendedEntities = []; // entities from last response (for follow-ups)
let lastLocationContext = null; // last detected location (for follow-ups)
let cachedUserLocation = null; // { lat, lng } from geolocation or localStorage

export function clearConversation() {
    conversationHistory = [];
    lastRecommendedEntities = [];
    lastLocationContext = null;
}

// ======================================================================
// SECTION 1: QUERY DETECTION (mirrors iOS exactly)
// ======================================================================

// ── "Near me" detection (mirrors iOS isLocationQuery in Relevance extension) ──
function isNearbyQuery(q) {
    const locationPatterns = [
        'near me', 'nearby', 'nearest', 'closest', 'around me',
        'in my area', 'close to me', 'local',
        "what's nearby", 'what is nearby', 'near my location',
        'around here', 'in this area', 'close by',
        'within', 'walking distance', 'nearest to me',
        'nerest to me', 'neerest', 'near est'
    ];
    const queryLower = q.toLowerCase();
    return locationPatterns.some(pattern => {
        if (pattern.includes('.*')) {
            return new RegExp(pattern).test(queryLower);
        }
        return queryLower.includes(pattern);
    });
}

// ── Event query detection (mirrors iOS ParishRAGService.detectEventQuery) ──
function detectEventQuery(q) {
    const eventKeywords = [
        'event', 'happening', 'going on', 'upcoming', 'this week',
        'this weekend', 'tonight', 'tomorrow', 'activities', 'calendar',
        'fish fry', 'festival', 'concert', 'talk', 'speaker',
        'info meeting', 'information meeting', 'meeting', 'food drive',
        'theology on tap', 'pig roast', 'pancake', 'potluck'
    ];
    return eventKeywords.some(kw => q.includes(kw));
}

// ── Schedule query detection (mirrors iOS ParishRAGService.detectScheduleQuery) ──
function detectScheduleQuery(q) {
    const scheduleKeywords = [
        'what time', 'when is', 'schedule', 'hours', 'mass time',
        'confession time', 'adoration', 'daily mass', 'sunday mass',
        'saturday', 'weekday'
    ];
    return scheduleKeywords.some(kw => q.includes(kw));
}

// ── Parish query detection (mirrors iOS ParishRAGService.detectParishQuery) ──
function detectParishQuery(q) {
    const parishKeywords = [
        'parish', 'church', 'mass', 'confession', 'adoration',
        'bulletin', 'pastor', 'priest', 'catholic', 'sacrament',
        'baptism', 'ocia', 'rcia', 'wedding', 'funeral',
        'cgs', 'ccgs', 'catechesis', 'good shepherd', 'confirmation', 'first communion',
        'first eucharist', 'marriage prep', 'pre-cana', 'precana',
        'sacred heart', 'st. thomas', 'st thomas', 'thomas aquinas'
    ];
    return parishKeywords.some(kw => q.includes(kw));
}

// ── Extract parish name (mirrors iOS ParishRAGService.extractParishName) ──
function extractParishName(queryStr) {
    const queryLower = queryStr.toLowerCase();

    // Known parish names
    if (queryLower.includes('sacred heart')) return 'Sacred Heart';
    if (queryLower.includes('thomas aquinas') || queryLower.includes('st. thomas') || queryLower.includes('st thomas')) return 'St. Thomas Aquinas';

    // Regex patterns
    const patterns = [
        /about\s+([A-Za-z\s'.]+?)(?:\s+par+ish|\s+church|\?|$)/i,
        /at\s+([A-Za-z\s'.]+?)(?:\s+par+ish|\s+church|\?|$)/i,
        /([A-Za-z\s'.]+?)(?:\s+par+ish|\s+church)(?:'s)?\s+/i,
        /saint\s+\w+/i
    ];

    for (const pattern of patterns) {
        const match = queryStr.match(pattern);
        if (match && match[1]) {
            const extracted = match[1].trim();
            if (extracted.length > 2 && extracted.length < 50) return extracted;
        }
    }
    return null;
}

// ── Follow-up detection ──
function extractFollowUpEntity(q) {
    const patterns = [
        /tell me (?:more )?about\s+(.+)/i,
        /more (?:info|information|details) (?:on|about)\s+(.+)/i,
        /what (?:is|about)\s+(.+)/i,
        /(?:learn|know) more about\s+(.+)/i,
    ];
    for (const p of patterns) {
        const m = q.match(p);
        if (m) return m[1].trim();
    }
    return null;
}

// ── Organization detection ──
function detectOrganizationQuery(q) {
    const keywords = [
        'organization', 'network', 'group', 'community',
        'association', 'institute', 'catholic leadership', 'cli',
        'focus', 'sent', 'help my parish', 'parish resources',
        'level up', 'consulting', 'formation', 'training',
        'professional', 'leadership', 'connect with', 'join',
        'catholic business', 'catholic entrepreneurs',
        'student mission', 'campus ministry network'
    ];
    return keywords.some(kw => q.includes(kw));
}

function extractOrganizationName(queryStr) {
    const q = queryStr.toLowerCase();
    const known = [
        ['catholic leadership institute', 'Catholic Leadership Institute'],
        ['cli', 'Catholic Leadership Institute'],
        ['focus', 'FOCUS'],
        ['sent ventures', 'SENT Ventures'],
        ['sent', 'SENT Ventures']
    ];
    for (const [kw, name] of known) {
        if (q.includes(kw)) return name;
    }
    return null;
}

// ======================================================================
// SECTION 2: GEOLOCATION (mirrors iOS SharedLocationManager)
// ======================================================================

// Get user location from localStorage (saved by map page) or browser geolocation
async function getUserLocation() {
    // 1. Check cached location first
    if (cachedUserLocation) return cachedUserLocation;

    // 2. Check localStorage (saved by map page)
    try {
        const saved = localStorage.getItem('nave_user_location');
        if (saved) {
            const { lat, lng } = JSON.parse(saved);
            if (lat && lng) {
                cachedUserLocation = { lat, lng };
                console.log(`📍 [Gabriel] Using saved location: ${lat}, ${lng}`);
                return cachedUserLocation;
            }
        }
    } catch (e) { /* ignore */ }

    // 3. Try browser geolocation (with timeout)
    if ('geolocation' in navigator) {
        try {
            const pos = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: false,
                    timeout: 5000,
                    maximumAge: 300000 // 5 min cache
                });
            });
            cachedUserLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            console.log(`📍 [Gabriel] Geolocation: ${cachedUserLocation.lat}, ${cachedUserLocation.lng}`);
            return cachedUserLocation;
        } catch (e) {
            console.log('📍 [Gabriel] Geolocation unavailable:', e.message);
        }
    }

    return null;
}

// ======================================================================
// SECTION 3: MAIN ENTRY — sendMessage
// ======================================================================

export async function sendMessage(userQuery) {
    if (!hasAPIKey()) throw new Error('MISSING_KEY');

    // 1. Add user message to history
    conversationHistory.push({ role: 'user', content: userQuery });

    const queryLower = userQuery.toLowerCase();

    // 2. Check if this is a follow-up about a previously recommended entity
    const followUpName = extractFollowUpEntity(userQuery);
    let context = [];
    let isFollowUp = false;

    if (followUpName && lastRecommendedEntities.length > 0) {
        const matchedEntity = lastRecommendedEntities.find(e => {
            const eName = e.name.toLowerCase();
            const fName = followUpName.toLowerCase();
            return eName === fName || eName.includes(fName) || fName.includes(eName);
        });

        if (matchedEntity) {
            console.log(`🔗 [Gabriel] Follow-up detected for: "${matchedEntity.name}"`);
            isFollowUp = true;
            context = await fetchEntityDetails(matchedEntity);
        }
    }

    // 3. Detect query types
    const isNearby = isNearbyQuery(queryLower);
    const isEvent = detectEventQuery(queryLower);
    const isSchedule = detectScheduleQuery(queryLower);
    const isParish = detectParishQuery(queryLower);
    const parishName = extractParishName(userQuery);
    const locationInfo = detectLocationQuery(queryLower);

    // 4. If not a follow-up, do a normal RAG fetch
    let richParishContexts = [];
    let userLocation = null;

    if (!isFollowUp) {
        // Track location for future follow-ups
        if (locationInfo) lastLocationContext = locationInfo;

        // For nearby queries, try to get GPS coordinates
        if (isNearby) {
            userLocation = await getUserLocation();
            if (userLocation) {
                context = await fetchNearbyContext(userLocation.lat, userLocation.lng, queryLower);
                console.log(`📍 [Gabriel] Nearby context: ${context.length} entities`);
            } else {
                // No location available — fall back to standard fetch
                context = await fetchRankedContext(userQuery);
            }
        } else {
            context = await fetchRankedContext(userQuery);
        }

        console.log(`🎯 [Gabriel] Fetched ${context.length} relevant entities`);

        // For parish queries, also fetch rich parish data (schedules, events, programs)
        if (isParish || isEvent || isSchedule || parishName) {
            richParishContexts = await fetchRichParishContext(queryLower, userLocation, parishName);
            console.log(`🏛️ [Gabriel] Fetched ${richParishContexts.length} rich parish contexts`);
        }
    }

    // 5. Check for organization queries
    const isOrgQuery = detectOrganizationQuery(queryLower);
    let orgContexts = [];
    if (isOrgQuery) {
        orgContexts = await fetchOrganizations(userQuery);
        console.log(`📚 [Gabriel] Fetched ${orgContexts.length} organizations`);
    }

    // 6. Build system prompt (route through correct path)
    let systemPrompt;
    if (isFollowUp) {
        systemPrompt = buildFollowUpPrompt(context, userQuery, followUpName);
    } else if (isNearby && userLocation && context.length > 0) {
        // Nearby query with GPS coordinates → distance-sorted prompt
        systemPrompt = buildNearbySystemPrompt(context, userQuery);
    } else if ((isParish || isEvent || isSchedule) && richParishContexts.length > 0) {
        // Parish-specific query with rich data → enhanced parish prompt
        const parishSection = buildParishPromptSection(richParishContexts, isEvent, isSchedule, parishName);
        systemPrompt = buildParishEnhancedSystemPrompt(parishSection, context, isEvent, isNearby, parishName);
    } else if (!isNearby || !userLocation) {
        // No location for nearby, or standard query
        if (isNearby && !userLocation) {
            // Special: nearby query but no location
            systemPrompt = buildNoLocationPrompt();
        } else {
            systemPrompt = buildUnifiedSystemPrompt(context, userQuery);
        }
    } else {
        systemPrompt = buildUnifiedSystemPrompt(context, userQuery);
    }

    if (orgContexts.length > 0) {
        const specificOrgName = extractOrganizationName(userQuery);
        systemPrompt += buildOrganizationSystemPrompt(orgContexts, specificOrgName);
    }

    // 7. Build OpenAI messages
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory
    ];

    // 8. Call OpenAI
    const response = await callOpenAI(messages);

    // 9. Parse response (strip RECOMMEND tags, extract entities + events)
    const { cleanedResponse, suggestedEntities, suggestedEvents } = parseRecommendation(response, context, orgContexts);

    // 10. Save recommended entities for follow-ups
    if (suggestedEntities.length > 0) {
        lastRecommendedEntities = suggestedEntities;
    } else if (context.length > 0 && !isFollowUp) {
        lastRecommendedEntities = context.slice(0, 5);
    }

    // 11. Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: cleanedResponse });

    return { text: cleanedResponse, suggestions: suggestedEntities, events: suggestedEvents };
}

// ======================================================================
// SECTION 4: RICH PARISH CONTEXT (mirrors iOS ParishRAGService)
// ======================================================================

// Fetch unlocked parishes with full schedules, events, programs
async function fetchRichParishContext(queryLower, userLocation, specificParishName) {
    try {
        // Fetch unlocked parishes (they have rich data)
        const unlockedSnap = await getDocs(query(collection(db, 'Churches'), where('isUnlocked', '==', true)));
        let contexts = [];

        unlockedSnap.forEach(doc => {
            const ctx = buildParishContext(doc, userLocation);
            if (ctx) contexts.push(ctx);
        });

        // If asking about a specific parish, also search by name
        if (specificParishName) {
            const nameMatch = contexts.find(c =>
                c.name.toLowerCase().includes(specificParishName.toLowerCase()) ||
                specificParishName.toLowerCase().includes(c.name.toLowerCase())
            );
            if (nameMatch) {
                // Move it to front
                contexts = [nameMatch, ...contexts.filter(c => c.id !== nameMatch.id)];
            }
        }

        // Sort by relevance
        if (detectEventQuery(queryLower)) {
            contexts.sort((a, b) => b.upcomingEvents.length - a.upcomingEvents.length);
        }
        if (userLocation) {
            contexts.sort((a, b) => (a.distance || 999) - (b.distance || 999));
        }

        return contexts.slice(0, 10);
    } catch (e) {
        console.error('❌ Error fetching rich parish context:', e);
        return [];
    }
}

function buildParishContext(doc, userLocation) {
    const d = doc.data();
    const name = d.name || '';
    if (!name) return null;

    const address = d.address || '';
    const city = d.city || '';
    const state = d.state || '';
    const isUnlocked = d.isUnlocked === true;
    const description = d.description || '';
    const website = d.link || d.website || '';
    const phone = d.phone || '';

    // Distance
    let distance = null;
    if (userLocation) {
        const coords = extractCoords(d);
        if (coords) {
            distance = haversineDistance(userLocation.lat, userLocation.lng, coords.lat, coords.lng);
        }
    }

    // Parse schedules (handle multiple Firebase formats)
    const massSchedule = parseSchedule(d.massSchedule);
    const confessionSchedule = parseSchedule(d.confessionSchedule);
    const adorationSchedule = parseSchedule(d.adorationSchedule);

    // Parse events
    let upcomingEvents = [];
    if (Array.isArray(d.events)) {
        const now = new Date();
        for (const eventData of d.events) {
            const evt = parseEventData(eventData);
            if (evt && evt.date >= now) {
                upcomingEvents.push(evt);
            }
        }
        upcomingEvents.sort((a, b) => a.date - b.date);
        upcomingEvents = upcomingEvents.slice(0, 5);
    }

    // Programs
    const hasOCIA = d.hasOCIA === true || !!d.prepClassSignupURL;
    const ociaSignupURL = d.prepClassSignupURL || d.ociaSignupURL || null;
    const hasConfirmation = d.hasConfirmation !== false;
    const hasFirstEucharist = d.hasFirstEucharist !== false;
    const hasMarriagePrep = d.hasMarriagePrep !== false;
    const hasSignUpSheets = d.hasSignUpSheets === true || isUnlocked;
    const signUpCategories = d.signUpCategories || ['Groups', 'Liturgy', 'Service'];
    const hasBulletin = !!d.latestBulletinURLs || !!d.bulletinURL;

    return {
        id: doc.id, name, address, city, state, distance, isUnlocked,
        description, website, phone,
        massSchedule, confessionSchedule, adorationSchedule,
        upcomingEvents,
        hasOCIA, ociaSignupURL, hasConfirmation, hasFirstEucharist, hasMarriagePrep,
        hasSignUpSheets, signUpCategories, hasBulletin
    };
}

// Parse schedule from various Firebase formats (mirrors iOS parseSchedule)
function parseSchedule(scheduleData) {
    if (!scheduleData) return {};

    // Format 1: { day: [times] } direct mapping
    if (typeof scheduleData === 'object' && !Array.isArray(scheduleData)) {
        const result = {};
        for (const [day, value] of Object.entries(scheduleData)) {
            if (Array.isArray(value)) {
                // Could be array of strings or array of objects
                const times = [];
                for (const v of value) {
                    if (typeof v === 'string') {
                        times.push(v);
                    } else if (typeof v === 'object' && v.time) {
                        let timeStr = v.time;
                        if (v.language && v.language !== 'English') {
                            timeStr += ` (${v.language})`;
                        }
                        times.push(timeStr);
                    }
                }
                if (times.length > 0) result[day] = times;
            } else if (typeof value === 'string') {
                result[day] = [value];
            }
        }
        return result;
    }
    return {};
}

// Parse event data from Firebase (mirrors iOS parseEvent)
function parseEventData(data) {
    const title = data.title || '';
    if (!title) return null;

    let eventDate = new Date();

    // Handle Firestore Timestamp
    if (data.date && data.date.toDate) {
        eventDate = data.date.toDate();
    } else if (data.date && data.date.seconds) {
        eventDate = new Date(data.date.seconds * 1000);
    } else if (typeof data.date === 'string') {
        // Try multiple date formats
        const dateStr = data.date;
        const formats = [
            // "March 22" or "Mar 22"
            { regex: /^([A-Za-z]+)\s+(\d{1,2})$/, parse: (m) => new Date(`${m[1]} ${m[2]}, ${new Date().getFullYear()}`) },
            // "2026-03-22" ISO
            { regex: /^\d{4}-\d{2}-\d{2}$/, parse: (m) => new Date(dateStr + 'T00:00:00') },
            // "03/22/2026" US
            { regex: /^\d{2}\/\d{2}\/\d{4}$/, parse: (m) => new Date(dateStr) },
        ];

        for (const { regex, parse } of formats) {
            const match = dateStr.match(regex);
            if (match) {
                const parsed = parse(match);
                if (!isNaN(parsed.getTime())) {
                    eventDate = parsed;
                    // If no year in string and date is in the past, bump to next year
                    if (!dateStr.includes('202') && eventDate < new Date()) {
                        eventDate.setFullYear(eventDate.getFullYear() + 1);
                    }
                    break;
                }
            }
        }
    }

    const time = data.time || null;
    const location = data.location || null;
    const description = data.description || null;

    // Format date
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const formattedDate = `${months[eventDate.getMonth()]} ${eventDate.getDate()}`;

    return {
        title,
        date: eventDate,
        time,
        location,
        description,
        formattedDate,
        formattedDateTime: time ? `${formattedDate} at ${time}` : formattedDate,
        formattedString: `${formattedDate}: ${title}${time ? ` (${time}${location ? ', ' + location : ''})` : ''}`
    };
}

// Format schedule compactly (mirrors iOS formatScheduleCompact)
function formatScheduleCompact(schedule) {
    const dayOrder = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Monday-Friday'];
    const dayAbbrev = { 'Sunday': 'Sun', 'Monday': 'Mon', 'Tuesday': 'Tue', 'Wednesday': 'Wed',
        'Thursday': 'Thu', 'Friday': 'Fri', 'Saturday': 'Sat', 'Monday-Friday': 'Mon-Fri' };

    const parts = [];
    for (const day of dayOrder) {
        if (schedule[day] && schedule[day].length > 0) {
            parts.push(`${dayAbbrev[day] || day} ${schedule[day].join(', ')}`);
        }
    }
    return parts.join(' | ');
}

// Format schedule in detail (mirrors iOS formatScheduleDetailed)
function formatScheduleDetailed(schedule) {
    const dayOrder = ['Sunday', 'Monday-Friday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let result = '';
    for (const day of dayOrder) {
        if (schedule[day] && schedule[day].length > 0) {
            result += `   ${day}: ${schedule[day].join(', ')}\n`;
        }
    }
    return result;
}

// Build full context string for a parish (mirrors iOS fullContextString)
function buildParishFullContextString(ctx) {
    let result = '';
    result += `═══════════════════════════════════════\n`;
    result += `🏛️ ${ctx.name.toUpperCase()}\n`;
    result += `═══════════════════════════════════════\n`;
    result += `📍 Address: ${ctx.address}\n`;
    result += `   ${ctx.city}, ${ctx.state}\n`;
    if (ctx.distance !== null) result += `   Distance: ${ctx.distance.toFixed(1)} miles\n`;
    if (ctx.website) result += `🌐 Website: ${ctx.website}\n`;
    if (ctx.phone) result += `📞 Phone: ${ctx.phone}\n`;
    if (ctx.description) result += `\n📝 About: ${ctx.description}\n`;

    result += `\n⛪ MASS SCHEDULE:\n`;
    if (Object.keys(ctx.massSchedule).length > 0) {
        result += formatScheduleDetailed(ctx.massSchedule);
    } else {
        result += `   Schedule not available - contact parish\n`;
    }

    result += `\n🙏 CONFESSION:\n`;
    if (Object.keys(ctx.confessionSchedule).length > 0) {
        result += formatScheduleDetailed(ctx.confessionSchedule);
    } else {
        result += `   By appointment - contact parish\n`;
    }

    if (Object.keys(ctx.adorationSchedule).length > 0) {
        result += `\n✝️ ADORATION:\n`;
        result += formatScheduleDetailed(ctx.adorationSchedule);
    }

    if (ctx.upcomingEvents.length > 0) {
        result += `\n📅 UPCOMING EVENTS:\n`;
        for (const evt of ctx.upcomingEvents) {
            result += `   • ${evt.title}\n`;
            result += `     ${evt.formattedDateTime}\n`;
            if (evt.location) result += `     Location: ${evt.location}\n`;
            if (evt.description) result += `     ${evt.description}\n`;
        }
    }

    result += `\n📋 PROGRAMS & SACRAMENTS:\n`;
    if (ctx.hasOCIA) {
        result += `   ✓ OCIA (Order of Christian Initiation of Adults)\n`;
        if (ctx.ociaSignupURL) result += `     Sign up: ${ctx.ociaSignupURL}\n`;
    }
    if (ctx.hasConfirmation) result += `   ✓ Confirmation preparation (youth & adult)\n`;
    if (ctx.hasFirstEucharist) result += `   ✓ First Eucharist preparation\n`;
    if (ctx.hasMarriagePrep) result += `   ✓ Marriage preparation (Pre-Cana)\n`;

    if (ctx.hasSignUpSheets && ctx.signUpCategories.length > 0) {
        result += `\n📝 VOLUNTEER SIGN-UPS AVAILABLE:\n`;
        result += `   Categories: ${ctx.signUpCategories.join(', ')}\n`;
    }
    if (ctx.hasBulletin) result += `\n📄 Current bulletin available in app\n`;

    return result;
}

// Build compact context string for a parish (mirrors iOS contextString)
function buildParishContextString(ctx) {
    let result = '';
    if (ctx.distance !== null) {
        result += `📍 ${ctx.name.toUpperCase()} (${ctx.city}, ${ctx.state}) - ${ctx.distance.toFixed(1)} miles away\n`;
    } else {
        result += `📍 ${ctx.name.toUpperCase()} (${ctx.city}, ${ctx.state})\n`;
    }
    result += `   Address: ${ctx.address}\n`;

    if (Object.keys(ctx.massSchedule).length > 0) {
        result += `   Mass: ${formatScheduleCompact(ctx.massSchedule)}\n`;
    }
    if (Object.keys(ctx.confessionSchedule).length > 0) {
        result += `   Confession: ${formatScheduleCompact(ctx.confessionSchedule)}\n`;
    }
    if (Object.keys(ctx.adorationSchedule).length > 0) {
        result += `   Adoration: ${formatScheduleCompact(ctx.adorationSchedule)}\n`;
    }
    if (ctx.upcomingEvents.length > 0) {
        result += `   Upcoming Events:\n`;
        for (const evt of ctx.upcomingEvents.slice(0, 3)) {
            result += `   - ${evt.formattedString}\n`;
        }
    }
    const programs = [];
    if (ctx.hasOCIA) programs.push('OCIA');
    if (ctx.hasConfirmation) programs.push('Confirmation');
    if (ctx.hasFirstEucharist) programs.push('First Eucharist');
    if (ctx.hasMarriagePrep) programs.push('Marriage Prep');
    if (programs.length > 0) result += `   Programs: ${programs.join(', ')}\n`;
    if (ctx.hasBulletin) result += `   📄 Has current bulletin\n`;

    return result;
}

// Build parish prompt section (mirrors iOS buildParishSystemPromptSection)
function buildParishPromptSection(contexts, isEvent, isSchedule, specificParishName) {
    if (contexts.length === 0) {
        return `\nPARISH DATA:\nNo unlocked parishes found matching the query. These parishes haven't submitted their bulletins yet, so I don't have detailed schedule or event information.`;
    }

    let prompt = '\n\n';

    // If asking about a specific parish, provide FULL detailed context
    if (specificParishName) {
        const match = contexts.find(c =>
            c.name.toLowerCase().includes(specificParishName.toLowerCase()) ||
            specificParishName.toLowerCase().includes(c.name.toLowerCase())
        );
        if (match) {
            prompt += `DETAILED INFORMATION FOR ${match.name.toUpperCase()}:\n`;
            prompt += buildParishFullContextString(match);
            return prompt;
        }
    }

    prompt += 'UNLOCKED PARISHES WITH RICH DATA:\n';

    if (isEvent) {
        prompt += '(Showing parishes with upcoming events)\n\n';
        const withEvents = contexts.filter(c => c.upcomingEvents.length > 0);
        for (const ctx of withEvents.slice(0, 5)) {
            prompt += buildParishContextString(ctx) + '\n';
        }
        if (withEvents.length === 0) {
            prompt += 'No upcoming events found at unlocked parishes.\n';
        }
    } else if (isSchedule) {
        prompt += '(Showing Mass, Confession, and Adoration schedules)\n\n';
        for (const ctx of contexts.slice(0, 5)) {
            prompt += buildParishContextString(ctx) + '\n';
        }
    } else {
        for (const ctx of contexts.slice(0, 5)) {
            prompt += buildParishContextString(ctx) + '\n';
        }
    }

    return prompt;
}

// ======================================================================
// SECTION 5: NEARBY CONTEXT FETCHING
// ======================================================================

// Fetch entities sorted by distance from user (mirrors iOS fetchRankedContext for nearby)
async function fetchNearbyContext(userLat, userLng, queryLower) {
    try {
        // Load all churches (like the map does)
        const snap = await getDocs(collection(db, 'Churches'));
        let results = [];

        snap.forEach(doc => {
            const d = doc.data();
            const coords = extractCoords(d);
            if (!coords || !coords.lat || !coords.lng) return;

            const distanceMiles = haversineDistance(userLat, userLng, coords.lat, coords.lng);

            // Only include within 50 miles
            if (distanceMiles <= 50) {
                const name = d.name || '';
                const city = d.city || '';
                const state = d.state || '';
                const diocese = d.diocese || '';
                const address = d.address || '';
                const displayCity = city || extractCityFromAddress(address);

                results.push({
                    id: doc.id,
                    name,
                    type: EntityType.CHURCH,
                    subtitle: diocese || 'Parish',
                    description: 'Catholic parish',
                    location: displayCity ? `${displayCity}, ${state}` : state,
                    distanceMiles
                });
            }
        });

        // Sort by distance (closest first)
        results.sort((a, b) => a.distanceMiles - b.distanceMiles);

        // Also fetch other entity types nearby (if they have coordinates)
        // For now, just return churches sorted by distance
        const top20 = results.slice(0, 20);

        console.log(`📍 [Gabriel] Nearby: ${results.length} churches within 50mi, returning top ${top20.length}`);
        if (top20.length > 0) {
            top20.slice(0, 3).forEach((r, i) =>
                console.log(`   ${i + 1}. ${r.name} — ${r.distanceMiles.toFixed(1)}mi`)
            );
        }

        return top20;
    } catch (e) {
        console.error('❌ Error fetching nearby context:', e);
        return [];
    }
}

// ======================================================================
// SECTION 6: SYSTEM PROMPT BUILDING
// ======================================================================

// ── No-location prompt (mirrors iOS) ──
function buildNoLocationPrompt() {
    return `You are Gabriel, a friendly Catholic AI assistant in the Nave app.

The user asked about nearby Catholic resources, but I don't have access to their location yet.

Politely let them know that to find parishes, churches, or other Catholic resources near them, they can enable location services or search by city name, like:
- "Catholic churches in Philadelphia"
- "Retreats in California"
- "Sacred Heart in Bridgeport PA"

Keep your tone warm and helpful! Keep response under 50 words.`;
}

// ── Nearby system prompt (mirrors iOS buildNearbySystemPrompt) ──
function buildNearbySystemPrompt(entities, queryStr) {
    // Filter to churches/parishes and sort by distance
    const parishes = entities
        .filter(e => e.type === EntityType.CHURCH && e.distanceMiles !== undefined)
        .sort((a, b) => a.distanceMiles - b.distanceMiles)
        .slice(0, 10);

    // Build numbered list
    let parishList = '';
    parishes.forEach((p, i) => {
        const distStr = p.distanceMiles < 1.0
            ? `${p.distanceMiles.toFixed(1)} mi`
            : `${Math.round(p.distanceMiles)} mi`;
        parishList += `${i + 1}. ${p.name} — ${p.location} (${distStr} away)\n`;
    });

    // Check for other entity types
    const others = entities.filter(e => e.type !== EntityType.CHURCH).slice(0, 3);
    let otherList = '';
    if (others.length > 0) {
        otherList = '\n\nOTHER NEARBY:\n';
        for (const e of others) {
            const dist = e.distanceMiles !== undefined ? `${Math.round(e.distanceMiles)} mi away` : '';
            otherList += `• ${e.name} (${e.type}) — ${dist}\n`;
        }
    }

    return `You are Gabriel, a Catholic AI assistant in the Nave app.

THE USER ASKED: "${queryStr}"

HERE ARE THE NEAREST PARISHES (sorted by distance):
${parishList}${otherList}

YOUR TASK:
1. Recommend the TOP 3 NEAREST parishes from the list
2. For EACH parish, include [RECOMMEND: exact parish name] using the EXACT name
3. Mention each parish's name and distance in your response
4. Keep it brief and helpful

EXAMPLE FORMAT:
Here are some parishes nearby:

[RECOMMEND: St. Mary Church]
1. St. Mary Church — just 0.5 mi away

[RECOMMEND: Holy Family Parish]
2. Holy Family Parish — 1 mi away

[RECOMMEND: Sacred Heart]
3. Sacred Heart — 2 mi away

Tap the cards below to see Mass times and more!

RULES:
- List parishes in ORDER of distance (closest first)
- Include the distance for each parish
- Use EXACT names from the list for [RECOMMEND: name] tags
- Keep response under 80 words`;
}

// ── Parish enhanced system prompt (mirrors iOS buildParishEnhancedSystemPrompt) ──
function buildParishEnhancedSystemPrompt(parishSection, otherEntities, isEventQuery, isLocationQuery, specificParishName) {
    let prompt = `You are Gabriel, the Nave AI assistant helping Catholics discover parishes and Catholic resources.\n\n`;

    // Specific parish priority
    if (specificParishName) {
        prompt += `⚠️ CRITICAL: The user is asking specifically about "${specificParishName}".

You MUST answer about this specific parish using the data provided below.
DO NOT suggest other parishes or resources unless explicitly asked.
DO NOT say "I don't have information" if there is ANY data about this parish below.

`;
    }

    // Add the rich parish context (unlocked parishes with full schedules/events)
    prompt += parishSection;

    // ALSO include regular entities from fetchRankedContext (churches + other types)
    // This ensures the AI sees ALL nearby parishes, not just unlocked ones
    if (otherEntities && otherEntities.length > 0 && !specificParishName) {
        const churches = otherEntities.filter(e => e.type === 'Church');
        const others = otherEntities.filter(e => e.type !== 'Church');

        if (churches.length > 0) {
            prompt += `\n\nADDITIONAL NEARBY PARISHES (basic info):\n`;
            for (const c of churches.slice(0, 12)) {
                prompt += `• ${c.name}`;
                if (c.location) prompt += ` — ${c.location}`;
                if (c.subtitle && c.subtitle !== 'Parish') prompt += ` (${c.subtitle})`;
                prompt += '\n';
            }
        }

        if (others.length > 0) {
            prompt += `\nOTHER CATHOLIC RESOURCES NEARBY:\n`;
            for (const e of others.slice(0, 5)) {
                prompt += `• ${e.name} (${e.type})`;
                if (e.location) prompt += ` — ${e.location}`;
                prompt += '\n';
            }
        }
    }

    // Customize based on query type
    if (isEventQuery) {
        prompt += `
USER IS ASKING ABOUT EVENTS.

YOUR RESPONSE FORMAT (follow exactly):
[RECOMMEND: Parish Name]
[RECOMMEND_EVENT: Event Title|Date|Time|Parish Name]
Brief 1-2 sentence summary of events. Tap the cards below to RSVP!

IMPORTANT: For each event you mention, include a [RECOMMEND_EVENT: ...] tag with this EXACT format:
[RECOMMEND_EVENT: CGS Info Meeting|February 18|6:30 PM|Sacred Heart]

The format is: [RECOMMEND_EVENT: Title|Month Day|Time|Parish Name]
This creates a tappable event card for the user.

You MUST start with the [RECOMMEND: tag before any text.`;
    } else if (isLocationQuery) {
        prompt += `
USER IS ASKING ABOUT NEARBY PARISHES.

Recommend 2-3 parishes from the lists above. Prefer parishes with rich data (schedules, events) but also include nearby parishes from the ADDITIONAL list.

YOUR RESPONSE FORMAT (follow exactly):
[RECOMMEND: Parish Name]
[RECOMMEND: Another Parish Name]
Brief description. Tap the cards below to explore!

You MUST include multiple [RECOMMEND: name] tags — one for each parish you recommend.`;
    } else if (specificParishName) {
        prompt += `
USER IS ASKING ABOUT A SPECIFIC PARISH BY NAME.

YOUR RESPONSE FORMAT (follow exactly):
[RECOMMEND: Exact Parish Name From Data]
2-3 sentence friendly summary about THIS parish. Tap the card below to learn more!

You MUST start your response with [RECOMMEND: Parish Name] using the EXACT name from the data.
Focus ONLY on the parish the user asked about. Do not mention other locations.`;
    } else {
        prompt += `
USER IS ASKING ABOUT PARISHES.

Recommend 2-3 parishes from the lists above. Include [RECOMMEND: name] for each.

YOUR RESPONSE FORMAT (follow exactly):
[RECOMMEND: Parish Name]
[RECOMMEND: Another Parish]
Brief, warm summary. Tap the cards below to learn more!

Keep your response under 50 words after the tags. Be warm and inviting.`;
    }

    prompt += `

⚠️ MANDATORY: Include [RECOMMEND: Parish Name] for EACH parish you recommend (up to 3).

These tags create tappable cards. Use the EXACT names from the lists above.

SPACING RULES:
- Put a SPACE after EVERY period, comma, colon, and exclamation mark
- WRONG: "daily Mass,confession" or "events.Tap"
- CORRECT: "daily Mass, confession" or "events. Tap"`;

    return prompt;
}

// ── Standard unified system prompt (existing, enhanced) ──
function buildUnifiedSystemPrompt(entities, queryStr) {
    if (entities.length === 0) {
        return `You are Gabriel, a friendly Catholic AI assistant in the Nave app. You help users discover Catholic churches, schools, retreats, pilgrimages, missionaries, vocations, and businesses.

I couldn't find relevant matches for this query in our database.

If they're greeting you, respond warmly and let them know you can help find Catholic parishes, schools, retreats, pilgrimages, and more. Suggest they try asking about a specific city or topic.

If they asked about something specific, kindly let them know: "I don't have information on that just yet — we're always adding new Catholic resources! Try asking about parishes, schools, retreats, or pilgrimages in a specific city."

RULES:
- Do NOT list or recommend any resources — you have none to share for this query
- Do NOT make up or fabricate any locations, parishes, schools, or other entities
- Keep your response short (under 40 words)
- Be warm and helpful, suggest they try a different or more specific query
- Don't mention databases, queries, or technical terms`;
    }

    // Group entities by type
    const grouped = {};
    for (const e of entities) {
        if (!grouped[e.type]) grouped[e.type] = [];
        grouped[e.type].push(e);
    }

    let resourceList = '';
    for (const [type, items] of Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]))) {
        const typeName = type.toUpperCase();
        const suffix = typeName.endsWith('S') ? 'ES' : 'S';
        resourceList += `\n${typeName}${suffix}:\n`;
        for (const e of items.slice(0, 8)) {
            resourceList += `• ${e.name}`;
            if (e.location) resourceList += ` — ${e.location}`;
            if (e.subtitle && e.subtitle !== type && e.subtitle !== 'Retreat') resourceList += ` (${e.subtitle})`;
            resourceList += '\n';
        }
        if (items.length > 8) {
            resourceList += `  (and ${items.length - 8} more)\n`;
        }
    }

    const availableTypes = Object.keys(grouped).join(', ');

    return `You are Gabriel, a Catholic AI assistant helping users discover Catholic resources in the Nave app.

THE USER ASKED: "${queryStr}"

I FOUND THESE RELEVANT RESOURCES:
${resourceList}

YOUR TASK:
1. Pick 1-3 resources from the list above that BEST MATCH what they're asking for (prefer resources whose location matches the user's query)
2. For EACH resource you recommend, include [RECOMMEND: exact name] using the EXACT name from the list
3. Write a SHORT, concise response — just introduce the results and tell them to tap the cards below

MATCHING GUIDELINES:
- If asking about a specific city/location → ALWAYS recommend resources in or near that location
- If asking about "retreat" or "retreat centers" → recommend from RETREATS
- If asking about "parish" or "church" or "mass" → recommend from CHURCHS
- If asking about "school" or "education" → recommend from SCHOOLS
- If asking about "business" or "shop" → recommend from BUSINESSS
- If asking about "pilgrimage" or "holy site" → recommend from PILGRIMAGES
- If asking generally → pick the most relevant across all types

AVAILABLE TYPES: ${availableTypes}

RULES:
- ONLY recommend from the list above (1-3 options)
- Use the EXACT name as written in the list for each [RECOMMEND: name] tag
- Keep response under 50 words
- Be warm but brief
- NEVER fabricate or make up details about a resource (like descriptions, services, atmosphere, history) that aren't in the data above
- If you only have names and locations, just say "Here are the closest [type] near [location]" and let the cards speak for themselves
- NEVER say you "don't have" resources if there ARE matching items in the list above
- Do NOT number the results — the cards below will show them

CRITICAL: Put a space after EVERY period, comma, and colon.
CRITICAL: ALWAYS include at least one [RECOMMEND: name] tag when there are relevant resources.

Example response for a location query:
[RECOMMEND: St. Patrick Cathedral]
[RECOMMEND: Holy Family Parish]
Here are some parishes near downtown Philadelphia. Tap the cards below to learn more!`;
}

// ── Follow-up prompt ──
function buildFollowUpPrompt(entities, queryStr, entityName) {
    if (entities.length === 0) {
        return `You are Gabriel, a Catholic AI assistant. The user asked about "${entityName}" but I couldn't find detailed information about it. Let them know politely and suggest they try a different query. Keep it brief.`;
    }

    const entity = entities[0];
    let details = entity.description || 'No additional details available.';

    return `You are Gabriel, a Catholic AI assistant helping users discover Catholic resources in the Nave app.

THE USER WANTS TO KNOW MORE ABOUT: "${entityName}"

HERE IS WHAT I KNOW ABOUT THIS RESOURCE:
Name: ${entity.name}
Type: ${entity.type}
${entity.location ? `Location: ${entity.location}` : ''}
${entity.subtitle ? `Category: ${entity.subtitle}` : ''}

DETAILS:
${details}

YOUR TASK:
1. Share the available information about this resource in a helpful, conversational way
2. Include [RECOMMEND: ${entity.name}] so the card appears
3. If you have limited data, just share what's available — do NOT make up details like mass times, events, descriptions, or history that aren't listed above
4. Keep response under 80 words

RULES:
- ONLY share facts from the data above
- NEVER fabricate descriptions, schedules, history, or services not listed
- If the data is sparse, say something like "Here's what I have on [name]" and share what's available
- Be warm and brief

CRITICAL: Put a space after EVERY period, comma, and colon.`;
}

// ── Organization system prompt ──
function buildOrganizationSystemPrompt(orgs, specificName) {
    if (orgs.length === 0) return '';

    let prompt = '\n\nCATHOLIC NETWORKS & ORGANIZATIONS AVAILABLE:\n';

    if (specificName) {
        const match = orgs.find(o => o.name.toLowerCase().includes(specificName.toLowerCase()));
        if (match) {
            prompt += `ORGANIZATION: ${match.name}\nType: ${match.type}\nDescription: ${match.description}\nMembers: ${match.memberCount}\nFeatures: ${(match.features || []).join(', ')}`;
            if (match.websiteURL) prompt += `\nWebsite: ${match.websiteURL}`;
            return prompt;
        }
    }

    for (const org of orgs) {
        prompt += `- ${org.name} (${org.type}): ${org.description}`;
        if (org.memberCount > 0) prompt += ` | ${org.memberCount} members`;
        if (org.features && org.features.length) prompt += ` | Features: ${org.features.join(', ')}`;
        prompt += '\n';
    }

    prompt += `
RESPONSE INSTRUCTIONS FOR ORGANIZATION QUERIES:
1. Recommend the most relevant organization(s) for what the user is asking about
2. Use [RECOMMEND_ORG: exact organization name] tag for each recommendation
3. Briefly explain why this organization would help them
4. Keep response concise (2-3 sentences max)

CRITICAL: Always include [RECOMMEND_ORG: name] tag to create a tappable card.`;

    return prompt;
}

// ======================================================================
// SECTION 7: RESPONSE PARSING (mirrors iOS parseRecommendation)
// ======================================================================

function parseRecommendation(response, context, orgContexts) {
    // ── Parse entity recommendations ──
    const entityPattern = /\[RECOMMEND:\s*([^\]]+)\]/gi;
    let match;
    let suggestions = [];
    let matchedIds = new Set();

    while ((match = entityPattern.exec(response)) !== null) {
        const recName = match[1].trim();
        if (recName.toLowerCase() === 'none') continue;

        const found = context.find(e => {
            if (matchedIds.has(e.id)) return false;
            const eName = e.name.toLowerCase();
            const rName = recName.toLowerCase();
            return eName === rName ||
                   eName.includes(rName) ||
                   rName.includes(eName) ||
                   eName.replace(/^(st\.?|saint)\s+/i, '').includes(rName.replace(/^(st\.?|saint)\s+/i, ''));
        });

        if (found) {
            matchedIds.add(found.id);
            suggestions.push(found);
        }
    }

    // ── Parse event recommendations (NEW — mirrors iOS) ──
    const eventPattern = /\[RECOMMEND_EVENT:\s*([^\]]+)\]/gi;
    let suggestedEvents = [];

    while ((match = eventPattern.exec(response)) !== null) {
        const content = match[1].trim();
        const parts = content.split('|').map(p => p.trim());

        if (parts.length >= 3) {
            const title = parts[0];
            const date = parts[1];
            const time = parts[2];
            const parishName = parts.length > 3 ? parts[3] : null;

            console.log(`🎯 [Gabriel] AI recommended event: '${title}' on ${date} at ${time}`);
            suggestedEvents.push({ title, date, time, parishName });
        }
    }

    // ── Parse organization recommendations ──
    const orgPattern = /\[RECOMMEND_ORG:\s*([^\]]+)\]/gi;
    while ((match = orgPattern.exec(response)) !== null) {
        const recName = match[1].trim();
        if (recName.toLowerCase() === 'none') continue;
        const found = (orgContexts || []).find(o =>
            o.name.toLowerCase() === recName.toLowerCase() ||
            o.name.toLowerCase().includes(recName.toLowerCase()) ||
            recName.toLowerCase().includes(o.name.toLowerCase())
        );
        if (found) {
            suggestions.push({ id: found.id, name: found.name, type: 'Organization', subtitle: found.type, description: found.description, location: '' });
        }
    }

    // ── Remove all tag types from display text ──
    let cleaned = response
        .replace(/\[RECOMMEND:[^\]]*\]\s*/gi, '')
        .replace(/\[RECOMMEND_EVENT:[^\]]*\]\s*/gi, '')
        .replace(/\[RECOMMEND_ORG:[^\]]*\]\s*/gi, '')
        .trim();

    // Fix spacing issues (mirrors iOS fixSpacing)
    cleaned = fixSpacing(cleaned);

    // Only suppress suggestions if the AI truly found nothing
    const noMatchPhrases = ["don't have", "no matching", "sorry", "can't find", "not found", "no resources", "isn't in"];
    if (suggestions.length === 0 && suggestedEvents.length === 0) {
        const admitsNoMatch = noMatchPhrases.some(p => cleaned.toLowerCase().includes(p));
        if (admitsNoMatch) {
            return { cleanedResponse: cleaned, suggestedEntities: [], suggestedEvents: [] };
        }
    }

    return {
        cleanedResponse: cleaned,
        suggestedEntities: suggestions.slice(0, 3),
        suggestedEvents: suggestedEvents.slice(0, 3)
    };
}

// ── Fix spacing (mirrors iOS fixSpacing exactly) ──
function fixSpacing(text) {
    let r = text;
    // Missing space after periods (but not in URLs/decimals)
    r = r.replace(/\.([A-Za-z])/g, '. $1');
    // Fix over-correction for abbreviations
    r = r.replace(/St\.\s+/g, 'St. ');
    r = r.replace(/Dr\.\s+/g, 'Dr. ');
    // Missing space after commas
    r = r.replace(/,([A-Za-z0-9])/g, ', $1');
    // Missing space after colons (but not in times like 10:30)
    r = r.replace(/:([A-Za-z])/g, ': $1');
    // Missing space after exclamation marks
    r = r.replace(/!([A-Za-z0-9])/g, '! $1');
    // Missing space after question marks
    r = r.replace(/\?([A-Za-z0-9])/g, '? $1');
    // Missing space before emojis (common unicode ranges)
    r = r.replace(/([A-Za-z0-9])([⛪🙏✝️📅📋🌐📞📝🏛️📍])/g, '$1 $2');
    // Fix double spaces
    r = r.replace(/  /g, ' ');
    // Fix AM/PM spacing issues
    r = r.replace(/AM([A-Z])/g, 'AM $1');
    r = r.replace(/PM([A-Z])/g, 'PM $1');
    return r;
}

// ======================================================================
// SECTION 8: CONTEXT FETCHING (existing, cleaned up)
// ======================================================================

async function fetchRankedContext(queryStr) {
    const queryLower = queryStr.toLowerCase();
    const fetchers = [
        fetchChurchContext(queryLower),
        fetchMissionaryContext(queryLower),
        fetchPilgrimageContext(queryLower),
        fetchRetreatContext(queryLower),
        fetchSchoolContext(queryLower),
        fetchVocationContext(queryLower),
        fetchBusinessContext(queryLower),
        fetchCampusMinistryContext(queryLower)
    ];

    const results = await Promise.all(fetchers);
    const all = results.flat();
    console.log(`📦 [Gabriel] Total entities: ${all.length}`);
    return all;
}

function isQueryRelevant(queryStr, searchableText) {
    const words = queryStr.split(/\s+/);
    return words.some(w => w.length > 2 && searchableText.includes(w));
}

// Major city → { state, lat, lng }
const CITY_DATA = {
    'philadelphia':    { state: 'PA', lat: 39.9526, lng: -75.1652 },
    'pittsburgh':      { state: 'PA', lat: 40.4406, lng: -79.9959 },
    'harrisburg':      { state: 'PA', lat: 40.2732, lng: -76.8867 },
    'allentown':       { state: 'PA', lat: 40.6084, lng: -75.4902 },
    'norristown':      { state: 'PA', lat: 40.1218, lng: -75.3399 },
    'conshohocken':    { state: 'PA', lat: 40.0782, lng: -75.3016 },
    'ardmore':         { state: 'PA', lat: 40.0068, lng: -75.2846 },
    'bryn mawr':       { state: 'PA', lat: 40.0210, lng: -75.3163 },
    'media':           { state: 'PA', lat: 39.9168, lng: -75.3877 },
    'wayne':           { state: 'PA', lat: 40.0440, lng: -75.3877 },
    'paoli':           { state: 'PA', lat: 40.0421, lng: -75.4813 },
    'exton':           { state: 'PA', lat: 40.0290, lng: -75.6210 },
    'west chester':    { state: 'PA', lat: 39.9607, lng: -75.6055 },
    'doylestown':      { state: 'PA', lat: 40.3101, lng: -75.1299 },
    'lansdale':        { state: 'PA', lat: 40.2415, lng: -75.2835 },
    'ambler':          { state: 'PA', lat: 40.1543, lng: -75.2213 },
    'jenkintown':      { state: 'PA', lat: 40.0960, lng: -75.1252 },
    'cheltenham':      { state: 'PA', lat: 40.0590, lng: -75.1077 },
    'abington':        { state: 'PA', lat: 40.1140, lng: -75.1177 },
    'new york':        { state: 'NY', lat: 40.7128, lng: -74.0060 },
    'brooklyn':        { state: 'NY', lat: 40.6782, lng: -73.9442 },
    'queens':          { state: 'NY', lat: 40.7282, lng: -73.7949 },
    'bronx':           { state: 'NY', lat: 40.8448, lng: -73.8648 },
    'manhattan':       { state: 'NY', lat: 40.7831, lng: -73.9712 },
    'buffalo':         { state: 'NY', lat: 42.8864, lng: -78.8784 },
    'rochester':       { state: 'NY', lat: 43.1566, lng: -77.6088 },
    'albany':          { state: 'NY', lat: 42.6526, lng: -73.7562 },
    'syracuse':        { state: 'NY', lat: 43.0481, lng: -76.1474 },
    'chicago':         { state: 'IL', lat: 41.8781, lng: -87.6298 },
    'boston':           { state: 'MA', lat: 42.3601, lng: -71.0589 },
    'los angeles':     { state: 'CA', lat: 34.0522, lng: -118.2437 },
    'san francisco':   { state: 'CA', lat: 37.7749, lng: -122.4194 },
    'san diego':       { state: 'CA', lat: 32.7157, lng: -117.1611 },
    'san jose':        { state: 'CA', lat: 37.3382, lng: -121.8863 },
    'sacramento':      { state: 'CA', lat: 38.5816, lng: -121.4944 },
    'denver':          { state: 'CO', lat: 39.7392, lng: -104.9903 },
    'colorado springs':{ state: 'CO', lat: 38.8339, lng: -104.8214 },
    'dallas':          { state: 'TX', lat: 32.7767, lng: -96.7970 },
    'houston':         { state: 'TX', lat: 29.7604, lng: -95.3698 },
    'san antonio':     { state: 'TX', lat: 29.4241, lng: -98.4936 },
    'austin':          { state: 'TX', lat: 30.2672, lng: -97.7431 },
    'fort worth':      { state: 'TX', lat: 32.7555, lng: -97.3308 },
    'atlanta':         { state: 'GA', lat: 33.7490, lng: -84.3880 },
    'miami':           { state: 'FL', lat: 25.7617, lng: -80.1918 },
    'orlando':         { state: 'FL', lat: 28.5383, lng: -81.3792 },
    'tampa':           { state: 'FL', lat: 27.9506, lng: -82.4572 },
    'jacksonville':    { state: 'FL', lat: 30.3322, lng: -81.6557 },
    'phoenix':         { state: 'AZ', lat: 33.4484, lng: -112.0740 },
    'tucson':          { state: 'AZ', lat: 32.2226, lng: -110.9747 },
    'seattle':         { state: 'WA', lat: 47.6062, lng: -122.3321 },
    'portland':        { state: 'OR', lat: 45.5152, lng: -122.6784 },
    'minneapolis':     { state: 'MN', lat: 44.9778, lng: -93.2650 },
    'st. paul':        { state: 'MN', lat: 44.9537, lng: -93.0900 },
    'st. louis':       { state: 'MO', lat: 38.6270, lng: -90.1994 },
    'kansas city':     { state: 'MO', lat: 39.0997, lng: -94.5786 },
    'detroit':         { state: 'MI', lat: 42.3314, lng: -83.0458 },
    'grand rapids':    { state: 'MI', lat: 42.9634, lng: -85.6681 },
    'cleveland':       { state: 'OH', lat: 41.4993, lng: -81.6944 },
    'columbus':        { state: 'OH', lat: 39.9612, lng: -82.9988 },
    'cincinnati':      { state: 'OH', lat: 39.1031, lng: -84.5120 },
    'baltimore':       { state: 'MD', lat: 39.2904, lng: -76.6122 },
    'washington':      { state: 'DC', lat: 38.9072, lng: -77.0369 },
    'omaha':           { state: 'NE', lat: 41.2565, lng: -95.9345 },
    'nashville':       { state: 'TN', lat: 36.1627, lng: -86.7816 },
    'memphis':         { state: 'TN', lat: 35.1495, lng: -90.0490 },
    'richmond':        { state: 'VA', lat: 37.5407, lng: -77.4360 },
    'charlotte':       { state: 'NC', lat: 35.2271, lng: -80.8431 },
    'raleigh':         { state: 'NC', lat: 35.7796, lng: -78.6382 },
    'indianapolis':    { state: 'IN', lat: 39.7684, lng: -86.1581 },
    'milwaukee':       { state: 'WI', lat: 43.0389, lng: -87.9065 },
    'new orleans':     { state: 'LA', lat: 29.9511, lng: -90.0715 },
    'baton rouge':     { state: 'LA', lat: 30.4515, lng: -91.1871 },
    'bridgeport':      { state: 'CT', lat: 41.1865, lng: -73.1952 },
    'hartford':        { state: 'CT', lat: 41.7658, lng: -72.6734 },
    'new haven':       { state: 'CT', lat: 41.3083, lng: -72.9279 },
    'providence':      { state: 'RI', lat: 41.8240, lng: -71.4128 },
    'newark':          { state: 'NJ', lat: 40.7357, lng: -74.1724 },
    'jersey city':     { state: 'NJ', lat: 40.7178, lng: -74.0431 },
    'trenton':         { state: 'NJ', lat: 40.2171, lng: -74.7429 },
    'camden':          { state: 'NJ', lat: 39.9259, lng: -75.1196 },
    'wilmington':      { state: 'DE', lat: 39.7391, lng: -75.5398 },
};

// Haversine distance in miles
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractCoords(docData) {
    const d = docData;
    if (d.coordinates) {
        const c = d.coordinates;
        if (c.latitude !== undefined) return { lat: c.latitude, lng: c.longitude };
        if (c._latitude !== undefined) return { lat: c._latitude, lng: c._longitude };
        if (Array.isArray(c)) return { lat: c[0], lng: c[1] };
    }
    if (d.latitude !== undefined && d.longitude !== undefined) return { lat: d.latitude, lng: d.longitude };
    if (d.lat !== undefined && (d.lng !== undefined || d.lon !== undefined)) return { lat: d.lat, lng: d.lng || d.lon };
    return null;
}

// Detect city-based location query (returns { city, expectedState, centerLat, centerLng })
function detectLocationQuery(q) {
    const locationPatterns = [
        /(?:near|in|around|close to|nearby)\s+([A-Za-z\s.]+)/i,
        /([A-Za-z\s.]+?)\s+(?:parishes|churches|schools|retreats|businesses|mass)/i,
        /parishes?\s+(?:near|in|around)\s+([A-Za-z\s.]+)/i,
        /churches?\s+(?:near|in|around)\s+([A-Za-z\s.]+)/i,
    ];

    let cityName = null;
    for (const pattern of locationPatterns) {
        const match = q.match(pattern);
        if (match) { cityName = match[1].trim().toLowerCase(); break; }
    }

    if (!cityName) {
        const sorted = Object.keys(CITY_DATA).sort((a, b) => b.length - a.length);
        for (const city of sorted) {
            if (q.includes(city)) { cityName = city; break; }
        }
    }

    if (!cityName) return null;

    const statePattern = new RegExp(cityName.replace('.', '\\.') + '[,\\s]+([A-Z]{2})\\b', 'i');
    const stateMatch = q.match(statePattern);
    const cityData = CITY_DATA[cityName];
    const expectedState = stateMatch ? stateMatch[1].toUpperCase() : (cityData?.state || null);
    const centerLat = cityData?.lat || null;
    const centerLng = cityData?.lng || null;

    return { city: cityName, expectedState, centerLat, centerLng };
}

// ── Individual entity fetchers ─────────────────────────────────────────

async function fetchChurchContext(q) {
    try {
        const locationInfo = detectLocationQuery(q);
        const isLocationBased = locationInfo !== null;
        const detectedCity = locationInfo?.city || null;
        const expectedState = locationInfo?.expectedState || null;

        let allDocs = [];

        if (isLocationBased) {
            console.log(`📍 [Gabriel] Location query detected: "${detectedCity}"${expectedState ? ` (expected state: ${expectedState})` : ''} — loading all churches`);
            const snap = await getDocs(collection(db, 'Churches'));
            snap.forEach(doc => allDocs.push(doc));
        } else {
            const unlockedSnap = await getDocs(query(collection(db, 'Churches'), where('isUnlocked', '==', true)));
            unlockedSnap.forEach(doc => allDocs.push(doc));
            const extraSnap = await getDocs(query(collection(db, 'Churches'), limit(50)));
            extraSnap.forEach(doc => {
                if (!allDocs.some(d => d.id === doc.id)) allDocs.push(doc);
            });
        }

        const centerLat = locationInfo?.centerLat;
        const centerLng = locationInfo?.centerLng;
        const hasCenter = centerLat != null && centerLng != null;

        let scored = [];
        const seenIds = new Set();

        for (const doc of allDocs) {
            if (seenIds.has(doc.id)) continue;
            seenIds.add(doc.id);

            const d = doc.data();
            const name = d.name || '';
            const city = d.city || '';
            const state = d.state || '';
            const diocese = d.diocese || '';
            const address = d.address || '';
            const hasEvents = Array.isArray(d.events) && d.events.length > 0;
            const hasMass = d.massSchedule && Object.keys(d.massSchedule).length > 0;
            const isUnlocked = d.isUnlocked === true;

            let description = 'Catholic parish';
            if (hasEvents && hasMass) description = 'Parish with schedules & events';
            else if (hasMass) description = 'Parish with Mass schedule';

            const displayCity = city || extractCityFromAddress(address);
            const searchable = `${name} ${city} ${state} ${diocese} ${address} church parish catholic`.toLowerCase();

            let score = 0;
            let distanceMiles = Infinity;

            if (isLocationBased && hasCenter) {
                const coords = extractCoords(d);
                if (coords && coords.lat && coords.lng) {
                    distanceMiles = haversineDistance(centerLat, centerLng, coords.lat, coords.lng);
                    if (distanceMiles <= 30) {
                        score = Math.max(0, 200 - Math.round(distanceMiles * (200 / 30)));
                        if (expectedState) {
                            const stateUpper = state.toUpperCase();
                            if (stateUpper === expectedState) score += 20;
                            else if (stateUpper && stateUpper !== expectedState) score = -1;
                        }
                    }
                } else {
                    const cityLower = city.toLowerCase();
                    const addressLower = address.toLowerCase();
                    if (cityLower === detectedCity) score = 80;
                    else if (cityLower.includes(detectedCity) || addressLower.includes(detectedCity)) score = 60;
                    else if (diocese.toLowerCase().includes(detectedCity)) score = 20;
                    if (score > 0 && expectedState) {
                        if (state.toUpperCase() === expectedState) score += 20;
                        else if (state.toUpperCase() && state.toUpperCase() !== expectedState) score = -1;
                    }
                }
            } else {
                if (isQueryRelevant(q, searchable)) score += 10;
            }

            if (score > 0) {
                if (isUnlocked) score += 5;
                if (hasEvents) score += 3;
                if (hasMass) score += 2;
            }

            if (score > 0) {
                scored.push({
                    score, distanceMiles,
                    context: {
                        id: doc.id, name, type: EntityType.CHURCH,
                        subtitle: diocese || 'Parish', description,
                        location: displayCity ? `${displayCity}, ${state}` : state
                    }
                });
            }
        }

        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.distanceMiles - b.distanceMiles;
        });

        const maxResults = isLocationBased ? 15 : 10;
        const results = scored.slice(0, maxResults).map(s => s.context);

        if (isLocationBased && scored.length > 0) {
            const within5 = scored.filter(s => s.distanceMiles <= 5).length;
            const within15 = scored.filter(s => s.distanceMiles <= 15).length;
            console.log(`⛪ [Gabriel] Found ${results.length} churches near ${detectedCity} (${within5} within 5mi, ${within15} within 15mi)`);
            scored.slice(0, 3).forEach((s, i) => console.log(`   ${i + 1}. ${s.context.name} — ${s.distanceMiles === Infinity ? 'no coords' : s.distanceMiles.toFixed(1) + 'mi'} (score: ${s.score})`));
        } else {
            console.log(`⛪ [Gabriel] Found ${results.length} churches`);
        }
        return results;
    } catch (e) {
        console.error('❌ Error fetching churches:', e);
        return [];
    }
}

async function fetchMissionaryContext(q) {
    try {
        const snap = await getDocs(query(collection(db, 'missionaries'), limit(30)));
        let contexts = [];
        snap.forEach(doc => {
            const d = doc.data();
            const name = d.name || '';
            const org = d.organization || '';
            const desc = (d.bio || d.description || '').substring(0, 100);
            const city = d.city || '';
            const country = d.country || '';
            const searchable = `${name} ${org} ${desc} ${city} ${country} missionary mission`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({
                    id: doc.id, name, type: EntityType.MISSIONARY,
                    subtitle: org, description: desc,
                    location: country ? `${city}, ${country}` : city
                });
            }
        });
        return contexts.slice(0, 5);
    } catch (e) {
        console.error('❌ Error fetching missionaries:', e);
        return [];
    }
}

async function fetchPilgrimageContext(q) {
    let contexts = [];
    try {
        const sitesSnap = await getDocs(query(collection(db, 'pilgrimageSites'), limit(20)));
        sitesSnap.forEach(doc => {
            const d = doc.data();
            const name = d.name || '';
            const location = d.location || '';
            const desc = (d.description || '').substring(0, 100);
            const searchable = `${name} ${location} ${desc} pilgrimage holy site shrine`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({ id: doc.id, name, type: EntityType.PILGRIMAGE, subtitle: 'Pilgrimage Site', description: desc, location });
            }
        });
    } catch (e) { console.error('❌ Error fetching pilgrimage sites:', e); }

    try {
        const offSnap = await getDocs(query(collection(db, 'pilgrimageOfferings'), limit(20)));
        offSnap.forEach(doc => {
            const d = doc.data();
            const title = d.title || '';
            const location = d.location || '';
            const desc = (d.description || '').substring(0, 100);
            const searchable = `${title} ${location} ${desc} pilgrimage trip tour`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({ id: doc.id, name: title, type: EntityType.PILGRIMAGE, subtitle: 'Pilgrimage Trip', description: desc, location });
            }
        });
    } catch (e) { console.error('❌ Error fetching pilgrimage offerings:', e); }

    return contexts.slice(0, 5);
}

async function fetchRetreatContext(q) {
    let contexts = [];

    try {
        const snap = await getDocs(query(collection(db, 'retreats'), limit(20)));
        snap.forEach(doc => {
            const d = doc.data();
            const name = d.name || d.title || '';
            if (!name) return;
            const location = d.location || '';
            const desc = (d.description || '').substring(0, 100);
            const rType = d.retreatType || d.type || '';
            const searchable = `${name} ${location} ${desc} ${rType} retreat center spiritual`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({ id: doc.id, name, type: EntityType.RETREAT, subtitle: rType || 'Retreat Center', description: desc, location });
            }
        });
    } catch (e) { console.error('❌ Error fetching retreats:', e); }

    try {
        const offSnap = await getDocs(query(collection(db, 'retreatOfferings'), limit(20)));
        offSnap.forEach(doc => {
            const d = doc.data();
            const title = d.title || '';
            if (!title) return;
            const location = d.location || '';
            const desc = (d.description || '').substring(0, 100);
            const rType = d.retreatType || '';
            const searchable = `${title} ${location} ${desc} ${rType} retreat spiritual`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({ id: doc.id, name: title, type: EntityType.RETREAT, subtitle: rType || 'Retreat', description: desc, location });
            }
        });
    } catch (e) { console.error('❌ Error fetching retreat offerings:', e); }

    try {
        const orgSnap = await getDocs(query(collection(db, 'retreatOrganizations'), limit(20)));
        orgSnap.forEach(doc => {
            const d = doc.data();
            const name = d.name || '';
            if (!name) return;
            const desc = (d.description || '').substring(0, 100);
            const searchable = `${name} ${desc} retreat center organization`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({ id: doc.id, name, type: EntityType.RETREAT, subtitle: 'Retreat Center', description: desc, location: '' });
            }
        });
    } catch (e) { console.error('❌ Error fetching retreat organizations:', e); }

    return contexts.slice(0, 5);
}

async function fetchSchoolContext(q) {
    try {
        const locationInfo = detectLocationQuery(q);
        const isLocationBased = locationInfo !== null;
        const maxFetch = isLocationBased ? 100 : 30;
        const snap = await getDocs(query(collection(db, 'schools'), limit(maxFetch)));
        let contexts = [];
        snap.forEach(doc => {
            const d = doc.data();
            const name = d.name || '';
            const city = d.city || '';
            const state = d.state || '';
            const desc = (d.description || '').substring(0, 100);
            const sType = d.schoolType || '';
            const searchable = `${name} ${city} ${state} ${desc} ${sType} school catholic education`.toLowerCase();

            let relevant = isQueryRelevant(q, searchable);

            if (locationInfo) {
                const cityMatch = city.toLowerCase() === locationInfo.city;
                const stateMatch = locationInfo.expectedState && state.toUpperCase() === locationInfo.expectedState;
                if (cityMatch && stateMatch) relevant = true;
                else if (cityMatch) relevant = true;
            }

            if (relevant) {
                contexts.push({ id: doc.id, name, type: EntityType.SCHOOL, subtitle: sType || 'Catholic School', description: desc, location: `${city}, ${state}` });
            }
        });
        return contexts.slice(0, 5);
    } catch (e) {
        console.error('❌ Error fetching schools:', e);
        return [];
    }
}

async function fetchVocationContext(q) {
    try {
        const snap = await getDocs(query(collection(db, 'vocations'), limit(30)));
        let contexts = [];
        snap.forEach(doc => {
            const d = doc.data();
            const title = d.title || '';
            const location = d.location || '';
            const desc = (d.description || '').substring(0, 100);
            const vType = d.type || '';
            const searchable = `${title} ${location} ${desc} ${vType} vocation religious order seminary`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({ id: doc.id, name: title, type: EntityType.VOCATION, subtitle: vType || 'Religious Vocation', description: desc, location });
            }
        });
        return contexts.slice(0, 5);
    } catch (e) {
        console.error('❌ Error fetching vocations:', e);
        return [];
    }
}

async function fetchBusinessContext(q) {
    try {
        const locationInfo = detectLocationQuery(q);
        const isLocationBased = locationInfo !== null;
        const maxFetch = isLocationBased ? 100 : 50;
        const snap = await getDocs(query(collection(db, 'businesses'), limit(maxFetch)));
        let contexts = [];
        snap.forEach(doc => {
            const d = doc.data();
            const name = d.name || '';
            const cat = d.category || '';
            const sub = d.subcategory || '';
            const desc = (d.description || '').substring(0, 100);
            const city = d.addressCity || d.city || '';
            const state = d.addressState || d.state || '';
            const searchable = `${name} ${cat} ${sub} ${desc} ${city} ${state} business`.toLowerCase();

            let relevant = isQueryRelevant(q, searchable);

            if (locationInfo) {
                const cityMatch = city.toLowerCase() === locationInfo.city;
                const stateMatch = locationInfo.expectedState && state.toUpperCase() === locationInfo.expectedState;
                if (cityMatch && stateMatch) relevant = true;
                else if (cityMatch) relevant = true;
            }

            if (relevant) {
                contexts.push({ id: doc.id, name, type: EntityType.BUSINESS, subtitle: sub || cat, description: desc, location: `${city}, ${state}` });
            }
        });
        return contexts.slice(0, 10);
    } catch (e) {
        console.error('❌ Error fetching businesses:', e);
        return [];
    }
}

async function fetchCampusMinistryContext(q) {
    try {
        const snap = await getDocs(query(collection(db, 'bibleStudies'), limit(30)));
        let contexts = [];
        snap.forEach(doc => {
            const d = doc.data();
            const title = d.title || '';
            const location = d.location || '';
            const desc = (d.description || '').substring(0, 100);
            const t = d.type || '';
            const searchable = `${title} ${location} ${desc} ${t} campus ministry college university`.toLowerCase();
            if (isQueryRelevant(q, searchable)) {
                contexts.push({ id: doc.id, name: title, type: EntityType.CAMPUS_MINISTRY, subtitle: t || 'Campus Ministry', description: desc, location });
            }
        });
        return contexts.slice(0, 5);
    } catch (e) {
        console.error('❌ Error fetching campus ministries:', e);
        return [];
    }
}

// ── Organization fetching ──────────────────────────────────────────────

async function fetchOrganizations(queryStr) {
    try {
        const snap = await getDocs(collection(db, 'organizations'));
        let orgs = [];
        snap.forEach(doc => {
            const d = doc.data();
            if (!d.name || !d.description) return;
            orgs.push({
                id: doc.id,
                name: d.name,
                description: d.description,
                type: d.type || 'organization',
                memberCount: d.memberCount || 0,
                features: d.features || [],
                websiteURL: d.websiteURL || null
            });
        });
        return orgs;
    } catch (e) {
        console.error('❌ Error fetching organizations:', e);
        return [];
    }
}

// ── Fetch detailed data for a specific entity (for follow-ups) ────────
async function fetchEntityDetails(entity) {
    const collectionMap = {
        [EntityType.CHURCH]: 'Churches',
        [EntityType.MISSIONARY]: 'missionaries',
        [EntityType.PILGRIMAGE]: 'pilgrimageSites',
        [EntityType.RETREAT]: 'retreats',
        [EntityType.SCHOOL]: 'schools',
        [EntityType.VOCATION]: 'vocations',
        [EntityType.BUSINESS]: 'businesses',
        [EntityType.CAMPUS_MINISTRY]: 'bibleStudies',
    };

    const colName = collectionMap[entity.type];
    if (!colName) return [entity];

    try {
        const snap = await getDocs(collection(db, colName));
        let bestMatch = null;

        snap.forEach(doc => {
            const d = doc.data();
            const name = d.name || d.title || d.parishName || '';
            if (name.toLowerCase() === entity.name.toLowerCase() ||
                name.toLowerCase().includes(entity.name.toLowerCase()) ||
                entity.name.toLowerCase().includes(name.toLowerCase())) {

                const details = [];
                if (d.address) details.push(`Address: ${d.address}`);
                if (d.city && d.state) details.push(`Location: ${d.city}, ${d.state}`);
                if (d.diocese) details.push(`Diocese: ${d.diocese}`);
                if (d.phone) details.push(`Phone: ${d.phone}`);
                if (d.website || d.websiteURL || d.link) details.push(`Website: ${d.website || d.websiteURL || d.link}`);

                // Rich parish data
                if (d.massSchedule) {
                    const schedule = parseSchedule(d.massSchedule);
                    if (Object.keys(schedule).length > 0) {
                        details.push(`Mass Schedule: ${formatScheduleCompact(schedule)}`);
                    }
                }
                if (d.confessionSchedule) {
                    const schedule = parseSchedule(d.confessionSchedule);
                    if (Object.keys(schedule).length > 0) {
                        details.push(`Confession: ${formatScheduleCompact(schedule)}`);
                    }
                }
                if (d.adorationSchedule) {
                    const schedule = parseSchedule(d.adorationSchedule);
                    if (Object.keys(schedule).length > 0) {
                        details.push(`Adoration: ${formatScheduleCompact(schedule)}`);
                    }
                }

                if (d.events && Array.isArray(d.events) && d.events.length > 0) {
                    const eventNames = d.events.slice(0, 3).map(e => e.title || e.name || e).join(', ');
                    details.push(`Upcoming events: ${eventNames}`);
                }
                if (d.description) details.push(`Description: ${d.description.substring(0, 200)}`);
                if (d.schoolType) details.push(`Type: ${d.schoolType}`);
                if (d.category) details.push(`Category: ${d.category}`);
                if (d.subcategory) details.push(`Subcategory: ${d.subcategory}`);

                bestMatch = {
                    ...entity,
                    description: details.join('\n') || entity.description,
                    _fullData: true
                };
            }
        });

        return bestMatch ? [bestMatch] : [entity];
    } catch (e) {
        console.error('❌ Error fetching entity details:', e);
        return [entity];
    }
}

// ======================================================================
// SECTION 9: OpenAI API
// ======================================================================

async function callOpenAI(messages) {
    const res = await fetch(GABRIEL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages })
    });

    if (!res.ok) {
        const errBody = await res.text();
        console.error('❌ Gabriel API error:', errBody);
        throw new Error(`API_ERROR_${res.status}`);
    }

    const data = await res.json();
    if (!data.content) throw new Error('NO_RESPONSE');
    return data.content;
}

// ======================================================================
// SECTION 10: HELPERS
// ======================================================================

function extractCityFromAddress(address) {
    const parts = (address || '').split(',');
    if (parts.length >= 2) {
        return parts[parts.length - 2].trim().replace(/\d/g, '').trim();
    }
    return '';
}
