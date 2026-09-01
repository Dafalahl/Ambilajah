const cheerio = require('cheerio');
const { sessionRequest, BASE_URL, LMS_ORIGIN, toProxyUrl } = require('./auth');

/**
 * Fetch list of courses the user is enrolled in
 * @param {object} session - Authenticated session
 * @returns {Array} List of courses with id, name, url
 */
async function getCourses(session) {
  console.log('[scraper] Fetching course list...');
  
  // Prioritize student dashboard & enrolled courses routes
  const routes = ['/dashboard', '/home', '/my-courses', '/user/courses', '/courses'];
  let html = '';
  let successUrl = '';

  for (const route of routes) {
    try {
      let response = await sessionRequest(session, 'GET', `${BASE_URL}${route}`);
      let redirectCount = 0;
      while ([301, 302, 303, 307, 308].includes(response.status) && redirectCount < 5) {
        redirectCount++;
        const redirectUrl = response.headers.location;
        if (!redirectUrl) break;
        if (redirectUrl.includes('/login')) break;
        const fullUrl = toProxyUrl(redirectUrl.startsWith('http') ? redirectUrl : `${LMS_ORIGIN}${redirectUrl}`);
        response = await sessionRequest(session, 'GET', fullUrl);
      }

      if (response.status === 200 && response.data && typeof response.data === 'string' && !response.data.includes('Sign in to your account')) {
        if (route === '/dashboard' || route === '/home' || route === '/my-courses') {
          html = response.data;
          successUrl = route;
          break;
        }
        if (!html) {
          html = response.data;
          successUrl = route;
        }
      }
    } catch (e) {
      continue;
    }
  }

  if (!html) {
    throw new Error('Tidak bisa mengakses halaman courses. Pastikan sudah login.');
  }

  console.log(`[scraper] Found courses page at ${successUrl}`);
  const rawCourses = parseCourses(html, successUrl);

  console.log('[scraper] Verifying course enrollments...');
  const checkResults = await Promise.all(
    rawCourses.map(async (course) => {
      try {
        const learnUrl = course.url.endsWith('/learn') ? course.url : `${course.url.replace(/\/+$/, '')}/learn`;
        const chkResp = await sessionRequest(session, 'GET', learnUrl);
        if (chkResp.status !== 200) return null;
        const txt = typeof chkResp.data === 'string' ? chkResp.data : '';
        const hasLessons = /\/lessons\/\d+/i.test(txt);
        const isBlocked = txt.includes('belum terdaftar') || txt.includes('tidak memiliki akses') || txt.includes('Daftar Sekarang') || txt.includes('Enroll Now');
        if (hasLessons && !isBlocked) return course;
        return null;
      } catch (e) {
        return null;
      }
    })
  );

  const authorized = checkResults.filter(Boolean);
  const finalCourses = authorized.length > 0 ? authorized : rawCourses;

  return { courses: finalCourses, rawHtml: html, pageUrl: `${BASE_URL}${successUrl}` };
}

function parseCourses(html, currentRoute = '') {
  const $ = cheerio.load(html);
  const courses = [];
  const courseMap = new Map();

  const cleanCourseName = (raw) => {
    let name = raw.replace(/\s+/g, ' ').trim();
    name = name.replace(/\s*(Start Quiz|Take Quiz|Lihat Materi|Lihat Mata Kuliah|Lanjutkan|Free Preview|\d+%\s*|\d+\s*lessons?|\d+\s*materi).*$/i, '').trim();
    name = name.replace(/\s*(Programming|Networking|Multimedia|Sistem Informasi|Teknik Informatika|Sains Data|Umum|Wajib|Pilihan)$/i, '').trim();
    return name;
  };

  const courseSelectors = [
    'a[href*="/course"]',
    'a[href*="/courses/"]',
    '.course-card a',
    '.course-item a',
    '[class*="course"] a',
    '.card a[href*="course"]',
  ];

  for (const selector of courseSelectors) {
    $(selector).each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      
      if (href.includes('/login') || href.includes('/register') || href.includes('/forgot')) return;
      if (href.includes('/logout') || href.includes('/quiz') || href === '#') return;
      
      const cleanHref = href.replace(/\/+$/, '');
      if (cleanHref.endsWith('/courses') || cleanHref.endsWith('/course') || cleanHref.endsWith('/dashboard') || cleanHref.endsWith('/home')) return;

      const card = $(el).closest('.card, [class*="card"], [class*="course"]');
      const cardText = card.text() || '';

      // If on catalog, ignore non-enrolled courses
      if (currentRoute === '/courses' && (cardText.includes('Daftar Sekarang') || cardText.includes('Enroll Now')) && !cardText.includes('Lihat Materi') && !href.includes('/learn')) {
        return;
      }

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      const idMatch = href.match(/\/courses?\/(\d+)/);
      const courseId = idMatch ? idMatch[1] : fullUrl;

      let titleAttr = $(el).attr('title') || $(el).attr('data-original-title') || $(el).find('[title]').attr('title') || $(el).parent().attr('title') || card.attr('title') || '';
      let name = $(el).find('h1, h2, h3, h4, h5, .title, .name, [class*="title"], [class*="name"]').first().text().trim() || $(el).text().trim();
      
      if (titleAttr && (name.includes('...') || titleAttr.length > name.length)) {
        name = titleAttr;
      }

      const cardTitle = card.find('h2, h3, h4, h5, .card-title, .title').first().text().trim();
      if (cardTitle && (name.includes('...') || cardTitle.length > name.length || name.toLowerCase().includes('lihat'))) {
        name = cardTitle;
      }

      name = cleanCourseName(name);
      if (!name || name.length < 2) return;

      const lowerName = name.toLowerCase();
      if (lowerName === 'courses' || lowerName === 'course' || lowerName === 'dashboard' || lowerName === 'home' || lowerName === 'all courses' || lowerName.includes('quiz')) return;

      if (!courseMap.has(courseId)) {
        courseMap.set(courseId, {
          id: courseId,
          name: name.substring(0, 300),
          url: fullUrl,
        });
      } else {
        const existing = courseMap.get(courseId);
        if (name.length > existing.name.length && !name.includes('...')) {
          existing.name = name.substring(0, 300);
        }
        if (fullUrl.includes('/learn')) {
          existing.url = fullUrl;
        }
      }
    });
  }

  for (const course of courseMap.values()) {
    courses.push(course);
  }

  // If no courses found via links, try parsing card/list structures
  if (courses.length === 0) {
    // Try to find any structured content that looks like a course listing
    $('[class*="card"], [class*="item"], [class*="list"]').each((i, el) => {
      const $el = $(el);
      const link = $el.find('a').first();
      const href = link.attr('href');
      if (!href || !href.includes('course')) return;

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);

      const name = $el.find('h2, h3, h4, h5, .title, .name, p').first().text().trim();
      const idMatch = href.match(/\/courses?\/(\d+)/);
      
      courses.push({
        id: idMatch ? idMatch[1] : href,
        name: name || `Course ${i + 1}`,
        url: fullUrl,
      });
    });
  }

  console.log(`[scraper] Found ${courses.length} courses`);
  return courses;
}

