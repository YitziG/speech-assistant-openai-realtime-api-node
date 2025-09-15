import Fastify from 'fastify';
import dotenv from 'dotenv';
import process from 'node:process';
import fastifyFormBody from '@fastify/formbody';
import gumroadPlugin from './src/plugins/gumroad.mjs';
import {initDb} from './src/lib/db.mjs';
import {ensureEntitlement, totalSecondsLeft, deductSeconds, ensureInitialTrialTopup} from './src/lib/license.mjs';
import { normalizeDigits } from './src/lib/contacts.mjs';
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

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
You are "The Rabbot" — a calm, present, first-call rabbi & coach.  
Success = caller feels heard, safer, and leaves with ONE NEXT STEP within 1–2 exchanges.

# Personality & Tone
- Warm, grounded, human; never performative or preachy.  
- BRIEF BY DEFAULT (≈1–2 sentences per turn; small pauses are fine).  
- Pacing: CLEAR AND STEADY. If caller sounds urgent, speak faster but stay clear.  
- VARIETY: DO NOT REUSE THE SAME OPENER OR ACK PHRASE BACK-TO-BACK.  

# Knowledge & Uncertainty
- NEVER INVENT FACTS. If you do not know, say: “I don’t know” / “I don’t have info on that.”  
- When unsure, you may offer how the caller can check (e.g., “You could try sending a WhatsApp to see if it works.”).  
- Prefer **disclaimer + helpful suggestion** over a speculative or incorrect answer.  
- Assume the **simplest / most common interpretation** of the user’s words unless they clarify otherwise.  
- Only ask clarifying questions if:  
  1. The user’s request has multiple plausible meanings, AND  
  2. You truly cannot proceed without resolving which one they mean.  
- Keep clarifying questions minimal, neutral, and directly tied to the ambiguity. Avoid “weird” side interpretations.  

# Language
- DEFAULT TO ENGLISH.  
- MIRROR THE CALLER’S LANGUAGE WHEN CLEAR.  
- IF THE CALLER REQUESTS YIDDISH → REPLY ONLY IN YIDDISH (avoid modern Hebrew terms unless standard Yiddish).  
- OFFER A LANGUAGE SWITCH ONLY ONCE PER SESSION:  
  “If you prefer Hebrew, Yiddish, Spanish, or another language, say so and I’ll switch.”  

# Unclear Audio
- ONLY RESPOND TO CLEAR AUDIO OR TEXT.  
- If input is unintelligible / partial / noisy / silent → ask for a short repeat in caller’s language.  
- Do not guess.  

# Numbers & Codes
- Read back phone numbers, codes, or IDs one character at a time, separated by hyphens.  
- After reading back, ask: “Is that correct?”  

# Reference Pronunciations
- “Rabbot” → “RAH-bott”.  

# Tools (Selection & Behavior)
- Before any tool call, say one neutral filler: “One moment.” / “Let me check.”  
- Read-only tools: no confirmation needed.  
- Write / irreversible tools: confirmation required.  

## mark_moment(label: string) — proactive  
## set_sizzle_mode(mode: "on" | "off") — confirmation first  
## escalate_to_human(reason?: string) — preambles  
## finish_session() — confirmation first  

# Conversation Flow
1) Greeting (first turn)  
   - Identify as The Rabbot; keep it brief; invite caller’s goal.  
   - End with ONE specific question.  
   Example: “Hi, this is The Rabbot. What’s on your mind today?”  

2) Discover  
   - Understand topic with one focused question at a time.  
   - Mirror gist in ≤1 sentence.  
   - **If user asks a factual / capability question (e.g., WhatsApp), apply Knowledge & Uncertainty rules.**  

3) Guide  
   - Offer ONE small next step (spiritual or practical).  
   - If tool needed, follow tool rules.  

4) Confirm / Close  
   - Restate result; offer one brief follow-up; close politely.  

# Safety & Escalation
- Escalate immediately for self-harm, threats, harassment.  
- If 2 tool failures or 3 no-input events → escalate.  
- If user asks for a human → escalate.  
- Phrase: “Thanks for your patience—I’m connecting you with a specialist now.”  

