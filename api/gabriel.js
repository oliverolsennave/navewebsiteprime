// Vercel Serverless Function — proxies OpenAI calls for Gabriel AI
// The API key is stored as a Vercel environment variable (OPENAI_API_KEY)
// so it never appears in client-side code or the git repo.

// ── In-memory rate limiter (per serverless instance) ──────────────
// Tracks requests per IP: max 10 requests per 60-second window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX = 10;              // max requests per window
const ipRequests = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const record = ipRequests.get(ip);

    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        // New window
        ipRequests.set(ip, { windowStart: now, count: 1 });
        return false;
    }

    record.count++;
    if (record.count > RATE_LIMIT_MAX) {
        return true;
    }

    return false;
}

// Clean up stale entries every 5 minutes to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of ipRequests) {
        if (now - record.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            ipRequests.delete(ip);
        }
    }
}, 5 * 60 * 1000);

export default async function handler(req, res) {
    // CORS headers — restrict to our domain only
    const allowedOrigins = ['https://www.catholicnave.com', 'https://catholicnave.com'];
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Rate limiting ─────────────────────────────────────────────
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';

    if (isRateLimited(clientIP)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'OpenAI API key not configured on server' });
    }

    try {
        const { messages } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Missing messages array' });
        }

        // Limit message array size to prevent prompt injection / cost abuse
        if (messages.length > 20) {
            return res.status(400).json({ error: 'Too many messages in conversation' });
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages,
                temperature: 0.7,
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('OpenAI error:', errBody);
            return res.status(response.status).json({ error: `OpenAI API error: ${response.status}` });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            return res.status(500).json({ error: 'No response from AI' });
        }

        return res.status(200).json({ content });
    } catch (err) {
        console.error('Gabriel proxy error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
