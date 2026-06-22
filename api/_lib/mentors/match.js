// Vercel Serverless Function — Mentor Matching Algorithm
// Ports iOS MentorMatchService.calculateScore() to JS + optional OpenAI re-ranking

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

// ── Firebase Admin init ──────────────────────────────────────────
if (!getApps().length) {
    initializeApp({
        credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}
const db = getFirestore();
const adminAuth = getAuth();

// ── Rate limiter ─────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const ipRequests = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const record = ipRequests.get(ip);
    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        ipRequests.set(ip, { windowStart: now, count: 1 });
        return false;
    }
    record.count++;
    return record.count > RATE_LIMIT_MAX;
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of ipRequests) {
        if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            ipRequests.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// ── Matching Algorithm (ported from iOS MentorMatchService.swift) ──

const DEFAULT_WEIGHTS = { skills: 35, stage: 25, industry: 15, geography: 15, experience: 10 };

const STAGE_ORDER = {
    'Side Project': 0, 'Pre-Seed': 1, 'Seed': 2, 'Series A': 3, 'Series B': 4,
    // Fallback ordering
    'student': 0, 'recent grad': 1, 'early career': 2, 'mid career': 3, 'senior leader': 4
};

function stageOrder(stage) {
    if (!stage) return 2;
    return STAGE_ORDER[stage] ?? STAGE_ORDER[stage.toLowerCase()] ?? 2;
}

const EXP_MIDPOINTS = { '0-2': 1, '3-5': 4, '6-10': 8, '10+': 12 };

function expMidpoint(level) {
    return EXP_MIDPOINTS[level] ?? 4;
}

function calculateScore(current, candidate, weights) {
    let totalScore = 0;
    const reasons = [];

    // Determine mentor/mentee roles
    const isMentor = current.mentorshipRole === 'Mentor' ||
        (current.mentorshipRole === 'Both' && candidate.mentorshipRole !== 'Mentor');
    const mentorProfile = isMentor ? current : candidate;
    const menteeProfile = isMentor ? candidate : current;

    // 1. Skills Overlap (max: weights.skills + 5)
    const menteeNeeds = new Set(menteeProfile.skillsNeeded || []);
    const mentorOffers = new Set(mentorProfile.skillsOffered || []);
    if (menteeNeeds.size > 0) {
        const overlap = [...menteeNeeds].filter(s => mentorOffers.has(s));
        const pct = overlap.length / menteeNeeds.size;
        let skillScore = pct * weights.skills;

        // Bonus for reverse overlap
        const reverseOverlap = (mentorProfile.skillsNeeded || []).filter(s =>
            (menteeProfile.skillsOffered || []).includes(s)
        );
        if (reverseOverlap.length > 0) skillScore += 5.0;
        skillScore = Math.min(skillScore, weights.skills + 5.0);
        totalScore += skillScore;

        if (overlap.length > 0) {
            if (isMentor) {
                reasons.push(`You mentor in ${overlap[0]} — their top need`);
            } else {
                reasons.push(`Mentors in ${overlap[0]} — your top need`);
            }
        }
    }

    // 2. Stage Proximity (max: weights.stage)
    const mentorOrder = stageOrder(mentorProfile.businessStage);
    const menteeOrder = stageOrder(menteeProfile.businessStage);
    const stageDiff = mentorOrder - menteeOrder;
    let stageScore = 0;
    if (stageDiff === 1) stageScore = weights.stage;
    else if (stageDiff === 2) stageScore = weights.stage * 0.8;
    else if (stageDiff === 0) stageScore = weights.stage * 0.4;
    else if (stageDiff >= 3) stageScore = weights.stage * 0.48;
    // Negative diff (mentee ahead) = 0
    totalScore += stageScore;

    if (stageDiff === 1) {
        reasons.push('1 stage ahead — ideal mentorship gap');
    } else if (stageDiff >= 2) {
        reasons.push(`${stageDiff} stages ahead in their journey`);
    }

    // 3. Industry Alignment (max: weights.industry)
    const currentIndustries = new Set(current.industries || []);
    const candidateIndustries = new Set(candidate.industries || []);
    const sharedIndustries = [...currentIndustries].filter(i => candidateIndustries.has(i));
    let industryScore;
    if (sharedIndustries.length >= 2) industryScore = weights.industry;
    else if (sharedIndustries.length === 1) industryScore = weights.industry * 0.67;
    else industryScore = weights.industry * 0.2;
    totalScore += industryScore;

    if (sharedIndustries.length > 0) {
        reasons.push(`Shared industry: ${sharedIndustries[0]}`);
    }

    // 4. Geographic Proximity (max: weights.geography)
    const sameCity = current.chapterCity && candidate.chapterCity &&
        current.chapterCity === candidate.chapterCity;
    const geoScore = sameCity ? weights.geography : weights.geography * 0.33;
    totalScore += geoScore;
    if (sameCity) {
        reasons.push(`Same city: ${current.chapterCity}`);
    }

    // 5. Experience Gap (max: weights.experience)
    const currentMid = expMidpoint(current.yearsOfExperience);
    const candidateMid = expMidpoint(candidate.yearsOfExperience);
    const expGap = Math.abs(currentMid - candidateMid);
    let expScore;
    if (expGap >= 3 && expGap <= 8) expScore = weights.experience;
    else if (expGap >= 1 && expGap <= 2) expScore = weights.experience * 0.7;
    else if (expGap >= 9) expScore = weights.experience * 0.5;
    else expScore = weights.experience * 0.3; // same level

    totalScore += expScore;

    // Normalize to 0–1
    const maxPossible = weights.skills + 5.0 + weights.stage + weights.industry + weights.geography + weights.experience;
    const normalizedScore = Math.min(totalScore / maxPossible, 1.0);

    return { score: normalizedScore, reasons: reasons.slice(0, 3) };
}

function computeMatches(currentProfile, allProfiles, existingMatches, weights) {
    const existingPartnerIds = new Set();
    for (const match of existingMatches) {
        for (const pid of (match.participantIds || [])) {
            existingPartnerIds.add(pid);
        }
    }

    const candidates = allProfiles.filter(profile => {
        if (profile.userId === currentProfile.userId) return false;
        if (!profile.isActive) return false;
        if (existingPartnerIds.has(profile.userId)) return false;
        if (currentProfile.mentorshipRole === 'Mentee' && profile.mentorshipRole === 'Mentee') return false;
        if (currentProfile.mentorshipRole === 'Mentor' && profile.mentorshipRole === 'Mentor') return false;
        return true;
    });

    const results = candidates.map(candidate => {
        const { score, reasons } = calculateScore(currentProfile, candidate, weights);
        return { profile: candidate, score, reasons };
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 3);
}

// ── Handler ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
    // CORS
    const allowedOrigins = ['https://www.catholicnave.com', 'https://catholicnave.com'];
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Rate limiting
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';

    if (isRateLimited(clientIP)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }

    try {
        const { orgId, firebaseIdToken } = req.body;

        if (!firebaseIdToken) return res.status(401).json({ error: 'Missing auth token' });
        if (!orgId) return res.status(400).json({ error: 'Missing orgId' });

        // Verify Firebase token
        let decodedToken;
        try {
            decodedToken = await adminAuth.verifyIdToken(firebaseIdToken);
        } catch {
            return res.status(401).json({ error: 'Invalid auth token' });
        }
        const userId = decodedToken.uid;

        // Load mentorship config for weights
        let weights = DEFAULT_WEIGHTS;
        try {
            const configDoc = await db.doc(`organizations/${orgId}/config/mentorship`).get();
            if (configDoc.exists && configDoc.data().matchWeights) {
                weights = { ...DEFAULT_WEIGHTS, ...configDoc.data().matchWeights };
            }
        } catch {
            // Use defaults
        }

        // Load current user's profile
        const profileDoc = await db.doc(`organizations/${orgId}/mentorProfiles/${userId}`).get();
        if (!profileDoc.exists) {
            return res.status(404).json({ error: 'No mentor profile found. Create a profile first.' });
        }
        const currentProfile = { userId, ...profileDoc.data() };

        // Load all profiles
        const allSnap = await db.collection(`organizations/${orgId}/mentorProfiles`).get();
        const allProfiles = allSnap.docs.map(d => ({ userId: d.id, ...d.data() }));

        // Load existing matches for user
        const matchesSnap = await db.collection('mentor_matches')
            .where('participantIds', 'array-contains', userId)
            .get();
        const existingMatches = matchesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Compute matches
        const topMatches = computeMatches(currentProfile, allProfiles, existingMatches, weights);

        // Optional: OpenAI re-ranking for better reasons
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey && topMatches.length > 0) {
            try {
                const matchSummaries = topMatches.map((m, i) => {
                    const p = m.profile;
                    return `Match ${i + 1}: ${p.displayName || 'Unknown'}, ${p.companyName || 'N/A'}, Stage: ${p.businessStage}, Industries: ${(p.industries || []).join(', ')}, Skills offered: ${(p.skillsOffered || []).join(', ')}, Skills needed: ${(p.skillsNeeded || []).join(', ')}, City: ${p.chapterCity || 'N/A'}, Experience: ${p.yearsOfExperience || 'N/A'}`;
                }).join('\n');

                const userSummary = `User: ${currentProfile.displayName || 'Unknown'}, ${currentProfile.companyName || 'N/A'}, Stage: ${currentProfile.businessStage}, Industries: ${(currentProfile.industries || []).join(', ')}, Skills offered: ${(currentProfile.skillsOffered || []).join(', ')}, Skills needed: ${(currentProfile.skillsNeeded || []).join(', ')}, City: ${currentProfile.chapterCity || 'N/A'}, Experience: ${currentProfile.yearsOfExperience || 'N/A'}, Role: ${currentProfile.mentorshipRole}`;

                const reRankResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [
                            {
                                role: 'system',
                                content: 'You are a mentorship matching assistant. Given a user profile and their top matches, provide 2-3 short, specific reasons why each match is good. Return JSON: { "matches": [{ "index": 0, "reasons": ["reason1", "reason2"] }] }'
                            },
                            {
                                role: 'user',
                                content: `${userSummary}\n\nTop matches:\n${matchSummaries}`
                            }
                        ],
                        temperature: 0.3,
                        max_tokens: 400,
                        response_format: { type: 'json_object' }
                    })
                });

                if (reRankResponse.ok) {
                    const reRankData = await reRankResponse.json();
                    const content = reRankData.choices?.[0]?.message?.content;
                    if (content) {
                        const parsed = JSON.parse(content);
                        if (parsed.matches) {
                            for (const m of parsed.matches) {
                                if (m.index >= 0 && m.index < topMatches.length && m.reasons?.length) {
                                    topMatches[m.index].reasons = m.reasons.slice(0, 3);
                                }
                            }
                        }
                    }
                }
            } catch {
                // Re-ranking failed — keep algorithmic reasons
            }
        }

        // Format response — strip sensitive fields from profiles
        const matches = topMatches.map(m => ({
            profile: {
                userId: m.profile.userId,
                displayName: m.profile.displayName,
                photoURL: m.profile.photoURL || null,
                companyName: m.profile.companyName || '',
                tagline: m.profile.tagline || '',
                businessStage: m.profile.businessStage,
                industries: m.profile.industries || [],
                yearsOfExperience: m.profile.yearsOfExperience,
                chapterCity: m.profile.chapterCity || '',
                mentorshipRole: m.profile.mentorshipRole,
                skillsOffered: m.profile.skillsOffered || [],
                skillsNeeded: m.profile.skillsNeeded || [],
            },
            score: m.score,
            reasons: m.reasons
        }));

        return res.status(200).json({ matches });
    } catch (err) {
        console.error('Match mentors error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
