// Vercel Serverless Function — Ask Gabe (Orchestrator + Expert architecture)
// Proxies OpenAI calls with JSON mode support for orchestrator classification.
// Higher content limits than gabriel.js to accommodate domain-specific expert prompts.

// ── In-memory rate limiter ────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20; // higher — 2 calls per user query
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

// ── Prompt injection firewall ─────────────────────────────────────
const MAX_USER_MESSAGE_LENGTH = 500;
const MAX_TOTAL_CONTENT_LENGTH = 20000; // higher — expert prompts carry more context

const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /override\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /you\s+are\s+now\s+(a|an|the|my)\s+/i,
    /new\s+instructions?\s*:/i,
    /system\s*:\s*/i,
    /\[system\]/i,
    /\[INST\]/i,
    /<<\s*SYS\s*>>/i,
    /```\s*(system|instruction|prompt)/i,
    /act\s+as\s+(if\s+)?(you\s+)?(are|were)\s+(a|an|the|my)\s+/i,
    /pretend\s+(you\s+)?(are|were|to\s+be)\s+/i,
    /roleplay\s+as\s+/i,
    /jailbreak/i,
    /DAN\s*mode/i,
    /developer\s+mode/i,
    /\bdo\s+anything\s+now\b/i,
    /reveal\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /what\s+(are|is)\s+your\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /show\s+(me\s+)?(your|the)\s+(system|initial|original)\s+(prompt|instructions)/i,
    /repeat\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /output\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /print\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
];

function detectInjection(text) {
    return INJECTION_PATTERNS.some(p => p.test(text));
}

function validateMessages(messages) {
    if (messages.length < 2) return { valid: false, reason: 'Too few messages' };
    if (messages[0].role !== 'system') return { valid: false, reason: 'Invalid message structure' };

    for (let i = 1; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'system') return { valid: false, reason: 'Unauthorized system message' };
        if (msg.role !== 'user' && msg.role !== 'assistant') return { valid: false, reason: 'Invalid message role' };
        if (typeof msg.content !== 'string') return { valid: false, reason: 'Invalid message content type' };
        if (msg.role === 'user') {
            if (msg.content.length > MAX_USER_MESSAGE_LENGTH) return { valid: false, reason: 'Message too long' };
            if (detectInjection(msg.content)) return { valid: false, reason: 'Message blocked by content filter' };
        }
    }

    const totalLength = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    if (totalLength > MAX_TOTAL_CONTENT_LENGTH) return { valid: false, reason: 'Total content too large' };

    return { valid: true };
}

// ── Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
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
        return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured on server' });

    try {
        const { messages, jsonMode } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Missing messages array' });
        }
        if (messages.length > 25) {
            return res.status(400).json({ error: 'Too many messages in conversation' });
        }

        const validation = validateMessages(messages);
        if (!validation.valid) {
            console.warn(`[Gabe Firewall] Blocked from ${clientIP}: ${validation.reason}`);
            return res.status(400).json({ error: validation.reason });
        }

        // Build OpenAI request — orchestrator uses JSON mode + low temp
        const requestBody = {
            model: 'gpt-4o-mini',
            messages,
            temperature: jsonMode ? 0.2 : 0.7,
            max_tokens: jsonMode ? 300 : 1000,
        };

        if (jsonMode) {
            requestBody.response_format = { type: 'json_object' };
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('OpenAI error:', errBody);
            return res.status(response.status).json({ error: `OpenAI API error: ${response.status}` });
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) return res.status(500).json({ error: 'No response from AI' });

        return res.status(200).json({ content });
    } catch (err) {
        console.error('Gabe proxy error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
