const cheerio = require('cheerio');
const { sessionRequest, BASE_URL } = require('./auth');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOWNLOADS_DIR = (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NODE_ENV === 'production' && !fs.existsSync(path.join(__dirname, '..', 'downloads')))
  ? path.join('/tmp', 'ambilajah-downloads')
  : path.join(__dirname, '..', 'downloads');

// Ensure downloads directory exists safely
try {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('[extractor] Could not create DOWNLOADS_DIR:', e.message);
}

/**
 * Detect file extension and MIME type from URL or header
 */
function getFileInfo(url = '', contentType = '') {
  const cleanUrl = url.split('?')[0].toLowerCase();
  if (cleanUrl.endsWith('.pdf') || contentType.includes('pdf')) {
    return { ext: 'pdf', mimeType: 'application/pdf', isBinary: true };
  }
  if (cleanUrl.endsWith('.pptx') || contentType.includes('presentationml')) {
    return { ext: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', isBinary: true };
  }
  if (cleanUrl.endsWith('.ppt') || contentType.includes('powerpoint')) {
    return { ext: 'ppt', mimeType: 'application/vnd.ms-powerpoint', isBinary: true };
  }
  if (cleanUrl.endsWith('.docx') || contentType.includes('wordprocessingml')) {
    return { ext: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', isBinary: true };
  }
  if (cleanUrl.endsWith('.doc') || contentType.includes('msword')) {
    return { ext: 'doc', mimeType: 'application/msword', isBinary: true };
  }
  if (cleanUrl.endsWith('.zip') || contentType.includes('zip')) {
    return { ext: 'zip', mimeType: 'application/zip', isBinary: true };
  }
  if (cleanUrl.endsWith('.rar') || contentType.includes('rar')) {
    return { ext: 'rar', mimeType: 'application/x-rar-compressed', isBinary: true };
  }
  return { ext: 'html', mimeType: 'text/html;charset=utf-8', isBinary: false };
}

/**
 * Extract and clean content from a material page (Supports HTML, PDF, PPTX, DOCX, etc.).
 */
async function extractContent(session, materialUrl, materialTitle) {
  console.log(`[extractor] Extracting content from ${materialUrl}...`);

  const response = await sessionRequest(session, 'GET', materialUrl);
  let html = response.data;

  // Follow redirects
  if (response.status === 302) {
    const redirectUrl = response.headers.location;
    const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`;
    const redirected = await sessionRequest(session, 'GET', fullUrl);
    html = redirected.data;
  }

  // Check if materialUrl itself is directly a binary document
  const directFileInfo = getFileInfo(materialUrl, response.headers['content-type'] || '');
  if (directFileInfo.isBinary) {
    console.log(`[extractor] Direct binary document detected: ${materialUrl}`);
    const binResponse = await sessionRequest(session, 'GET', materialUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(binResponse.data);
    const safeTitle = materialTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').substring(0, 80);
    const filename = `${safeTitle}.${directFileInfo.ext}`;
    const filepath = path.join(DOWNLOADS_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    return {
      filename,
      filepath,
      title: materialTitle,
      url: materialUrl,
      size: buffer.length,
      isBinary: true,
      mimeType: directFileInfo.mimeType,
      contentBase64: buffer.toString('base64'),
      timestamp: new Date().toISOString(),
    };
  }

  const $ = cheerio.load(html);

  // === Step 1: Find iframe, embed, object or direct file download links ===
  let directFileUrl = null;

  // 1a. Check iframes
  const iframes = $('iframe, embed, object');
  for (let i = 0; i < iframes.length; i++) {
    const src = iframes.eq(i).attr('src') || iframes.eq(i).attr('data') || '';
    if (src && src !== 'about:blank') {
      const fullSrc = src.startsWith('http') ? src : `${BASE_URL}${src}`;
      const fInfo = getFileInfo(fullSrc);
      if (fInfo.isBinary) {
        directFileUrl = fullSrc;
        break;
      }
    }
  }

  // 1b. Check direct file links inside page
  if (!directFileUrl) {
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('/files/lessons/materials/') || href.match(/\.(pdf|pptx|ppt|docx|doc|zip|rar)($|\?)/i)) {
        directFileUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        return false;
      }
    });
  }

  // If a PDF/PPTX/document file was found inside iframe or page links, download the real binary file!
  if (directFileUrl) {
    const fInfo = getFileInfo(directFileUrl);
    console.log(`[extractor] Downloading real binary file from: ${directFileUrl} (${fInfo.ext})`);
    try {
      const binResponse = await sessionRequest(session, 'GET', directFileUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(binResponse.data);
      const safeTitle = materialTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').substring(0, 80);
      const filename = `${safeTitle}.${fInfo.ext}`;
      const filepath = path.join(DOWNLOADS_DIR, filename);
      fs.writeFileSync(filepath, buffer);
      console.log(`[extractor] Saved binary file to ${filepath}`);
      return {
        filename,
        filepath,
        title: materialTitle,
        url: directFileUrl,
        size: buffer.length,
        isBinary: true,
        mimeType: fInfo.mimeType,
        contentBase64: buffer.toString('base64'),
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      console.log(`[extractor] Failed to fetch binary file directly, falling back to HTML: ${e.message}`);
    }
  }

  // === Step 2: HTML iframe Extraction ===
  let materialHtml = null;
  let materialSourceUrl = null;

  for (let i = 0; i < iframes.length; i++) {
    const src = iframes.eq(i).attr('src') || '';
    if (!src || src === 'about:blank') continue;
    const iframeUrl = src.startsWith('http') ? src : `${BASE_URL}${src}`;
    try {
      const iframeResponse = await sessionRequest(session, 'GET', iframeUrl);
      if (iframeResponse.status === 200 && iframeResponse.data && typeof iframeResponse.data === 'string') {
        materialHtml = iframeResponse.data;
        materialSourceUrl = iframeUrl;
        break;
      }
    } catch (e) {
      console.log(`[extractor] Could not fetch iframe: ${e.message}`);
    }
  }

  // === Step 3: Clean the HTML while preserving interactive buttons ===
  let finalHtml;
  if (materialHtml) {
    finalHtml = cleanMaterialHtml(materialHtml, materialTitle);
  } else {
    const mainContent = extractMainContent($);
    finalHtml = buildCleanHtml(materialTitle, mainContent, []);
  }

  const cleanTitle = materialTitle.replace(/^(\d+[\s._\-–—:]*)+/g, '').trim() || materialTitle;
  const safeTitle = cleanTitle
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff\s\-_]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 80);
  const hash = crypto.createHash('md5').update(materialUrl).digest('hex').substring(0, 6);
  const filename = `${safeTitle}_${hash}.html`;
  const filepath = path.join(DOWNLOADS_DIR, filename);

  fs.writeFileSync(filepath, finalHtml, 'utf-8');
  console.log(`[extractor] Saved HTML to ${filepath}`);

  return {
    filename,
    filepath,
    title: materialTitle,
    url: materialUrl,
    size: Buffer.byteLength(finalHtml, 'utf-8'),
    isBinary: false,
    content: finalHtml,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Clean material HTML — unblock copy & right click while keeping interactive buttons & scripts working
 */
function cleanMaterialHtml(html, title) {
  const $ = cheerio.load(html);

  // --- Remove only pure anti-copy scripts (keep Bootstrap, Alpine, jQuery, interactive widgets) ---
  $('script').each((i, el) => {
    const scriptContent = $(el).html() || '';
    const src = $(el).attr('src') || '';
    // If external library (bootstrap, mathjax, jquery, etc.), keep it!
    if (src && !src.includes('protect') && !src.includes('anti-copy')) return;

    // If script is purely an anti-copy / contextmenu listener, remove it
    if (
      scriptContent.includes('contextmenu') && scriptContent.includes('preventDefault') ||
      scriptContent.includes('selectstart') && scriptContent.includes('preventDefault') ||
      scriptContent.includes('debugger') && scriptContent.includes('setInterval')
    ) {
      $(el).remove();
    }
  });

  // --- Remove protection styles & ensure user-select is enabled ---
  $('style').each((i, el) => {
    let css = $(el).html() || '';
    if (css.includes('Content Protection') && css.includes('user-select: none')) {
      $(el).remove();
      return;
    }
    css = css.replace(/user-select\s*:\s*none\s*(!important)?;/gi, 'user-select: text !important;');
    css = css.replace(/-webkit-user-select\s*:\s*none\s*(!important)?;/gi, '-webkit-user-select: text !important;');
    css = css.replace(/-moz-user-select\s*:\s*none\s*(!important)?;/gi, '-moz-user-select: text !important;');
    css = css.replace(/-ms-user-select\s*:\s*none\s*(!important)?;/gi, '-ms-user-select: text !important;');
    css = css.replace(/pointer-events\s*:\s*none\s*(!important)?;/gi, 'pointer-events: auto !important;');
    $(el).html(css);
  });

  // --- Remove blocking inline event attributes (without removing onclick navigation/interactive handlers) ---
  $('*').each((i, el) => {
    const $el = $(el);
    $el.removeAttr('oncontextmenu');
    $el.removeAttr('onselectstart');
    $el.removeAttr('ondragstart');
    $el.removeAttr('oncopy');
    $el.removeAttr('oncut');
    $el.removeAttr('onpaste');
    $el.removeAttr('onkeydown');
    $el.removeAttr('onmousedown');
    $el.removeAttr('unselectable');
  });

  // Remove full blocking overlays if any
  $('.absolute.inset-0.pointer-events-none').remove();
  $('.controls, .scroll-indicator, #fullscreenBtn').remove();

  // Fix relative URLs
  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('http') && !src.startsWith('data:')) {
      const fullSrc = src.startsWith('/') ? `${BASE_URL}${src}` : `${BASE_URL}/${src}`;
      $(el).attr('src', fullSrc);
    }
  });

  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('javascript:') && !href.startsWith('mailto:')) {
      const fullHref = href.startsWith('/') ? `${BASE_URL}${href}` : `${BASE_URL}/${href}`;
      $(el).attr('href', fullHref);
    }
  });

  const styles = [];
  $('head style').each((i, el) => {
    const css = $(el).html();
    if (css && css.trim()) styles.push(css);
  });

  const linkStyles = [];
  $('link[rel="stylesheet"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) {
      const fullHref = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      linkStyles.push(fullHref);
    }
  });

  // Keep all existing scripts in the body/head for interactive buttons
  const scripts = [];
  $('script').each((i, el) => {
    const src = $(el).attr('src');
    if (src) {
      const fullSrc = src.startsWith('http') ? src : `${BASE_URL}${src}`;
      scripts.push(`<script src="${fullSrc}"></script>`);
    } else {
      const inlineCode = $(el).html();
      if (inlineCode && inlineCode.trim()) {
        scripts.push(`<script>${inlineCode}</script>`);
      }
    }
  });

  const bodyContent = $('body').html() || '';

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Ambilajah</title>
  ${linkStyles.map(href => `<link rel="stylesheet" href="${href}">`).join('\n  ')}
  ${styles.map(css => `<style>${css}</style>`).join('\n  ')}

  <!-- AmbilAjah Guaranteed Selection & Button Clickability -->
  <style>
    *, *::before, *::after {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      -ms-user-select: text !important;
      user-select: text !important;
      -webkit-touch-callout: default !important;
    }
    html, body {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      user-select: text !important;
      overflow-x: hidden;
      overflow-y: auto !important;
    }
    button, input, select, textarea, a, .btn, [role="button"], [onclick] {
      pointer-events: auto !important;
      cursor: pointer !important;
    }
    img {
      pointer-events: auto !important;
      -webkit-user-drag: auto !important;
    }
    ::selection { background: #2563eb !important; color: #ffffff !important; }
    ::-moz-selection { background: #2563eb !important; color: #ffffff !important; }
  </style>

  <!-- Authority Event Unblocker (runs in capture phase before any blocker) -->
  <script>
    (function() {
      const unblock = function(e) {
        e.stopImmediatePropagation();
      };
      ['contextmenu', 'copy', 'cut', 'selectstart'].forEach(function(evt) {
        window.addEventListener(evt, unblock, true);
        document.addEventListener(evt, unblock, true);
      });
      window.addEventListener('DOMContentLoaded', function() {
        document.oncontextmenu = null;
        document.onselectstart = null;
        document.ondragstart = null;
        document.oncopy = null;
        document.oncut = null;
        document.onkeydown = null;
        if (document.body) {
          document.body.oncontextmenu = null;
          document.body.onselectstart = null;
          document.body.ondragstart = null;
        }
      });
    })();
  </script>
</head>
<body>
${bodyContent}
${scripts.join('\n')}
</body>
</html>`;
}

/**
 * Extract main content from a page without iframes (fallback)
 */
function extractMainContent($) {
  const selectors = [
    '.prose',
    '.lesson-content',
    '.material-content',
    '.content',
    'article',
    'main',
  ];

  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length > 0 && el.text().trim().length > 50) {
      return el.html();
    }
  }

  return $('body').html() || '';
}

/**
 * Build a clean standalone HTML file (for non-iframe content)
 */
function buildCleanHtml(title, content, stylesheets) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Ambilajah</title>
  ${stylesheets.map(href => `<link rel="stylesheet" href="${href}">`).join('\n  ')}
  <style>
    *, *::before, *::after {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      -ms-user-select: text !important;
      user-select: text !important;
    }
    ::before, ::after {
      pointer-events: none !important;
    }
    ::selection {
      background: #2563eb !important;
      color: #ffffff !important;
    }
    ::-moz-selection {
      background: #2563eb !important;
      color: #ffffff !important;
    }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.7;
      max-width: 960px;
      margin: 0 auto;
      padding: 20px 40px;
      color: #1a1a1a;
    }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f5f5f5; }
    pre, code { background: #f4f4f4; border-radius: 4px; padding: 2px 6px; }
    pre { padding: 16px; overflow-x: auto; }
  </style>
</head>
<body>
  ${content}
</body>
</html>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * List all downloaded files
 */
function listDownloads() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];

  return fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => f.endsWith('.html'))
    .map(filename => {
      const filepath = path.join(DOWNLOADS_DIR, filename);
      const stats = fs.statSync(filepath);
      return {
        filename,
        size: stats.size,
        downloadedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.downloadedAt) - new Date(a.downloadedAt));
}

/**
 * Delete a downloaded file
 */
function deleteDownload(filename) {
  const filepath = path.join(DOWNLOADS_DIR, filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    return true;
  }
  return false;
}

/**
 * Cleanup downloaded files older than maxAge (default 2 hours)
 */
function cleanupOldDownloads(maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(DOWNLOADS_DIR);
    for (const file of files) {
      if (file.endsWith('.html')) {
        const filepath = path.join(DOWNLOADS_DIR, file);
        const stats = fs.statSync(filepath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filepath);
        }
      }
    }
  } catch (e) {
    // Ignore cleanup errors
  }
}

module.exports = { extractContent, listDownloads, deleteDownload, cleanupOldDownloads, DOWNLOADS_DIR };
