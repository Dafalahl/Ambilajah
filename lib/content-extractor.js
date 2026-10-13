const cheerio = require('cheerio');
const { sessionRequest, BASE_URL } = require('./auth');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

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
  const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase();
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
  if (cleanUrl.endsWith('.xlsx') || contentType.includes('spreadsheetml')) {
    return { ext: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', isBinary: true };
  }
  if (cleanUrl.endsWith('.xls') || contentType.includes('ms-excel')) {
    return { ext: 'xls', mimeType: 'application/vnd.ms-excel', isBinary: true };
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
 * Detect if a URL is a Google Drive/Docs link and extract file ID
 */
function parseGoogleDriveUrl(url) {
  if (!url) return null;

  // Google Drive file: https://drive.google.com/file/d/FILE_ID/view
  const driveFileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveFileMatch) {
    return { type: 'drive', fileId: driveFileMatch[1] };
  }

  // Google Drive open: https://drive.google.com/open?id=FILE_ID
  const driveOpenMatch = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (driveOpenMatch) {
    return { type: 'drive', fileId: driveOpenMatch[1] };
  }

  // Google Drive uc: https://drive.google.com/uc?id=FILE_ID
  const driveUcMatch = url.match(/drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]+)/);
  if (driveUcMatch) {
    return { type: 'drive', fileId: driveUcMatch[1] };
  }

  // Google Docs: https://docs.google.com/document/d/FILE_ID/edit
  const docsMatch = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docsMatch) {
    return { type: 'gdoc', fileId: docsMatch[1] };
  }

  // Google Slides: https://docs.google.com/presentation/d/FILE_ID/edit
  const slidesMatch = url.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (slidesMatch) {
    return { type: 'gslides', fileId: slidesMatch[1] };
  }

  // Google Sheets: https://docs.google.com/spreadsheets/d/FILE_ID/edit
  const sheetsMatch = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (sheetsMatch) {
    return { type: 'gsheets', fileId: sheetsMatch[1] };
  }

  return null;
}

/**
 * Download a file from Google Drive/Docs
 */
