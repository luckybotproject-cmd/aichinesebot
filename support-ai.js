// ============================================================================
//  support-ai.js — ADDITIVE MODULE (v9)
//  AI Customer-Support Assistant (text + voice) for Chinese Signal Bot.
//  Nothing in this file modifies existing behaviour. It only ADDS routes:
//      POST /api/support/chat      → AI reply (text)
//      POST /api/support/stt       → voice message → text
//      POST /api/support/tts       → text → spoken audio (mp3)
//      POST /api/support/ticket    → create support ticket + notify admin
//      GET  /api/support/tickets   → admin: list tickets
//      POST /api/support/tickets/:id/close  → admin: close ticket
//      GET  /support-tickets       → tiny admin page for tickets
//
//  PRIVACY RULES (enforced server side, not just in the prompt):
//   • Licence keys are NEVER sent to the AI or to the browser by this module.
//   • Only non-sensitive order fields are shared (masked contact, status, plan).
//   • No free keys, no discounts, no promises — the AI can only inform/escalate.
//
//  CONFIG (all optional — the widget degrades gracefully if unset):
//      SUPPORT_AI_KEY      (or LOVABLE_API_KEY / OPENAI_API_KEY)
//      SUPPORT_AI_URL      default https://ai.gateway.lovable.dev/v1
//      SUPPORT_AI_MODEL    default google/gemini-3.8-flash
//      SUPPORT_TTS_MODEL   default openai/gpt-4o-mini-tts
//      SUPPORT_STT_MODEL   default google/gemini-3.5-transcribe
//      SUPPORT_TTS_VOICE   default alloy
// ============================================================================

const path = require('path');

const AI_BASE   = (process.env.SUPPORT_AI_URL || 'https://ai.gateway.lovable.dev/v1').replace(/\/+$/, '');
const AI_KEY    = process.env.SUPPORT_AI_KEY || process.env.LOVABLE_API_KEY || process.env.OPENAI_API_KEY || '';
const AI_MODEL  = process.env.SUPPORT_AI_MODEL || 'google/gemini-3.8-flash';
const TTS_MODEL = process.env.SUPPORT_TTS_MODEL || 'openai/gpt-4o-mini-tts';
const STT_MODEL = process.env.SUPPORT_STT_MODEL || 'google/gemini-3.5-transcribe';
const TTS_VOICE = process.env.SUPPORT_TTS_VOICE || 'alloy';

const MAX_TURNS = 16;   // conversation turns forwarded to the model
const MAX_CHARS = 1200; // max characters accepted per user message

function aiConfigured() { return !!AI_KEY; }

function aiHeaders() {
    // Lovable AI Gateway accepts the Lovable-API-Key header; other
    // OpenAI-compatible gateways accept the standard Authorization header.
    return {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AI_KEY,
        'Lovable-API-Key': AI_KEY,
    };
}

function mask(v) {
    const s = String(v || '');
    if (!s) return '';
    if (s.length <= 4) return '••';
    return s.slice(0, 2) + '•'.repeat(Math.max(2, s.length - 5)) + s.slice(-3);
}

