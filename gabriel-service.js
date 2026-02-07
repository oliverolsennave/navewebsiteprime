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

export function clearConversation() {
    conversationHistory = [];
    lastRecommendedEntities = [];
    lastLocationContext = null;
}

// Detect "tell me more about X" follow-up patterns
function extractFollowUpEntity(query) {
    const patterns = [
        /tell me (?:more )?about\s+(.+)/i,
        /more (?:info|information|details) (?:on|about)\s+(.+)/i,
        /what (?:is|about)\s+(.+)/i,
        /(?:learn|know) more about\s+(.+)/i,
    ];
    for (const p of patterns) {
        const m = query.match(p);
        if (m) return m[1].trim();
    }
    return null;
}

// ── Main entry: send a message and get Gabriel's response ──────────────
export async function sendMessage(userQuery) {
    if (!hasAPIKey()) {
        throw new Error('MISSING_KEY');
    }

    // 1. Add user message to history
    conversationHistory.push({ role: 'user', content: userQuery });

    // 2. Check if this is a follow-up about a previously recommended entity
    const followUpName = extractFollowUpEntity(userQuery);
    let context = [];
    let isFollowUp = false;

    if (followUpName && lastRecommendedEntities.length > 0) {
        // Try to find the entity in our last recommendations
        const matchedEntity = lastRecommendedEntities.find(e => {
            const eName = e.name.toLowerCase();
            const fName = followUpName.toLowerCase();
            return eName === fName || eName.includes(fName) || fName.includes(eName);
        });

        if (matchedEntity) {
            console.log(`🔗 [Gabriel] Follow-up detected for: "${matchedEntity.name}"`);
            isFollowUp = true;
            // Use the matched entity as the sole context — fetch its full data
            context = await fetchEntityDetails(matchedEntity);
        }
    }

    // 3. If not a follow-up, do a normal RAG fetch
    if (!isFollowUp) {
        // Track location for future follow-ups
        const locInfo = detectLocationQuery(userQuery.toLowerCase());
        if (locInfo) lastLocationContext = locInfo;

        context = await fetchRankedContext(userQuery);
        console.log(`🎯 [Gabriel] Fetched ${context.length} relevant entities`);
    }

    // 4. Check for organization queries
    const isOrgQuery = detectOrganizationQuery(userQuery.toLowerCase());
    let orgContexts = [];
    if (isOrgQuery) {
        orgContexts = await fetchOrganizations(userQuery);
        console.log(`📚 [Gabriel] Fetched ${orgContexts.length} organizations`);
    }

    // 5. Build system prompt
    let systemPrompt;
    if (isFollowUp) {
        systemPrompt = buildFollowUpPrompt(context, userQuery, followUpName);
    } else {
        systemPrompt = buildUnifiedSystemPrompt(context, userQuery);
    }

    if (orgContexts.length > 0) {
        const specificOrgName = extractOrganizationName(userQuery);
        systemPrompt += buildOrganizationSystemPrompt(orgContexts, specificOrgName);
    }

    // 6. Build OpenAI messages
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory
    ];

    // 7. Call OpenAI
    const response = await callOpenAI(messages);

    // 8. Parse response (strip RECOMMEND tags)
    const { cleanedResponse, suggestedEntities } = parseRecommendation(response, context, orgContexts);

    // 9. Save recommended entities for follow-ups
    if (suggestedEntities.length > 0) {
        lastRecommendedEntities = suggestedEntities;
    } else if (context.length > 0 && !isFollowUp) {
        lastRecommendedEntities = context.slice(0, 5);
    }

    // 10. Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: cleanedResponse });

    return { text: cleanedResponse, suggestions: suggestedEntities };
}