async function downloadGoogleDriveFile(driveInfo, title) {
  const safeTitle = title.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').substring(0, 80);
  let downloadUrl, ext, mimeType;

  switch (driveInfo.type) {
    case 'drive':
      // Direct download link for Google Drive files
      downloadUrl = `https://drive.google.com/uc?export=download&id=${driveInfo.fileId}`;
      break;
    case 'gdoc':
      downloadUrl = `https://docs.google.com/document/d/${driveInfo.fileId}/export?format=pdf`;
      ext = 'pdf';
      mimeType = 'application/pdf';
      break;
    case 'gslides':
      downloadUrl = `https://docs.google.com/presentation/d/${driveInfo.fileId}/export/pptx`;
      ext = 'pptx';
      mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      break;
    case 'gsheets':
      downloadUrl = `https://docs.google.com/spreadsheets/d/${driveInfo.fileId}/export?format=xlsx`;
      ext = 'xlsx';
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      break;
    default:
      downloadUrl = `https://drive.google.com/uc?export=download&id=${driveInfo.fileId}`;
  }

  console.log(`[extractor] Downloading from Google Drive: ${downloadUrl}`);

  try {
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      maxRedirects: 10,
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers['content-type'] || '';

    // Detect actual file type from response if not pre-set
    if (!ext) {
      const fileInfo = getFileInfo(downloadUrl, contentType);
      ext = fileInfo.ext;
      mimeType = fileInfo.mimeType;

      // If still HTML (Google's confirmation page), try to extract confirm link
      if (ext === 'html' && buffer.length < 200000) {
        const htmlStr = buffer.toString('utf-8');
        const confirmMatch = htmlStr.match(/href="(\/uc\?export=download[^"]+)"/);
        if (confirmMatch) {
          const confirmUrl = `https://drive.google.com${confirmMatch[1].replace(/&amp;/g, '&')}`;
          console.log(`[extractor] Following Google Drive confirm link: ${confirmUrl}`);
          const confirmResp = await axios.get(confirmUrl, {
            responseType: 'arraybuffer',
            maxRedirects: 10,
            timeout: 60000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
          });
          const confirmBuffer = Buffer.from(confirmResp.data);
          const confirmCt = confirmResp.headers['content-type'] || '';
          const confirmInfo = getFileInfo('', confirmCt);

          // Use content-disposition header to detect filename
          const disposition = confirmResp.headers['content-disposition'] || '';
          const filenameMatch = disposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i);
          if (filenameMatch) {
            const origName = decodeURIComponent(filenameMatch[1]).trim();
            const dotIdx = origName.lastIndexOf('.');
            if (dotIdx > 0) {
              ext = origName.substring(dotIdx + 1).toLowerCase();
              const extInfo = getFileInfo(`file.${ext}`);
              mimeType = extInfo.mimeType;
            }
          } else if (confirmInfo.isBinary) {
            ext = confirmInfo.ext;
            mimeType = confirmInfo.mimeType;
          }

          const filename = `${safeTitle}.${ext || 'bin'}`;
          const filepath = path.join(DOWNLOADS_DIR, filename);
          fs.writeFileSync(filepath, confirmBuffer);
          return {
            filename, filepath, title, url: downloadUrl,
            size: confirmBuffer.length, isBinary: true,
            mimeType: mimeType || 'application/octet-stream',
            contentBase64: confirmBuffer.toString('base64'),
            timestamp: new Date().toISOString(),
          };
        }
      }

      // Detect from content-disposition header
      const disposition = response.headers['content-disposition'] || '';
      const filenameMatch = disposition.match(/filename[*]?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      if (filenameMatch) {
        const origName = decodeURIComponent(filenameMatch[1]).trim();
        const dotIdx = origName.lastIndexOf('.');
        if (dotIdx > 0) {
          ext = origName.substring(dotIdx + 1).toLowerCase();
          const extInfo = getFileInfo(`file.${ext}`);
          mimeType = extInfo.mimeType;
        }
      }
    }

    const filename = `${safeTitle}.${ext || 'pdf'}`;
    const filepath = path.join(DOWNLOADS_DIR, filename);
    fs.writeFileSync(filepath, buffer);

    return {
      filename, filepath, title, url: downloadUrl,
      size: buffer.length, isBinary: true,
      mimeType: mimeType || 'application/octet-stream',
      contentBase64: buffer.toString('base64'),
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`[extractor] Google Drive download failed: ${e.message}`);
    // Fallback: return an HTML page with a link to the Google Drive file
    const fallbackHtml = buildGDriveFallbackHtml(title, driveInfo);
    const filename = `${safeTitle}_gdrive.html`;
    const filepath = path.join(DOWNLOADS_DIR, filename);
    fs.writeFileSync(filepath, fallbackHtml, 'utf-8');
    return {
      filename, filepath, title, url: downloadUrl,
      size: Buffer.byteLength(fallbackHtml, 'utf-8'),
      isBinary: false, content: fallbackHtml,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Build a fallback HTML page when Google Drive download fails
 */
function buildGDriveFallbackHtml(title, driveInfo) {
  let viewUrl;
  switch (driveInfo.type) {
    case 'gdoc': viewUrl = `https://docs.google.com/document/d/${driveInfo.fileId}/preview`; break;
    case 'gslides': viewUrl = `https://docs.google.com/presentation/d/${driveInfo.fileId}/embed`; break;
    case 'gsheets': viewUrl = `https://docs.google.com/spreadsheets/d/${driveInfo.fileId}/preview`; break;
    default: viewUrl = `https://drive.google.com/file/d/${driveInfo.fileId}/preview`;
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Ambilajah</title>
  <style>
    body { margin: 0; font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; height: 100vh; }
    .header { padding: 12px 24px; background: #1e293b; border-bottom: 1px solid rgba(52,211,153,0.3); display: flex; justify-content: space-between; align-items: center; }
    .header h2 { font-size: 1.1rem; margin: 0; color: #34d399; }
    .header a { color: #fbbf24; text-decoration: none; font-weight: 600; padding: 8px 16px; background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.4); border-radius: 8px; }
    .header a:hover { background: rgba(245,158,11,0.3); }
    iframe { flex: 1; border: none; width: 100%; }
  </style>
</head>
<body>
  <div class="header">
    <h2>${escapeHtml(title)}</h2>
    <a href="https://drive.google.com/uc?export=download&id=${driveInfo.fileId}" target="_blank">⬇️ Download Langsung</a>
  </div>
  <iframe src="${viewUrl}" allowfullscreen></iframe>
</body>
</html>`;
}

/**
 * Extract and clean content from a material page (Supports HTML, PDF, PPTX, DOCX, Google Drive, etc.).
 */
async function extractContent(session, materialUrl, materialTitle) {
  console.log(`[extractor] Extracting content from ${materialUrl}...`);

  // === Step 0: Check if URL is a Google Drive / Google Docs link ===
  const driveInfo = parseGoogleDriveUrl(materialUrl);
  if (driveInfo) {
    console.log(`[extractor] Google Drive link detected (${driveInfo.type}), downloading...`);
    return downloadGoogleDriveFile(driveInfo, materialTitle);
  }

  const response = await sessionRequest(session, 'GET', materialUrl);
  let html = response.data;

  // Follow redirects
  if (response.status === 302 || response.status === 301) {
    const redirectUrl = response.headers.location;
    const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`;

    // Check if redirect target is Google Drive
    const redirectDriveInfo = parseGoogleDriveUrl(fullUrl);
    if (redirectDriveInfo) {
      console.log(`[extractor] Redirected to Google Drive, downloading...`);
      return downloadGoogleDriveFile(redirectDriveInfo, materialTitle);
    }

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

  // 1a. Check ALL iframes, embeds, objects for binary files or Google Drive links
  const iframes = $('iframe, embed, object');
  for (let i = 0; i < iframes.length; i++) {
    const src = iframes.eq(i).attr('src') || iframes.eq(i).attr('data') || '';
    if (src && src !== 'about:blank') {
      const fullSrc = src.startsWith('http') ? src : `${BASE_URL}${src}`;

      // Check if iframe points to Google Drive
      const iframeDriveInfo = parseGoogleDriveUrl(fullSrc);
      if (iframeDriveInfo) {
        console.log(`[extractor] Google Drive iframe detected, downloading...`);
        return downloadGoogleDriveFile(iframeDriveInfo, materialTitle);
      }

      const fInfo = getFileInfo(fullSrc);
      if (fInfo.isBinary) {
        directFileUrl = fullSrc;
        break;
      }
    }
  }

  // 1b. Check direct file links inside page (including Google Drive links)
  if (!directFileUrl) {
    $('a[href]').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (!href || href === '#') return;

      // Check for Google Drive links in page
      const linkDriveInfo = parseGoogleDriveUrl(href);
      if (linkDriveInfo) {
        directFileUrl = href; // Will be handled separately
        return false;
      }

      if (href.includes('/files/lessons/materials/') || href.match(/\.(pdf|pptx|ppt|docx|doc|xlsx|xls|zip|rar)($|\?)/i)) {
        directFileUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        return false;
      }
    });
  }

  // If a Google Drive link was found in page links
  if (directFileUrl) {
    const pageDriveInfo = parseGoogleDriveUrl(directFileUrl);
    if (pageDriveInfo) {
      console.log(`[extractor] Google Drive link found in page, downloading...`);
      return downloadGoogleDriveFile(pageDriveInfo, materialTitle);
    }
  }

  // If a PDF/PPTX/document file was found inside iframe or page links, download the real binary file!
  if (directFileUrl) {
    const fInfo = getFileInfo(directFileUrl);
    console.log(`[extractor] Downloading real binary file from: ${directFileUrl} (${fInfo.ext})`);
    try {
      const binResponse = await sessionRequest(session, 'GET', directFileUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(binResponse.data);

      // Verify it's actually binary and not an error page
      if (buffer.length > 100) {
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
      }
    } catch (e) {
      console.log(`[extractor] Failed to fetch binary file directly, falling back to HTML: ${e.message}`);
    }
  }

  // === Step 2: HTML iframe Extraction — fetch ALL iframe content, pick the best one ===
  let materialHtml = null;
  let materialSourceUrl = null;

  for (let i = 0; i < iframes.length; i++) {
    const src = iframes.eq(i).attr('src') || '';
    if (!src || src === 'about:blank') continue;
    const iframeUrl = src.startsWith('http') ? src : `${BASE_URL}${src}`;
    try {
      const iframeResponse = await sessionRequest(session, 'GET', iframeUrl);
      if (iframeResponse.status === 200 && iframeResponse.data && typeof iframeResponse.data === 'string') {
        const iframeContent = iframeResponse.data;
        // Prefer iframe with more content (more likely to be the main material)
        if (!materialHtml || iframeContent.length > materialHtml.length) {
          materialHtml = iframeContent;
          materialSourceUrl = iframeUrl;
        }
      }
    } catch (e) {
      console.log(`[extractor] Could not fetch iframe: ${e.message}`);
    }
  }

  // === Step 3: Clean the HTML while preserving interactive buttons ===
  let finalHtml;
  if (materialHtml) {
    finalHtml = cleanMaterialHtml(materialHtml, materialTitle, materialSourceUrl);
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
 * Now also fixes ALL relative URLs (link, script, video, source, audio, img, a)
 */
function cleanMaterialHtml(html, title, sourceUrl) {
  const $ = cheerio.load(html);

  // Compute base URL from source URL for relative path resolution
  let baseUrl = BASE_URL;
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      const lastSlash = parsed.pathname.lastIndexOf('/');
      baseUrl = `${parsed.origin}${parsed.pathname.substring(0, lastSlash + 1)}`;
    } catch (e) {
      baseUrl = BASE_URL;
    }
  }

  // Helper to resolve a relative URL
  const resolveUrl = (rawUrl) => {
    if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('javascript:') || rawUrl.startsWith('mailto:') || rawUrl.startsWith('#') || rawUrl.startsWith('blob:')) return rawUrl;
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://') || rawUrl.startsWith('//')) return rawUrl;
    if (rawUrl.startsWith('/')) return `${BASE_URL}${rawUrl}`;
    return `${baseUrl}${rawUrl}`;
  };

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

  // Fix relative URLs for ALL tag types
  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', resolveUrl(src));
    const srcset = $(el).attr('srcset');
    if (srcset) {
      $(el).attr('srcset', srcset.replace(/(\S+)(\s+\S+)?/g, (match, url, descriptor) => {
        return resolveUrl(url) + (descriptor || '');
      }));
    }
  });

  $('a').each((i, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', resolveUrl(href));
  });

  // Fix link[href] — CSS stylesheets
  $('link[href]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', resolveUrl(href));
  });

  // Fix script[src]
  $('script[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', resolveUrl(src));
  });

  // Fix video, audio, source tags
  $('video[src], video[poster], audio[src], source[src]').each((i, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    if (src) $el.attr('src', resolveUrl(src));
    const poster = $el.attr('poster');
    if (poster) $el.attr('poster', resolveUrl(poster));
  });

  // Fix iframe src
  $('iframe[src]').each((i, el) => {
    const src = $(el).attr('src');
    if (src && src !== 'about:blank') $(el).attr('src', resolveUrl(src));
  });

  // Fix object data
  $('object[data]').each((i, el) => {
    const data = $(el).attr('data');
    if (data) $(el).attr('data', resolveUrl(data));
  });

  // Fix background images in inline styles
  $('[style]').each((i, el) => {
    let style = $(el).attr('style') || '';
    style = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
      return `url('${resolveUrl(url)}')`;
    });
    $(el).attr('style', style);
  });

  const styles = [];
  $('head style').each((i, el) => {
    const css = $(el).html();
    if (css && css.trim()) styles.push(css);
  });

  const linkStyles = [];
  $('link[rel="stylesheet"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href) linkStyles.push(href);
  });

  // Keep all existing scripts in the body/head for interactive buttons
  const scripts = [];
  $('script').each((i, el) => {
    const src = $(el).attr('src');
    if (src) {
      scripts.push(`<script src="${src}"><\/script>`);
    } else {
      const inlineCode = $(el).html();
      if (inlineCode && inlineCode.trim()) {
        scripts.push(`<script>${inlineCode}<\/script>`);
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
      max-width: 100%;
      height: auto;
    }
    ::selection { background: #2563eb !important; color: #ffffff !important; }
    ::-moz-selection { background: #2563eb !important; color: #ffffff !important; }
  </style>

  <!-- Authority Event Unblocker (runs in capture phase before any blocker) -->
  <script>
    (function() {
      var unblock = function(e) {
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
  <\/script>
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
    @media (max-width: 768px) {
      body { padding: 12px 16px; }
    }
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
 * List all downloaded files (including binary files like PDF, PPTX, DOCX)
 */
function listDownloads() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return [];

  // Include ALL file types, not just .html
  return fs.readdirSync(DOWNLOADS_DIR)
    .filter(f => !f.startsWith('.'))
    .map(filename => {
      const filepath = path.join(DOWNLOADS_DIR, filename);
      try {
        const stats = fs.statSync(filepath);
        if (!stats.isFile()) return null;
        return {
          filename,
          size: stats.size,
          downloadedAt: stats.mtime.toISOString(),
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
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
 * Now cleans ALL file types, not just .html
 */
function cleanupOldDownloads(maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(DOWNLOADS_DIR);
    for (const file of files) {
      if (file.startsWith('.')) continue;
      const filepath = path.join(DOWNLOADS_DIR, file);
      try {
        const stats = fs.statSync(filepath);
        if (stats.isFile() && now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filepath);
        }
      } catch (e) {
        // Ignore per-file errors
      }
    }
  } catch (e) {
    // Ignore cleanup errors
  }
}

module.exports = { extractContent, listDownloads, deleteDownload, cleanupOldDownloads, DOWNLOADS_DIR, parseGoogleDriveUrl };
