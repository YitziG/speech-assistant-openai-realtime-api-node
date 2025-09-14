import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import process from 'node:process';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { RealtimeAgent, RealtimeSession, OpenAIRealtimeWebSocket } from '@openai/agents/realtime';
import gumroadPlugin from './src/plugins/gumroad.mjs';
import { initDb } from './src/lib/db.mjs';
import { findOrCreateByPhone } from './src/lib/contacts.mjs';
import { totalSecondsLeft, deductSeconds, ensureEntitlement, upgradeEntitlementFromContact, ensureInitialTrialTopup } from './src/lib/license.mjs';
import twilio from 'twilio';
// Stripe import intentionally omitted (optional later) to avoid runtime dep

// Load environment variables
dotenv.config();

const {
    OPENAI_API_KEY, PORT: PORT_ENV,       // 🔥 allow voice override
    RABBOT_TEMP = '0.8',          // 🔥 temperature override
    COLD_OPEN = 'true',    // 🔥 toggle the hook intro
    RABBOT_SIZZLE_DEFAULT = 'off', // 🔥 default "sizzle" mode (on|off)
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    GUMROAD_PRODUCT_PERMALINK,
    TWILIO_NUMBER,
    TRIAL_SECONDS = '300',
    PER_CALL_CAP_SECONDS = '600',
    ADMIN_TOKEN,
    // Optional VAD tuning
    VAD_THRESHOLD = '0.4',
    VAD_SILENCE_MS = '500',
    VAD_PREFIX_MS = '200',
    // Optional fast barge-in tuning (local heuristic)
    FAST_BARGE = 'on',
    FAST_BARGE_MIN_NON_SILENT = '44',
    FAST_BARGE_WINDOW_BYTES = '160',
    FAST_BARGE_COOLDOWN_MS = '250',
    FAST_BARGE_FRAMES = '2',
    FAST_BARGE_START_GUARD_MS = '200',
    // VAD mode: 'server' (default) or 'semantic'
    VAD_MODE = 'server',
    VAD_SEMANTIC_EAGERNESS = 'auto',
    // Local barge-in energy thresholds (μ-law decoded avg abs amplitude)
    FAST_BARGE_ABS_THRESH = '3500',
    FAST_BARGE_RATIO = '1.2',

} = process.env;

// Use env vars for Twilio (rotate any leaked creds in Console)
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TRIAL_S = Number(TRIAL_SECONDS) || 0;
const PER_CALL_CAP_S = Number(PER_CALL_CAP_SECONDS) || 0;
const checkoutUrlFor = (userId) =>
  GUMROAD_PRODUCT_PERMALINK
    ? `https://yitzi.gumroad.com/l/${GUMROAD_PRODUCT_PERMALINK}?wanted=true&userId=${encodeURIComponent(userId || 'anonymous')}`
    : null;


if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in your environment.');
    process.exit(1);
}

const PORT = PORT_ENV || 5050;

// Initialize Fastify
const fastify = Fastify({logger: true});
fastify.register(fastifyFormBody);
// Ensure we acknowledge Twilio's requested WebSocket subprotocol (if any)
fastify.register(fastifyWs, {
    options: {
        handleProtocols: (protocols /*, request */) => {
            try {
                if (Array.isArray(protocols) && protocols.length > 0) {
                    const chosen = protocols[0];
                    fastify.log.info({ chosen, protocols }, 'WS subprotocol selected');
                    return chosen; // Echo first offered (Twilio expects one echoed)
                }
            } catch {}
            return false; // No subprotocol
        },
    }
});
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


// Voice, temperature, etc
const VOICE = 'cedar';
const TEMPERATURE = Number('0.8');

// Event logging
const LOG_EVENT_TYPES = ['error', 'response.content.done', 'rate_limits.updated',
    'response.created', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created', 'session.updated',
    // GA event names
    'response.output_audio.delta', 'response.output_text.delta', 'response.output_audio_transcript.delta'];// Latency math toggle
const SHOW_TIMING_MATH = false;

const ENABLE_TEXT_TAPS = true; // set true to log assistant text

// Root route
fastify.get('/', async (_req, reply) => {
    reply.send({message: 'Rabbot Realtime Voice is live.'});
});

