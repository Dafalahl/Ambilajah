/**
 * Ambilajah — Cloudflare Worker API & Bypass Proxy
 * Deploy this code in Cloudflare Dashboard -> ambilajah-proxy -> Edit code
 */

const LMS_ORIGIN = 'http://class.tiflab.my.id';
const SECRET_KEY = 'ambilajah-super-secure-secret-key-2026-untidar';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session-Token, X-Proxy-Cookie, X-CSRF-TOKEN, X-XSRF-TOKEN',
  'Access-Control-Expose-Headers': 'Set-Cookie, Location, X-Set-Cookie',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

function djb2Fingerprint() {
  const traits = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'id-ID',
    'Linux x86_64',
    '8',
    '1920x1080x24',
    'Asia/Jakarta',
    '-420',
  ].join('|');

  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < traits.length; i++) {
    const c = traits.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + c) >>> 0;
    h2 = (((h2 << 5) + h2) ^ c) >>> 0;
  }
  return h1.toString(16) + h2.toString(16);
}

// AES-256-GCM Session Token Encryption using Web Crypto API
async function getCryptoKey() {
  const enc = new TextEncoder();
  const keyData = enc.encode(SECRET_KEY);
  const hash = await crypto.subtle.digest('SHA-256', keyData);
  return await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSession(data) {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(data))
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  let binary = '';
  for (let i = 0; i < combined.length; i++) {
    binary += String.fromCharCode(combined[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decryptSession(token) {
  try {
    if (!token) return null;
    let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length < 28) return null;

    const iv = bytes.subarray(0, 12);
    const encrypted = bytes.subarray(12);
    const key = await getCryptoKey();
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (e) {
    return null;
  }
}

function parseCookiesFromHeaders(headers) {
  const map = new Map();
  let rawList = [];

  if (typeof headers.getSetCookie === 'function') {
    rawList = headers.getSetCookie();
  } else if (typeof headers.getAll === 'function') {
    rawList = headers.getAll('set-cookie');
  } else {
    const raw = headers.get('set-cookie') || '';
    rawList = raw ? [raw] : [];
  }

  for (const h of rawList) {
    const firstPart = h.split(';')[0];
    if (firstPart) {
      const idx = firstPart.indexOf('=');
      if (idx !== -1) {
        const key = firstPart.substring(0, idx).trim();
        const val = firstPart.substring(idx + 1).trim();
        if (key && val) {
          map.set(key, val);
        }
      }
    }
  }

  const out = [];
  for (const [k, v] of map.entries()) {
    out.push(`${k}=${v}`);
  }
  return out.join('; ');
}

function mergeCookieStrings(oldCookies = '', newCookies = '') {
  const map = new Map();
  const parse = (str) => {
    if (!str) return;
    str.split(';').forEach(pair => {
      const [k, ...v] = pair.trim().split('=');
      if (k) map.set(k.trim(), v.join('='));
    });
  };
  parse(oldCookies);
  parse(newCookies);
  const out = [];
  for (const [k, v] of map.entries()) {
    out.push(`${k}=${v}`);
  }
  return out.join('; ');
}

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

// Clean right-click locks while preserving ALL interactive scripts, buttons, tabs, and slide controls
function cleanHtmlContent(html, title, baseUrl = LMS_ORIGIN) {
  if (!html) return '';

  let cleaned = html;

  // 1. Inject <base href="..."> so all relative slide scripts, fonts, images, and CSS load from LMS origin
  const baseTag = `<base href="${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}">`;
  if (cleaned.includes('<head>')) {
    cleaned = cleaned.replace('<head>', `<head>\n  ${baseTag}`);
  } else if (cleaned.includes('<head ')) {
    cleaned = cleaned.replace(/<head[^>]*>/i, `$&\n  ${baseTag}`);
  } else {
    cleaned = `${baseTag}\n${cleaned}`;
  }

  // 2. Remove ONLY inline blocker attributes (DO NOT remove any <script> tags so slide/booklet controllers run 100%)
  cleaned = cleaned
    .replace(/\soncontextmenu\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\sonselectstart\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\sondragstart\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\soncopy\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\soncut\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\sonpaste\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\sunselectable\s*=\s*["'][^"']*["']/gi, '');

  // 3. Remove ONLY invisible protection overlay and dev warning (DO NOT touch controls or slide structures)
  cleaned = cleaned
    .replace(/<div\s+[^>]*class=["'][^"']*(?:scroll-indicator|dev-warning)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<div\s+[^>]*id=["']devWarning["'][^>]*>[\s\S]*?<\/div>/gi, '');

  // 4. Force user-select in all CSS without breaking slide transitions
  cleaned = cleaned
    .replace(/user-select\s*:\s*none\s*(!important)?;/gi, 'user-select: text !important;')
    .replace(/-webkit-user-select\s*:\s*none\s*(!important)?;/gi, '-webkit-user-select: text !important;')
    .replace(/-moz-user-select\s*:\s*none\s*(!important)?;/gi, '-moz-user-select: text !important;')
    .replace(/-ms-user-select\s*:\s*none\s*(!important)?;/gi, '-ms-user-select: text !important;');

  // 5. Inject guaranteed selection styles & authoritative capture-phase event unblocker
  const cleanHeadInject = `
  <style>
    *, *::before, *::after {
      -webkit-user-select: text !important;
      -moz-user-select: text !important;
      -ms-user-select: text !important;
      user-select: text !important;
      -webkit-touch-callout: default !important;
    }
    button, input, select, textarea, a, .btn, .control-btn, .next-btn, .prev-btn, [role="button"], [onclick], .navigate-left, .navigate-right, .navigate-up, .navigate-down, .controls button {
      pointer-events: auto !important;
      cursor: pointer !important;
    }
    img {
      pointer-events: auto !important;
      -webkit-user-drag: auto !important;
    }
    ::selection { background: #2563eb !important; color: #ffffff !important; }
    ::-moz-selection { background: #2563eb !important; color: #ffffff !important; }
    .scroll-indicator, #devWarning { display: none !important; }
  </style>
  <script>
    (function() {
      // Capture phase unblocker: intercepts and stops anti-copy blockers before they run, leaving all slide controls 100% working
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
        if (document.body) {
          document.body.oncontextmenu = null;
          document.body.onselectstart = null;
          document.body.ondragstart = null;
        }
      });
    })();
  </script>
`;

  if (cleaned.includes('</head>')) {
    cleaned = cleaned.replace('</head>', `${cleanHeadInject}</head>`);
  } else {
    cleaned = `${cleanHeadInject}${cleaned}`;
  }

  return cleaned;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'AmbilAjah Cloudflare Worker API' });
    }

    // ==========================================
    // 1. POST /api/login
    // ==========================================
    if (url.pathname === '/api/login' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { username, password } = body;

        if (!username || !password) {
          return jsonResponse({ error: 'NPM dan password wajib diisi.' }, 400);
        }

        // Fetch /login page for CSRF token & initial cookies
        const loginPageRes = await fetch(`${LMS_ORIGIN}/login`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
          },
          redirect: 'manual',
        });

        const initialCookies = parseCookiesFromHeaders(loginPageRes.headers);
        const loginHtml = await loginPageRes.text();

        const tokenMatch = loginHtml.match(/name=["']_token["']\s+value=["']([^"']+)["']/i) 
                        || loginHtml.match(/value=["']([^"']+)["']\s+name=["']_token["']/i)
                        || loginHtml.match(/csrf-token["']\s+content=["']([^"']+)["']/i);
        const csrfToken = tokenMatch ? tokenMatch[1] : '';

        if (!csrfToken) {
          return jsonResponse({ error: 'CSRF token not found on login page.' }, 500);
        }

        // POST credentials to LMS
        const xsrfMatch = initialCookies.match(/XSRF-TOKEN=([^;]+)/);
        const rawXsrf = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : '';
        const fingerprint = djb2Fingerprint();

        const formData = new URLSearchParams({
          _token: csrfToken,
          email: username,
          password: password,
          remember: 'on',
          client_screen_width: '1920',
          client_screen_height: '1080',
          client_timezone: 'Asia/Jakarta',
          client_fingerprint: fingerprint,
        });

        const postRes = await fetch(`${LMS_ORIGIN}/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': initialCookies,
            'X-CSRF-TOKEN': csrfToken,
            ...(rawXsrf ? { 'X-XSRF-TOKEN': rawXsrf } : {}),
            'Referer': `${LMS_ORIGIN}/login`,
            'Origin': LMS_ORIGIN,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
          body: formData.toString(),
          redirect: 'manual',
        });

        const postCookies = parseCookiesFromHeaders(postRes.headers);
        const allCookies = mergeCookieStrings(initialCookies, postCookies);

        // Success condition: Laravel redirects (302/301/303) away from /login
        if (postRes.status === 302 || postRes.status === 301 || postRes.status === 303) {
          const loc = postRes.headers.get('location') || '';
          if (loc.includes('/login')) {
            return jsonResponse({ error: 'Login gagal. NPM atau password tidak sesuai.' }, 401);
          }

          // Follow redirect to dashboard to get fresh CSRF & final session cookies
          const dashUrl = loc.startsWith('http') ? loc : `${LMS_ORIGIN}${loc}`;
          const dashRes = await fetch(dashUrl, {
            headers: {
              'Cookie': allCookies,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
            redirect: 'manual',
          });

          const dashCookies = parseCookiesFromHeaders(dashRes.headers);
          const finalCookies = mergeCookieStrings(allCookies, dashCookies);
          const dashHtml = await dashRes.text();
          const newCsrfMatch = dashHtml.match(/csrf-token["']\s+content=["']([^"']+)["']/i);
          const finalCsrf = newCsrfMatch ? newCsrfMatch[1] : csrfToken;

          const sessionPayload = {
            cookies: finalCookies,
            csrfToken: finalCsrf,
            username: username,
            timestamp: Date.now(),
          };

          const token = await encryptSession(sessionPayload);
          return jsonResponse({
            success: true,
            message: 'Login berhasil!',
            token,
            username,
          });
        }

        return jsonResponse({ error: 'Login gagal. NPM atau password tidak sesuai.' }, 401);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // ==========================================
    // 2. GET /api/courses
    // ==========================================
    if (url.pathname === '/api/courses' && request.method === 'GET') {
      try {
        const sessionToken = request.headers.get('x-session-token');
        const session = await decryptSession(sessionToken);
        if (!session) return jsonResponse({ error: 'Belum login atau sesi telah berakhir.' }, 401);

        const routes = ['/courses', '/course', '/dashboard', '/home'];
        let html = '';

        for (const r of routes) {
          try {
            let resp = await fetch(`${LMS_ORIGIN}${r}`, {
              headers: {
                'Cookie': session.cookies,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
              },
              redirect: 'manual',
            });

            if (resp.status === 302 || resp.status === 301 || resp.status === 303) {
              const redirectLoc = resp.headers.get('location');
              if (redirectLoc && !redirectLoc.includes('/login')) {
                const fullRedirect = redirectLoc.startsWith('http') ? redirectLoc : `${LMS_ORIGIN}${redirectLoc}`;
                resp = await fetch(fullRedirect, {
                  headers: {
                    'Cookie': session.cookies,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                  },
                  redirect: 'manual',
                });
              }
            }

            if (resp.status === 200) {
              const txt = await resp.text();
              const isLoginPage = txt.includes('type="password"') || txt.includes('name="password"') || (txt.includes('id="password"') && txt.includes('/login'));
              if (!isLoginPage && txt.length > 500) {
                html = txt;
                break;
              }
            }
          } catch (e) {
            // continue
          }
        }

        if (!html) {
          return jsonResponse({ error: 'Tidak bisa mengakses halaman courses. Pastikan sudah login.' }, 500);
        }

        const courses = [];
        const seen = new Set();

        // Strategy 1: Match structured Cards with title outside <a> tag
        const cardRegex = /<div\s+[^>]*class=["']([^"']*(?:card|course-item|course-box|course)[^"']*)["'][^>]*>([\s\S]*?)<\/div\s*>/gi;
        let cm;
        while ((cm = cardRegex.exec(html)) !== null) {
          const cardBlock = cm[2];
          const linkMatch = cardBlock.match(/href=["']([^"']*\/courses?\/[^"']*)["']/i);
          if (!linkMatch) continue;

          const href = linkMatch[1];
          if (href.includes('/login') || href.includes('/logout') || href.includes('/register') || href === '#') continue;
          const cleanHref = href.replace(/\/+$/, '');
          if (cleanHref.endsWith('/courses') || cleanHref.endsWith('/course') || cleanHref.endsWith('/dashboard')) continue;

          const fullUrl = href.startsWith('http') ? href : `${LMS_ORIGIN}${href}`;
          if (seen.has(fullUrl)) continue;

          const headingMatch = cardBlock.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
                            || cardBlock.match(/class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\//i);
          let title = headingMatch ? headingMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
          title = title.replace(/\s+/g, ' ').trim();

          if (title && title.length >= 2 && !title.toLowerCase().includes('courses') && !title.toLowerCase().includes('dashboard')) {
            seen.add(fullUrl);
            const idMatch = href.match(/\/courses?\/(\d+)/);
            courses.push({ id: idMatch ? idMatch[1] : href, name: title, url: fullUrl });
          }
        }

        // Strategy 2: Match all remaining direct <a> course links
        const aRegex = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
        let am;
        while ((am = aRegex.exec(html)) !== null) {
          const attrs = am[1];
          const inner = am[2];
          const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
          if (!hrefMatch) continue;
          const href = hrefMatch[1];
          if (!href.includes('/course') && !href.includes('/courses/')) continue;
          if (href.includes('/login') || href.includes('/logout') || href.includes('/register') || href.includes('/forgot') || href === '#') continue;
          const cleanHref = href.replace(/\/+$/, '');
          if (cleanHref.endsWith('/courses') || cleanHref.endsWith('/course') || cleanHref.endsWith('/dashboard') || cleanHref.endsWith('/home')) continue;

          const fullUrl = href.startsWith('http') ? href : `${LMS_ORIGIN}${href}`;
          if (seen.has(fullUrl)) continue;

          const titleAttr = (attrs.match(/title=["']([^"']+)["']/i) || [])[1] || '';
          const heading = (inner.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i) || [])[1] || '';
          let name = (heading || titleAttr || inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          name = name.replace(/\s*(Start Quiz|Take Quiz|Lihat Materi|Lihat Mata Kuliah|Free Preview|\d+%\s*|\d+\s*lessons?|\d+\s*materi).*$/i, '').trim();

          if (name && name.length >= 2 && !name.toLowerCase().includes('courses') && !name.toLowerCase().includes('dashboard')) {
            seen.add(fullUrl);
            const idMatch = href.match(/\/courses?\/(\d+)/);
            courses.push({ id: idMatch ? idMatch[1] : href, name, url: fullUrl });
          }
        }

        if (courses.length === 0) {
          return jsonResponse({ error: 'Tidak ada course ditemukan. Pastikan akunmu sudah terdaftar di kelas.' }, 404);
        }

        return jsonResponse({ success: true, courses });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // ==========================================
    // 3. GET /api/materials
    // ==========================================
    if (url.pathname === '/api/materials' && request.method === 'GET') {
      try {
        const sessionToken = request.headers.get('x-session-token');
        const session = await decryptSession(sessionToken);
        if (!session) return jsonResponse({ error: 'Belum login.' }, 401);

        const rawUrl = url.searchParams.get('url');
        if (!rawUrl) return jsonResponse({ error: 'URL mata kuliah diperlukan.' }, 400);

        let courseUrl = rawUrl;
        try {
          if (!rawUrl.startsWith('http')) {
            courseUrl = atob(rawUrl);
          }
        } catch (e) {}

        const learnUrl = courseUrl.endsWith('/learn') ? courseUrl : `${courseUrl.replace(/\/+$/, '')}/learn`;
        const resp = await fetch(learnUrl, {
          headers: {
            'Cookie': session.cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
          redirect: 'manual',
        });

        const html = await resp.text();
        const materials = [];
        const seen = new Set();
        const lessonRegex = /<a\s+[^>]*href=["']([^"']*\/lessons\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        let index = 1;

        while ((match = lessonRegex.exec(html)) !== null) {
          const href = match[1];
          const inner = match[3];
          const fullUrl = href.startsWith('http') ? href : `${LMS_ORIGIN}${href}`;
          if (seen.has(fullUrl)) continue;
          seen.add(fullUrl);

          let rawTitle = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          let title = rawTitle.replace(/^(\d+[\s._\-–—:]*)+/g, '').trim() || rawTitle;

          materials.push({
            id: match[2],
            index: index++,
            title: title || `Materi ${index}`,
            url: fullUrl,
            type: 'material',
          });
        }

        const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([\s\S]*?)<\/title>/i);
        const courseTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Mata Kuliah';

        return jsonResponse({ success: true, materials, courseTitle });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // ==========================================
    // 4. POST /api/download
    // ==========================================
    if (url.pathname === '/api/download' && request.method === 'POST') {
      try {
        const sessionToken = request.headers.get('x-session-token');
        const session = await decryptSession(sessionToken);
        if (!session) return jsonResponse({ error: 'Belum login.' }, 401);

        const body = await request.json();
        let lessonUrl = body.url;
        try {
          if (!lessonUrl.startsWith('http')) {
            lessonUrl = atob(lessonUrl);
          }
        } catch (e) {}

        let title = body.title || 'Materi_Kuliah';
        title = title.replace(/^(\d+[\s._\-–—:]*)+/g, '').trim() || title;
        const safeTitle = title.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').substring(0, 70);

        // Check if lessonUrl directly targets a binary file
        const directFileInfo = getFileInfo(lessonUrl);
        if (directFileInfo.isBinary) {
          const fileResp = await fetch(lessonUrl, {
            headers: {
              'Cookie': session.cookies,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
          });
          const arrayBuffer = await fileResp.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }
          const base64 = btoa(binary);
          const filename = `${safeTitle}.${directFileInfo.ext}`;
          return jsonResponse({
            success: true,
            filename,
            isBinary: true,
            mimeType: directFileInfo.mimeType,
            base64,
            title,
          });
        }

        const lessonResp = await fetch(lessonUrl, {
          headers: {
            'Cookie': session.cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
          redirect: 'manual',
        });

        const lessonHtml = await lessonResp.text();

        // 1. Search for binary download links or iframe/embed/object
        let targetBinaryUrl = null;

        const iframeMatch = lessonHtml.match(/<(?:iframe|embed|object)\s+[^>]*(?:src|data)=["']([^"']+)["']/i);
        if (iframeMatch && iframeMatch[1] && iframeMatch[1] !== 'about:blank') {
          const rawSrc = iframeMatch[1];
          const fullSrc = rawSrc.startsWith('http') ? rawSrc : `${LMS_ORIGIN}${rawSrc}`;
          const fInfo = getFileInfo(fullSrc);
          if (fInfo.isBinary) {
            targetBinaryUrl = fullSrc;
          }
        }

        if (!targetBinaryUrl) {
          const linkMatch = lessonHtml.match(/href=["']([^"']*(?:\/files\/lessons\/materials\/|\.(?:pdf|pptx|ppt|docx|doc|zip|rar))[^"']*)["']/i);
          if (linkMatch && linkMatch[1]) {
            const rawLink = linkMatch[1];
            targetBinaryUrl = rawLink.startsWith('http') ? rawLink : `${LMS_ORIGIN}${rawLink}`;
          }
        }

        // If a binary file (PDF/PPTX/etc.) is found, fetch it as binary ArrayBuffer!
        if (targetBinaryUrl) {
          const fInfo = getFileInfo(targetBinaryUrl);
          const binResp = await fetch(targetBinaryUrl, {
            headers: {
              'Cookie': session.cookies,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
          });
          const arrayBuffer = await binResp.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
          }
          const base64 = btoa(binary);
          const filename = `${safeTitle}.${fInfo.ext}`;
          return jsonResponse({
            success: true,
            filename,
            isBinary: true,
            mimeType: fInfo.mimeType,
            base64,
            title,
          });
        }

        // 2. Otherwise handle as HTML (iframe content or direct page content)
        let finalHtml = '';
        if (iframeMatch && iframeMatch[1] && iframeMatch[1] !== 'about:blank') {
          const iframeSrc = iframeMatch[1];
          const iframeUrl = iframeSrc.startsWith('http') ? iframeSrc : `${LMS_ORIGIN}${iframeSrc}`;
          const iframeResp = await fetch(iframeUrl, {
            headers: {
              'Cookie': session.cookies,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
            redirect: 'manual',
          });
          const rawIframeHtml = await iframeResp.text();

          // Calculate base directory URL for slide assets (images, CSS, JS frameworks)
          let materialBaseUrl = LMS_ORIGIN;
          const lastSlash = iframeUrl.lastIndexOf('/');
          if (lastSlash !== -1) {
            materialBaseUrl = iframeUrl.substring(0, lastSlash + 1);
          }

          finalHtml = cleanHtmlContent(rawIframeHtml, title, materialBaseUrl);
        } else {
          finalHtml = cleanHtmlContent(lessonHtml, title, LMS_ORIGIN);
        }

        const filename = `${safeTitle}.html`;

        return jsonResponse({
          success: true,
          filename,
          isBinary: false,
          content: finalHtml,
          title,
        });
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // ==========================================
    // 5. POST /api/logout
    // ==========================================
    if (url.pathname === '/api/logout') {
      return jsonResponse({ success: true, message: 'Logged out.' });
    }

    // ==========================================
    // 6. Transparent /proxy/* Handler
    // ==========================================
    if (url.pathname.startsWith('/proxy/')) {
      const targetPath = url.pathname.replace('/proxy/', '');
      const targetUrl = `${LMS_ORIGIN}/${targetPath}${url.search}`;

      const cleanHeaders = new Headers();
      cleanHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
      cleanHeaders.set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
      cleanHeaders.set('Accept-Language', 'id-ID,id;q=0.9,en-US;q=0.8');

      const cookie = request.headers.get('cookie') || request.headers.get('x-proxy-cookie');
      if (cookie) cleanHeaders.set('Cookie', cookie);

      const proxyReq = new Request(targetUrl, {
        method: request.method,
        headers: cleanHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'manual',
      });

      const response = await fetch(proxyReq);
      const resHeaders = new Headers(response.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => resHeaders.set(k, v));

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: resHeaders,
      });
    }

    return jsonResponse({ error: 'Endpoint not found.' }, 404);
  }
};