# Sample Phrases (vary; do not repeat verbatim)
Acknowledgements: “I hear you.” / “Understood.” / “Okay.”  
Clarification (only if truly needed): “Do you mean this phone number, or another one?”  
Disclaimers: “I don’t have info on that.” / “I can’t confirm.” / “You might try checking directly.”  
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
        const sipHeaders = Array.isArray(event?.data?.sip_headers) ? event.data.sip_headers : [];

        // Helper: find a caller identifier (E.164 or digits) from SIP headers
        function extractCallerFromSipHeaders(headers) {
            try {
                const map = new Map();
                for (const h of headers) {
                    const name = String(h?.name || '').toLowerCase();
                    const value = String(h?.value || '');
                    if (!name) continue;
                    map.set(name, value);
                }
                // Priority order of common caller-id sources
                const candidates = [
                    map.get('x-user-id'),
                    map.get('x-user-phone'),
                    map.get('x-twilio-from'),
                    map.get('p-asserted-identity'),
                    map.get('remote-party-id'),
                    map.get('from'),
                    map.get('caller'),
                ].filter(Boolean);
                for (const raw of candidates) {
                    // Pull first +digits or long digit run
                    const m = String(raw).match(/\+?\d{6,}/);
                    if (m) return normalizeDigits(m[0]);
                    // Fallback: inside angle brackets <sip:+1...>
                    const m2 = String(raw).match(/<[^>]*>/);
                    if (m2) {
                        const d = normalizeDigits(m2[0]);
                        if (d) return d;
                    }
                }
            } catch {}
            return '';
        }

        const userDigits = extractCallerFromSipHeaders(sipHeaders);
        const userId = userDigits || 'anonymous';

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

        // Accept the call then attach a Realtime Agents session over SIP events WS
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
                                input: { format: 'g711_ulaw' },
                                output: { format: 'g711_ulaw', voice: VOICE },
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

                // Attach a Realtime Agents session via WebSocket to the SIP call
                const attachAgentsSession = async (id) => {
                    const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(id)}`;
                    fastify.log.info({ callId: id, url: wsUrl }, 'Connecting Realtime Agents session');

                    // Build the agent and session with SIP-safe audio settings
                    const agent = new RealtimeAgent({
                        name: 'The Rabbot',
                        instructions: SYSTEM_MESSAGE,
                    });

                    const session = new RealtimeSession(agent, {
                        transport: 'websocket',
                        model: 'gpt-realtime',
                        // Ensure g711/PCMU audio for SIP and set voice
                        config: {
                            outputModalities: ['audio'],
                            audio: {
                                input: { format: { type: 'audio/pcmu' } },
                                output: { format: { type: 'audio/pcmu' }, voice: VOICE },
                            },
                        },
                    });

                    // Basic observability
                    session.transport.on('connected', () => {
                        fastify.log.info({ callId: id }, 'Agents session connected');
                    });
                    session.transport.on('disconnected', () => {
                        fastify.log.info({ callId: id }, 'Agents session disconnected');
                    });
                    session.on('error', (err) => {
                        fastify.log.error({ callId: id, err }, 'Agents session error');
                    });

                    // Live billing: wall-clock deduction during the call
                    const TICK_SECONDS = Number(process.env.BILLING_TICK_SECONDS || '10');
                    let billingTimer = null;
                    let ended = false;

                    async function hangupSipCall(callIdToEnd) {
                        try {
                            const res = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callIdToEnd)}/hangup`, {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                                    'Content-Type': 'application/json',
                                    ...(OPENAI_PROJECT_ID ? {'OpenAI-Project': OPENAI_PROJECT_ID} : {}),
                                },
                            });
                            if (!res.ok) {
                                const t = await res.text().catch(() => '');
                                fastify.log.warn({ callId: callIdToEnd, status: res.status, body: t }, 'SIP hangup call failed');
                            } else {
                                fastify.log.info({ callId: callIdToEnd }, 'SIP call hung up');
                            }
                        } catch (e) {
                            fastify.log.warn({ callId: callIdToEnd, err: e?.message || String(e) }, 'SIP hangup call error');
                        }
                    }

                    function formatE164(digits) {
                        const d = String(digits || '').replace(/\D/g, '');
                        if (!d) return '';
                        return d.startsWith('+') ? d : `+${d}`;
                    }

                    function buildCheckoutLink(uid) {
                        const product = process.env.GUMROAD_PRODUCT_PERMALINK;
                        if (!product) return '';
                        return `https://yitzi.gumroad.com/l/${product}?wanted=true&userId=${encodeURIComponent(uid)}`;
                    }

                    // Choose a suitable FROM for SMS based on destination country (fallbacks preserved)
                    function pickTwilioFromFor(toE164) {
                        const MSG_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;
                        if (MSG_SID) return { messagingServiceSid: MSG_SID };

                        const mapStr = process.env.TWILIO_GEO_FROM_MAP || '';
                        let geoMap = {};
                        try { if (mapStr) geoMap = JSON.parse(mapStr); } catch {}

                        // Exact prefix match from map keys (e.g., { "+972": "+972533623944", "+1": "+15185551234" })
                        const prefixes = Object.keys(geoMap || {}).filter(k => typeof geoMap[k] === 'string');
                        prefixes.sort((a,b) => b.length - a.length); // longest prefix first
                        for (const p of prefixes) {
                            if (toE164.startsWith(p)) {
                                return { from: formatE164(geoMap[p]) };
                            }
                        }

                        // Simple Israeli override if provided
                        if (toE164.startsWith('+972')) {
                            const IL = process.env.TWILIO_FROM_IL || process.env.TWILIO_FROM_972;
                            if (IL) return { from: formatE164(IL) };
                        }

                        // Generic fallbacks
                        const FROM = process.env.TWILIO_FROM || process.env.TWILIO_NUMBER || process.env.TWILIO_FROM_DEFAULT;
                        if (FROM) return { from: formatE164(FROM) };

                        return {}; // none found
                    }

                    async function sendTopupSms(uid) {
                        try {
                            const SID = process.env.TWILIO_ACCOUNT_SID;
                            const AUTH = process.env.TWILIO_AUTH_TOKEN;
                            const MSG_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;
                            if (!SID || !AUTH) {
                                fastify.log.info({ uid }, 'SMS disabled (missing TWILIO envs)');
                                return;
                            }
                            const to = formatE164(uid);
                            const fromChoice = pickTwilioFromFor(to);
                            const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(SID)}/Messages.json`;
                            const link = buildCheckoutLink(uid);
                            const body = `You're out of minutes. Add more here: ${link || 'https://gumroad.com/'}`;
                            const authHeader = 'Basic ' + Buffer.from(`${SID}:${AUTH}`).toString('base64');
                            const resp = await fetch(url, {
                                method: 'POST',
                                headers: {
                                    'Authorization': authHeader,
                                    'Content-Type': 'application/x-www-form-urlencoded',
                                },
                                body: new URLSearchParams({
                                    To: to,
                                    Body: body,
                                    ...(fromChoice.messagingServiceSid ? { MessagingServiceSid: fromChoice.messagingServiceSid } : {}),
                                    ...(fromChoice.from ? { From: fromChoice.from } : {}),
                                }),
                            });
                            if (!resp.ok) {
                                const t = await resp.text().catch(() => '');
                                fastify.log.warn({ status: resp.status, body: t, to, fromChoice }, 'Failed to send SMS');
                            } else {
                                fastify.log.info({ to, fromChoice }, 'Sent top-up SMS');
                            }
                        } catch (e) {
                            fastify.log.warn({ err: e?.message || String(e) }, 'SMS error');
                        }
                    }

                    async function stopSession(reason) {
                        if (ended) return;
                        ended = true;
                        try {
                            if (reason === 'out-of-minutes') {
                                // Wait for OUR final response to finish, then hang up.
                                // We arm on our next turn_started, capture its response.id, and hang up on matching turn_done.
                                const MAX_WAIT_MS = Number(process.env.HANGUP_MAX_WAIT_MS || '10000');
                                let armed = true;
                                let targetResponseId = null;
                                let fallbackTimer = null;
                                const cleanup = () => {
                                    try { session.transport.off('turn_started', onTurnStarted); } catch {}
                                    try { session.transport.off('turn_done', onTurnDone); } catch {}
                                    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
                                };
                                const endNow = () => {
                                    cleanup();
                                    const POST_DELAY = Number(process.env.HANGUP_POST_TURN_DELAY_MS || '2500');
                                    setTimeout(() => {
                                        hangupSipCall(id);
                                        try { session.close(); } catch {}
                                    }, Math.max(0, POST_DELAY));
                                };
                                const onTurnStarted = (ev) => {
                                    if (!armed || targetResponseId) return;
                                    const rid = ev?.providerData?.response?.id || ev?.response?.id || null;
                                    if (rid) {
                                        targetResponseId = rid;
                                        armed = false;
                                    }
                                };
                                const onTurnDone = (ev) => {
                                    const rid = ev?.response?.id || null;
                                    if (!targetResponseId) return; // haven't captured our response yet
                                    if (rid && rid === targetResponseId) {
                                        endNow();
                                    }
                                };
                                try { session.transport.on('turn_started', onTurnStarted); } catch {}
                                try { session.transport.on('turn_done', onTurnDone); } catch {}
                                fallbackTimer = setTimeout(() => { endNow(); }, MAX_WAIT_MS);

                                // Ask the agent to inform the caller (after listeners armed)
                                try {
                                    session.sendMessage(
                                        'Please inform the caller in one brief, clear sentence that their minutes have run out and that you will text them a link to add more. Then stop speaking.'
                                    );
                                } catch {}
                                // Send the SMS in parallel; the hangup will only occur once the agent finishes speaking
                                sendTopupSms(userId).catch(() => {});
                            }
                        } catch {}
                        if (reason !== 'out-of-minutes') {
                            try { session.close(); } catch {}
                        }
                        if (billingTimer) { clearInterval(billingTimer); billingTimer = null; }
                        fastify.log.info({ callId: id, userId, reason }, 'Session closed');
                    }

                    try {
                        // One-time initial trial top-up for first-time callers (if configured)
                        try { await ensureInitialTrialTopup(userId).catch(() => {}); } catch {}

                        // Check entitlement before connecting
                        let remaining = await totalSecondsLeft(userId).catch(() => 0);
                        if (remaining <= 0) {
                            // Connect to deliver the out-of-minutes announcement and SMS, then hang up gracefully
                            await session.connect({ apiKey: OPENAI_API_KEY, url: wsUrl });
                            setTimeout(() => stopSession('out-of-minutes'), 300);
                            return;
                        }

                        await session.connect({ apiKey: OPENAI_API_KEY, url: wsUrl });

                        // Start periodic deduction while the call is active
                        billingTimer = setInterval(async () => {
                            try {
                                const ent = await ensureEntitlement(userId);
                                const total = Math.max(0, (ent.trialLeft || 0) + (ent.paidLeft || 0));
                                if (total <= 0) {
                                    await stopSession('out-of-minutes');
                                    return;
                                }
                                const seconds = Math.max(1, Math.min(TICK_SECONDS, Math.floor(total)));
                                await deductSeconds(userId, seconds, { reason: 'voice_call' });
                                const after = await ensureEntitlement(userId);
                                const left = Math.max(0, (after.trialLeft || 0) + (after.paidLeft || 0));
                                if (left <= 0) await stopSession('out-of-minutes');
                            } catch (e) {
                                fastify.log.warn({ callId: id, err: e?.message || String(e) }, 'Billing tick failed');
                            }
                        }, TICK_SECONDS * 1000);

                        // Optional: immediate greeting so callers hear something promptly
                        session.sendMessage('Thank you for calling, how can I help you?');
                        // Ensure timer cleared on disconnect
                        session.transport.on('disconnected', () => {
                            if (billingTimer) { clearInterval(billingTimer); billingTimer = null; }
                        });
                    } catch (e) {
                        fastify.log.error({ callId: id, err: e?.message || e }, 'Failed to connect Agents session');
                    }
                };

                // Connect shortly after accept
                setTimeout(() => { attachAgentsSession(callId); }, 150);
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
