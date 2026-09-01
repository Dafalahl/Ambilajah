const axios = require('axios');
const cheerio = require('cheerio');
const tough = require('tough-cookie');
const setCookieParser = require('set-cookie-parser');
const crypto = require('crypto');

const LMS_ORIGIN = 'http://class.tiflab.my.id';
const PROXY_URL = 'https://ambilajah-proxy.dafafalah1616.workers.dev/proxy';
const IS_CLOUD = !!process.env.VERCEL || !!process.env.RENDER;

// On cloud (Vercel/Render), route through Cloudflare Worker proxy to bypass Bot Fight Mode
// On local dev, connect directly to LMS for fastest response
const BASE_URL = IS_CLOUD ? PROXY_URL : LMS_ORIGIN;

/**
 * Create a new session with a cookie jar
 */
function createSession() {
  const cookieJar = new tough.CookieJar();
  return {
    cookieJar,
    csrfToken: null,
    authenticated: false,
  };
}

/**
 * Get cookies as header string from cookie jar
 */
async function getCookieString(session, url) {
  // Always use LMS origin for cookie lookups regardless of proxy
  const cookieUrl = url.replace(PROXY_URL, LMS_ORIGIN);
  return new Promise((resolve, reject) => {
    session.cookieJar.getCookieString(cookieUrl, (err, cookies) => {
      if (err) reject(err);
      else resolve(cookies);
    });
  });
}

/**
 * Store cookies from response into cookie jar
 */
async function storeCookies(session, response, url) {
  const setCookieHeaders = response.headers['set-cookie'];
  if (!setCookieHeaders) return;

  // Always store cookies under LMS origin regardless of proxy
  const cookieUrl = LMS_ORIGIN + new URL(url.replace(PROXY_URL, LMS_ORIGIN)).pathname;

  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const h of headers) {
    const clean = h.replace(/;\s*secure/gi, '');
    await new Promise((resolve) => {
      session.cookieJar.setCookie(clean, cookieUrl, { ignoreError: true }, () => resolve());
    });
  }
}

/**
 * Convert an LMS URL to proxy URL when running on cloud
 * e.g. http://class.tiflab.my.id/courses -> https://ambilajah-proxy.../proxy/courses
 */
function toProxyUrl(url) {
  if (!url) return url;
  if (IS_CLOUD) {
    return url
      .replace(/^https?:\/\/class\.tiflab\.my\.id\/?/i, PROXY_URL + '/')
      .replace(/\/\/+/g, '/') // clean double slashes
      .replace('https:/', 'https://') // restore protocol
      .replace('http:/', 'http://');
  }
  // Local: normalize to HTTP
  return url.replace(/^https:\/\/class\.tiflab\.my\.id/i, LMS_ORIGIN);
}

/**
 * Generate client fingerprint matching the login page script
 */