// ── System prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt(ctx) {
    const plans = (ctx.plans || []).map(p =>
        `- ${p.label || p.key}: PKR ${p.pricePKR || '—'} / $${p.priceUSD || '—'} (${p.duration || ''})`).join('\n');
    const pays  = (ctx.payments || []).join(', ') || 'Easypaisa, JazzCash, Binance, USDT';

    return [
        'You are "Signal Support", the customer-support assistant for the Chinese Signal Bot licence store.',
        'You help ONLY with customer support: plans and prices, how to order, payment steps, order status,',
        'licence delivery and activation, email delivery, and general questions about the service.',
        '',
        'LANGUAGE: reply in the language the customer used — English, Urdu (اردو) or Roman Urdu. Keep the same script they used.',
        'TONE: short, friendly, practical. Use at most a few short lines or bullets. No long essays.',
        '',
        'HARD RULES — never break these:',
        '• NEVER give out, guess, generate or hint at a licence key, activation code, password, OTP or admin link.',
        '• NEVER offer free keys, trials, discounts, refunds, price changes or extensions. If asked, say only the admin can decide and offer to create a support ticket.',
        '• NEVER share another customer\'s data, phone number, email, or order details.',
        '• NEVER ask for card numbers, passwords, OTP codes or full account credentials.',
        '• Do not invent order data. Use only the ORDER CONTEXT below. If it is empty, ask for the Order ID, Telegram username or WhatsApp number used at checkout.',
        '• If the customer is angry, has a payment/refund problem, a wrong or missing key, or anything you cannot solve, say you are escalating and end your reply with the exact tag [[ESCALATE]].',
        '',
        'PLANS:', plans || '- (ask the customer to open the Buy Licence page for current plans)',
        'PAYMENT METHODS: ' + pays,
        '',
        'HOW TO ORDER (explain when asked):',
        '1. Tap "Buy Licence Key" and pick a plan.',
        '2. Enter name, contact (WhatsApp for Pakistan, Telegram username for other countries) and optional email for instant delivery.',
        '3. Pay with one of the payment methods shown, then upload the payment screenshot and transaction ID.',
        '4. The admin verifies the payment and the licence key is delivered on your contact and email.',
        '',
        'ORDER TRACKING: the customer can track from the site using Order ID, Telegram username or WhatsApp number.',
        'For security the licence key itself is only shown in the order tracker or sent on their contact — never in this chat.',
        '',
        'ORDER CONTEXT (verified from our system; may be empty):',
        ctx.orderText || '(no order was found for this conversation yet)',
    ].join('\n');
}

// ── Detect an order reference inside free text ──────────────────────────────
function detectRefs(text) {
    const t = String(text || '');
    const out = [];
    const id = t.match(/\bORD[-_ ]?[A-Z0-9-]{3,}\b/i);
    if (id) out.push({ method: 'id', value: id[0].replace(/\s/g, '').toUpperCase() });
    const tg = t.match(/@([A-Za-z0-9_]{4,32})\b/);
    if (tg) out.push({ method: 'telegram', value: tg[1] });
    const wa = t.match(/(?:\+?\d[\d\s-]{8,17}\d)/);
    if (wa) out.push({ method: 'whatsapp', value: wa[0].replace(/[^\d+]/g, '') });
    return out;
}

