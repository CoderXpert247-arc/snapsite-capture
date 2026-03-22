/**
 * SnapSite Screenshot Microservice
 * Deploy this on Koyeb free tier (512MB dedicated RAM, no sleep)
 * 
 * Single responsibility: receive a URL, capture screenshots, 
 * upload to Cloudinary, return the URLs.
 * 
 * The main SnapSite API calls this service instead of running
 * Puppeteer locally — keeps the main server under 150MB RAM.
 */

const express    = require('express');
const puppeteer  = require('puppeteer-core');
const { v2: cloudinary } = require('cloudinary');
const { execSync } = require('child_process');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

const app  = express();
app.use(express.json({ limit: '1mb' }));

// ── Cloudinary setup ─────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Find system Chromium ─────────────────────────────────────────
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
  // Try which command
  try { return execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim(); }
  catch(e) { throw new Error('Chromium not found. Install chromium package.'); }
}

const CHROMIUM_PATH = findChromium();
console.log('🌐 Chromium:', CHROMIUM_PATH);

// ── Puppeteer config ─────────────────────────────────────────────
const LAUNCH_OPTS = {
  executablePath: CHROMIUM_PATH,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--single-process',
    '--memory-pressure-off',
    '--js-flags=--max-old-space-size=192',
  ],
};

const VIEWPORTS = {
  desktop: { width: 1280, height: 720  },
  tablet:  { width: 768,  height: 1024 },
  mobile:  { width: 390,  height: 844  },
};

// ── In-memory semaphore — 1 capture at a time ────────────────────
let capturing = false;
const waitQueue = [];

function acquireLock() {
  if (!capturing) { capturing = true; return Promise.resolve(); }
  return new Promise(function(resolve) { waitQueue.push(resolve); });
}

function releaseLock() {
  if (waitQueue.length > 0) {
    waitQueue.shift()();
  } else {
    capturing = false;
  }
}

// ── Auth middleware ──────────────────────────────────────────────
function auth(req, res, next) {
  const secret = process.env.CAPTURE_SECRET;
  if (!secret) return next(); // no secret = open (dev only)
  const provided = req.headers['x-capture-secret'];
  if (provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({ ok: true, capturing, queue: waitQueue.length });
});

// ── Main capture endpoint ─────────────────────────────────────────
app.post('/capture', auth, async function(req, res) {
  const { url, viewports, fullPage, uuid } = req.body;

  if (!url) return res.status(400).json({ error: 'url required' });

  const jobId     = uuid || crypto.randomUUID();
  const tmpDir    = os.tmpdir();
  const vpNames   = viewports && viewports.length ? viewports : ['desktop', 'mobile'];
  const NAV_TIMEOUT = 60000;

  await acquireLock();

  let browser = null;
  const results = {};

  try {
    browser = await puppeteer.launch(LAUNCH_OPTS);

    // Sequential — one viewport at a time to stay within memory
    for (const vpName of vpNames) {
      const vpCfg = VIEWPORTS[vpName];
      if (!vpCfg) continue;

      const tmpFile = path.join(tmpDir, jobId + '-' + vpName + '.jpg');
      let page = null;

      try {
        page = await browser.newPage();
        await page.setViewport({ width: vpCfg.width, height: vpCfg.height, deviceScaleFactor: 1 });

        // Block non-essential resources to reduce memory and speed up load
        await page.setRequestInterception(true);
        page.on('request', function(req) {
          const type = req.resourceType();
          if (type === 'media' || type === 'font') req.abort();
          else req.continue();
        });

        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
        } catch(e) {
          try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }); }
          catch(e2) { /* screenshot whatever loaded */ }
        }

        await page.screenshot({ path: tmpFile, type: 'jpeg', quality: 85, fullPage: !!fullPage });

        // Upload to Cloudinary
        const publicId = 'screenshots/' + jobId + '-' + vpName;
        const upload   = await cloudinary.uploader.upload(tmpFile, {
          public_id:     publicId,
          resource_type: 'image',
          overwrite:     true,
        });

        results[vpName] = upload.secure_url;

      } finally {
        if (page) await page.close().catch(function(){});
        // Clean up temp file immediately
        try { fs.unlinkSync(tmpFile); } catch(e) {}
      }
    }

    // Full-page desktop if requested
    if (fullPage && !vpNames.includes('fullpage')) {
      const tmpFp  = path.join(tmpDir, jobId + '-fullpage.jpg');
      let fpPage   = null;
      try {
        fpPage = await browser.newPage();
        await fpPage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
        await fpPage.setRequestInterception(true);
        fpPage.on('request', function(req) {
          if (req.resourceType() === 'media') req.abort();
          else req.continue();
        });
        try { await fpPage.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }); }
        catch(e) { await fpPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(function(){}); }
        await fpPage.screenshot({ path: tmpFp, type: 'jpeg', quality: 85, fullPage: true });
        const fpUpload = await cloudinary.uploader.upload(tmpFp, {
          public_id: 'screenshots/' + jobId + '-fullpage',
          resource_type: 'image', overwrite: true,
        });
        results.fullpage = fpUpload.secure_url;
      } finally {
        if (fpPage) await fpPage.close().catch(function(){});
        try { fs.unlinkSync(tmpFp); } catch(e) {}
      }
    }

    res.json({ ok: true, urls: results, uuid: jobId });

  } catch (err) {
    console.error('[Capture] Error:', err.message);
    res.status(500).json({ error: err.message, urls: results });
  } finally {
    if (browser) await browser.close().catch(function(){});
    releaseLock();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, function() {
  console.log('📸 SnapSite capture service → port', PORT);
});
