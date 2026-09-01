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
 * Extract and clean content from a material page.
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

  const $ = cheerio.load(html);

  // === Step 1: Find iframe sources (the real material lives here) ===
  const iframes = $('iframe');
  let materialHtml = null;
  let materialSourceUrl = null;

  for (let i = 0; i < iframes.length; i++) {
    const iframe = iframes.eq(i);
    const src = iframe.attr('src');
    if (!src || src === 'about:blank') continue;

    const iframeUrl = src.startsWith('http') ? src : `${BASE_URL}${src}`;
    console.log(`[extractor] Found iframe material: ${iframeUrl}`);

    try {
      const iframeResponse = await sessionRequest(session, 'GET', iframeUrl);
      if (iframeResponse.status === 200 && iframeResponse.data) {
        materialHtml = iframeResponse.data;
        materialSourceUrl = iframeUrl;
        break; // Primary iframe content found
      }
    } catch (e) {
      console.log(`[extractor] Could not fetch iframe: ${e.message}`);
    }
  }

  // === Step 2: Clean the material HTML ===
  let finalHtml;

  if (materialHtml) {
    // Extracted directly from iframe
    finalHtml = cleanMaterialHtml(materialHtml, materialTitle);
    console.log(`[extractor] Successfully cleaned iframe material: ${materialSourceUrl}`);
  } else {
    // Fallback: extract main content directly from lesson page
    console.log('[extractor] No iframe found, extracting from lesson page body');
    const mainContent = extractMainContent($);
    finalHtml = buildCleanHtml(materialTitle, mainContent, []);
  }

  // === Step 3: Save to file ===
  const safeTitle = materialTitle
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff\s\-_]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 80);
  const hash = crypto.createHash('md5').update(materialUrl).digest('hex').substring(0, 6);
  const filename = `${safeTitle}_${hash}.html`;
  const filepath = path.join(DOWNLOADS_DIR, filename);

  fs.writeFileSync(filepath, finalHtml, 'utf-8');
  console.log(`[extractor] Saved to ${filepath}`);

  return {
    filename,
    filepath,
    title: materialTitle,
    url: materialUrl,
    size: Buffer.byteLength(finalHtml, 'utf-8'),
    hasIframes: !!materialHtml,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Clean material HTML from iframe — strip protections, controls, and wrap as standalone
 */
function cleanMaterialHtml(html, title) {
  const $ = cheerio.load(html);

  // --- Remove all existing script tags to prevent any anti-copy/contextmenu listeners ---
  $('script').remove();

  // --- Remove protection styles ---
  $('style').each((i, el) => {
    let css = $(el).html() || '';
    
    // Remove entire style block if it's purely protection
    if (css.includes('Content Protection') && css.includes('user-select: none')) {
      $(el).remove();
      return;
    }

    // Replace all variations of user-select: none
    css = css.replace(/user-select\s*:\s*none\s*(!important)?;/gi, 'user-select: text !important;');
    css = css.replace(/-webkit-user-select\s*:\s*none\s*(!important)?;/gi, '-webkit-user-select: text !important;');
    css = css.replace(/-moz-user-select\s*:\s*none\s*(!important)?;/gi, '-moz-user-select: text !important;');
    css = css.replace(/-ms-user-select\s*:\s*none\s*(!important)?;/gi, '-ms-user-select: text !important;');
    css = css.replace(/-webkit-touch-callout\s*:\s*none\s*(!important)?;/gi, '-webkit-touch-callout: default !important;');

    // Remove pointer-events: none
    css = css.replace(/pointer-events\s*:\s*none\s*(!important)?;/gi, 'pointer-events: auto !important;');

    // Remove print blocker styles
    css = css.replace(/@media\s+print\s*\{[^}]*display\s*:\s*none[^}]*\}/gi, '');

    $(el).html(css);
  });

  // --- Remove protection attributes from all elements ---
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

  // --- Remove control buttons (Top/Bottom/Fullscreen) ---
  $('.controls').remove();
  $('[onclick*="scrollToTop"]').remove();
  $('[onclick*="scrollToBottom"]').remove();
  $('[onclick*="toggleFullscreen"]').remove();
  $('#fullscreenBtn').remove();

  // --- Remove scroll indicator ---
  $('.scroll-indicator').remove();
  $('#scrollThumb').remove();

  // --- Remove invisible overlays ---
  $('.absolute.inset-0.pointer-events-none').remove();
  $('[class*="overlay"]').each((i, el) => {
    const $el = $(el);
    if ($el.children().length === 0 && $el.text().trim().length === 0) {
      $el.remove();
    }
  });

  // --- Remove dev tools warning ---
  $('#devWarning').remove();
  $('.dev-warning').remove();

  // --- Clean up empty cover-page container if present so content is immediately visible ---
  $('.cover-page').each((i, el) => {
    const $el = $(el);
    if ($el.text().trim().length === 0) {
      $el.remove();
    }
  });

  // --- Fix relative image and link URLs so offline downloaded HTML displays all graphics ---
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

  // --- Get all styles from <head> ---
  const styles = [];
  $('head style').each((i, el) => {
    const css = $(el).html();
    if (css && css.trim()) styles.push(css);
  });

  // Also collect <link> stylesheet references
  const linkStyles = [];
  $('link[rel="stylesheet"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) {
      const fullHref = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      linkStyles.push(fullHref);
    }
  });

  // --- Get the body content ---
  const bodyContent = $('body').html() || '';

  // --- Build final clean standalone HTML ---
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Ambilajah</title>
  ${linkStyles.map(href => `<link rel="stylesheet" href="${href}">`).join('\n  ')}
  
  ${styles.map(css => `<style>${css}</style>`).join('\n  ')}

  <!-- AmbilAjah Guaranteed Copy & Selection Styles -->
  <style>
    *, *::before, *::after {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      -ms-user-select: text !important;
      user-select: text !important;
      -webkit-touch-callout: default !important;
    }
    ::before, ::after {
      pointer-events: none !important;
    }
    html, body {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      user-select: text !important;
      overflow-x: hidden;
      overflow-y: auto !important;
      height: auto !important;
    }
    img {
      pointer-events: auto !important;
      -webkit-user-drag: auto !important;
    }
    ::selection {
      background: #2563eb !important;
      color: #ffffff !important;
    }
    ::-moz-selection {
      background: #2563eb !important;
      color: #ffffff !important;
    }
    @media print {
      body, html { display: block !important; }
      .controls, .scroll-indicator { display: none !important; }
    }
  </style>

  <script>
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
  </script>
</head>
<body>
${bodyContent}
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
