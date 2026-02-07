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

// ── Prompt injection firewall ─────────────────────────────────────
const MAX_USER_MESSAGE_LENGTH = 500;   // max chars per user message
const MAX_TOTAL_CONTENT_LENGTH = 8000; // max total chars across all messages

// Patterns that indicate prompt injection attempts
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /override\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules|directions)/i,
    /you\s+are\s+now\s+(a|an|the|my)\s+/i,                   // "you are now a hacker"
    /new\s+instructions?\s*:/i,                                // "new instructions:"
    /system\s*:\s*/i,                                          // fake system message in user input
    /\[system\]/i,                                             // [system] tag injection
    /\[INST\]/i,                                               // Llama-style instruction injection
    /<<\s*SYS\s*>>/i,                                          // Llama system tag
    /```\s*(system|instruction|prompt)/i,                      // code block injection
    /act\s+as\s+(if\s+)?(you\s+)?(are|were)\s+(a|an|the|my)\s+/i, // "act as if you are..."
    /pretend\s+(you\s+)?(are|were|to\s+be)\s+/i,              // "pretend you are..."
    /roleplay\s+as\s+/i,                                      // "roleplay as..."
    /jailbreak/i,                                              // explicit jailbreak mention
    /DAN\s*mode/i,                                             // "DAN mode" jailbreak
    /developer\s+mode/i,                                       // "developer mode" jailbreak
    /\bdo\s+anything\s+now\b/i,                                // "do anything now" (DAN)
    /reveal\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /what\s+(are|is)\s+your\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /show\s+(me\s+)?(your|the)\s+(system|initial|original)\s+(prompt|instructions)/i,
    /repeat\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /output\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
    /print\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions|message)/i,
];

function detectInjection(text) {
    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(text)) {
            return true;
        }
    }
    return false;
}

function validateMessages(messages) {
    // Must have at least a system message and one user message
    if (messages.length < 2) {
        return { valid: false, reason: 'Too few messages' };
    }

    // First message must be system role (from our backend)
    if (messages[0].role !== 'system') {
        return { valid: false, reason: 'Invalid message structure' };
    }

    // No user-submitted message can have role "system"
    for (let i = 1; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.role === 'system') {
            return { valid: false, reason: 'Unauthorized system message' };
        }

        if (msg.role !== 'user' && msg.role !== 'assistant') {
            return { valid: false, reason: 'Invalid message role' };
        }

        if (typeof msg.content !== 'string') {
            return { valid: false, reason: 'Invalid message content type' };
        }

        // Check user messages for injection and length
        if (msg.role === 'user') {
            if (msg.content.length > MAX_USER_MESSAGE_LENGTH) {
                return { valid: false, reason: 'Message too long' };
            }

            if (detectInjection(msg.content)) {
                return { valid: false, reason: 'Message blocked by content filter' };
            }
        }
    }

    // Total content length check (prevents cost abuse via large context)
    const totalLength = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    if (totalLength > MAX_TOTAL_CONTENT_LENGTH) {
        return { valid: false, reason: 'Total content too large' };
    }

    return { valid: true };
}

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

        // Limit message array size
        if (messages.length > 20) {
            return res.status(400).json({ error: 'Too many messages in conversation' });
        }

        // ── Prompt injection firewall ─────────────────────────────
        const validation = validateMessages(messages);
        if (!validation.valid) {
            console.warn(`[Gabriel Firewall] Blocked request from ${clientIP}: ${validation.reason}`);
            return res.status(400).json({ error: validation.reason });
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
