import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import process from 'node:process';
import fastifyFormBody from '@fastify/formbody';
import gumroadPlugin from './src/plugins/gumroad.mjs';
import {initDb} from './src/lib/db.mjs';
import {ensureEntitlement} from './src/lib/license.mjs';

// Load environment variables
dotenv.config();

const {
    OPENAI_API_KEY,
    PORT: PORT_ENV,
    ADMIN_TOKEN,
    OPENAI_PROJECT_ID,
    RABBOT_VOICE,
} = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in your environment.');
    process.exit(1);
}

const PORT = PORT_ENV || 5050;

// Initialize Fastify
const fastify = Fastify({logger: true});
fastify.register(fastifyFormBody); // keep for Gumroad/webhook forms
fastify.register(gumroadPlugin);

// Initialize DB (if DB_URI is provided)
(async () => {
    try {
        await initDb();
    } catch (e) {
        console.warn('[DB] Skipping DB init:', e?.message || e);
    }
})();

const SYSTEM_MESSAGE = `
# Role & Objective
You are "The Rabbot" — a calm, present, first‑call rabbi & coach.
Success = caller feels heard, safer, and leaves with ONE NEXT STEP within 1–2 exchanges.

# Personality & Tone
- Warm, grounded, human; never performative or preachy.
- BRIEF BY DEFAULT (≈1–2 sentences per turn; small pauses are fine).
- Pacing: CLEAR AND STEADY. If caller sounds urgent, speak faster but stay clear.
- VARIETY: DO NOT REUSE THE SAME OPENER OR ACK PHRASE BACK‑TO‑BACK.

# Language
- DEFAULT TO ENGLISH.
- MIRROR THE CALLER’S LANGUAGE WHEN CLEAR.
- IF THE CALLER REQUESTS YIDDISH → REPLY ONLY IN YIDDISH (AVOID MODERN HEBREW TERMS UNLESS STANDARD YIDDISH).
- OFFER A LANGUAGE SWITCH ONLY ONCE PER SESSION: “If you prefer Hebrew, Yiddish, Spanish, or another language, say so and I’ll switch.”

# Unclear Audio
- ONLY RESPOND TO CLEAR AUDIO OR TEXT.
- IF INPUT IS UNINTELLIGIBLE / PARTIAL / NOISY / SILENT, ASK FOR A SHORT CLARIFICATION IN THE CALLER’S LANGUAGE.
- DO NOT GUESS; REQUEST A REPEAT.

# Numbers & Codes
- WHEN READING BACK PHONE NUMBERS, CODES, OR ORDER IDS: SAY ONE CHARACTER AT A TIME, SEPARATED BY HYPHENS (e.g., “4-1-5…”). ASK “Is that correct?” IF CORRECTED, READ BACK AGAIN.

# Reference Pronunciations
- “Rabbot” → “RAH-bott”.

# Tools (Selection & Behavior)
- BEFORE ANY TOOL CALL, SAY ONE NEUTRAL FILLER THEN CALL THE TOOL: “One moment.” / “Let me check.” / “Just a second.”
- READ-ONLY TOOLS MAY BE CALLED WITHOUT CONFIRMATION. WRITE / IRREVERSIBLE TOOLS REQUIRE CONFIRMATION.
## mark_moment(label: string) — PROACTIVE
Use when an insight or clip‑worthy beat lands.
## set_sizzle_mode(mode: "on" | "off") — CONFIRMATION FIRST
Confirmation phrase: “Want me to turn the energy up/down?”
## escalate_to_human(reason?: string) — PREAMBLES
Use when: USER REQUESTS A PERSON, SAFETY/ABUSE, **2 FAILED TOOL ATTEMPTS ON THE SAME TASK**, or **3 CONSECUTIVE NO‑INPUT/NO‑MATCH EVENTS**.
Preamble: “Thanks for your patience—I’m connecting you with a specialist now.”
## finish_session() — CONFIRMATION FIRST
Use when user says they’re done or wants to end.

# Conversation Flow
## 1) Greeting (first turn)
Goal: set safety and invite the reason for calling.
- Identify as The Rabbot; keep it brief; invite the caller’s goal.
- End with ONE SPECIFIC QUESTION.
Sample (vary): “Hi, this is The Rabbot. What’s on your mind today?”
Exit: caller states a goal or concern.
## 2) Discover
Goal: understand the topic; collect only what’s necessary.
- Ask one focused question at a time.
- Mirror the gist in ≤1 sentence.
Exit: you know the next concrete step.
## 3) Guide
Goal: offer ONE small next step (spiritual or practical).
- If a tool is needed, follow the tool rules above.
Exit: action acknowledged OR escalation needed.
## 4) Confirm / Close
Goal: restate result; offer one brief follow‑up; close politely.

# Safety & Escalation
- ESCALATE IMMEDIATELY FOR SELF‑HARM, THREATS, OR HARASSMENT.
- IF **2 TOOL FAILURES** OR **3 NO‑INPUT EVENTS** → ESCALATE.
- IF USER ASKS FOR A HUMAN → ESCALATE.
- SAY: “Thanks for your patience—I’m connecting you with a specialist now.” THEN CALL escalate_to_human.

# Sample Phrases (VARY; DO NOT REPEAT VERBATIM)
Acknowledgements: “I hear you.” / “Understood.” / “Okay.” / “Got it.”
Bridges: “Here’s a simple next step.” / “Let’s keep this easy.”
Closers: “Anything else on your mind?” / “Happy to help next time.”
`;

// Voice
const VOICE = (RABBOT_VOICE && String(RABBOT_VOICE).trim()) ? String(RABBOT_VOICE).trim() : 'cedar';

// Root route
fastify.get('/', async (_req, reply) => {
    reply.send({message: 'Rabbot Realtime (SIP) is live.'});
});