// Optional: quick check to verify DB connectivity without altering schema
fastify.get('/db/health', async (_req, reply) => {
  try {
    // Lazy import to keep this endpoint decoupled if DB is not configured
    const { sequelize } = await import('./src/lib/db.mjs');
    if (!sequelize) return reply.send({ ok:false, connected:false, reason:'no DB configured' });
    await sequelize.authenticate();
    return reply.send({ ok:true, connected:true });
  } catch (e) {
    return reply.send({ ok:false, connected:false, error: e?.message || String(e) });
  }
});

// Simple debug endpoint to check remaining seconds for a user/phone.
// Protect with ADMIN_TOKEN if provided (header: x-admin-token or query: token)
fastify.get('/billing/remaining', async (request, reply) => {
    const token = request.headers['x-admin-token'] || request.query?.token;
    if (ADMIN_TOKEN && token !== ADMIN_TOKEN) {
        return reply.code(401).send({ ok:false, error: 'unauthorized' });
    }
    const userId = request.query?.userId || request.query?.phone || request.query?.caller || '';
    if (!userId) return reply.code(400).send({ ok:false, error: 'missing userId|phone|caller' });
    const ent = await ensureEntitlement(userId);
    const total = Math.max(0, (ent.trialLeft || 0) + (ent.paidLeft || 0));
    reply.send({ ok:true, userId, trialLeft: ent.trialLeft || 0, paidLeft: ent.paidLeft || 0, totalLeft: total });
});

// OpenAI Realtime SIP webhook
fastify.post('/openai-sip', async (request, reply) => {
    const event = request.body;
    if (event?.type === 'realtime.call.incoming') {
        const callId = event.data?.id;
        // Accept the call then attach a session using the Agents SDK
        (async () => {
            try {
                await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/accept`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${OPENAI_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        voice: 'alloy',
                        instructions: SYSTEM_MESSAGE,
                    }),
                });

                const agent = new RealtimeAgent({
                    name: 'Rabbot',
                    instructions: SYSTEM_MESSAGE,
                });

                const session = new RealtimeSession(agent, {
                    model: 'gpt-realtime',
                    transport: new OpenAIRealtimeWebSocket({
                        url: `wss://api.openai.com/v1/realtime/calls/${callId}`,
                    }),
                    config: {
                        audio: {
                            output: { voice: 'alloy' },
                        },
                    },
                });

                session.connect({ apiKey: OPENAI_API_KEY }).catch(err =>
                    fastify.log.error({ err }, 'Failed to connect SIP session'));
            } catch (err) {
                fastify.log.error({ err }, 'Failed to accept SIP call');
            }
        })();
    }
    reply.send({ ok: true });
});