/**
 * Fetch list of materials/topics in a course
 * @param {object} session - Authenticated session
 * @param {string} courseUrl - URL of the course page
 * @returns {Array} List of materials with id, title, url, type
 */
async function getMaterials(session, courseUrl) {
  console.log(`[scraper] Fetching materials from ${courseUrl}...`);
  
  const response = await sessionRequest(session, 'GET', courseUrl);
  
  if (response.status === 302) {
    const redirectUrl = response.headers.location;
    const fullUrl = toProxyUrl(redirectUrl.startsWith('http') ? redirectUrl : `${LMS_ORIGIN}${redirectUrl}`);
    const redirected = await sessionRequest(session, 'GET', fullUrl);
    return parseMaterials(redirected.data, courseUrl);
  }
  
  if (response.status !== 200) {
    throw new Error(`Gagal mengakses course: HTTP ${response.status}`);
  }

  return parseMaterials(response.data, courseUrl);
}

/**
 * Parse material listings from course HTML
 */
function parseMaterials(html, courseUrl) {
  const $ = cheerio.load(html);
  const materials = [];
  const seen = new Set();

  // Try multiple selectors
  const matSelectors = [
    'a[href*="/material"]',
    'a[href*="/materi"]',
    'a[href*="/topic"]',
    'a[href*="/content"]',
    'a[href*="/lesson"]',
    'a[href*="/chapter"]',
    'a[href*="/section"]',
    'a[href*="/module"]',
    'a[href*="/slide"]',
    'a[href*="/view"]',
    'a[href*="/show"]',
  ];

  for (const selector of matSelectors) {
    $(selector).each((i, el) => {
      const href = $(el).attr('href');
      if (!href || href === '#') return;
      if (href.includes('/login') || href.includes('/register')) return;

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);

      let rawTitle = $(el).text().trim();
      if (!rawTitle || rawTitle.length < 2) {
        rawTitle = $(el).attr('title') || $(el).find('.title, .name, h3, h4, h5, span').first().text().trim();
      }
      let title = (rawTitle || `Materi ${materials.length + 1}`).replace(/^(\d+[\s._\-–—:]*)+/g, '').trim() || rawTitle;

      const idMatch = href.match(/\/(\d+)(?:[/?#]|$)/);

      materials.push({
        id: idMatch ? idMatch[1] : String(materials.length),
        title: title.substring(0, 300),
        url: fullUrl,
        type: 'material',
      });
    });
  }

  // Also look for any links inside content areas that might be materials
  if (materials.length === 0) {
    // Broader search — any link inside main content area
    $('main a, .content a, .container a, #app a').each((i, el) => {
      const href = $(el).attr('href');
      if (!href || href === '#') return;
      if (href.includes('/login') || href.includes('/logout') || href.includes('/register')) return;
      if (href.includes('/course') && !href.includes('/course/')) return;
      
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (seen.has(fullUrl)) return;
      if (fullUrl === courseUrl) return;
      seen.add(fullUrl);

      const title = $(el).text().trim();
      if (!title || title.length < 2 || title.length > 300) return;

      materials.push({
        id: String(materials.length),
        title,
        url: fullUrl,
        type: 'html',
      });
    });
  }

  console.log(`[scraper] Found ${materials.length} materials`);
  return { materials, rawHtml: html, pageUrl: courseUrl };
}

/**
 * Fetch a specific page's HTML content
 * @param {object} session - Authenticated session
 * @param {string} url - URL to fetch
 * @returns {string} HTML content
 */
async function fetchPage(session, url) {
  const response = await sessionRequest(session, 'GET', url);
  
  if (response.status === 302) {
    const redirectUrl = response.headers.location;
    const fullUrl = toProxyUrl(redirectUrl.startsWith('http') ? redirectUrl : `${LMS_ORIGIN}${redirectUrl}`);
    const redirected = await sessionRequest(session, 'GET', fullUrl);
    return redirected.data;
  }
  
  return response.data;
}

module.exports = { getCourses, getMaterials, fetchPage };