// ── Fetch detailed data for a specific entity (for follow-ups) ────────
async function fetchEntityDetails(entity) {
    // Try to find the full document by searching the relevant collection
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
    if (!colName) return [entity]; // fallback to what we have

    try {
        const snap = await getDocs(collection(db, colName));
        let bestMatch = null;

        snap.forEach(doc => {
            const d = doc.data();
            const name = d.name || d.title || d.parishName || '';
            if (name.toLowerCase() === entity.name.toLowerCase() ||
                name.toLowerCase().includes(entity.name.toLowerCase()) ||
                entity.name.toLowerCase().includes(name.toLowerCase())) {

                // Build a rich context from all available fields
                const details = [];
                if (d.address) details.push(`Address: ${d.address}`);
                if (d.city && d.state) details.push(`Location: ${d.city}, ${d.state}`);
                if (d.diocese) details.push(`Diocese: ${d.diocese}`);
                if (d.phone) details.push(`Phone: ${d.phone}`);
                if (d.website || d.websiteURL) details.push(`Website: ${d.website || d.websiteURL}`);
                if (d.massSchedule) {
                    const masses = Object.entries(d.massSchedule).map(([day, times]) => `${day}: ${Array.isArray(times) ? times.join(', ') : times}`).join('; ');
                    if (masses) details.push(`Mass Schedule: ${masses}`);
                }
                if (d.confessionSchedule) details.push(`Confession: ${d.confessionSchedule}`);
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

// ── Context fetching (mirrors fetchRankedContext) ──────────────────────

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

// Major city → { state, lat, lng } — center coordinates + expected state
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

// Haversine distance in miles between two lat/lng points
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 3959; // Earth's radius in miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Extract coordinates from a Firebase church document
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

// Detect if query is location-based and extract city + expected state + center coords
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
        // Check longest city names first to match "new york" before "york"
        const sorted = Object.keys(CITY_DATA).sort((a, b) => b.length - a.length);
        for (const city of sorted) {
            if (q.includes(city)) { cityName = city; break; }
        }
    }

    if (!cityName) return null;

    // Check if user explicitly mentioned a state (e.g., "Philadelphia DE" or "Philadelphia, PA")
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

        // For location queries, load ALL churches (like the map does) so we can match by city
        // For non-location queries, use smaller batches
        let allDocs = [];

        if (isLocationBased) {
            console.log(`📍 [Gabriel] Location query detected: "${detectedCity}"${expectedState ? ` (expected state: ${expectedState})` : ''} — loading all churches`);
            const snap = await getDocs(collection(db, 'Churches'));
            snap.forEach(doc => allDocs.push(doc));
        } else {
            // Non-location: fetch unlocked + some extras
            const unlockedSnap = await getDocs(query(collection(db, 'Churches'), where('isUnlocked', '==', true)));
            unlockedSnap.forEach(doc => allDocs.push(doc));
            const extraSnap = await getDocs(query(collection(db, 'Churches'), limit(50)));
            extraSnap.forEach(doc => {
                if (!allDocs.some(d => d.id === doc.id)) allDocs.push(doc);
            });
        }

        // Get city center coords for distance calculation
        const centerLat = locationInfo?.centerLat;
        const centerLng = locationInfo?.centerLng;
        const hasCenter = centerLat !== null && centerLng !== null && centerLat !== undefined && centerLng !== undefined;

        // Score and rank churches
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

            // Relevance scoring
            let score = 0;
            let distanceMiles = Infinity;

            if (isLocationBased && hasCenter) {
                // PRIMARY: Distance-based scoring (closest to city center wins)
                const coords = extractCoords(d);
                if (coords && coords.lat && coords.lng) {
                    distanceMiles = haversineDistance(centerLat, centerLng, coords.lat, coords.lng);

                    // Only consider churches within 30 miles of city center
                    if (distanceMiles <= 30) {
                        // Distance score: closer = higher (max 200 for 0 miles, 0 for 30 miles)
                        score = Math.max(0, 200 - Math.round(distanceMiles * (200 / 30)));

                        // State: hard filter — wrong state gets eliminated
                        if (expectedState) {
                            const stateUpper = state.toUpperCase();
                            if (stateUpper === expectedState) {
                                score += 20; // Boost correct state
                            } else if (stateUpper && stateUpper !== expectedState) {
                                score = -1; // Eliminate wrong state entirely
                            }
                        }
                    }
                } else {
                    // No coordinates — fall back to city name matching
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
                // Non-location: general keyword relevance
                if (isQueryRelevant(q, searchable)) score += 10;
            }

            // Bonus for rich data
            if (isUnlocked) score += 5;
            if (hasEvents) score += 3;
            if (hasMass) score += 2;

            if (score > 0 || !isLocationBased) {
                scored.push({
                    score,
                    distanceMiles,
                    context: {
                        id: doc.id, name, type: EntityType.CHURCH,
                        subtitle: diocese || 'Parish', description,
                        location: displayCity ? `${displayCity}, ${state}` : state
                    }
                });
            }
        }

        // Sort by score descending, then by distance ascending
        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.distanceMiles - b.distanceMiles;
        });

        // Return top results
        const maxResults = isLocationBased ? 15 : 10;
        const results = scored.slice(0, maxResults).map(s => s.context);

        if (isLocationBased && scored.length > 0) {
            const within5 = scored.filter(s => s.distanceMiles <= 5).length;
            const within15 = scored.filter(s => s.distanceMiles <= 15).length;
            console.log(`⛪ [Gabriel] Found ${results.length} churches near ${detectedCity} (${within5} within 5mi, ${within15} within 15mi)`);
            // Log top 3 for debugging
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
            if (isQueryRelevant(q, searchable) || contexts.length < 3) {
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
            if (isQueryRelevant(q, searchable) || contexts.length < 3) {
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
            if (isQueryRelevant(q, searchable) || contexts.length < 5) {
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
            if (isQueryRelevant(q, searchable) || contexts.length < 3) {
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
            if (isQueryRelevant(q, searchable) || contexts.length < 5) {
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
            if (isQueryRelevant(q, searchable) || contexts.length < 7) {
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
        // For location queries, load more schools
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

            // Boost location-matched schools
            if (locationInfo) {
                const cityMatch = city.toLowerCase() === locationInfo.city;
                const stateMatch = locationInfo.expectedState && state.toUpperCase() === locationInfo.expectedState;
                if (cityMatch && stateMatch) relevant = true;
                else if (cityMatch) relevant = true;
            }

            if (relevant || contexts.length < 3) {
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
            if (isQueryRelevant(q, searchable) || contexts.length < 3) {
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

            if (relevant || contexts.length < 5) {
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
            if (isQueryRelevant(q, searchable) || contexts.length < 3) {
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

// ── System prompt building (mirrors iOS exactly) ───────────────────────

function buildUnifiedSystemPrompt(entities, queryStr) {
    if (entities.length === 0) {
        return `You are Gabriel, a friendly Catholic AI assistant in the Nave app. You help users discover Catholic churches, schools, retreats, pilgrimages, missionaries, vocations, and businesses.

I couldn't find specific matches for this query, but I'm always learning about new Catholic resources!

If they're greeting you, respond warmly and let them know you can help find Catholic parishes, schools, retreats, pilgrimages, and more.

If they asked about something specific, kindly let them know you don't have that particular information yet and encourage them to try another query.

Keep your tone warm, conversational, and helpful. Don't mention databases, queries, or technical terms.`;
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

// ── Follow-up prompt for "tell me more about X" ───────────────────────
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

// ── Response parsing (strip RECOMMEND tags) ────────────────────────────

function parseRecommendation(response, context, orgContexts) {
    // Parse entity recommendations FIRST (before cleaning tags)
    const entityPattern = /\[RECOMMEND:\s*([^\]]+)\]/gi;
    let match;
    let suggestions = [];
    let matchedIds = new Set();

    while ((match = entityPattern.exec(response)) !== null) {
        const recName = match[1].trim();
        if (recName.toLowerCase() === 'none') continue;

        // Try exact match first, then fuzzy
        const found = context.find(e => {
            if (matchedIds.has(e.id)) return false;
            const eName = e.name.toLowerCase();
            const rName = recName.toLowerCase();
            return eName === rName ||
                   eName.includes(rName) ||
                   rName.includes(eName) ||
                   // Also try matching without common prefixes like "St.", "Saint", etc.
                   eName.replace(/^(st\.?|saint)\s+/i, '').includes(rName.replace(/^(st\.?|saint)\s+/i, ''));
        });

        if (found) {
            matchedIds.add(found.id);
            suggestions.push(found);
        }
    }

    // Parse organization recommendations
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

    // Remove all tag types from display text
    let cleaned = response
        .replace(/\[RECOMMEND:[^\]]*\]\s*/gi, '')
        .replace(/\[RECOMMEND_EVENT:[^\]]*\]\s*/gi, '')
        .replace(/\[RECOMMEND_ORG:[^\]]*\]\s*/gi, '')
        .trim();

    // Fix spacing issues (mirrors iOS fixSpacing)
    cleaned = fixSpacing(cleaned);

    // Only suppress suggestions if the AI truly found nothing
    // (no tags at all AND the response admits no match)
    if (suggestions.length === 0) {
        const noMatchPhrases = ["don't have", "no matching", "can't find", "not found", "no resources", "isn't in"];
        const admitsNoMatch = noMatchPhrases.some(p => cleaned.toLowerCase().includes(p));
        if (admitsNoMatch) {
            return { cleanedResponse: cleaned, suggestedEntities: [] };
        }
    }

    return { cleanedResponse: cleaned, suggestedEntities: suggestions.slice(0, 3) };
}

function fixSpacing(text) {
    let r = text;
    r = r.replace(/\.([A-Za-z])/g, '. $1');
    r = r.replace(/,([A-Za-z0-9])/g, ', $1');
    r = r.replace(/:([A-Za-z])/g, ': $1');
    r = r.replace(/!([A-Za-z0-9])/g, '! $1');
    r = r.replace(/\?([A-Za-z0-9])/g, '? $1');
    r = r.replace(/  /g, ' ');
    return r;
}

// ── OpenAI API call (via Vercel serverless proxy) ──────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────

function extractCityFromAddress(address) {
    const parts = (address || '').split(',');
    if (parts.length >= 2) {
        return parts[parts.length - 2].trim().replace(/\d/g, '').trim();
    }
    return '';
}
