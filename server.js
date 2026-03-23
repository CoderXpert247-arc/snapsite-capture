/**
 * SnapSite Screenshot Microservice
 * Deploy on HuggingFace Spaces (Docker) — free, 16GB RAM, no credit card
 * Listens on port 7860 (required by HuggingFace)
 */

const express    = require('express');
const puppeteer  = require('puppeteer-core');
const { v2: cloudinary } = require('cloudinary');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Cloudinary ───────────────────────────────────────────────────
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('✅ Cloudinary configured');
} else {
  console.warn('⚠️  CLOUDINARY_CLOUD_NAME not set — uploads will fail');
}

// ── Find Chromium ────────────────────────────────────────────────
function findChromium() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch(e) {}
  }
  throw new Error('Chromium not found. Checked: ' + candidates.join(', '));
}

let CHROMIUM_PATH;
try {
  CHROMIUM_PATH = findChromium();
  console.log('✅ Chromium found:', CHROMIUM_PATH);
} catch(e) {
  console.error('❌ ' + e.message);
  // Don't crash on startup — still serve health endpoint
}

// ── Puppeteer launch options ─────────────────────────────────────
const LAUNCH_OPTS = {
  executablePath: null, // set at capture time
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--single-process',
    '--memory-pressure-off',
    '--js-flags=--max-old-space-size=512',
  ],
};

const VIEWPORTS = {
  desktop: { width: 1280, height: 720  },
  tablet:  { width: 768,  height: 1024 },
  mobile:  { width: 390,  height: 844  },
};

// ── In-memory semaphore — 1 at a time ───────────────────────────
let capturing = false;
const waitQueue = [];
function acquireLock() {
  if (!capturing) { capturing = true; return Promise.resolve(); }
  return new Promise(function(r) { waitQueue.push(r); });
}
function releaseLock() {
  if (waitQueue.length > 0) { waitQueue.shift()(); }
  else { capturing = false; }
}

// ── Auth ─────────────────────────────────────────────────────────
function auth(req, res, next) {
  const secret = process.env.CAPTURE_SECRET;
  if (!secret) return next(); // no secret set = open
  if (req.headers['x-capture-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized — x-capture-secret header missing or wrong' });
  }
  next();
}

// ── GET / ────────────────────────────────────────────────────────
// HuggingFace checks this to confirm the app is alive
app.get('/', function(req, res) {
  res.json({
    service:  'SnapSite Capture',
    status:   'running',
    chromium: CHROMIUM_PATH || 'not found',
    cloudinary: !!process.env.CLOUDINARY_CLOUD_NAME,
  });
});

// ── GET /health ──────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    ok:        true,
    capturing: capturing,
    queue:     waitQueue.length,
    chromium:  CHROMIUM_PATH || null,
    cloudinary: !!process.env.CLOUDINARY_CLOUD_NAME,
  });
});

// ── POST /capture ────────────────────────────────────────────────
app.post('/capture', auth, async function(req, res) {
  const { url, viewports, fullPage, uuid } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!CHROMIUM_PATH) return res.status(500).json({ error: 'Chromium not found on this server' });
  if (!process.env.CLOUDINARY_CLOUD_NAME) return res.status(500).json({ error: 'CLOUDINARY_CLOUD_NAME not set on HuggingFace Space' });

  const jobId    = uuid || crypto.randomUUID();
  const vpNames  = (viewports && viewports.length) ? viewports : ['desktop', 'mobile'];
  const NAV_MS   = 60000;
  const results  = {};

  await acquireLock();
  let browser = null;

  try {
    console.log('[Capture] Starting job', jobId, 'url:', url, 'viewports:', vpNames);

    LAUNCH_OPTS.executablePath = CHROMIUM_PATH;
    browser = await puppeteer.launch(LAUNCH_OPTS);

    for (const vpName of vpNames) {
      const vpCfg   = VIEWPORTS[vpName];
      if (!vpCfg) continue;
      const tmpFile = path.join(os.tmpdir(), jobId + '-' + vpName + '.jpg');
      let page = null;

      try {
        page = await browser.newPage();
        await page.setViewport({ width: vpCfg.width, height: vpCfg.height, deviceScaleFactor: 1 });
        await page.setRequestInterception(true);
        page.on('request', function(r) {
          if (r.resourceType() === 'media' || r.resourceType() === 'font') r.abort();
          else r.continue();
        });

        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_MS });
        } catch(e) {
          try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }); }
          catch(e2) { console.warn('[Capture] Navigation fallback also failed:', e2.message); }
        }

        await page.screenshot({ path: tmpFile, type: 'jpeg', quality: 85, fullPage: false });
        console.log('[Capture] Screenshot taken:', vpName, tmpFile);

        const upload = await cloudinary.uploader.upload(tmpFile, {
          public_id:     'screenshots/' + jobId + '-' + vpName,
          resource_type: 'image',
          overwrite:     true,
        });
        results[vpName] = upload.secure_url;
        console.log('[Capture] Uploaded to Cloudinary:', vpName, upload.secure_url);

      } finally {
        if (page) await page.close().catch(function(){});
        try { fs.unlinkSync(tmpFile); } catch(e) {}
      }
    }

    // Full-page if requested
    if (fullPage) {
      const tmpFp = path.join(os.tmpdir(), jobId + '-fullpage.jpg');
      let fpPage  = null;
      try {
        fpPage = await browser.newPage();
        await fpPage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
        await fpPage.setRequestInterception(true);
        fpPage.on('request', function(r) {
          if (r.resourceType() === 'media') r.abort(); else r.continue();
        });
        try { await fpPage.goto(url, { waitUntil: 'networkidle2', timeout: NAV_MS }); }
        catch(e) { await fpPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_MS }).catch(function(){}); }
        await fpPage.screenshot({ path: tmpFp, type: 'jpeg', quality: 85, fullPage: true });
        const fpUp = await cloudinary.uploader.upload(tmpFp, {
          public_id: 'screenshots/' + jobId + '-fullpage',
          resource_type: 'image', overwrite: true,
        });
        results.fullpage = fpUp.secure_url;
      } finally {
        if (fpPage) await fpPage.close().catch(function(){});
        try { fs.unlinkSync(tmpFp); } catch(e) {}
      }
    }

    console.log('[Capture] Job done:', jobId, '| urls:', Object.keys(results));
    res.json({ ok: true, urls: results, uuid: jobId });

  } catch (err) {
    console.error('[Capture] Job failed:', jobId, err.message);
    res.status(500).json({ error: err.message, urls: results });
  } finally {
    if (browser) await browser.close().catch(function(){});
    releaseLock();
  }
});

const PORT = parseInt(process.env.PORT) || 7860;
app.listen(PORT, '0.0.0.0', function() {
  console.log('📸 SnapSite capture service running on port', PORT);
  console.log('   GET  /         → status');
  console.log('   GET  /health   → health check');
  console.log('   POST /capture  → run capture');
});
