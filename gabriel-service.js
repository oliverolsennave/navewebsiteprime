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

export function clearConversation() {
    conversationHistory = [];
}

// ── Main entry: send a message and get Gabriel's response ──────────────
export async function sendMessage(userQuery) {
    if (!hasAPIKey()) {
        throw new Error('MISSING_KEY');
    }

    // 1. Add user message to history
    conversationHistory.push({ role: 'user', content: userQuery });

    // 2. RAG: Fetch relevant entities from Firebase
    const context = await fetchRankedContext(userQuery);
    console.log(`🎯 [Gabriel] Fetched ${context.length} relevant entities`);

    // 3. Check for organization queries
    const isOrgQuery = detectOrganizationQuery(userQuery.toLowerCase());
    let orgContexts = [];
    if (isOrgQuery) {
        orgContexts = await fetchOrganizations(userQuery);
        console.log(`📚 [Gabriel] Fetched ${orgContexts.length} organizations`);
    }

    // 4. Build system prompt (matches iOS exactly)
    let systemPrompt = buildUnifiedSystemPrompt(context, userQuery);

    if (orgContexts.length > 0) {
        const specificOrgName = extractOrganizationName(userQuery);
        systemPrompt += buildOrganizationSystemPrompt(orgContexts, specificOrgName);
    }

    // 5. Build OpenAI messages
    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory
    ];

    // 6. Call OpenAI
    const response = await callOpenAI(messages);

    // 7. Parse response (strip RECOMMEND tags)
    const { cleanedResponse, suggestedEntities } = parseRecommendation(response, context, orgContexts);

    // 8. Add assistant response to history
    conversationHistory.push({ role: 'assistant', content: cleanedResponse });

    return { text: cleanedResponse, suggestions: suggestedEntities };
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

// Major city → expected state mapping (the "obvious" state when no state is specified)
const CITY_STATE_MAP = {
    'philadelphia': 'PA', 'pittsburgh': 'PA', 'harrisburg': 'PA', 'allentown': 'PA',
    'new york': 'NY', 'brooklyn': 'NY', 'queens': 'NY', 'bronx': 'NY', 'manhattan': 'NY',
    'buffalo': 'NY', 'rochester': 'NY', 'albany': 'NY', 'syracuse': 'NY',
    'chicago': 'IL', 'boston': 'MA', 'los angeles': 'CA', 'san francisco': 'CA',
    'san diego': 'CA', 'san jose': 'CA', 'sacramento': 'CA',
    'denver': 'CO', 'colorado springs': 'CO',
    'dallas': 'TX', 'houston': 'TX', 'san antonio': 'TX', 'austin': 'TX', 'fort worth': 'TX',
    'atlanta': 'GA', 'miami': 'FL', 'orlando': 'FL', 'tampa': 'FL', 'jacksonville': 'FL',
    'phoenix': 'AZ', 'tucson': 'AZ',
    'seattle': 'WA', 'portland': 'OR',
    'minneapolis': 'MN', 'st. paul': 'MN',
    'st. louis': 'MO', 'kansas city': 'MO',
    'detroit': 'MI', 'grand rapids': 'MI',
    'cleveland': 'OH', 'columbus': 'OH', 'cincinnati': 'OH',
    'baltimore': 'MD', 'washington': 'DC',
    'omaha': 'NE', 'nashville': 'TN', 'memphis': 'TN',
    'richmond': 'VA', 'charlotte': 'NC', 'raleigh': 'NC',
    'indianapolis': 'IN', 'milwaukee': 'WI',
    'new orleans': 'LA', 'baton rouge': 'LA',
    'bridgeport': 'CT', 'hartford': 'CT', 'new haven': 'CT',
    'providence': 'RI', 'newark': 'NJ', 'jersey city': 'NJ', 'trenton': 'NJ', 'camden': 'NJ',
    'wilmington': 'DE',
    'norristown': 'PA', 'conshohocken': 'PA', 'ardmore': 'PA', 'bryn mawr': 'PA',
    'media': 'PA', 'wayne': 'PA', 'paoli': 'PA', 'exton': 'PA', 'west chester': 'PA',
    'doylestown': 'PA', 'lansdale': 'PA', 'ambler': 'PA', 'jenkintown': 'PA',
    'cheltenham': 'PA', 'abington': 'PA'
};