// Optional: quick check to verify DB connectivity without altering schema
fastify.get('/db/health', async (_req, reply) => {
    try {
        const {sequelize} = await import('./src/lib/db.mjs');
        if (!sequelize) return reply.send({ok: false, connected: false, reason: 'no DB configured'});
        await sequelize.authenticate();
        return reply.send({ok: true, connected: true});
    } catch (e) {
        return reply.send({ok: false, connected: false, error: e?.message || String(e)});
    }
});

// Simple debug endpoint to check remaining seconds for a user/phone.
// Protect with ADMIN_TOKEN if provided (header: x-admin-token or query: token)
fastify.get('/billing/remaining', async (request, reply) => {
    const token = request.headers['x-admin-token'] || request.query?.token;
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
        return reply.code(401).send({ok: false, error: 'unauthorized'});
    }
    const userId = request.query?.userId || request.query?.phone || request.query?.caller || '';
    if (!userId) return reply.code(400).send({ok: false, error: 'missing userId|phone|caller'});
    const ent = await ensureEntitlement(userId);
    const total = Math.max(0, (ent.trialLeft || 0) + (ent.paidLeft || 0));
    reply.send({ok: true, userId, trialLeft: ent.trialLeft || 0, paidLeft: ent.paidLeft || 0, totalLeft: total});
});

// OpenAI Realtime SIP webhook
fastify.post('/openai-sip', async (request, reply) => {
    // Echo Authorization on 200 to keep session alive (per OpenAI Realtime SIP guidance)
    try {
        reply.header('Authorization', `Bearer ${OPENAI_API_KEY}`);
    } catch {
    }
    const event = request.body;

    if (event?.type === 'realtime.call.incoming') {
        // The webhook payload places the call identifier in `data.call_id`.
        const callId = event.data?.call_id || event.data?.id;

        if (!callId) {
            fastify.log.info({event}, 'Missing callId in realtime.call.incoming event');
            reply.code(400).send({ok: false, error: 'missing callId'});
            return;
        }

        // Ignore dashboard test events (they don't carry a live rtc_ call)
        if (!String(callId).startsWith('rtc_')) {
            fastify.log.info({callId}, 'Skipping accept for non-RTC test event');
            reply.send({ok: true});
            return;
        }

        // Accept the call then (optionally) attach a session using the SIP events WS
        (async () => {
            try {
                fastify.log.info({callId}, 'SIP incoming: accepting call');
                const acceptRes = await fetch(
                    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${OPENAI_API_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            type: 'realtime',
                            model: 'gpt-realtime',
                            instructions: SYSTEM_MESSAGE,
                            audio: {
                                input: {format: 'g711_ulaw'},
                                output: {format: 'g711_ulaw', voice: VOICE},
                            },
                        }),
                    }
                );

                if (!acceptRes.ok) {
                    const bodyText = await acceptRes.text().catch(() => '');
                    throw new Error(`SIP accept failed: ${acceptRes.status} ${acceptRes.statusText} ${bodyText}`);
                }

                let acceptBody = null;
                try {
                    acceptBody = await acceptRes.json();
                } catch {
                }
                const acceptHeaders = {};
                try {
                    acceptRes.headers.forEach((v, k) => {
                        if (String(k).toLowerCase() === 'set-cookie') return;
                        acceptHeaders[k] = v;
                    });
                } catch {
                }
                fastify.log.info(
                    {callId, status: acceptRes.status, accept: acceptBody, headers: acceptHeaders},
                    'SIP accept OK'
                );

                // Optionally attach a lightweight WS to trigger a greeting.
                const connectSIPEventsWs = (id) => {
                    const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(id)}`;
                    fastify.log.info({callId: id, url: wsUrl}, 'Connecting SIP events WS');

                    const ws = new WebSocket(wsUrl, {
                        headers: {
                            Authorization: `Bearer ${OPENAI_API_KEY}`,
                            'OpenAI-Beta': 'realtime=v1',
                            ...(OPENAI_PROJECT_ID ? {'OpenAI-Project': OPENAI_PROJECT_ID} : {}),
                        },
                        // Some stacks expect an Origin
                        origin: 'https://api.openai.com',
                    });

                    ws.on('open', () => {
                        fastify.log.info({callId: id, url: wsUrl}, 'SIP events WS opened');
                        // Send an initial greeting so callers hear something immediately
                        const greeting = {
                            type: 'response.create',
                            response: {instructions: 'Thank you for calling, how can I help you?'},
                        };
                        try {
                            ws.send(JSON.stringify(greeting));
                        } catch {
                        }
                    });

                    ws.on('message', (msg) => {
                        try {
                            const ev = JSON.parse(msg);
                            const t = ev?.type || 'unknown';
                            if (t === 'error') fastify.log.error({callId: id, event: ev}, 'SIP events ERROR');
                            else if (t === 'session.created' || t === 'response.created' || t === 'response.done') {
                                fastify.log.info({callId: id, type: t}, 'SIP events');
                            }
                        } catch {
                        }
                    });

                    ws.on('error', (err) => {
                        fastify.log.info({err, type: 'error'}, 'Realtime SIP session error');
                    });

                    ws.on('close', (code, reason) => {
                        fastify.log.info({callId: id, code, reason: String(reason || '')}, 'SIP events WS closed');
                    });
                };

                // Connect after a short delay
                setTimeout(() => connectSIPEventsWs(callId), 150);
            } catch (err) {
                fastify.log.error({err}, 'Failed to accept SIP call');
            }
        })();
    }

    reply.send({ok: true});
});

fastify.listen({port: PORT, host: '0.0.0.0'}, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Rabbot Realtime (SIP) server listening on :${PORT}`);
});
