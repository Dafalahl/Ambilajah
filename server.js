const express = require('express');
const path = require('path');
const { login, serializeSession, deserializeSession } = require('./lib/auth');
const { getCourses, getMaterials, fetchPage } = require('./lib/scraper');
const { extractContent, listDownloads, deleteDownload, cleanupOldDownloads, DOWNLOADS_DIR } = require('./lib/content-extractor');

const app = express();
const PORT = process.env.PORT || 3000;

// Periodic cleanup of temporary download files older than 2 hours (non-blocking)
try {
  cleanupOldDownloads();
  setInterval(cleanupOldDownloads, 30 * 60 * 1000);
} catch (e) {
  // Ignore in serverless cold start
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory fallback map for legacy compatibility
const sessions = new Map();

/**
 * Get session from request header (Stateless Decryption + Fallback)
 */
function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token) return null;

  // 1. Try stateless decrypt first (works 100% on Vercel & serverless)
  const statelessSession = deserializeSession(token);
  if (statelessSession) {
    return statelessSession;
  }

  // 2. Fallback to in-memory map
  if (sessions.has(token)) {
    return sessions.get(token);
  }

  return null;
}

// ============================================
// API Routes
// ============================================

/**
 * GET /api/debug — Temporary diagnostic endpoint to check connectivity from server to LMS
 * Remove this after debugging is complete
 */
app.get('/api/debug', async (req, res) => {
  const axios = require('axios');
  const results = {};

  const urls = [
    'http://class.tiflab.my.id/login',
    'https://class.tiflab.my.id/login',
  ];

  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 10000,
      });

      const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      results[url] = {
        status: resp.status,
        hasToken: body.includes('_token'),
        hasCsrfMeta: body.includes('csrf-token'),
        hasCloudflare: body.includes('Just a moment') || body.includes('cf-mitigated') || body.includes('Cloudflare'),
        setCookies: resp.headers['set-cookie'] ? resp.headers['set-cookie'].length : 0,
        bodyPreview: body.substring(0, 500),
      };
    } catch (err) {
      results[url] = { error: err.message };
    }
  }

  res.json({
    serverTime: new Date().toISOString(),
    vercel: !!process.env.VERCEL,
    region: process.env.VERCEL_REGION || 'local',
    results,
  });
});

/**
 * POST /api/login
 * Login to Class.tiflab with NPM + password
 */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username (NPM) dan password wajib diisi.' });
    }

    console.log(`[server] Login attempt for: ${username}`);
    const session = await login(username, password);
    
    // Generate secure AES-256 stateless session token containing encrypted cookies
    const token = serializeSession(session, username);
    sessions.set(token, session);

    res.json({
      success: true,
      message: 'Login berhasil!',
      token,
      username,
    });
  } catch (error) {
    console.error('[server] Login error:', error.message);
    res.status(401).json({ error: error.message });
  }
});

/**
 * POST /api/logout
 * Clear session
 */
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) sessions.delete(token);
  res.json({ success: true, message: 'Logged out.' });
});

/**
 * GET /api/courses
 * Get list of enrolled courses
 */
app.get('/api/courses', async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Belum login. Silakan login dulu.' });

    const result = await getCourses(session);
    res.json({
      success: true,
      courses: result.courses,
      pageUrl: result.pageUrl,
      // Include raw HTML for debugging (can be toggled)
      ...(req.query.debug === '1' ? { rawHtml: result.rawHtml } : {}),
    });
  } catch (error) {
    console.error('[server] Courses error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/courses/:courseUrl/materials
 * Get list of materials in a course
 * courseUrl is base64-encoded
 */
app.get('/api/materials', async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Belum login. Silakan login dulu.' });

    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL course wajib diisi.' });

    const courseUrl = Buffer.from(url, 'base64').toString('utf-8');
    const result = await getMaterials(session, courseUrl);
    
    res.json({
      success: true,
      materials: result.materials,
      pageUrl: result.pageUrl,
      ...(req.query.debug === '1' ? { rawHtml: result.rawHtml } : {}),
    });
  } catch (error) {
    console.error('[server] Materials error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/download
 * Download a material
 */
app.post('/api/download', async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Belum login. Silakan login dulu.' });

    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL materi wajib diisi.' });

    const materialUrl = Buffer.from(url, 'base64').toString('utf-8');
    const materialTitle = title || 'Untitled Material';

    const result = await extractContent(session, materialUrl, materialTitle);
    
    res.json({
      success: true,
      message: `Materi "${materialTitle}" berhasil didownload!`,
      ...result,
    });
  } catch (error) {
    console.error('[server] Download error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/downloads
 * List all downloaded files
 */
app.get('/api/downloads', (req, res) => {
  const files = listDownloads();
  res.json({ success: true, downloads: files });
});

/**
 * GET /api/downloads/:filename
 * Serve a downloaded file
 */
app.get('/api/downloads/:filename', (req, res) => {
  const filepath = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!require('fs').existsSync(filepath)) {
    return res.status(404).json({ error: 'File tidak ditemukan.' });
  }
  res.sendFile(filepath);
});

/**
 * DELETE /api/downloads/:filename
 * Delete a downloaded file
 */
app.delete('/api/downloads/:filename', (req, res) => {
  const deleted = deleteDownload(req.params.filename);
  if (deleted) {
    res.json({ success: true, message: 'File dihapus.' });
  } else {
    res.status(404).json({ error: 'File tidak ditemukan.' });
  }
});

/**
 * POST /api/preview
 * Preview a material's raw HTML (fetch without saving)
 */
app.post('/api/preview', async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Belum login. Silakan login dulu.' });

    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL wajib diisi.' });

    const materialUrl = Buffer.from(url, 'base64').toString('utf-8');
    const html = await fetchPage(session, materialUrl);
    
    res.json({ success: true, html });
  } catch (error) {
    console.error('[server] Preview error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/fetch-page
 * Fetch any authenticated page (for exploring site structure)
 */
app.post('/api/fetch-page', async (req, res) => {
  try {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Belum login. Silakan login dulu.' });

    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL wajib diisi.' });

    const html = await fetchPage(session, url);
    res.json({ success: true, html });
  } catch (error) {
    console.error('[server] Fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Start Server (Standalone / Local / Render)
// ============================================
if (require.main === module || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║                                              ║');
    console.log('║   🎓  Ambilajah — Course Material Grabber    ║');
    console.log('║                                              ║');
    console.log(`║   🌐  http://localhost:${PORT}                  ║`);
    console.log('║                                              ║');
    console.log('║   Buka URL di atas di browser untuk mulai.   ║');
    console.log('║                                              ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
  });
}

module.exports = app;