// Detect if query is location-based and extract city + expected state
function detectLocationQuery(q) {
    const locationPatterns = [
        /(?:near|in|around|close to|nearby)\s+([A-Za-z\s]+)/i,
        /([A-Za-z\s]+?)\s+(?:parishes|churches|schools|retreats|businesses|mass)/i,
        /parishes?\s+(?:near|in|around)\s+([A-Za-z\s]+)/i,
        /churches?\s+(?:near|in|around)\s+([A-Za-z\s]+)/i,
    ];

    let cityName = null;
    for (const pattern of locationPatterns) {
        const match = q.match(pattern);
        if (match) { cityName = match[1].trim().toLowerCase(); break; }
    }

    if (!cityName) {
        for (const city of Object.keys(CITY_STATE_MAP)) {
            if (q.includes(city)) { cityName = city; break; }
        }
    }

    if (!cityName) return null;

    // Check if user explicitly mentioned a state (e.g., "Philadelphia DE" or "Philadelphia, PA")
    const statePattern = new RegExp(cityName + '[,\\s]+([A-Z]{2})\\b', 'i');
    const stateMatch = q.match(statePattern);
    const expectedState = stateMatch ? stateMatch[1].toUpperCase() : (CITY_STATE_MAP[cityName] || null);

    return { city: cityName, expectedState };
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

            // City + state matching for location queries
            if (detectedCity) {
                const cityLower = city.toLowerCase();
                const stateLower = state.toLowerCase();
                const addressLower = address.toLowerCase();
                const cityMatches = cityLower === detectedCity ||
                                    cityLower.includes(detectedCity) ||
                                    detectedCity.includes(cityLower);
                const addressMatches = addressLower.includes(detectedCity);

                if (cityMatches || addressMatches) {
                    let baseScore = cityLower === detectedCity ? 100 : (cityMatches ? 80 : 70);

                    // State bonus/penalty: strongly prefer the expected state
                    if (expectedState) {
                        const stateUpper = state.toUpperCase();
                        if (stateUpper === expectedState) {
                            baseScore += 50; // Big boost for correct state
                        } else if (stateUpper && stateUpper !== expectedState) {
                            baseScore -= 60; // Penalize wrong state heavily
                        }
                    }

                    score += baseScore;
                } else if (diocese.toLowerCase().includes(detectedCity)) {
                    score += 20;
                }
            }

            // General keyword relevance
            if (isQueryRelevant(q, searchable)) score += 10;

            // Bonus for rich data
            if (isUnlocked) score += 5;
            if (hasEvents) score += 3;
            if (hasMass) score += 2;

            if (score > 0 || !isLocationBased) {
                scored.push({
                    score,
                    context: {
                        id: doc.id, name, type: EntityType.CHURCH,
                        subtitle: diocese || 'Parish', description,
                        location: displayCity ? `${displayCity}, ${state}` : state
                    }
                });
            }
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Return top results
        const maxResults = isLocationBased ? 15 : 10;
        const results = scored.slice(0, maxResults).map(s => s.context);

        console.log(`⛪ [Gabriel] Found ${results.length} churches${detectedCity ? ` (${scored.filter(s => s.score >= 70).length} in/near ${detectedCity})` : ''}`);
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
1. Read the user's question carefully
2. Pick 1-3 resources from the list above that BEST MATCH what they're asking for (prefer resources whose location matches the user's query)
3. For EACH resource you recommend, include [RECOMMEND: exact name] using the EXACT name from the list
4. Write a helpful response explaining why these resources are relevant
5. Tell them to tap the cards below to learn more

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
- Keep response under 100 words
- Be warm and conversational
- NEVER say you "don't have" resources if there ARE matching items in the list above
- If the user asked about a location and there are resources listed in that location, confidently recommend them

CRITICAL: Put a space after EVERY period, comma, and colon.
CRITICAL: ALWAYS include at least one [RECOMMEND: name] tag when there are relevant resources.

Example response:
[RECOMMEND: Franciscan Retreat Center]
The Franciscan Retreat Center offers peaceful spiritual retreats grounded in Franciscan spirituality. Tap the card below to learn more!`;
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
