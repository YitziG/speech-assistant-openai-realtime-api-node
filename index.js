import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import process from 'node:process';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
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
    STRIPE_PAYMENT_LINK,
    TWILIO_NUMBER,
    TRIAL_SECONDS = '300',
    PER_CALL_CAP_SECONDS = '600',

} = process.env;

// Use env vars for Twilio (rotate any leaked creds in Console)
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TRIAL_S = Number(TRIAL_SECONDS) || 0;
const PER_CALL_CAP_S = Number(PER_CALL_CAP_SECONDS) || 0;


if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in your environment.');
    process.exit(1);
}

const PORT = PORT_ENV || 5050;

// Initialize Fastify
const fastify = Fastify({logger: false});
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// 🚦 Super‑simple seconds store (phone -> {trialLeft, paidLeft})
const minutesStore = new Map();
function getUserEntitlement(phone) {
  if (!minutesStore.has(phone)) {
    minutesStore.set(phone, { trialLeft: TRIAL_S, paidLeft: 0 });
  }
  return minutesStore.get(phone);
}
function totalSecondsLeft(e) { return Math.max(0, (e?.trialLeft||0) + (e?.paidLeft||0)); }
function deductUsage(e, seconds) {
  let remaining = seconds;
  if (e.trialLeft > 0) {
    const useTrial = Math.min(e.trialLeft, remaining);
    e.trialLeft -= useTrial;
    remaining -= useTrial;
  }
  if (remaining > 0 && e.paidLeft > 0) {
    e.paidLeft = Math.max(0, e.paidLeft - remaining);
  }
}

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
    'response.created', 'response.done', 'input_audio_buffer.committed', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.speech_started', 'session.created', 'session.updated', 'response.audio.delta'];// Latency math toggle
const SHOW_TIMING_MATH = false;

const ENABLE_TEXT_TAPS = true; // set true to log assistant text

// Root route
fastify.get('/', async (_req, reply) => {
    reply.send({message: 'Rabbot Realtime Voice is live.'});
});