function generateFingerprint() {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
  const traits = [
    ua,
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

/**
 * Make an HTTP request with session cookies
 */
async function sessionRequest(session, method, rawUrl, options = {}) {
  const url = rawUrl;
  const cookieString = await getCookieString(session, url);
  
  const { headers: optHeaders, ...restOptions } = options;

  const config = {
    method,
    url,
    ...restOptions,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      ...(cookieString ? { 'Cookie': cookieString } : {}),
      ...(optHeaders || {}),
    },
    maxRedirects: 0,
    validateStatus: (status) => status < 500,
  };

  const response = await axios(config);
  await storeCookies(session, response, url);
  return response;
}

/**
 * Login to the LMS
 * @param {string} username - NPM / email
 * @param {string} password - Password
 * @returns {object} session object with cookies if successful
 */
async function login(username, password) {
  const session = createSession();

  // Step 1: GET /login to fetch CSRF token and initial cookies
  console.log('[auth] Fetching login page for CSRF token...');
  let loginPage = await sessionRequest(session, 'GET', `${BASE_URL}/login`);
  
  // Follow all redirects (301, 302, 303, 307, 308)
  let redirectCount = 0;
  while ([301, 302, 303, 307, 308].includes(loginPage.status) && redirectCount < 5) {
    redirectCount++;
    const redirectLocation = loginPage.headers.location;
    if (!redirectLocation) break;
    // Redirect URLs from LMS point to class.tiflab.my.id — rewrite through proxy on cloud
    const fullUrl = toProxyUrl(redirectLocation.startsWith('http') ? redirectLocation : `${LMS_ORIGIN}${redirectLocation}`);
    console.log(`[auth] Following redirect (${loginPage.status}) to ${fullUrl}`);
    loginPage = await sessionRequest(session, 'GET', fullUrl);
  }

  return parseLoginPage(session, loginPage, username, password);
}

async function parseLoginPage(session, loginPage, username, password) {
  const htmlContent = typeof loginPage.data === 'string'
    ? loginPage.data
    : JSON.stringify(loginPage.data || '');

  if (htmlContent.includes('cf-mitigated') || htmlContent.includes('Just a moment...') || htmlContent.includes('Cloudflare')) {
    console.warn('[auth] Cloudflare challenge detected in response');
  }

  const $ = cheerio.load(htmlContent);
  
  // Extract CSRF token with multiple strategies
  let csrfToken = $('input[name="_token"]').val()
               || $('meta[name="csrf-token"]').attr('content');
  
  // Regex fallbacks if cheerio missed it
  if (!csrfToken) {
    const match1 = htmlContent.match(/name=["']_token["']\s+value=["']([^"']+)["']/i);
    const match2 = htmlContent.match(/value=["']([^"']+)["']\s+name=["']_token["']/i);
    const match3 = htmlContent.match(/csrf-token["']\s+content=["']([^"']+)["']/i);
    if (match1) csrfToken = match1[1];
    else if (match2) csrfToken = match2[1];
    else if (match3) csrfToken = match3[1];
  }
  
  if (!csrfToken) {
    console.error('[auth] Login page status:', loginPage.status, 'Data preview:', htmlContent.substring(0, 300));
    throw new Error('CSRF token not found on login page. Periksa koneksi ke Class.tiflab.');
  }
  
  session.csrfToken = csrfToken;
  console.log('[auth] CSRF token obtained successfully');

  // Step 2: POST /login with credentials
  const fingerprint = generateFingerprint();
  
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

  const cookieHeader = await getCookieString(session, `${BASE_URL}/login`);
  const xsrfMatch = cookieHeader.match(/XSRF-TOKEN=([^;]+)/);
  const rawXsrf = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : '';

  console.log('[auth] Submitting login...');
  const loginResponse = await sessionRequest(session, 'POST', `${BASE_URL}/login`, {
    data: formData.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-TOKEN': csrfToken,
      ...(rawXsrf ? { 'X-XSRF-TOKEN': rawXsrf } : {}),
      'Referer': `${BASE_URL}/login`,
      'Origin': BASE_URL,
    },
  });

  // Strict check: Laravel ALWAYS redirects (302/303) to /dashboard or /courses on successful login
  if (loginResponse.status === 302 || loginResponse.status === 303 || loginResponse.status === 301) {
    const redirectLocation = loginResponse.headers.location || '';
    if (redirectLocation.includes('/login')) {
      throw new Error('Login gagal. NPM atau password tidak sesuai.');
    }

    // Success — follow redirect to verify and get updated CSRF token
    const dashUrl = toProxyUrl(redirectLocation.startsWith('http') ? redirectLocation : `${LMS_ORIGIN}${redirectLocation}`);
    const dashPage = await sessionRequest(session, 'GET', dashUrl);
    
    // Update CSRF token from dashboard
    const $dash = cheerio.load(dashPage.data || '');
    const newCsrf = $dash('meta[name="csrf-token"]').attr('content');
    if (newCsrf) session.csrfToken = newCsrf;
    
    session.authenticated = true;
    console.log('[auth] Login berhasil!');
    return session;
  }

  // Handle specific error status codes
  if (loginResponse.status === 422) {
    throw new Error('Login gagal. NPM atau password tidak sesuai.');
  }

  if (loginResponse.status === 419) {
    throw new Error('Sesi halaman kedaluwarsa (CSRF 419). Silakan coba lagi.');
  }

  const responseStr = typeof loginResponse.data === 'string'
    ? loginResponse.data
    : JSON.stringify(loginResponse.data || '');

  if (responseStr.includes('Forgot your password') || responseStr.includes('credentials') || responseStr.includes('Password salah')) {
    throw new Error('Login gagal. NPM atau password tidak sesuai.');
  }

  throw new Error(`Login tidak berhasil (HTTP ${loginResponse.status}). Cek kembali NPM dan password.`);
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'ambilajah-super-secure-secret-key-2026-untidar';
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt and serialize session state into a secure stateless token
 */
function serializeSession(session, username) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(SESSION_SECRET).digest();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const payload = JSON.stringify({
    cookies: session.cookieJar.toJSON(),
    csrfToken: session.csrfToken,
    username: username,
    timestamp: Date.now(),
  });

  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine iv (12) + authTag (16) + encrypted
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64url');
}

/**
 * Decrypt and deserialize stateless session token
 */
function deserializeSession(token) {
  try {
    if (!token) return null;
    const combined = Buffer.from(token, 'base64url');
    if (combined.length < 28) return null;

    const iv = combined.subarray(0, 12);
    const authTag = combined.subarray(12, 28);
    const encrypted = combined.subarray(28);

    const key = crypto.createHash('sha256').update(SESSION_SECRET).digest();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const data = JSON.parse(decrypted);

    // Strict 2-hour TTL expiration check
    const MAX_AGE_MS = 2 * 60 * 60 * 1000;
    if (Date.now() - data.timestamp > MAX_AGE_MS) {
      console.log('[auth] Session token expired (exceeded 2 hours)');
      return null;
    }

    const cookieJar = tough.CookieJar.deserializeSync(data.cookies);
    return {
      cookieJar,
      csrfToken: data.csrfToken,
      username: data.username,
      authenticated: true,
    };
  } catch (e) {
    return null;
  }
}

module.exports = { 
  login, 
  sessionRequest, 
  createSession, 
  getCookieString,
  serializeSession, 
  deserializeSession, 
  BASE_URL,
  LMS_ORIGIN,
  toProxyUrl,
};
