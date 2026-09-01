const axios = require('axios');
const cheerio = require('cheerio');
const tough = require('tough-cookie');
const setCookieParser = require('set-cookie-parser');
const crypto = require('crypto');

const BASE_URL = 'http://class.tiflab.my.id';

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
  return new Promise((resolve, reject) => {
    session.cookieJar.getCookieString(url, (err, cookies) => {
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

  const cookies = setCookieParser.parse(setCookieHeaders);
  for (const cookie of cookies) {
    const toughCookie = new tough.Cookie({
      key: cookie.name,
      value: cookie.value,
      domain: cookie.domain || new URL(url).hostname,
      path: cookie.path || '/',
      httpOnly: cookie.httpOnly || false,
      secure: cookie.secure || false,
      expires: cookie.expires ? new Date(cookie.expires) : 'Infinity',
    });
    await new Promise((resolve, reject) => {
      session.cookieJar.setCookie(toughCookie, url, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Generate a client fingerprint similar to what the login page does
 */
function generateFingerprint() {
  const traits = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'en-US',
    'Linux x86_64',
    '8',
    '1920x1080x24',
    'Asia/Jakarta',
    '-420',
  ].join('|');

  const hash = crypto.createHash('sha256').update(traits).digest('hex');
  return hash;
}

/**
 * Make an HTTP request with session cookies
 */
async function sessionRequest(session, method, url, options = {}) {
  const cookieString = await getCookieString(session, url);
  
  const config = {
    method,
    url,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      ...(cookieString ? { 'Cookie': cookieString } : {}),
      ...(options.headers || {}),
    },
    maxRedirects: 0,
    validateStatus: (status) => status < 500,
    ...options,
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
    const redirectUrl = loginPage.headers.location;
    if (!redirectUrl) break;
    const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`;
    console.log(`[auth] Following redirect (${loginPage.status}) to ${fullUrl}`);
    loginPage = await sessionRequest(session, 'GET', fullUrl);
  }

  return parseLoginPage(session, loginPage, username, password);
}

async function parseLoginPage(session, loginPage, username, password) {
  if (typeof loginPage.data === 'string' && (loginPage.data.includes('cf-mitigated') || loginPage.data.includes('Just a moment...') || loginPage.data.includes('Cloudflare'))) {
    console.warn('[auth] Cloudflare challenge detected in response');
  }

  const $ = cheerio.load(loginPage.data || '');
  
  // Extract CSRF token with multiple strategies
  let csrfToken = $('input[name="_token"]').val()
               || $('meta[name="csrf-token"]').attr('content');
  
  // Regex fallbacks if cheerio missed it
  if (!csrfToken && typeof loginPage.data === 'string') {
    const match1 = loginPage.data.match(/name=["']_token["']\s+value=["']([^"']+)["']/i);
    const match2 = loginPage.data.match(/value=["']([^"']+)["']\s+name=["']_token["']/i);
    const match3 = loginPage.data.match(/csrf-token["']\s+content=["']([^"']+)["']/i);
    if (match1) csrfToken = match1[1];
    else if (match2) csrfToken = match2[1];
    else if (match3) csrfToken = match3[1];
  }
  
  if (!csrfToken) {
    console.error('[auth] Login page status:', loginPage.status, 'Data preview:', String(loginPage.data).substring(0, 300));
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

  console.log('[auth] Submitting login...');
  const loginResponse = await sessionRequest(session, 'POST', `${BASE_URL}/login`, {
    data: formData.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `${BASE_URL}/login`,
      'Origin': BASE_URL,
    },
  });

  // Check if login was successful
  // Laravel redirects to /dashboard or /home on success, back to /login on failure
  if (loginResponse.status === 302) {
    const redirectLocation = loginResponse.headers.location || '';
    if (redirectLocation.includes('/login')) {
      throw new Error('Login gagal. Cek kembali NPM dan password.');
    }
    // Success — follow redirect to get updated CSRF token
    const dashUrl = redirectLocation.startsWith('http') ? redirectLocation : `${BASE_URL}${redirectLocation}`;
    const dashPage = await sessionRequest(session, 'GET', dashUrl);
    
    // Update CSRF token from dashboard
    const $dash = cheerio.load(dashPage.data);
    const newCsrf = $dash('meta[name="csrf-token"]').attr('content');
    if (newCsrf) session.csrfToken = newCsrf;
    
    session.authenticated = true;
    console.log('[auth] Login berhasil!');
    return session;
  }

  // If we get 200, check if we're on dashboard or still on login
  if (loginResponse.data && loginResponse.data.includes('Forgot your password')) {
    throw new Error('Login gagal. Cek kembali NPM dan password.');
  }

  session.authenticated = true;
  console.log('[auth] Login berhasil!');
  return session;
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
  serializeSession, 
  deserializeSession, 
  BASE_URL 
};