// Twilio webhook: connect media stream
fastify.all('/incoming-call', async (request, reply) => {
    const from = request.body?.From || request.query?.From || '';
    console.log('[Call] Incoming', { from });

    // Lookup or create shared Contact by phone number and upgrade entitlements
    let contactWid = '';
    let isUnlimited = false;
    try {
      const res = await findOrCreateByPhone(from);
      if (res?.contact) {
        contactWid = res.contact.wid || '';
        const ent = await upgradeEntitlementFromContact(from, res.contact);
        isUnlimited = !!res.contact.is_unlimited;
        console.log('[Call] Contact mapped', { from, wid: contactWid, created: !!res.created, unlimited: isUnlimited, paidLeft: ent.paidLeft, trialLeft: ent.trialLeft });
      } else {
        console.warn('[Call] Contact not available', { reason: res?.reason || 'unknown' });
      }
    } catch (e) {
      console.warn('[Call] Contact lookup failed', e?.message || e);
    }

    // One-time initial trial as RBT top-up (idempotent)
    try {
      const grant = await ensureInitialTrialTopup(from);
      if (grant?.ok) {
        console.log('[Call] Trial granted as top-up', grant);
      } else if (grant?.reason) {
        console.log('[Call] Trial top-up skipped', grant.reason);
      }
    } catch (e) {
      console.warn('[Call] Trial top-up error', e?.message || e);
    }

    await ensureEntitlement(from);
    const secondsLeft = await totalSecondsLeft(from);

    console.log(`Incoming call from ${from || 'unknown'} — seconds remaining: ${secondsLeft}s`);

    if (secondsLeft <= 0) {
      // Text them the checkout link
      const link = checkoutUrlFor(from);
      if (link && TWILIO_NUMBER && from) {
        try {
          await twilioClient.messages.create({
            to: from,
            from: TWILIO_NUMBER,
            body: `Your Rabbot trial is used up. Get more minutes: ${link}`
          });
        } catch (e) { console.error('SMS fail', e?.message || e); }
      }
      const outTwiML = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>Thanks for calling. Your free minutes are used up. I just texted you a link to get more minutes. See you soon.</Say>
        <Hangup/>
      </Response>`;
      reply.type('text/xml').send(outTwiML);
      return;
    }

    // Limit this call by what's left (and an absolute per‑call cap)
    const cap = PER_CALL_CAP_S > 0 ? PER_CALL_CAP_S : secondsLeft;
    const allowThisCall = Math.min(secondsLeft, cap);
    console.log(`[Call cap] Allowing up to ${allowThisCall}s this call (cap=${cap}s, left=${secondsLeft}s)`);

    // Build WSS URL and escape for XML attribute (avoid Twilio 12100 parse error)
    const buildWsUrl = () => {
      const host = request.headers.host;
      const callerParam = encodeURIComponent(from);
      const widParam = contactWid ? `&wid=${encodeURIComponent(contactWid)}` : '';
      const ulParam = isUnlimited ? `&unlimited=1` : '';
      const raw = `wss://${host}/media-stream?caller=${callerParam}&max=${allowThisCall}${widParam}${ulParam}`;
      // Minimal XML attribute escaping
      return raw
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
    };

    const esc = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="${buildWsUrl()}">
          <Parameter name="caller" value="${esc(from)}" />
          ${contactWid ? `<Parameter name="wid" value="${esc(contactWid)}" />` : ''}
          ${isUnlimited ? `<Parameter name="unlimited" value="1" />` : ''}
          <Parameter name="max" value="${allowThisCall}" />
        </Stream>
      </Connect>
    </Response>`;
    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', {websocket: true}, (connection, req) => {
        console.log('Client connected');
        // Query params from <Stream url="...">
        const url = new URL(req.url, `http://${req.headers.host}`);
        let caller = url.searchParams.get('caller') || '';
        let maxThisCall = Number(url.searchParams.get('max') || '0') || 0;
        let contactWid = url.searchParams.get('wid') || '';
        let isUnlimited = ['1','true','yes'].includes(String(url.searchParams.get('unlimited') || '').toLowerCase());
        console.log(`[WS connect] caller=${caller || '(missing)'} wid=${contactWid || '(none)'} unlimited=${isUnlimited} max=${maxThisCall}s path=${req.url}`);

        // Per-connection state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let callSid = null;
        let callStartedAt = null;
        let cutoffTimer = null;
        let billed = false; // ensure we only deduct once per connection

        const billUsage = async (reason = 'unknown') => {
            if (billed) return;
            if (!caller) {
                console.warn(`[Billing] skip (${reason}): missing caller`);
                return;
            }
            if (!callStartedAt) {
                console.warn(`[Billing] skip (${reason}): callStartedAt not set`);
                return;
            }
            billed = true;
            // Prefer wall time since start, but include Twilio timestamp as a lower bound
            const wall = Math.ceil((Date.now() - callStartedAt) / 1000);
            const twilioMs = Number.isFinite(latestMediaTimestamp) ? latestMediaTimestamp : 0;
            const fromTwilio = Math.ceil((twilioMs || 0) / 1000);
            const seconds = Math.max(1, Math.max(wall, fromTwilio));
            if (isUnlimited) {
                console.log(`[Billing] skip deduction (${reason}): unlimited user ${caller} (${seconds}s)`);
                return;
            }
            try {
                const ent = await deductSeconds(caller, seconds, { reason });
                console.log(`Usage deducted ${seconds}s for ${caller} [${reason}]. TrialLeft=${ent.trialLeft}s PaidLeft=${ent.paidLeft}s`);
            } catch (e) {
                console.warn('Deduct failed', e?.message || e);
            }
        };

        let hasActiveResponse = false;
        let assistantStreaming = false;
        // GA barge-in and gating state
        let currentResponseId = null;
        let dropAudioUntilNextResponse = false;
        let userSpeaking = false; // true between speech_started and speech_stopped/committed
        let lastLocalBargeTs = 0;
        let fastBargeCount = 0;
        // Track how many assistant audio bytes we've actually forwarded to Twilio for the current response
        let assistantBytesSent = 0;
        // Track assistant audio energy (avg abs amplitude, EMA)
        let assistantOutAvgAbsEma = 0;
        const ema = (prev, v, a) => (prev === 0 ? v : (prev * (1 - a) + v * a));

        // 🔥 Low-latency auto-commit (server-VAD style)
        let hasUncommittedAudio = false;
        let lastUserAudioAt = 0;
        const SILENCE_MS = 550; // commit if ~0.5s of silence
        const COMMIT_TICK_MS = 150;

        const USE_MANUAL_COMMIT = false;
        // 🔥 Live energy toggle
        let sizzleMode = (RABBOT_SIZZLE_DEFAULT.toLowerCase() === 'on');

        const openAiWs = new WebSocket(// NOTE: voice in query helps some stacks; we also set it in session.update
            `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`, {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                },
            },);

        // --- Helpers ----------------------------------------------------------------

        const send = (obj) => openAiWs.readyState === WebSocket.OPEN && openAiWs.send(JSON.stringify(obj));

        const now = () => Date.now();

        // μ-law decode to linear 16-bit approx; return average absolute amplitude
        const muLawAvgAbs = (buf, limit) => {
            const n = Math.min(buf.length, Math.max(1, limit || buf.length));
            let sum = 0;
            for (let i = 0; i < n; i++) {
                const u = (~buf[i]) & 0xff;
                const sign = u & 0x80;
                const exponent = (u >> 4) & 0x07;
                const mantissa = u & 0x0f;
                let magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
                let pcm = magnitude - 0x84;
                if (sign) pcm = -pcm;
                sum += (pcm < 0 ? -pcm : pcm);
            }
            return sum / n;
        };

        const sendMark = () => {
            if (!streamSid) return;
            const markEvent = {event: 'mark', streamSid, mark: {name: 'responsePart'}};
            connection.send(JSON.stringify(markEvent));
            markQueue.push('responsePart');
        };

        const handleSpeechStartedEvent = () => {
            // True barge-in: prefer server-side interrupt via turn_detection, but also try to cancel if mid-stream
            const shouldCancel = hasActiveResponse || assistantStreaming || !!currentResponseId;
            if (shouldCancel) {
                try {
                    if (currentResponseId) {
                        send({ type: 'response.cancel', response_id: currentResponseId });
                    } else {
                        send({ type: 'response.cancel' });
                    }
                } catch {}
            }
            // Regardless, drop any late deltas until next response begins
            dropAudioUntilNextResponse = true;
            userSpeaking = true;
            // Attempt to trim the assistant's last output item so transcripts match what was heard
            try {
                if (lastAssistantItem && assistantBytesSent > 0) {
                    const audio_end_ms = Math.floor(assistantBytesSent / 8); // 8000 bytes ≈ 1000ms
                    // Lightweight log: server-side truncate to align transcript with heard audio
                    try { console.log(`[TRUNCATE] item=${lastAssistantItem} audio_end_ms=${audio_end_ms}`); } catch {}
                    send({
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms
                    });
                }
            } catch {}
            // Reset local tracking
            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
            assistantStreaming = false;
            hasActiveResponse = false;
            fastBargeCount = 0;
        };


        const sendColdOpen = () => {
            const instructions = sizzleMode
                ? `Give a *natural*, warm first-call rabbi greeting (2 short sentences max). Default English unless caller clearly uses another language. Include a single unobtrusive language offer ("If you prefer Hebrew, Yiddish, Spanish, or any other language, just say so and I'll switch."). If they ask for Yiddish later, reply only in Yiddish (no Hebrew). End with one specific short question.`
                : `Give a *calm, gentle* first-call rabbi greeting (2 short sentences max). Default English unless caller clearly uses another language. Include a single soft language offer ("If you prefer Hebrew, Yiddish, Spanish, or any other language, just say so and I'll switch."). If they ask for Yiddish later, reply only in Yiddish (no Hebrew). End with one specific short question.`;

            send({
                type: 'response.create',
                response: {
                    instructions
                }
            });
            hasActiveResponse = true;
        };


        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update', session: {
                    type: 'realtime',
                    model: 'gpt-realtime',
                    // Output modality: 'audio' only (model in this env does not allow both)
                    output_modalities: ['audio'],

                    // ✅ GA schema: nested audio.{input,output}.format.type = 'audio/pcmu'
                    audio: {
                        input: {
                            format: {type: 'audio/pcmu'},
                            noise_reduction: { type: 'near_field' },
                            // Move VAD config back under audio.input to satisfy GA shape
                            turn_detection: (() => {
                                const mode = String(VAD_MODE || 'server').toLowerCase();
                                if (mode === 'semantic') {
                                    // semantic_vad uses eagerness instead of threshold/silence
                                    const eagerness = ['low','medium','high','auto'].includes(String(VAD_SEMANTIC_EAGERNESS).toLowerCase())
                                        ? String(VAD_SEMANTIC_EAGERNESS).toLowerCase()
                                        : 'auto';
                                    return {
                                        type: 'semantic_vad',
                                        eagerness,
                                        interrupt_response: true,
                                        create_response: true,
                                    };
                                }
                                // default: server_vad
                                return {
                                    type: 'server_vad',
                                    threshold: Math.max(0, Math.min(1, Number(VAD_THRESHOLD) || 0.5)),
                                    silence_duration_ms: Number(VAD_SILENCE_MS) || 500,
                                    prefix_padding_ms: Number(VAD_PREFIX_MS) || 200,
                                    interrupt_response: true,
                                    create_response: true,
                                };
                            })()
                        },
                        output: {
                            format: {type: 'audio/pcmu'}, voice: VOICE
                        },
                    },

                    // system instructions
                    instructions: SYSTEM_MESSAGE,

                    // Note: input_audio_transcription is only supported in transcription-only sessions.
                    // For conversation (speech-to-speech) mode, omit it to avoid unknown_parameter errors.

                    // your simple, side-effect-free tools
                    tools: [{
                        type: 'function',
                        name: 'mark_moment',
                        description: 'Mark a clip-worthy beat in the log. Use when an aha/punchline lands.',
                        parameters: {
                            type: 'object', properties: {label: {type: 'string'}}, required: ['label']
                        }
                    }, {
                        type: 'function',
                        name: 'set_sizzle_mode',
                        description: 'Switch energy profile. "on" = hype, hooks; "off" = calm, depth.',
                        parameters: {
                            type: 'object',
                            properties: {mode: {type: 'string', enum: ['on', 'off']}},
                            required: ['mode']
                        }
                    }]
                }
            };

            console.log('Sending session.update');
            send(sessionUpdate);

            if ((COLD_OPEN || 'true').toLowerCase() === 'true') {
                setTimeout(sendColdOpen, 120);
            }
        };

        // --- Tool-call helper (supports both function-event and item-event shapes) --
        function handleFunctionCall({name, call_id, args, shape}) {
            // Default result
            let result = {ok: true};

            // mark_moment
            if (name === 'mark_moment') {
                const label = (args && args.label) ? String(args.label) : '';
                console.log(`🔥 CLIP MARK: ${label}`);
                result = {ok: true, label};
            }

            // set_sizzle_mode
            else if (name === 'set_sizzle_mode') {
                const mode = (args && args.mode) ? String(args.mode) : '';
                if (mode === 'on' || mode === 'off') {
                    sizzleMode = (mode === 'on');
                    console.log(`🔥 SIZZLE MODE: ${mode}`);
                    // (Optional) push a tiny overlay so the model actually shifts delivery
                    const overlay = sizzleMode
                        ? '# Energy Mode\\n- Higher energy; hooks allowed.\\n- Slightly faster cadence; keep 1–2 sentences; end with a crisp question.'
                        : '# Energy Mode\\n- Calmer, depth-first.\\n- Slightly slower cadence; keep 1–2 sentences; end with a gentle, specific question.';
                    send({type: 'session.update', session: {instructions: `${SYSTEM_MESSAGE}\\n\\n${overlay}`}});
                    result = {mode};
                } else {
                    result = {error: 'mode must be "on" or "off"'};
                }
            }

            // unknown tool
            else {
                result = {ok: false, error: `unknown_tool: ${name}`};
            }

            // Return according to the shape we received
            if (shape === 'function_event') {
                send({type: 'response.function.result', call_id, result});
            } else {
                // item-based tool call: must create a function_call_output item then ask for a response
                send({
                    type: 'conversation.item.create',
                    item: {type: 'function_call_output', call_id, output: JSON.stringify(result)}
                });
                send({type: 'response.create'});
            }
        }

        // --- OpenAI WS handlers ------------------------------------------------------

        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime');
            // Keepalive ping (avoid idle timeouts)
            const pingIv = setInterval(() => {
                try {
                    openAiWs.ping?.();
                } catch {
                }
            }, 15000);
            openAiWs.once('close', () => clearInterval(pingIv));
            setTimeout(initializeSession, 80);
        });

        openAiWs.on('message', (data) => {

            let response;
            try {
                response = JSON.parse(data);
            } catch (e) {
                console.error('Non-JSON from OpenAI:', String(data));
                return;
            }

            if (response.type === 'error') {
                const code = response.error?.code;
                // Ignore benign race from barge-in when generation already finished
                if (code === 'response_cancel_not_active') {
                    if (fastify.log?.debug) fastify.log.debug('Cancel ignored: no active response');
                } else {
                    console.error('Realtime ERROR:', {
                        message: response.error?.message,
                        type: response.error?.type,
                        code: code,
                        details: response.error,
                    });
                }
            }


            if (LOG_EVENT_TYPES.includes(response.type)) {
                console.log(`OpenAI event: ${response.type}`);
            }

            if (response.type === 'response.created') {
                hasActiveResponse = true;
                // Track current response for barge-in dropping
                currentResponseId = response.response?.id || response.id || null;
                dropAudioUntilNextResponse = false;
                assistantBytesSent = 0;
            }

            // Audio deltas → Twilio (GA name; keep legacy as fallback)
            if ((response.type === 'response.output_audio.delta' || response.type === 'response.audio.delta') && response.delta) {
                // Gate: drop if we've canceled this response, or user is speaking
                if (dropAudioUntilNextResponse || userSpeaking) {
                    // swallow this delta to prevent double-talk / late tails
                } else {
                const audioDelta = {
                    event: 'media', streamSid, media: {payload: response.delta},
                };
                connection.send(JSON.stringify(audioDelta));
                try {
                    // Count bytes forwarded (PCMU 8kHz: 8000 bytes ≈ 1000ms)
                    assistantBytesSent += Buffer.from(response.delta, 'base64').length;
                } catch {}
                // Update outgoing energy EMA for echo discrimination
                try {
                    const outBuf = Buffer.from(response.delta, 'base64');
                    const win = Math.max(1, Number(FAST_BARGE_WINDOW_BYTES) || 160);
                    const outAvg = muLawAvgAbs(outBuf, win);
                    assistantOutAvgAbsEma = ema(assistantOutAvgAbsEma, outAvg, 0.35);
                } catch {}

                if (!responseStartTimestampTwilio) {
                    responseStartTimestampTwilio = latestMediaTimestamp;
                    if (SHOW_TIMING_MATH) console.log(`Assistant start @ ${responseStartTimestampTwilio}ms`);
                }
                assistantStreaming = true;
                if (response.item_id) lastAssistantItem = response.item_id;

                // mark to detect "assistant finished" via Twilio mark callback
                sendMark();
                }
            }

            // Text deltas (GA)
            if (ENABLE_TEXT_TAPS && (response.type === 'response.output_text.delta' || response.type === 'response.text.delta')) {
                // keep lines short—these arrive as small chunks
                const textDelta = typeof response.delta === 'string' ? response.delta : (response.text || '');
                if (textDelta) console.log('ASSISTANT_TEXT:', textDelta);
            }

            // Optional: audio transcript deltas (GA)
            if (response.type === 'response.output_audio_transcript.delta') {
                if (response.delta) console.log('ASSISTANT_ASR:', response.delta);
            }

            if (response.type === 'response.done') {
                hasActiveResponse = false;
                assistantStreaming = false;
                currentResponseId = null;
                dropAudioUntilNextResponse = false;
                assistantBytesSent = 0;
            }

            // Capture the assistant output item id as soon as it's added
            if (response.type === 'response.output_item.added' && response.item?.id) {
                lastAssistantItem = response.item.id;
            }

            // Barge-in cues
            if (response.type === 'input_audio_buffer.speech_started') {
                try { console.log('[BARGE] server VAD speech_started'); } catch {}
                handleSpeechStartedEvent();
            }
            if (response.type === 'input_audio_buffer.speech_stopped' || response.type === 'input_audio_buffer.committed') {
                userSpeaking = false;
            }

            // 🔥 Handle simple tool calls (shape 1: function-event)
            if (response.type === 'response.function.call') {
                const {name, call_id, arguments: args} = response;
                handleFunctionCall({name, call_id, args, shape: 'function_event'});
            }

            // 🔥 Handle simple tool calls (shape 2: item-event)
            if (response.type === 'response.output_item.done' && response.item?.type === 'function_call') {
                const {name, call_id} = response.item;
                // Some stacks send `arguments` as a JSON string here:
                let args = response.item.arguments;
                try {
                    if (typeof args === 'string') args = JSON.parse(args);
                } catch {
                    // leave as-is if parsing fails
                }
                handleFunctionCall({name, call_id, args, shape: 'item_event'});
            }
        });

        openAiWs.on('close', (code, reason) => {
            console.log(`Disconnected from OpenAI (${code}) ${reason || ''}`);
            try {
                connection.close();
            } catch {
            }
        });

        openAiWs.on('error', (err) => {
            console.error('OpenAI WS error:', err?.message || err);
        });

        // --- Twilio ↔︎ OpenAI Bridge -------------------------------------------------

        // Auto-commit interval (only if you disable server VAD)
        const commitInterval = USE_MANUAL_COMMIT ? setInterval(() => {
            const since = now() - lastUserAudioAt;
            if (hasUncommittedAudio && since > SILENCE_MS) {
                // Commit current buffer and ask for a response
                send({type: 'input_audio_buffer.commit'});
                send({type: 'response.create'});
                hasUncommittedAudio = false;
                if (SHOW_TIMING_MATH) console.log('Auto-commit after silence');
            }
        }, COMMIT_TICK_MS) : null;

        connection.on('message', (message) => {
            let data;
            try {
                data = JSON.parse(message);
            } catch (e) {
                console.error('Non-JSON from Twilio:', String(message));
                return;
            }

            switch (data.event) {
                case 'start': {
                    streamSid = data.start.streamSid;
                    callSid = data.start.callSid;
                    // Recover params from Twilio customParameters if query params were dropped by provider
                    try {
                        const cp = data?.start?.customParameters || data?.start?.custom_parameters || {};
                        if (cp) {
                            // Caller ID
                            const fromCp = cp.caller || cp.From || cp.from || cp.CALLER;
                            if (!caller && fromCp) caller = String(fromCp);
                            // Max seconds for this call
                            const maxCp = cp.max || cp.Max || cp.MAX;
                            if (!maxThisCall && maxCp) {
                                const n = Number(maxCp);
                                if (Number.isFinite(n)) maxThisCall = n;
                            }
                            // Contact WID
                            const widCp = cp.wid || cp.WID || cp.Wid;
                            if (!contactWid && widCp) contactWid = String(widCp);
                            // Unlimited flag
                            if (cp.unlimited != null) {
                              const v = String(cp.unlimited).toLowerCase();
                              if (['1','true','yes'].includes(v)) isUnlimited = true;
                            }
                            console.log('[WS params] Recovered from customParameters', { caller, contactWid, isUnlimited, maxThisCall });
                        }
                    } catch {}
                    console.log('Twilio stream started', streamSid);
                    responseStartTimestampTwilio = null;
                    latestMediaTimestamp = 0;
                    callStartedAt = Date.now();
                    console.log(`[Billing] start caller=${caller} callSid=${callSid || '(n/a)'} startedAt=${new Date(callStartedAt).toISOString()} max=${maxThisCall}s`);

                    // ⛔ auto-hangup when they hit their allowance for this call
                    if (maxThisCall > 0 && twilioClient && callSid) {
                        cutoffTimer = setTimeout(async () => {
                            try {
                                await twilioClient
                                  .calls(callSid)
                                  .update({
                                      twiml: `<?xml version="1.0" encoding="UTF-8"?>
                                      <Response>
                                        <Say>Time’s up for this call. I’ll text you a link for more minutes.</Say>
                                        <Hangup/>
                                      </Response>`
                                  });
                                // SMS link
                                const link = checkoutUrlFor(caller);
                                if (link && TWILIO_NUMBER && caller) {
                                  await twilioClient.messages.create({
                                    to: caller, from: TWILIO_NUMBER,
                                    body: `Add minutes to Rabbot: ${link}`
                                  });
                                }
                            } catch (err) {
                                console.error('Failed to stop call on cutoff', err?.message || err);
                            }
                        }, maxThisCall * 1000);
                    }

                    // Kick off Twilio-managed call recording (shows up in Console)
                    if (twilioClient && callSid) {
                        (async () => {
                            try {
                                const rec = await twilioClient
                                    .calls(callSid)
                                    .recordings
                                    .create({
                                        // Separate channels for caller vs. Twilio playback
                                        recordingChannels: 'dual',
                                        recordingTrack: 'both',
                                    });
                                console.log('Recording started:', rec.sid);
                            } catch (err) {
                                console.error('Failed to start recording', err?.message || err);
                            }
                        })();
                    }

                    break;
                }
                case 'media': {
                    latestMediaTimestamp = data.media.timestamp;
                    // Optional: fast local barge-in (disabled by default; enable via FAST_BARGE=on)
                    try {
                        const FAST_BARGE_ON = String(FAST_BARGE || '').toLowerCase() === 'on';
                        if (FAST_BARGE_ON && assistantStreaming && !userSpeaking && !dropAudioUntilNextResponse) {
                            const since = now() - lastLocalBargeTs;
                            const guardMs = Number(FAST_BARGE_START_GUARD_MS) || 1200;
                            // Skip local barge while within the echo guard window from assistant start
                            const sinceStart = (responseStartTimestampTwilio && latestMediaTimestamp)
                                ? (latestMediaTimestamp - responseStartTimestampTwilio)
                                : Infinity; // allow if not measurable
                            if (since > (Number(FAST_BARGE_COOLDOWN_MS) || 250) && sinceStart > guardMs) {
                                const b64 = data.media.payload;
                                const buf = Buffer.from(b64, 'base64');
                                const win = Math.max(1, Number(FAST_BARGE_WINDOW_BYTES) || 160);
                                const len = Math.min(buf.length, win);
                                // μ-law energy of inbound frame
                                const inAvg = muLawAvgAbs(buf, len);
                                const absThresh = Number(FAST_BARGE_ABS_THRESH) || 5000;
                                const ratio = Number(FAST_BARGE_RATIO) || 1.6;
                                const echoFloor = assistantOutAvgAbsEma * ratio;
                                const passesEnergy = inAvg > Math.max(absThresh, echoFloor);
                                if (passesEnergy) {
                                    fastBargeCount += 1;
                                    if (fastBargeCount >= (Number(FAST_BARGE_FRAMES) || 2)) {
                                        // Lightweight log: local heuristic barge triggered
                                        try { console.log(`[BARGE] local trigger inAvg=${inAvg.toFixed(0)} outEma=${assistantOutAvgAbsEma.toFixed(0)} ratio=${ratio} guardMs=${guardMs}`); } catch {}
                                        lastLocalBargeTs = now();
                                        handleSpeechStartedEvent();
                                        fastBargeCount = 0;
                                    }
                                } else {
                                    fastBargeCount = 0;
                                }
                            }
                        }
                    } catch {}
                    // forward audio to OpenAI
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        send({
                            type: 'input_audio_buffer.append', audio: data.media.payload, // base64 PCMU
                        });
                        // Only used when manual commit is enabled
                        if (USE_MANUAL_COMMIT) {
                            hasUncommittedAudio = true;
                            lastUserAudioAt = now();
                        }

                    }
                    break;
                }
                case 'mark': {
                    if (markQueue.length > 0) markQueue.shift();
                    break;
                }
                case 'stop': {
                    // Twilio ended the stream
                    try {
                        if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
                    } catch {
                    }
                    console.log('Twilio stream stopped');
                    if (cutoffTimer) { clearTimeout(cutoffTimer); cutoffTimer = null; }
                    // bill actual usage once
                    billUsage('stop');
                    break;
                }
                default:
                    // Useful for debugging: 'dtmf', etc.
                    // console.log('Non-media event:', data.event);
                    break;
            }
        });

        connection.on('close', () => {
            if (cutoffTimer) { clearTimeout(cutoffTimer); cutoffTimer = null; }
            // bill if not already billed
            billUsage('close');
            try {
                if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            } catch {
            }
            if (commitInterval) clearInterval(commitInterval);
            console.log('Client disconnected.');
        });
    });
});

fastify.listen({port: PORT, host: '0.0.0.0'}, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Rabbot Realtime server listening on :${PORT}`);
});
