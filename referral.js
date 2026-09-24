// ═══════════════════════════════════════════════════════════════════════════
//  REFERRAL / "EARN BY INVITE" MODULE
//  ---------------------------------------------------------------------------
//  Additive module for the existing Chinese Signal Bot server.
//  It does NOT create a second auth, payment or order system:
//    • Customer identity is derived from the EXISTING order contact fields
//      (email / WhatsApp / Telegram) — one referral profile per real customer.
//    • Commissions are only created from the EXISTING order confirmation flow.
//    • Dashboard access uses signed, expiring, single-use magic links.
//
//  Money safety: no multi-document transactions are required. Every balance
//  mutation is a single atomic conditional $inc, every commission is protected
//  by a unique index, and every movement is written to an immutable ledger.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const crypto = require('crypto');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* optional */ }

// ── helpers ────────────────────────────────────────────────────────────────
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes

function randomCode(len = 8) {
    let out = '';
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
}
function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}
function normEmail(v) {
    const s = String(v || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : '';
}
function normPhone(v) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length < 8) return '';
    return d.slice(-10); // last 10 digits — stable across +92 / 0092 / 03xx forms
}
function normTelegram(v) {
    const s = String(v || '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
    return /^[a-z0-9_]{3,64}$/.test(s) ? s : '';
}
function toAmount(v) {
    const n = Number(String(v == null ? '' : v).replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}
function safeStr(v, max = 200) {
    return String(v == null ? '' : v).trim().slice(0, max);
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = function initReferral(ctx) {
    const {
        app,            // express app
        mongoose,       // shared mongoose instance
        Order,          // existing Order model
        isAdmin,        // existing admin authorization check (server-side)
        isDbReady,      // () => boolean
        notifyAdmin,    // optional (text) => void   — existing Telegram notifier
        logger,
    } = ctx;

    const log = logger || console;

    // ───────────────────────────────────────────────────────────────────────
    //  SCHEMAS
    // ───────────────────────────────────────────────────────────────────────
    const profileSchema = new mongoose.Schema({
        id:            { type: String, required: true, unique: true },
        code:          { type: String, required: true, unique: true },
        fullName:      { type: String, default: '' },
        email:         { type: String, default: '' },
        emailNorm:     { type: String, default: '', index: true },
        whatsappNorm:  { type: String, default: '', index: true },
        telegramNorm:  { type: String, default: '', index: true },
        // referral relationship — set once, server-side only
        referredBy:    { type: String, default: '', index: true }, // profile id of direct inviter
        referredAt:    { type: Date,   default: null },
        // money (PKR)
        balance:       { type: Number, default: 0 },
        totalEarned:   { type: Number, default: 0 },
        totalWithdrawn:{ type: Number, default: 0 },
        blocked:       { type: Boolean, default: false }, // blocked from referral earnings
        createdAt:     { type: Date,   default: Date.now },
    });

    const commissionSchema = new mongoose.Schema({
        id:            { type: String, required: true, unique: true },
        orderId:       { type: String, required: true, index: true },
        buyerId:       { type: String, required: true, index: true },  // profile that purchased
        earnerId:      { type: String, required: true, index: true },  // profile that earns
        level:         { type: Number, required: true },               // 1..4
        percent:       { type: Number, required: true },
        baseAmountPKR: { type: Number, required: true },
        amountPKR:     { type: Number, required: true },
        status:        { type: String, default: 'confirmed', index: true }, // confirmed | reversed
        createdAt:     { type: Date,   default: Date.now },
        reversedAt:    { type: Date,   default: null },
    });
    // IDEMPOTENCY: one commission per order per level, ever.
    commissionSchema.index({ orderId: 1, level: 1 }, { unique: true });

    const withdrawalSchema = new mongoose.Schema({
        id:          { type: String, required: true, unique: true },
        profileId:   { type: String, required: true, index: true },
        amountPKR:   { type: Number, required: true },
        method:      { type: String, required: true },   // easypaisa | jazzcash | usdt_trc20
        amountUSDT:  { type: Number, default: 0 },
        accountName: { type: String, default: '' },
        accountRef:  { type: String, default: '' },      // number / TRC20 address
        status:      { type: String, default: 'Pending', index: true }, // Pending|Approved|Rejected
        adminNote:   { type: String, default: '' },
        createdAt:   { type: Date,   default: Date.now },
        decidedAt:   { type: Date,   default: null },
        decidedBy:   { type: String, default: '' },
    });

    // Immutable audit trail for every single balance movement.
    const ledgerSchema = new mongoose.Schema({
        id:            { type: String, required: true, unique: true },
        profileId:     { type: String, required: true, index: true },
        type:          { type: String, required: true }, // commission | withdrawal_hold | withdrawal_release | withdrawal_paid | admin_adjust
        amountPKR:     { type: Number, required: true }, // signed
        balanceBefore: { type: Number, required: true },
        balanceAfter:  { type: Number, required: true },
        refType:       { type: String, default: '' },
        refId:         { type: String, default: '' },
        reason:        { type: String, default: '' },
        actor:         { type: String, default: 'system' },
        createdAt:     { type: Date,   default: Date.now },
    });

    const settingsSchema = new mongoose.Schema({
        _id:            { type: String, default: 'referral' },
        enabled:        { type: Boolean, default: true },
        levels:         { type: [Number], default: [10, 5, 3, 2] }, // L1..L4 percent
        minEasypaisa:   { type: Number, default: 300 },
        minJazzcash:    { type: Number, default: 300 },
        minUsdtPKR:     { type: Number, default: 1400 },
        usdtRatePKR:    { type: Number, default: 280 },
        methodsEnabled: { type: [String], default: ['easypaisa', 'jazzcash', 'usdt_trc20'] },
        popup: {
            active:      { type: Boolean, default: false },
            title:       { type: String, default: 'Earn with Chinese Signal Bot' },
            description: { type: String, default: 'Invite your friends and earn commission on every plan they buy.' },
            ctaLabel:    { type: String, default: 'Start earning' },
            ctaUrl:      { type: String, default: '#earn-by-invite' },
            delaySec:    { type: Number, default: 5 },
            cooldownHrs: { type: Number, default: 24 },
            maxPerUser:  { type: Number, default: 3 },
        },
        updatedAt:      { type: Date, default: Date.now },
    }, { _id: false });

    // Single-use, expiring dashboard access tokens (hashed at rest).
    const magicSchema = new mongoose.Schema({
        tokenHash: { type: String, required: true, unique: true },
        profileId: { type: String, required: true, index: true },
        expiresAt: { type: Date,   required: true },
        usedAt:    { type: Date,   default: null },
        createdAt: { type: Date,   default: Date.now },
    });

    // Server-only HMAC key for signing attribution cookies. Never leaves the server.
    const keyStoreSchema = new mongoose.Schema({
        _id:   { type: String, default: 'referral_hmac' },
        value: { type: String, required: true },
    }, { _id: false });

    const RefProfile    = mongoose.models.RefProfile    || mongoose.model('RefProfile', profileSchema);
    const RefCommission = mongoose.models.RefCommission || mongoose.model('RefCommission', commissionSchema);
    const RefWithdrawal = mongoose.models.RefWithdrawal || mongoose.model('RefWithdrawal', withdrawalSchema);
    const RefLedger     = mongoose.models.RefLedger     || mongoose.model('RefLedger', ledgerSchema);
    const RefSettings   = mongoose.models.RefSettings   || mongoose.model('RefSettings', settingsSchema);
    const RefMagic      = mongoose.models.RefMagic      || mongoose.model('RefMagic', magicSchema);
    const RefKeyStore   = mongoose.models.RefKeyStore   || mongoose.model('RefKeyStore', keyStoreSchema);

    // ───────────────────────────────────────────────────────────────────────
    //  SETTINGS
    // ───────────────────────────────────────────────────────────────────────
    let _settingsCache = null;
    let _settingsAt = 0;
    async function getSettings(force) {
        if (!force && _settingsCache && Date.now() - _settingsAt < 15000) return _settingsCache;
        let doc = await RefSettings.findById('referral').lean();
        if (!doc) {
            await RefSettings.updateOne({ _id: 'referral' }, { $setOnInsert: { _id: 'referral' } }, { upsert: true });
            doc = await RefSettings.findById('referral').lean();
        }
        _settingsCache = doc;
        _settingsAt = Date.now();
        return doc;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  HMAC KEY (attribution cookie signing)
    // ───────────────────────────────────────────────────────────────────────
    let _hmacKey = null;
    async function getHmacKey() {
        if (_hmacKey) return _hmacKey;
        if (process.env.REFERRAL_SECRET) { _hmacKey = process.env.REFERRAL_SECRET; return _hmacKey; }
        let doc = await RefKeyStore.findById('referral_hmac').lean();
        if (!doc) {
            const value = crypto.randomBytes(32).toString('hex');
            await RefKeyStore.updateOne({ _id: 'referral_hmac' }, { $setOnInsert: { value } }, { upsert: true });
            doc = await RefKeyStore.findById('referral_hmac').lean();
        }
        _hmacKey = doc.value;
        return _hmacKey;
    }
    async function signAttribution(code) {
        const exp = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
        const payload = `${code}.${exp}`;
        const sig = crypto.createHmac('sha256', await getHmacKey()).update(payload).digest('hex').slice(0, 32);
        return `${payload}.${sig}`;
    }
    async function verifyAttribution(value) {
        const parts = String(value || '').split('.');
        if (parts.length !== 3) return '';
        const [code, exp, sig] = parts;
        if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return '';
        const expected = crypto.createHmac('sha256', await getHmacKey()).update(`${code}.${exp}`).digest('hex').slice(0, 32);
        const a = Buffer.from(sig), b = Buffer.from(expected);
        if (a.length !== b.length) return '';
        return crypto.timingSafeEqual(a, b) ? code : '';
    }
    function readCookie(req, name) {
        const raw = req.headers.cookie || '';
        for (const part of raw.split(';')) {
            const idx = part.indexOf('=');
            if (idx < 0) continue;
            if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
        }
        return '';
    }

    // ───────────────────────────────────────────────────────────────────────
    //  PROFILE RESOLUTION (one profile per real customer, never duplicated)
    // ───────────────────────────────────────────────────────────────────────
    async function createUniqueCode() {
        for (let i = 0; i < 12; i++) {
            const code = 'CS' + randomCode(6);
            const clash = await RefProfile.exists({ code });
            if (!clash) return code;
        }
        return 'CS' + randomCode(10);
    }

    /**
     * Find (or create) the single referral profile belonging to a customer
     * contact set. Existing profiles are enriched with newly-seen contacts so
     * the same human never ends up with two profiles.
     */
    async function resolveProfile(contact, { create = true } = {}) {
        const emailNorm    = normEmail(contact.email);
        const whatsappNorm = normPhone(contact.whatsapp);
        const telegramNorm = normTelegram(contact.telegram);
        if (!emailNorm && !whatsappNorm && !telegramNorm) return null;

        const or = [];
        if (emailNorm)    or.push({ emailNorm });
        if (whatsappNorm) or.push({ whatsappNorm });
        if (telegramNorm) or.push({ telegramNorm });

        let profile = await RefProfile.findOne({ $or: or });
        if (!profile) {
            if (!create) return null;
            profile = await RefProfile.create({
                id:   newId('rp'),
                code: await createUniqueCode(),
                fullName: safeStr(contact.fullName, 120),
                email: emailNorm,
                emailNorm, whatsappNorm, telegramNorm,
            });
            return profile;
        }
        // enrich missing contact identifiers (never overwrite an existing one)
        const patch = {};
        if (emailNorm    && !profile.emailNorm)    { patch.emailNorm = emailNorm; patch.email = emailNorm; }
        if (whatsappNorm && !profile.whatsappNorm) patch.whatsappNorm = whatsappNorm;
        if (telegramNorm && !profile.telegramNorm) patch.telegramNorm = telegramNorm;
        if (!profile.fullName && contact.fullName) patch.fullName = safeStr(contact.fullName, 120);
        if (Object.keys(patch).length) {
            await RefProfile.updateOne({ id: profile.id }, { $set: patch });
            Object.assign(profile, patch);
        }
        return profile;
    }

    /** Link a buyer to their inviter. Runs once per profile, server-side only. */
    async function attachReferrer(buyer, inviterCode) {
        if (!inviterCode || buyer.referredBy) return false;
        const inviter = await RefProfile.findOne({ code: String(inviterCode).toUpperCase().trim() });
        if (!inviter) return false;
        if (inviter.id === buyer.id) return false;                       // self-referral
        if (inviter.blocked) return false;
        // loop protection: inviter must not already sit below the buyer
        let cursor = inviter, hops = 0;
        while (cursor && cursor.referredBy && hops < 10) {
            if (cursor.referredBy === buyer.id) return false;
            cursor = await RefProfile.findOne({ id: cursor.referredBy });
            hops++;
        }
        // conditional update → safe against concurrent requests
        const res = await RefProfile.updateOne(
            { id: buyer.id, $or: [{ referredBy: '' }, { referredBy: null }] },
            { $set: { referredBy: inviter.id, referredAt: new Date() } }
        );
        if (res.modifiedCount) { buyer.referredBy = inviter.id; return true; }
        return false;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  BALANCE MOVEMENTS (atomic + ledgered)
    // ───────────────────────────────────────────────────────────────────────
    async function credit(profileId, amount, entry) {
        if (!(amount > 0)) return null;
        const before = await RefProfile.findOneAndUpdate(
            { id: profileId },
            { $inc: { balance: amount, totalEarned: entry.countsAsEarned === false ? 0 : amount } },
            { new: false }
        );
        if (!before) return null;
        await RefLedger.create({
            id: newId('lg'), profileId, type: entry.type, amountPKR: amount,
            balanceBefore: before.balance, balanceAfter: before.balance + amount,
            refType: entry.refType || '', refId: entry.refId || '',
            reason: safeStr(entry.reason, 500), actor: entry.actor || 'system',
        });
        return before.balance + amount;
    }

    /** Conditional debit — cannot overdraw even under concurrent requests. */
    async function debit(profileId, amount, entry) {
        if (!(amount > 0)) return null;
        const before = await RefProfile.findOneAndUpdate(
            { id: profileId, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: false }
        );
        if (!before) return null; // insufficient balance
        await RefLedger.create({
            id: newId('lg'), profileId, type: entry.type, amountPKR: -amount,
            balanceBefore: before.balance, balanceAfter: before.balance - amount,
            refType: entry.refType || '', refId: entry.refId || '',
            reason: safeStr(entry.reason, 500), actor: entry.actor || 'system',
        });
        return before.balance - amount;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  COMMISSION CREATION — called ONLY from the existing order confirmation
    // ───────────────────────────────────────────────────────────────────────
    const CONFIRMED_STATUSES = ['approved', 'confirmed', 'paid', 'completed'];

    async function onOrderConfirmed(order) {
        try {
            if (!isDbReady || !isDbReady()) return;
            const s = await getSettings();
            if (!s.enabled) return;
            if (!order || !order.id) return;
            if (!CONFIRMED_STATUSES.includes(String(order.status || '').toLowerCase())) return;

            const base = toAmount(order.finalPricePKR) || toAmount(order.planPricePKR);
            if (!base) return; // nothing eligible to pay a percentage of

            const buyer = await resolveProfile({
                email: order.email, whatsapp: order.whatsapp,
                telegram: order.telegram, fullName: order.fullName,
            });
            if (!buyer) return;

            // Attribution captured at order time (validated server-side then).
            if (!buyer.referredBy && order.referralCode) {
                await attachReferrer(buyer, order.referralCode);
            }
            if (!buyer.referredBy) return;

            const levels = Array.isArray(s.levels) && s.levels.length === 4 ? s.levels : [10, 5, 3, 2];
            let currentId = buyer.referredBy;

            for (let level = 1; level <= 4 && currentId; level++) {
                const earner = await RefProfile.findOne({ id: currentId });
                if (!earner) break;
                const percent = Number(levels[level - 1]) || 0;
                const next = earner.referredBy || '';

                if (percent > 0 && !earner.blocked && earner.id !== buyer.id) {
                    const amount = Math.round(base * percent) / 100;
                    if (amount > 0) {
                        try {
                            // Unique (orderId, level) index makes this exactly-once,
                            // even on duplicate payment callbacks or retries.
                            await RefCommission.create({
                                id: newId('rc'), orderId: order.id, buyerId: buyer.id,
                                earnerId: earner.id, level, percent,
                                baseAmountPKR: base, amountPKR: amount, status: 'confirmed',
                            });
                            await credit(earner.id, amount, {
                                type: 'commission', refType: 'order', refId: order.id,
                                reason: `Level ${level} commission (${percent}%) on order ${order.id}`,
                            });
                        } catch (e) {
                            if (e && e.code === 11000) {
                                // already paid for this order+level — nothing to do
                            } else { throw e; }
                        }
                    }
                }
                currentId = next;
            }
        } catch (e) {
            log.error && log.error('[referral] onOrderConfirmed failed:', e.message);
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  MAGIC LINK ACCESS (no passwords, no order-id-as-credential)
    // ───────────────────────────────────────────────────────────────────────
    const MAGIC_TTL_MS = 30 * 60 * 1000;

    async function issueMagicLink(profileId) {
        const token = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await RefMagic.create({ tokenHash, profileId, expiresAt: new Date(Date.now() + MAGIC_TTL_MS) });
        return token;
    }
    // Consumed once, then swapped for a short-lived in-memory session token.
    const refSessions = new Map(); // token -> { profileId, expiresAt }
    const REF_SESSION_TTL = 2 * 60 * 60 * 1000;

    function issueRefSession(profileId) {
        const t = 'rs_' + crypto.randomBytes(24).toString('hex');
        refSessions.set(t, { profileId, expiresAt: Date.now() + REF_SESSION_TTL });
        if (refSessions.size > 2000) {
            const now = Date.now();
            for (const [k, v] of refSessions) if (v.expiresAt < now) refSessions.delete(k);
        }
        return t;
    }
    function sessionProfileId(req) {
        const t = (req.headers['x-ref-session'] || req.query.session || req.body?.session || '').toString();
        const rec = refSessions.get(t);
        if (!rec) return '';
        if (rec.expiresAt < Date.now()) { refSessions.delete(t); return ''; }
        return rec.profileId;
    }
    async function requireProfile(req, res) {
        const id = sessionProfileId(req);
        if (!id) { res.status(401).json({ error: 'Sign in with your access link first.' }); return null; }
        const p = await RefProfile.findOne({ id });
        if (!p) { res.status(401).json({ error: 'Session expired.' }); return null; }
        return p;
    }

    async function sendMagicEmail(to, link) {
        const user = process.env.DELIVERY_EMAIL || process.env.OTP_EMAIL || '';
        const pass = process.env.DELIVERY_EMAIL_PASSWORD || process.env.OTP_EMAIL_PASSWORD || '';
        if (!nodemailer || !user || !pass) return false;
        const transport = nodemailer.createTransport({
            host: process.env.DELIVERY_SMTP_HOST || 'smtp.gmail.com',
            port: Number(process.env.DELIVERY_SMTP_PORT || 465),
            secure: String(process.env.DELIVERY_SMTP_SECURE || 'true') !== 'false',
            auth: { user, pass },
        });
        await transport.sendMail({
            from: process.env.DELIVERY_EMAIL_FROM || user,
            to,
            subject: 'Your Earn by Invite access link',
            text: `Open your referral dashboard with this link (valid for 30 minutes, single use):\n\n${link}\n\nIf you did not request it, ignore this email.`,
        });
        return true;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ───────────────────────────────────────────────────────────────────────
    const dbGuard = (req, res, next) => {
        if (!isDbReady || !isDbReady()) return res.status(503).json({ error: 'Service temporarily unavailable.' });
        next();
    };

    // Public settings for the storefront (no secrets, no internals).
    app.get('/api/referral/config', dbGuard, async (req, res) => {
        try {
            const s = await getSettings();
            res.json({
                enabled: !!s.enabled,
                levels: s.levels,
                minimums: { easypaisa: s.minEasypaisa, jazzcash: s.minJazzcash, usdt_trc20: s.minUsdtPKR },
                usdtRatePKR: s.usdtRatePKR,
                methods: s.methodsEnabled,
                popup: s.popup,
            });
        } catch (e) { res.status(500).json({ error: 'Failed to load settings' }); }
    });

    // Attribution: the visitor opened someone's referral link.
    // The code is validated server-side and stored in a signed httpOnly cookie,
    // so client-side storage alone is never trusted.
    app.post('/api/referral/attribute', dbGuard, async (req, res) => {
        try {
            const s = await getSettings();
            if (!s.enabled) return res.json({ ok: false });
            const code = safeStr(req.body?.code, 32).toUpperCase();
            if (!code) return res.status(400).json({ error: 'Missing code' });
            const inviter = await RefProfile.findOne({ code }).lean();
            if (!inviter || inviter.blocked) return res.status(404).json({ error: 'Invalid referral code' });
            const signed = await signAttribution(inviter.code);
            res.setHeader('Set-Cookie',
                `csai_ref=${encodeURIComponent(signed)}; Max-Age=${30 * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax; Secure`);
            res.json({ ok: true, invitedBy: inviter.fullName ? inviter.fullName.split(' ')[0] : 'a friend' });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    /**
     * Called by the existing order endpoint. Returns the referral code that
     * should be stored on the order, or '' when nothing valid is attributed.
     * Client-supplied codes are accepted only after server-side validation and
     * are always outranked by the signed cookie.
     */
    async function resolveAttribution(req, clientCode) {
        try {
            if (!isDbReady || !isDbReady()) return '';
            const s = await getSettings();
            if (!s.enabled) return '';
            const cookieCode = await verifyAttribution(readCookie(req, 'csai_ref'));
            const code = (cookieCode || safeStr(clientCode, 32)).toUpperCase();
            if (!code) return '';
            const inviter = await RefProfile.findOne({ code }).lean();
            if (!inviter || inviter.blocked) return '';
            return inviter.code;
        } catch (e) { return ''; }
    }

    /** Is this string a referral code? Used to extend the existing promo box. */
    async function lookupReferralCode(code) {
        if (!isDbReady || !isDbReady()) return null;
        const s = await getSettings();
        if (!s.enabled) return null;
        const c = safeStr(code, 32).toUpperCase();
        if (!c) return null;
        const p = await RefProfile.findOne({ code: c }).lean();
        if (!p || p.blocked) return null;
        return { code: p.code, ownerName: p.fullName ? p.fullName.split(' ')[0] : '' };
    }

    // Request a dashboard access link.
    app.post('/api/referral/request-link', dbGuard, async (req, res) => {
        try {
            const email = normEmail(req.body?.email);
            const whatsapp = normPhone(req.body?.whatsapp);
            const telegram = normTelegram(req.body?.telegram);
            if (!email && !whatsapp && !telegram) return res.status(400).json({ error: 'Enter your email, WhatsApp number or Telegram username.' });

            const profile = await resolveProfile({ email, whatsapp, telegram }, { create: false });
            // Never reveal whether a profile exists.
            const generic = { ok: true, message: 'If we have a matching customer record, an access link has been sent.' };
            if (!profile) return res.json(generic);

            const token = await issueMagicLink(profile.id);
            const base = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
            const link = `${base}/?refLogin=${token}`;

            if (profile.emailNorm) {
                await sendMagicEmail(profile.emailNorm, link).catch(() => {});
                return res.json(generic);
            }
            // No email on file → hand the link to human support to deliver.
            if (notifyAdmin) {
                notifyAdmin(`🔗 Referral dashboard link requested by ${profile.whatsappNorm || '@' + profile.telegramNorm}. Send them: ${link}`);
            }
            return res.json({ ...generic, message: 'Our support team will send you the access link on WhatsApp/Telegram shortly.' });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    // Exchange a magic token for a short-lived session (single use).
    app.post('/api/referral/consume-link', dbGuard, async (req, res) => {
        try {
            const token = safeStr(req.body?.token, 200);
            if (!token) return res.status(400).json({ error: 'Missing token' });
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const rec = await RefMagic.findOneAndUpdate(
                { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
                { $set: { usedAt: new Date() } }, { new: true }
            );
            if (!rec) return res.status(401).json({ error: 'This link has expired or was already used.' });
            res.json({ ok: true, session: issueRefSession(rec.profileId) });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    // "Earn by Invite" dashboard summary.
    app.get('/api/referral/me', dbGuard, async (req, res) => {
        const p = await requireProfile(req, res); if (!p) return;
        try {
            const s = await getSettings();
            const base = (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '');
            const [invited, commissions, withdrawals] = await Promise.all([
                RefProfile.find({ referredBy: p.id }).select('id fullName createdAt').lean(),
                RefCommission.find({ earnerId: p.id }).sort({ createdAt: -1 }).limit(200).lean(),
                RefWithdrawal.find({ profileId: p.id }).sort({ createdAt: -1 }).limit(50).lean(),
            ]);
            const buyerIds = new Set(commissions.map(c => c.buyerId));
            res.json({
                code: p.code,
                link: `${base}/?ref=${p.code}`,
                fullName: p.fullName,
                blocked: !!p.blocked,
                balance: p.balance,
                totalEarned: p.totalEarned,
                totalWithdrawn: p.totalWithdrawn,
                totalInvited: invited.length,
                invitedWhoPurchased: buyerIds.size,
                minimums: { easypaisa: s.minEasypaisa, jazzcash: s.minJazzcash, usdt_trc20: s.minUsdtPKR },
                usdtRatePKR: s.usdtRatePKR,
                methods: s.methodsEnabled,
                commissions: commissions.map(c => ({
                    level: c.level, percent: c.percent, amountPKR: c.amountPKR,
                    baseAmountPKR: c.baseAmountPKR, status: c.status, createdAt: c.createdAt,
                })),
                withdrawals: withdrawals.map(w => ({
                    id: w.id, amountPKR: w.amountPKR, amountUSDT: w.amountUSDT, method: w.method,
                    status: w.status, adminNote: w.adminNote, createdAt: w.createdAt, decidedAt: w.decidedAt,
                })),
            });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    // Referral details page — minimum information about invited customers only.
    app.get('/api/referral/details', dbGuard, async (req, res) => {
        const p = await requireProfile(req, res); if (!p) return;
        try {
            const invited = await RefProfile.find({ referredBy: p.id }).select('id fullName createdAt').lean();
            const commissions = await RefCommission.find({ earnerId: p.id }).sort({ createdAt: -1 }).limit(300).lean();
            const orderIds = [...new Set(commissions.map(c => c.orderId))];
            const orders = orderIds.length
                ? await Order.find({ id: { $in: orderIds } }).select('id planLabel planKey').lean()
                : [];
            const planById = Object.fromEntries(orders.map(o => [o.id, o.planLabel || o.planKey || '—']));
            const nameById = Object.fromEntries(invited.map(i => [i.id, maskName(i.fullName)]));
            res.json({
                totalInvited: invited.length,
                invited: invited.map(i => ({ name: maskName(i.fullName), joinedAt: i.createdAt })),
                earnings: commissions.map(c => ({
                    buyer: nameById[c.buyerId] || 'Customer',
                    plan: planById[c.orderId] || '—',
                    amountPKR: c.amountPKR,
                    baseAmountPKR: c.baseAmountPKR,
                    level: c.level,
                    status: c.status,
                    date: c.createdAt,
                })),
            });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    function maskName(name) {
        const n = safeStr(name, 60);
        if (!n) return 'Customer';
        const first = n.split(/\s+/)[0];
        return first.length <= 2 ? first : first.slice(0, 2) + '•'.repeat(Math.min(5, first.length - 2));
    }

    // ── Withdrawals ────────────────────────────────────────────────────────
    const METHOD_LABELS = { easypaisa: 'Easypaisa', jazzcash: 'JazzCash', usdt_trc20: 'USDT (TRC20)' };

    app.post('/api/referral/withdraw', dbGuard, async (req, res) => {
        const p = await requireProfile(req, res); if (!p) return;
        try {
            const s = await getSettings();
            if (!s.enabled) return res.status(403).json({ error: 'Referral programme is currently paused.' });
            if (p.blocked) return res.status(403).json({ error: 'Withdrawals are disabled for this account.' });

            const method = safeStr(req.body?.method, 20).toLowerCase();
            if (!METHOD_LABELS[method] || !s.methodsEnabled.includes(method)) {
                return res.status(400).json({ error: 'Choose a valid withdrawal method.' });
            }
            const amount = toAmount(req.body?.amountPKR);
            if (!amount) return res.status(400).json({ error: 'Enter a valid amount.' });

            const min = method === 'usdt_trc20' ? s.minUsdtPKR : (method === 'jazzcash' ? s.minJazzcash : s.minEasypaisa);
            if (amount < min) return res.status(400).json({ error: `Minimum withdrawal for ${METHOD_LABELS[method]} is PKR ${min}.` });

            const accountName = safeStr(req.body?.accountName, 80);
            const accountRef  = safeStr(req.body?.accountRef, 120);
            if (!accountRef) return res.status(400).json({ error: 'Enter your account number / wallet address.' });
            if (method === 'usdt_trc20' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(accountRef)) {
                return res.status(400).json({ error: 'Enter a valid USDT TRC20 address.' });
            }
            if (method !== 'usdt_trc20' && normPhone(accountRef).length < 10) {
                return res.status(400).json({ error: 'Enter a valid mobile account number.' });
            }
            if (method !== 'usdt_trc20' && !accountName) {
                return res.status(400).json({ error: 'Enter the account holder name.' });
            }

            // Duplicate / spam prevention: one open request at a time.
            const open = await RefWithdrawal.findOne({ profileId: p.id, status: 'Pending' }).lean();
            if (open) return res.status(409).json({ error: 'You already have a pending withdrawal request.' });

            const id = newId('rw');
            // Atomic hold — fails safely if the balance is not there.
            const after = await debit(p.id, amount, {
                type: 'withdrawal_hold', refType: 'withdrawal', refId: id,
                reason: `Withdrawal request via ${METHOD_LABELS[method]}`, actor: 'customer',
            });
            if (after === null) return res.status(400).json({ error: 'Insufficient balance.' });

            const amountUSDT = method === 'usdt_trc20'
                ? Math.round((amount / (s.usdtRatePKR || 280)) * 100) / 100 : 0;

            await RefWithdrawal.create({
                id, profileId: p.id, amountPKR: amount, method, amountUSDT,
                accountName, accountRef, status: 'Pending',
            });
            if (notifyAdmin) notifyAdmin(`💸 New referral withdrawal request: PKR ${amount} via ${METHOD_LABELS[method]}`);
            res.json({ ok: true, id, balance: after, amountUSDT });
        } catch (e) { res.status(500).json({ error: 'Failed to create withdrawal request.' }); }
    });

    // ───────────────────────────────────────────────────────────────────────
    //  ADMIN API — protected by the EXISTING admin authorization, server-side
    // ───────────────────────────────────────────────────────────────────────
    const adminGuard = (req, res, next) => {
        if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
        if (!isDbReady || !isDbReady()) return res.status(503).json({ error: 'Database unavailable' });
        next();
    };

    app.get('/api/admin/referral/settings', adminGuard, async (req, res) => {
        res.json(await getSettings(true));
    });

    app.put('/api/admin/referral/settings', adminGuard, async (req, res) => {
        try {
            const b = req.body || {};
            const patch = { updatedAt: new Date() };
            if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
            if (Array.isArray(b.levels) && b.levels.length === 4) {
                const lv = b.levels.map(n => Math.max(0, Math.min(100, Number(n) || 0)));
                if (lv.reduce((a, c) => a + c, 0) > 100) return res.status(400).json({ error: 'Total commission cannot exceed 100%.' });
                patch.levels = lv;
            }
            for (const [key, field] of [['minEasypaisa', 'minEasypaisa'], ['minJazzcash', 'minJazzcash'], ['minUsdtPKR', 'minUsdtPKR'], ['usdtRatePKR', 'usdtRatePKR']]) {
                if (b[key] != null) patch[field] = Math.max(0, Number(b[key]) || 0);
            }
            if (Array.isArray(b.methodsEnabled)) {
                patch.methodsEnabled = b.methodsEnabled.filter(m => METHOD_LABELS[m]);
            }
            if (b.popup && typeof b.popup === 'object') {
                patch.popup = {
                    active:      !!b.popup.active,
                    title:       safeStr(b.popup.title, 120),
                    description: safeStr(b.popup.description, 400),
                    ctaLabel:    safeStr(b.popup.ctaLabel, 40) || 'Start earning',
                    ctaUrl:      safeStr(b.popup.ctaUrl, 300) || '#earn-by-invite',
                    delaySec:    Math.max(0, Math.min(120, Number(b.popup.delaySec) || 5)),
                    cooldownHrs: Math.max(1, Math.min(720, Number(b.popup.cooldownHrs) || 24)),
                    maxPerUser:  Math.max(1, Math.min(50, Number(b.popup.maxPerUser) || 3)),
                };
            }
            await RefSettings.updateOne({ _id: 'referral' }, { $set: patch }, { upsert: true });
            res.json(await getSettings(true));
        } catch (e) { res.status(500).json({ error: 'Failed to save settings' }); }
    });

    app.get('/api/admin/referral/profiles', adminGuard, async (req, res) => {
        try {
            const q = safeStr(req.query.q, 80).toLowerCase();
            const filter = q ? {
                $or: [
                    { code: q.toUpperCase() }, { emailNorm: new RegExp(escapeRe(q)) },
                    { whatsappNorm: new RegExp(escapeRe(q)) }, { telegramNorm: new RegExp(escapeRe(q)) },
                    { fullName: new RegExp(escapeRe(q), 'i') },
                ],
            } : {};
            const rows = await RefProfile.find(filter).sort({ createdAt: -1 }).limit(300).lean();
            const byId = Object.fromEntries(rows.map(r => [r.id, r]));
            const counts = await RefProfile.aggregate([{ $match: { referredBy: { $ne: '' } } }, { $group: { _id: '$referredBy', n: { $sum: 1 } } }]);
            const countMap = Object.fromEntries(counts.map(c => [c._id, c.n]));
            res.json(rows.map(r => ({
                id: r.id, code: r.code, fullName: r.fullName,
                email: r.emailNorm, whatsapp: r.whatsappNorm, telegram: r.telegramNorm,
                referredByCode: byId[r.referredBy]?.code || '',
                invited: countMap[r.id] || 0,
                balance: r.balance, totalEarned: r.totalEarned, totalWithdrawn: r.totalWithdrawn,
                blocked: r.blocked, createdAt: r.createdAt,
            })));
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    app.get('/api/admin/referral/commissions', adminGuard, async (req, res) => {
        try {
            const rows = await RefCommission.find({}).sort({ createdAt: -1 }).limit(400).lean();
            const ids = [...new Set(rows.flatMap(r => [r.earnerId, r.buyerId]))];
            const profiles = await RefProfile.find({ id: { $in: ids } }).select('id code fullName').lean();
            const pm = Object.fromEntries(profiles.map(p => [p.id, p]));
            res.json(rows.map(r => ({
                id: r.id, orderId: r.orderId, level: r.level, percent: r.percent,
                amountPKR: r.amountPKR, baseAmountPKR: r.baseAmountPKR, status: r.status,
                earner: pm[r.earnerId]?.code || r.earnerId,
                earnerName: pm[r.earnerId]?.fullName || '',
                buyerName: pm[r.buyerId]?.fullName || '',
                createdAt: r.createdAt,
            })));
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    app.get('/api/admin/referral/withdrawals', adminGuard, async (req, res) => {
        try {
            const status = safeStr(req.query.status, 20);
            const rows = await RefWithdrawal.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(300).lean();
            const profiles = await RefProfile.find({ id: { $in: rows.map(r => r.profileId) } }).select('id code fullName whatsappNorm').lean();
            const pm = Object.fromEntries(profiles.map(p => [p.id, p]));
            res.json(rows.map(r => ({
                ...r, _id: undefined,
                code: pm[r.profileId]?.code || '',
                fullName: pm[r.profileId]?.fullName || '',
            })));
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    // Approve / reject — exactly once, with a safe reversal on rejection.
    app.post('/api/admin/referral/withdrawals/:id/decide', adminGuard, async (req, res) => {
        try {
            const decision = safeStr(req.body?.decision, 12).toLowerCase(); // approve | reject
            const note = safeStr(req.body?.note, 400);
            if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
            if (decision === 'reject' && !note) return res.status(400).json({ error: 'A reason is required to reject a withdrawal.' });

            // Conditional status change → a double click can never pay twice.
            const w = await RefWithdrawal.findOneAndUpdate(
                { id: req.params.id, status: 'Pending' },
                {
                    $set: {
                        status: decision === 'approve' ? 'Approved' : 'Rejected',
                        adminNote: note, decidedAt: new Date(), decidedBy: 'admin',
                    },
                },
                { new: true }
            );
            if (!w) return res.status(409).json({ error: 'This request was already processed.' });

            if (decision === 'approve') {
                // Amount was already held at request time — record the payout.
                await RefProfile.updateOne({ id: w.profileId }, { $inc: { totalWithdrawn: w.amountPKR } });
                const p = await RefProfile.findOne({ id: w.profileId }).lean();
                await RefLedger.create({
                    id: newId('lg'), profileId: w.profileId, type: 'withdrawal_paid', amountPKR: 0,
                    balanceBefore: p ? p.balance : 0, balanceAfter: p ? p.balance : 0,
                    refType: 'withdrawal', refId: w.id, reason: note || 'Withdrawal approved', actor: 'admin',
                });
            } else {
                // Release the held amount back — exactly once, because the status
                // transition above already succeeded atomically.
                await credit(w.profileId, w.amountPKR, {
                    type: 'withdrawal_release', refType: 'withdrawal', refId: w.id,
                    reason: `Withdrawal rejected: ${note}`, actor: 'admin', countsAsEarned: false,
                });
            }
            res.json({ ok: true, status: w.status });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    // Manual balance adjustment — reason required, immutable audit record.
    app.post('/api/admin/referral/profiles/:id/adjust', adminGuard, async (req, res) => {
        try {
            const amount = Number(req.body?.amountPKR);
            const reason = safeStr(req.body?.reason, 500);
            if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Enter a non-zero amount.' });
            if (!reason) return res.status(400).json({ error: 'A reason is required for every manual adjustment.' });
            const admin = safeStr(req.body?.adminName, 60) || 'admin';

            const result = amount > 0
                ? await credit(req.params.id, amount, { type: 'admin_adjust', reason, actor: admin, countsAsEarned: false })
                : await debit(req.params.id, Math.abs(amount), { type: 'admin_adjust', reason, actor: admin });
            if (result === null) return res.status(400).json({ error: 'Profile not found or insufficient balance.' });
            res.json({ ok: true, balance: result });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    app.post('/api/admin/referral/profiles/:id/block', adminGuard, async (req, res) => {
        try {
            const blocked = !!req.body?.blocked;
            const r = await RefProfile.updateOne({ id: req.params.id }, { $set: { blocked } });
            if (!r.matchedCount) return res.status(404).json({ error: 'Not found' });
            res.json({ ok: true, blocked });
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    app.get('/api/admin/referral/ledger/:profileId', adminGuard, async (req, res) => {
        try {
            const rows = await RefLedger.find({ profileId: req.params.profileId }).sort({ createdAt: -1 }).limit(300).lean();
            res.json(rows.map(r => ({ ...r, _id: undefined })));
        } catch (e) { res.status(500).json({ error: 'Failed' }); }
    });

    function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    log.info ? log.info('[referral] module ready') : console.log('✅ Referral module ready');

    return {
        onOrderConfirmed,
        resolveAttribution,
        lookupReferralCode,
        resolveProfile,
        getSettings,
        models: { RefProfile, RefCommission, RefWithdrawal, RefLedger, RefSettings },
    };
};
