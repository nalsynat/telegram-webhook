// =============================================================
// KH VOICE JOB — Webhook Relay Server
// =============================================================
// PURPOSE:
//   Render runs this Express server 24/7.
//   Telegram sends updates here (fast, always-on).
//   This server forwards to Google Apps Script (GAS).
//   GAS processes the update and talks to Google Sheets.
//
// WHY THIS ARCHITECTURE:
//   GAS URLs can change on redeploy (breaking webhook).
//   GAS has cold-start delays causing Telegram timeouts.
//   This server stays at a fixed Render URL forever.
//   It responds to Telegram in <50ms, then forwards to GAS.
//
// DOUBLE-CLICK / DUPLICATE PREVENTION (3 layers):
//   Layer 1: In-memory Map in this server (0ms, resets on restart)
//   Layer 2: GAS CacheService (fast, 10-min TTL)
//   Layer 3: GAS PropertiesService (persistent, 24h)
//
// SETUP:
//   1. Deploy this to Render as a Web Service
//   2. Set environment variables (see .env.example)
//   3. Register Telegram webhook once:
//      https://api.telegram.org/botTOKEN/setWebhook?url=https://YOUR-RENDER-URL/webhook
//   4. Never change your Render service name = URL stays fixed
// =============================================================

require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');

const app  = express();
app.use(express.json());

// =============================================================
// CONFIG — set these as Render environment variables
// =============================================================

const BOT_TOKEN     = process.env.BOT_TOKEN;
const GAS_URL       = process.env.GAS_URL;       // Your GAS web app URL
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // Optional extra security
const PORT          = process.env.PORT || 3000;

if (!BOT_TOKEN) { console.error('FATAL: BOT_TOKEN not set'); process.exit(1); }
if (!GAS_URL)   { console.error('FATAL: GAS_URL not set');   process.exit(1); }

// =============================================================
// LAYER 1: In-memory dedup (fastest — 0ms lookup)
// Prevents double-processing when Telegram retries within seconds
// Map: update_id → timestamp
// Cleaned up every 5 minutes to prevent memory leak
// =============================================================

const seen     = new Map();
const SEEN_TTL = 10 * 60 * 1000; // 10 minutes

setInterval(function() {
  const cutoff = Date.now() - SEEN_TTL;
  let cleaned  = 0;
  seen.forEach(function(ts, uid) {
    if (ts < cutoff) { seen.delete(uid); cleaned++; }
  });
  if (cleaned > 0) console.log('[dedup] Cleaned ' + cleaned + ' old entries');
}, 5 * 60 * 1000);

// =============================================================
// LAYER 2: Per-user action lock
// Prevents double-tap: if user taps a button twice fast,
// second request blocked for 3 seconds
// =============================================================

const userLocks = new Map();
const LOCK_TTL  = 3000; // 3 seconds

function isUserLocked(tid) {
  const ts = userLocks.get(tid);
  if (ts && Date.now() - ts < LOCK_TTL) return true;
  userLocks.set(tid, Date.now());
  return false;
}

function releaseUserLock(tid) {
  userLocks.delete(tid);
}

// Clean user locks every minute
setInterval(function() {
  const cutoff = Date.now() - LOCK_TTL;
  userLocks.forEach(function(ts, tid) {
    if (ts < cutoff) userLocks.delete(tid);
  });
}, 60 * 1000);

// =============================================================
// HEALTH CHECK — Render requires this to verify service is up
// =============================================================

app.get('/', function(req, res) {
  res.json({
    status:  'ok',
    service: 'KH Voice Job Webhook',
    time:    new Date().toISOString(),
    dedup_entries: seen.size,
    locked_users:  userLocks.size
  });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok' });
});

// =============================================================
// WEBHOOK ENDPOINT — receives ALL Telegram updates
// =============================================================

