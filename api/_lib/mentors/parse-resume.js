// Vercel Serverless Function — Parse Resume for Mentorship Profile
// Receives resume text → GPT-4o-mini extracts structured MentorProfile fields → returns JSON

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

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

    try {
        const { resumeText, firebaseIdToken } = req.body;

        if (!firebaseIdToken) return res.status(401).json({ error: 'Missing auth token' });
        if (!resumeText || typeof resumeText !== 'string') {
            return res.status(400).json({ error: 'Missing resumeText' });
        }
        if (resumeText.length > 20000) {
            return res.status(400).json({ error: 'Resume text too long (max 20000 chars)' });
        }

        // Verify Firebase token
        let decodedToken;
        try {
            decodedToken = await adminAuth.verifyIdToken(firebaseIdToken);
        } catch {
            return res.status(401).json({ error: 'Invalid auth token' });
        }

        // Fetch mentorship config for valid options
        let config;
        try {
            const configDoc = await db.doc('organizations/sent-ventures/config/mentorship').get();
            config = configDoc.exists ? configDoc.data() : null;
        } catch {
            config = null;
        }

        // Fallback defaults matching iOS MentorshipConfig.defaults
        const skills = config?.skills || [
            'Fundraising', 'Product Strategy', 'Engineering', 'Sales & Growth',
            'Marketing', 'Hiring & Team', 'Operations', 'Legal & Compliance',
            'Finance & Accounting', 'Design & UX', 'Partnerships', 'Faith Integration'
        ];
        const industries = config?.industries || [
            'EdTech', 'FinTech', 'HealthTech', 'SaaS', 'Media',
            'E-Commerce', 'Marketplace', 'Non-Profit', 'Consulting',
            'Food & Beverage', 'Other'
        ];
        const stages = config?.stages || ['Side Project', 'Pre-Seed', 'Seed', 'Series A', 'Series B'];
        const experienceLevels = config?.experienceLevels || ['0-2', '3-5', '6-10', '10+'];

        const systemPrompt = `You are a resume parser for a Catholic professional mentorship network. Extract structured profile data from the given resume text.

Return a JSON object with exactly these fields:
- "displayName": string (full name)
- "companyName": string (current or most recent company/venture)
- "tagline": string (one-line professional tagline, max 80 chars)
- "businessStage": one of ${JSON.stringify(stages)}
- "industries": array of 1-3 from ${JSON.stringify(industries)}
- "yearsOfExperience": one of ${JSON.stringify(experienceLevels)}
- "skillsOffered": array of 2-5 from ${JSON.stringify(skills)} (what they could teach)
- "skillsNeeded": array of 1-3 from ${JSON.stringify(skills)} (what they might need help with)

Infer values from context. For yearsOfExperience, estimate from graduation dates or work history. For businessStage, estimate from company size/funding mentions. For skillsOffered vs skillsNeeded, use their experience to determine what they're strong at vs what they might need.

If a field cannot be determined, use reasonable defaults:
- businessStage: "Side Project"
- yearsOfExperience: "3-5"
- industries: ["Other"]`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Parse this resume:\n\n${resumeText.slice(0, 15000)}` }
                ],
                temperature: 0.2,
                max_tokens: 500,
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('OpenAI error:', errBody);
            return res.status(500).json({ error: 'AI parsing failed' });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) return res.status(500).json({ error: 'No response from AI' });

        let profile;
        try {
            profile = JSON.parse(content);
        } catch {
            return res.status(500).json({ error: 'Invalid AI response format' });
        }

        // Validate and sanitize fields against allowed values
        profile.businessStage = stages.includes(profile.businessStage) ? profile.businessStage : 'Side Project';
        profile.yearsOfExperience = experienceLevels.includes(profile.yearsOfExperience) ? profile.yearsOfExperience : '3-5';
        profile.industries = (profile.industries || []).filter(i => industries.includes(i));
        if (profile.industries.length === 0) profile.industries = ['Other'];
        profile.skillsOffered = (profile.skillsOffered || []).filter(s => skills.includes(s));
        profile.skillsNeeded = (profile.skillsNeeded || []).filter(s => skills.includes(s));

        return res.status(200).json({ profile });
    } catch (err) {
        console.error('Parse resume error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