// Twilio webhook: connect media stream
fastify.all('/incoming-call', async (request, reply) => {
    const from = request.body?.From || request.query?.From || '';
    const ent = getUserEntitlement(from);
    const secondsLeft = totalSecondsLeft(ent);
    console.log(`Incoming call from ${from || 'unknown'} — seconds remaining: ${secondsLeft}s`);

    if (secondsLeft <= 0) {
      // Text them the checkout link
      if (STRIPE_PAYMENT_LINK && TWILIO_NUMBER && from) {
        try {
          await twilioClient.messages.create({
            to: from,
            from: TWILIO_NUMBER,
            body: `Your Rabbot trial is used up. Get more minutes: ${STRIPE_PAYMENT_LINK}`
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
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream?caller=${encodeURIComponent(from)}&max=${allowThisCall}" />
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
        const caller = url.searchParams.get('caller') || '';
        const maxThisCall = Number(url.searchParams.get('max') || '0') || 0;

        // Per-connection state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let callSid = null;
        let callStartedAt = null;
        let cutoffTimer = null;

        let hasActiveResponse = false;
        let assistantStreaming = false;

        // 🔥 Low-latency auto-commit (server-VAD style)
        let hasUncommittedAudio = false;
        let lastUserAudioAt = 0;
        const SILENCE_MS = 550; // commit if ~0.5s of silence
        const COMMIT_TICK_MS = 150;

        const USE_MANUAL_COMMIT = false;
        // 🔥 Live energy toggle
        let sizzleMode = (RABBOT_SIZZLE_DEFAULT.toLowerCase() === 'on');

        const openAiWs = new WebSocket(// NOTE: voice in query helps some stacks; we also set it in session.update
            `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}&voice=${VOICE}`, {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                },
            },);

        // --- Helpers ----------------------------------------------------------------

        const send = (obj) => openAiWs.readyState === WebSocket.OPEN && openAiWs.send(JSON.stringify(obj));

        const now = () => Date.now();

        const sendMark = () => {
            if (!streamSid) return;
            const markEvent = {event: 'mark', streamSid, mark: {name: 'responsePart'}};
            connection.send(JSON.stringify(markEvent));
            markQueue.push('responsePart');
        };

        const handleSpeechStartedEvent = () => {

            if (streamSid) {
                connection.send(JSON.stringify({event: 'clear', streamSid}));
            }

            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
            assistantStreaming = false;
            hasActiveResponse = false;
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
                    // If enabled, also request text alongside audio so we can log highlights
                    output_modalities: ['audio'],

                    // ✅ GA schema: nested audio.{input,output}.format.type = 'audio/pcmu'
                    audio: {
                        input: {
                            format: {type: 'audio/pcmu'}, // optional server VAD here (safe to keep):
                            turn_detection: {type: 'server_vad'}
                        }, output: {
                            format: {type: 'audio/pcmu'}
                        }
                    },

                    // system instructions
                    instructions: SYSTEM_MESSAGE,

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
                // ⭐ Print the full error for debugging
                console.error('Realtime ERROR:', {
                    message: response.error?.message,
                    type: response.error?.type,
                    code: response.error?.code,
                    details: response.error,
                });
            }


            if (LOG_EVENT_TYPES.includes(response.type)) {
                console.log(`OpenAI event: ${response.type}`);
            }

            if (response.type === 'response.created') {
                hasActiveResponse = true;
            }

            // Audio deltas → Twilio
            if ((response.type === 'response.output_audio.delta' || response.type === 'response.audio.delta') && response.delta) {
                const audioDelta = {
                    event: 'media', streamSid, media: {payload: response.delta},
                };
                connection.send(JSON.stringify(audioDelta));

                if (!responseStartTimestampTwilio) {
                    responseStartTimestampTwilio = latestMediaTimestamp;
                    if (SHOW_TIMING_MATH) console.log(`Assistant start @ ${responseStartTimestampTwilio}ms`);
                }
                assistantStreaming = true;
                if (response.item_id) lastAssistantItem = response.item_id;

                // mark to detect "assistant finished" via Twilio mark callback
                sendMark();
            }

            if (ENABLE_TEXT_TAPS && response.type === 'response.text.delta') {
                // keep lines short—these arrive as small chunks
                console.log('ASSISTANT_TEXT:', response.text);
            }

            if (response.type === 'response.done') {
                hasActiveResponse = false;
                assistantStreaming = false;
            }

            // Barge-in cue
            if (response.type === 'input_audio_buffer.speech_started') {
                handleSpeechStartedEvent();
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
                    console.log('Twilio stream started', streamSid);
                    responseStartTimestampTwilio = null;
                    latestMediaTimestamp = 0;
                    callStartedAt = Date.now();

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
                                if (STRIPE_PAYMENT_LINK && TWILIO_NUMBER && caller) {
                                  await twilioClient.messages.create({
                                    to: caller, from: TWILIO_NUMBER,
                                    body: `Add minutes to Rabbot: ${STRIPE_PAYMENT_LINK}`
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
                    // bill actual usage
                    if (caller && callStartedAt) {
                      const seconds = Math.max(1, Math.ceil((Date.now() - callStartedAt) / 1000));
                      const ent = getUserEntitlement(caller);
                      deductUsage(ent, seconds);
                      console.log(`Usage deducted ${seconds}s for ${caller}. TrialLeft=${ent.trialLeft}s PaidLeft=${ent.paidLeft}s`);
                    }
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
            if (caller && callStartedAt) {
              const seconds = Math.max(1, Math.ceil((Date.now() - callStartedAt) / 1000));
              const ent = getUserEntitlement(caller);
              deductUsage(ent, seconds);
              console.log(`Usage deducted (close) ${seconds}s for ${caller}. TrialLeft=${ent.trialLeft}s PaidLeft=${ent.paidLeft}s`);
            }
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