module.exports = function attachSupportAI(deps) {
    const { app, mongoose, express, multer, axios, isAdmin, sendTelegramMessage,
            getOrders, getPlansAndPayments, trackStage } = deps;

    // ── Support ticket model (new collection — nothing existing is touched) ──
    const supportTicketSchema = new mongoose.Schema({
        id:        { type: String, required: true, unique: true },
        subject:   { type: String, default: '' },
        message:   { type: String, default: '' },
        contact:   { type: String, default: '' },
        orderId:   { type: String, default: '' },
        language:  { type: String, default: '' },
        transcript:{ type: Array,  default: [] },
        status:    { type: String, default: 'Open', index: true },
        createdAt: { type: Date,   default: Date.now },
    });
    const SupportTicket = mongoose.models.SupportTicket
        || mongoose.model('SupportTicket', supportTicketSchema);
    const ticketsMem = [];

    async function saveTicket(doc) {
        try { await SupportTicket.create(doc); }
        catch (e) { ticketsMem.unshift(doc); }
        return doc;
    }
    async function listTickets(limit) {
        try {
            const rows = await SupportTicket.find({}).sort({ createdAt: -1 }).limit(limit).lean();
            if (rows && rows.length) return rows;
        } catch (e) {}
        return ticketsMem.slice(0, limit);
    }

    // ── Look up an order safely and build shareable context ────────────────
    async function findOrderContext(refs) {
        if (!refs.length) return { orderText: '', order: null };
        let orders = [];
        try { orders = await getOrders(); } catch (e) { orders = []; }
        const norm = s => String(s || '').replace(/[^\d]/g, '').slice(-10);
        let found = null;
        for (const ref of refs) {
            found = orders.find(o => {
                if (ref.method === 'id')       return String(o.id || '').toUpperCase() === ref.value;
                if (ref.method === 'telegram') return String(o.telegram || '').toLowerCase().replace(/^@/, '') === ref.value.toLowerCase();
                return norm(o.whatsapp) && norm(o.whatsapp) === norm(ref.value);
            });
            if (found) break;
        }
        if (!found) return { orderText: '', order: null };

        const stage = (() => { try { return trackStage(found); } catch (e) { return null; } })();
        const safe = {
            id:        found.id,
            firstName: String(found.fullName || '').trim().split(/\s+/)[0] || 'Customer',
            plan:      found.planLabel || found.planKey || '',
            status:    found.status || 'Pending',
            method:    found.paymentMethod || '',
            country:   found.country || '',
            hasKey:    !!found.licenseKey,       // boolean only — key never leaves the server
            email:     found.email ? mask(found.email) : '',
            contact:   found.telegram ? '@' + String(found.telegram).replace(/^@/, '') : mask(found.whatsapp),
            createdAt: found.createdAt || null,
            stage,
        };
        const orderText = [
            `Order ID: ${safe.id}`,
            `Customer first name: ${safe.firstName}`,
            `Plan: ${safe.plan}`,
            `Payment method: ${safe.method}`,
            `Status: ${safe.status}`,
            `Licence key issued: ${safe.hasKey ? 'YES (already delivered — tell them to check the order tracker / their contact, never repeat the key here)' : 'NOT YET'}`,
            `Contact on file: ${safe.contact}${safe.email ? ' | email: ' + safe.email : ''}`,
            `Placed: ${safe.createdAt ? new Date(safe.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '—'}`,
        ].join('\n');
        return { orderText, order: safe };
    }

    // ── POST /api/support/chat ─────────────────────────────────────────────
    app.post('/api/support/chat', async (req, res) => {
        try {
            if (!aiConfigured()) {
                return res.status(503).json({
                    ok: false,
                    error: 'AI support is not configured yet. Please contact us on WhatsApp or Telegram.',
                });
            }
            const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
            const history = raw
                .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
                .slice(-MAX_TURNS)
                .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
            if (!history.length || history[history.length - 1].role !== 'user') {
                return res.status(400).json({ ok: false, error: 'No message received' });
            }
            const lastUser = history[history.length - 1].content;

            // Order context: an explicit ref sent by the widget, or one found in the text.
            const refs = [];
            const pinned = String(req.body?.orderId || '').trim();
            if (pinned) refs.push({ method: 'id', value: pinned.toUpperCase() });
            refs.push(...detectRefs(lastUser));
            const { orderText, order } = await findOrderContext(refs);

            const meta   = await getPlansAndPayments().catch(() => ({ plans: [], payments: [] }));
            const system = buildSystemPrompt({ ...meta, orderText });

            const r = await axios.post(AI_BASE + '/chat/completions', {
                model: AI_MODEL,
                messages: [{ role: 'system', content: system }, ...history],
            }, { headers: aiHeaders(), timeout: 120000, validateStatus: () => true });

            if (r.status >= 400) {
                const msg = r.data?.error?.message || r.data?.message || 'AI service error';
                const friendly = r.status === 429 ? 'Support assistant is busy right now — please try again in a moment.'
                    : (r.status === 402 || r.status === 403) ? 'AI support is temporarily unavailable. Please contact us on WhatsApp or Telegram.'
                    : msg;
                return res.status(r.status).json({ ok: false, error: friendly });
            }

            let reply = r.data?.choices?.[0]?.message?.content || '';
            if (Array.isArray(reply)) reply = reply.map(p => p?.text || '').join('');
            reply = String(reply || '').trim();
            if (!reply) return res.status(502).json({ ok: false, error: 'Empty reply from AI. Please try again.' });

            // Escalation → auto ticket + Telegram alert to admin.
            let ticketId = '';
            const wantsEscalation = /\[\[ESCALATE\]\]/i.test(reply);
            reply = reply.replace(/\[\[ESCALATE\]\]/gi, '').trim();
            if (wantsEscalation) {
                ticketId = 'TKT-' + Date.now().toString(36).toUpperCase();
                const doc = {
                    id: ticketId,
                    subject: 'AI escalation',
                    message: lastUser,
                    contact: String(req.body?.contact || '').slice(0, 120),
                    orderId: order?.id || '',
                    language: '',
                    transcript: history.slice(-6),
                    status: 'Open',
                    createdAt: new Date(),
                };
                await saveTicket(doc);
                sendTelegramMessage(
                    `🆘 <b>New Support Ticket</b>\n` +
                    `🎫 <code>${ticketId}</code>\n` +
                    (doc.orderId ? `📦 Order: <code>${doc.orderId}</code>\n` : '') +
                    (doc.contact ? `📞 Contact: ${doc.contact}\n` : '') +
                    `💬 ${doc.message.slice(0, 500)}`
                );
            }

            res.json({ ok: true, reply, ticketId, order });
        } catch (e) {
            console.error('POST /api/support/chat error:', e.message);
            const slow = /timeout|ECONNRESET|ETIMEDOUT|aborted/i.test(e.message || '');
            res.status(slow ? 504 : 500).json({
                ok: false,
                error: slow ? 'That took too long — please send your message again.'
                            : 'Support assistant failed. Please try again.',
            });
        }
    });

    // ── POST /api/support/stt — voice message → text ───────────────────────
    const voiceUpload = multer
        ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } }).single('audio')
        : (req, res, next) => next();

    app.post('/api/support/stt', voiceUpload, async (req, res) => {
        try {
            if (!aiConfigured()) return res.status(503).json({ ok: false, error: 'Voice support is not configured.' });
            const f = req.file;
            if (!f || !f.buffer || f.buffer.length < 2048) {
                return res.status(400).json({ ok: false, error: 'That recording was empty — please try again.' });
            }
            const FD = typeof FormData !== 'undefined' ? FormData : null;
            if (!FD) return res.status(503).json({ ok: false, error: 'Voice support needs Node 18 or newer.' });

            const mime = String(f.mimetype || 'audio/wav').split(';')[0];
            const ext  = ({ 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
                            'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3',
                            'audio/ogg': 'ogg' })[mime] || 'wav';
            const form = new FD();
            form.append('model', STT_MODEL);
            form.append('file', new Blob([f.buffer], { type: mime }), 'voice.' + ext);

            const headers = aiHeaders();
            delete headers['Content-Type']; // let fetch set the multipart boundary
            const up = await fetch(AI_BASE + '/audio/transcriptions', { method: 'POST', headers, body: form });
            const txt = await up.text();
            if (!up.ok) {
                console.error('STT failed:', up.status, txt.slice(0, 300));
                return res.status(up.status).json({ ok: false, error: 'Could not understand that recording. Please try again.' });
            }
            let out = {};
            try { out = JSON.parse(txt); } catch (e) { out = { text: txt }; }
            const text = String(out.text || '').trim();
            if (!text) return res.status(422).json({ ok: false, error: 'No speech detected — please record again.' });
            res.json({ ok: true, text });
        } catch (e) {
            console.error('POST /api/support/stt error:', e.message);
            res.status(500).json({ ok: false, error: 'Voice transcription failed.' });
        }
    });

    // ── POST /api/support/tts — text → spoken mp3 ──────────────────────────
    app.post('/api/support/tts', async (req, res) => {
        try {
            if (!aiConfigured()) return res.status(503).json({ ok: false, error: 'Voice replies are not configured.' });
            const text = String(req.body?.text || '').trim().slice(0, 900);
            if (!text) return res.status(400).json({ ok: false, error: 'Nothing to speak' });

            const r = await axios.post(AI_BASE + '/audio/speech', {
                model: TTS_MODEL,
                input: text,
                voice: TTS_VOICE,
                response_format: 'mp3',
                stream_format: 'audio',
            }, { headers: aiHeaders(), responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });

            if (r.status >= 400) {
                console.error('TTS failed:', r.status);
                return res.status(r.status).json({ ok: false, error: 'Voice reply unavailable right now.' });
            }
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Cache-Control', 'no-store');
            res.send(Buffer.from(r.data));
        } catch (e) {
            console.error('POST /api/support/tts error:', e.message);
            res.status(500).json({ ok: false, error: 'Voice reply failed.' });
        }
    });

    // ── POST /api/support/ticket — manual "talk to a human" ────────────────
    app.post('/api/support/ticket', async (req, res) => {
        try {
            const message = String(req.body?.message || '').trim().slice(0, 1500);
            if (!message) return res.status(400).json({ ok: false, error: 'Please describe your problem' });
            const doc = {
                id: 'TKT-' + Date.now().toString(36).toUpperCase(),
                subject: String(req.body?.subject || 'Customer request').slice(0, 120),
                message,
                contact: String(req.body?.contact || '').slice(0, 120),
                orderId: String(req.body?.orderId || '').slice(0, 40).toUpperCase(),
                language: String(req.body?.language || '').slice(0, 20),
                transcript: Array.isArray(req.body?.transcript) ? req.body.transcript.slice(-6) : [],
                status: 'Open',
                createdAt: new Date(),
            };
            await saveTicket(doc);
            sendTelegramMessage(
                `🆘 <b>New Support Ticket</b>\n🎫 <code>${doc.id}</code>\n` +
                (doc.orderId ? `📦 Order: <code>${doc.orderId}</code>\n` : '') +
                (doc.contact ? `📞 Contact: ${doc.contact}\n` : '') +
                `💬 ${doc.message.slice(0, 500)}`
            );
            res.json({ ok: true, ticketId: doc.id });
        } catch (e) {
            console.error('POST /api/support/ticket error:', e.message);
            res.status(500).json({ ok: false, error: 'Could not create ticket' });
        }
    });

    // ── Admin: list / close tickets ─────────────────────────────────────────
    app.get('/api/support/tickets', async (req, res) => {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
        res.json({ ok: true, tickets: await listTickets(limit) });
    });

    app.post('/api/support/tickets/:id/close', async (req, res) => {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
        const id = String(req.params.id || '').toUpperCase();
        try { await SupportTicket.updateOne({ id }, { $set: { status: 'Closed' } }); } catch (e) {}
        const m = ticketsMem.find(t => t.id === id);
        if (m) m.status = 'Closed';
        res.json({ ok: true });
    });

    // ── Tiny admin page for tickets (does not touch admin-panel.html) ──────
    app.get('/support-tickets', (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Support Tickets</title>
<style>
body{margin:0;background:#030712;color:#e5e7eb;font:14px/1.5 system-ui,sans-serif;padding:18px}
h1{font-size:18px;color:#fbbf24;margin:0 0 12px}
input,button{background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:8px;padding:8px 10px;font:inherit}
button{cursor:pointer}
.t{border:1px solid #1f2937;border-radius:12px;padding:12px;margin:10px 0;background:#0b1220}
.id{color:#fbbf24;font-weight:600}.mut{color:#9ca3af;font-size:12px}
.open{color:#34d399}.closed{color:#9ca3af}
</style></head><body>
<h1>🆘 Support Tickets</h1>
<div><input id="k" placeholder="Admin key" style="width:220px"> <button onclick="load()">Load</button></div>
<div id="out" class="mut" style="margin-top:12px">Enter your admin key and press Load.</div>
<script>
var K='';
async function load(){K=document.getElementById('k').value.trim();
 var r=await fetch('/api/support/tickets?adminKey='+encodeURIComponent(K));
 if(!r.ok){document.getElementById('out').textContent='Forbidden — wrong admin key.';return;}
 var d=await r.json();var h='';
 (d.tickets||[]).forEach(function(t){h+='<div class="t"><div><span class="id">'+t.id+'</span> '+
  '<span class="'+(t.status==='Closed'?'closed':'open')+'">'+(t.status||'Open')+'</span></div>'+
  '<div class="mut">'+(t.orderId?('Order '+t.orderId+' • '):'')+(t.contact||'no contact')+' • '+
  (t.createdAt?new Date(t.createdAt).toLocaleString():'')+'</div>'+
  '<div style="margin-top:6px;white-space:pre-wrap">'+String(t.message||'').replace(/[<>]/g,'')+'</div>'+
  (t.status==='Closed'?'':'<div style="margin-top:8px"><button onclick="close_(\\''+t.id+'\\')">Mark closed</button></div>')+
  '</div>';});
 document.getElementById('out').innerHTML=h||'No tickets yet.';}
async function close_(id){await fetch('/api/support/tickets/'+id+'/close?adminKey='+encodeURIComponent(K),{method:'POST'});load();}
</script></body></html>`);
    });

    console.log('🤖 AI Support Assistant: ' + (aiConfigured() ? 'ENABLED' : 'disabled (set SUPPORT_AI_KEY)'));
};