app.post('/webhook', async function(req, res) {
  // Respond to Telegram IMMEDIATELY (< 50ms)
  // Telegram requires 200 OK within 5 seconds or it retries
  res.status(200).json({ ok: true });

  const update = req.body;
  if (!update || !update.update_id) {
    console.warn('[webhook] Invalid update received');
    return;
  }

  const uid = String(update.update_id);

  // Extract user id for logging and per-user lock
  let tid = 'unknown';
  try {
    if (update.message)         tid = String(update.message.from.id);
    else if (update.callback_query) tid = String(update.callback_query.from.id);
  } catch(e) {}

  // Determine update type for logging
  let utype = 'unknown';
  if (update.message) {
    if (update.message.voice)   utype = 'VOICE';
    else if (update.message.contact) utype = 'CONTACT';
    else if (update.message.text)    utype = 'TEXT:' + update.message.text.substring(0,20);
    else utype = 'MSG';
  } else if (update.callback_query) {
    utype = 'CB:' + (update.callback_query.data || '').substring(0,20);
  }

  console.log('[update] uid=' + uid + ' tid=' + tid + ' type=' + utype);

  // LAYER 1: In-memory dedup check
  if (seen.has(uid)) {
    console.log('[dedup] Blocked uid=' + uid + ' (already seen)');
    return;
  }
  seen.set(uid, Date.now());

  // LAYER 2: Per-user lock (skip for voice + contact — they take time)
  // Voice messages can take 10-50 seconds to record.
  // The user lock would have long expired. Voice has its own GAS-side handling.
  const isVoice   = !!(update.message && update.message.voice);
  const isContact = !!(update.message && update.message.contact);
  const isCommand = !!(update.message && update.message.text && update.message.text.startsWith('/'));

  if (!isVoice && !isContact && !isCommand) {
    if (isUserLocked(tid)) {
      console.log('[lock] Blocked double-tap uid=' + uid + ' tid=' + tid);
      return;
    }
  }

  // Forward to GAS asynchronously (don't await — already responded to Telegram)
  forwardToGAS(update, uid, tid).catch(function(err) {
    console.error('[forward] Error uid=' + uid + ':', err.message);
  });
});

// =============================================================
// FORWARD TO GAS
// Sends the Telegram update to Google Apps Script for processing
// Retries up to 3 times if GAS is slow/unresponsive
// =============================================================

async function forwardToGAS(update, uid, tid) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 500; // ms

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const startTime = Date.now();

      const response = await fetch(GAS_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(update),
        timeout: 30000  // 30 second timeout for GAS
      });

      const elapsed = Date.now() - startTime;

      if (response.ok) {
        console.log('[gas] OK uid=' + uid + ' tid=' + tid + ' attempt=' + attempt + ' time=' + elapsed + 'ms');
        // Release user lock after successful forward
        releaseUserLock(tid);
        return;
      }

      const body = await response.text();
      console.warn('[gas] HTTP ' + response.status + ' uid=' + uid + ' attempt=' + attempt + ': ' + body.substring(0,100));

    } catch(err) {
      console.error('[gas] Error uid=' + uid + ' attempt=' + attempt + ': ' + err.message);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY * attempt); // exponential backoff
    }
  }

  console.error('[gas] FAILED after ' + MAX_RETRIES + ' attempts uid=' + uid);
  // Still release lock so user isn't stuck
  releaseUserLock(tid);
}

// =============================================================
// WEBHOOK SETUP HELPER — call this once to register webhook
// GET /setup?secret=YOUR_WEBHOOK_SECRET
// =============================================================

app.get('/setup', async function(req, res) {
  // Basic protection — require secret query param if configured
  if (WEBHOOK_SECRET && req.query.secret !== WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const renderUrl = process.env.RENDER_EXTERNAL_URL || req.protocol + '://' + req.get('host');
  const webhookUrl = renderUrl + '/webhook';

  try {
    // First delete existing webhook + pending updates
    await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/deleteWebhook?drop_pending_updates=true');
    await sleep(500);

    // Register new webhook
    const r = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/setWebhook', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url:                  webhookUrl,
        drop_pending_updates: true,
        allowed_updates:      ['message', 'callback_query']
      })
    });

    const data = await r.json();

    if (data.ok) {
      console.log('[setup] Webhook registered: ' + webhookUrl);
      res.json({ success: true, webhook_url: webhookUrl, telegram_response: data });
    } else {
      res.status(400).json({ success: false, error: data.description });
    }
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================
// WEBHOOK STATUS — check current webhook info
// GET /status
// =============================================================

app.get('/status', async function(req, res) {
  try {
    const r    = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getWebhookInfo');
    const data = await r.json();
    res.json({
      server: {
        uptime:       Math.floor(process.uptime()) + 's',
        dedup_cache:  seen.size,
        locked_users: userLocks.size,
        gas_url:      GAS_URL ? GAS_URL.substring(0,60) + '...' : 'NOT SET'
      },
      telegram: data.result || data
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// UTILS
// =============================================================

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// =============================================================
// START SERVER
// =============================================================

app.listen(PORT, function() {
  console.log('=================================================');
  console.log(' KH Voice Job Webhook Server');
  console.log(' Port: ' + PORT);
  console.log(' GAS URL: ' + (GAS_URL ? GAS_URL.substring(0,60) + '...' : 'NOT SET — check env vars'));
  console.log('');
  console.log(' Endpoints:');
  console.log('   POST /webhook   — Telegram webhook receiver');
  console.log('   GET  /health    — Health check (for Render)');
  console.log('   GET  /status    — Webhook + server status');
  console.log('   GET  /setup     — Register webhook with Telegram');
  console.log('=================================================');
});

module.exports = app;
