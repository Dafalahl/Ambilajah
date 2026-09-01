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

// Clean right-click locks & protect scripts from downloaded HTML
function cleanHtmlContent(html, title) {
  if (!html) return '';
  let cleaned = html
    .replace(/oncontextmenu\s*=\s*["'][^"']*["']/gi, '')
    .replace(/onselectstart\s*=\s*["'][^"']*["']/gi, '')
    .replace(/ondragstart\s*=\s*["'][^"']*["']/gi, '')
    .replace(/oncopy\s*=\s*["'][^"']*["']/gi, '')
    .replace(/onkeydown\s*=\s*["'][^"']*["']/gi, '')
    .replace(/user-select\s*:\s*none\s*;?/gi, 'user-select: auto !important;')
    .replace(/-webkit-user-select\s*:\s*none\s*;?/gi, '-webkit-user-select: auto !important;')
    .replace(/-moz-user-select\s*:\s*none\s*;?/gi, '-moz-user-select: auto !important;');

  const banner = `
<!-- AmbilAjah Cleaned Material: ${title || 'Materi Kuliah'} -->
<style>
  * { user-select: auto !important; -webkit-user-select: auto !important; -moz-user-select: auto !important; }
  body { padding-top: 10px !important; }
  .ambilajah-banner {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    color: white; padding: 10px 18px; border-radius: 8px; font-family: sans-serif;
    font-size: 13px; margin: 12px auto; max-width: 96%; display: flex;
    justify-content: space-between; align-items: center; box-shadow: 0 4px 12px rgba(16,185,129,0.25);
  }
</style>
<div class="ambilajah-banner">
  <span>🎓 <strong>AmbilAjah</strong> — Materi ini telah dibebaskan dari proteksi lock & siap di-copy/split-screen.</span>
  <span>✨ Class.tiflab Helper</span>
</div>
`;

  if (cleaned.includes('<body')) {
    cleaned = cleaned.replace(/<body[^>]*>/i, `$&${banner}`);
  } else {
    cleaned = `${banner}${cleaned}`;
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

          // Follow redirect to dashboard to get fresh CSRF
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

        const routes = ['/courses', '/course', '/dashboard'];
        let html = '';

        for (const r of routes) {
          let resp = await fetch(`${LMS_ORIGIN}${r}`, {
            headers: {
              'Cookie': session.cookies,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            },
            redirect: 'manual',
          });

          // Follow redirect if redirected to /dashboard or /courses
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
            if (!txt.includes('Sign in to your account') && !txt.includes('name="_token"')) {
              html = txt;
              break;
            }
          }
        }

        if (!html) {
          return jsonResponse({ error: 'Tidak bisa mengakses halaman courses. Pastikan sudah login.' }, 500);
        }

        // Parse courses
        const courses = [];
        const seen = new Set();
        const linkRegex = /<a\s+[^>]*href=["']([^"']*\/courses?\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;

        while ((match = linkRegex.exec(html)) !== null) {
          const href = match[1];
          const id = match[2];
          const inner = match[3];

          if (href.includes('/login') || href.includes('/logout') || href.includes('/register')) continue;
          const fullUrl = href.startsWith('http') ? href : `${LMS_ORIGIN}${href}`;
          if (seen.has(fullUrl)) continue;
          seen.add(fullUrl);

          let name = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (name && name.length >= 2 && !name.toLowerCase().includes('all courses')) {
            courses.push({ id, name, url: fullUrl });
          }
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

          let title = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          materials.push({
            id: match[2],
            index: index++,
            title: title || `Materi ${index}`,
            url: fullUrl,
            type: 'html',
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

        const title = body.title || 'Materi_Kuliah';

        const lessonResp = await fetch(lessonUrl, {
          headers: {
            'Cookie': session.cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          },
          redirect: 'manual',
        });

        const lessonHtml = await lessonResp.text();

        // Search for iframe material
        const iframeMatch = lessonHtml.match(/<iframe\s+[^>]*src=["']([^"']+)["']/i);
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
          finalHtml = cleanHtmlContent(rawIframeHtml, title);
        } else {
          finalHtml = cleanHtmlContent(lessonHtml, title);
        }

        const safeTitle = title.replace(/[^a-zA-Z0-9\s\-_]/g, '').replace(/\s+/g, '_').substring(0, 60);
        const filename = `${safeTitle}.html`;

        return jsonResponse({
          success: true,
          filename,
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
