const cheerio = require('cheerio');
const { sessionRequest, BASE_URL } = require('./auth');

/**
 * Fetch list of courses the user is enrolled in
 * @param {object} session - Authenticated session
 * @returns {Array} List of courses with id, name, url
 */
async function getCourses(session) {
  console.log('[scraper] Fetching course list...');
  
  // Try common Laravel LMS course routes
  const routes = ['/courses', '/course', '/dashboard', '/home'];
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
        if (redirectUrl.includes('/login')) break; // redirected back to login
        const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`;
        response = await sessionRequest(session, 'GET', fullUrl);
      }

      if (response.status === 200 && response.data && typeof response.data === 'string' && !response.data.includes('Sign in to your account')) {
        html = response.data;
        successUrl = route;
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (!html) {
    throw new Error('Tidak bisa mengakses halaman courses. Pastikan sudah login.');
  }

  console.log(`[scraper] Found courses page at ${successUrl}`);
  const $ = cheerio.load(html);
  const courses = [];

  // Parse course listings - try multiple selectors for different LMS structures
  const courseSelectors = [
    'a[href*="/course"]',
    'a[href*="/courses/"]',
    '.course-card a',
    '.course-item a',
    '[class*="course"] a',
    '.card a[href*="course"]',
  ];

  const seen = new Set();

  for (const selector of courseSelectors) {
    $(selector).each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      
      // Filter out non-course links and navbar links
      if (href.includes('/login') || href.includes('/register') || href.includes('/forgot')) return;
      if (href.includes('/logout') || href === '#') return;
      
      const cleanHref = href.replace(/\/+$/, '');
      if (cleanHref.endsWith('/courses') || cleanHref.endsWith('/course') || cleanHref.endsWith('/dashboard') || cleanHref.endsWith('/home')) return;

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);

      // Extract course name: prioritize full title attributes, headings, or text
      let titleAttr = $(el).attr('title') || $(el).attr('data-original-title') || $(el).find('[title]').attr('title') || $(el).parent().attr('title') || $(el).closest('.card, [class*="card"]').attr('title') || '';
      
      let name = $(el).find('h1, h2, h3, h4, h5, .title, .name, [class*="title"], [class*="name"]').first().text().trim();
      if (!name) {
        name = $(el).text().trim();
      }
      
      // If name was truncated with ... in text but titleAttr has the full string, use titleAttr!
      if (titleAttr && (name.includes('...') || titleAttr.length > name.length)) {
        name = titleAttr;
      }

      // Check card heading
      const cardTitle = $(el).closest('.card, [class*="card"]').find('h2, h3, h4, h5, .card-title, .title').first().text().trim();
      if (cardTitle && (name.includes('...') || cardTitle.length > name.length)) {
        name = cardTitle;
      }

      name = name.replace(/\s+/g, ' ').trim();
      if (!name || name.length < 2) return;

      // Filter out generic navigation link names
      const lowerName = name.toLowerCase();
      if (lowerName === 'courses' || lowerName === 'course' || lowerName === 'dashboard' || lowerName === 'home' || lowerName === 'all courses') return;

      // Extract course ID from URL
      const idMatch = href.match(/\/courses?\/(\d+)/);
      const id = idMatch ? idMatch[1] : href;

      courses.push({
        id,
        name: name.substring(0, 300),
        url: fullUrl,
      });
    });
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
  
  // Also return raw HTML for debugging
  return { courses, rawHtml: html, pageUrl: `${BASE_URL}${successUrl}` };
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
    const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`;
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

      let title = $(el).text().trim();
      if (!title || title.length < 2) {
        title = $(el).attr('title') || $(el).find('.title, .name, h3, h4, h5, span').first().text().trim();
      }
      if (!title) title = `Materi ${materials.length + 1}`;

      // Try to detect material type from URL or icon
      let type = 'html';
      if (href.includes('.pdf')) type = 'pdf';
      else if (href.includes('.ppt') || href.includes('.pptx')) type = 'ppt';
      else if (href.includes('.doc') || href.includes('.docx')) type = 'doc';
      else if (href.includes('video') || href.includes('youtube')) type = 'video';

      const idMatch = href.match(/\/(\d+)(?:[/?#]|$)/);

      materials.push({
        id: idMatch ? idMatch[1] : String(materials.length),
        title: title.substring(0, 300),
        url: fullUrl,
        type,
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
    const fullUrl = redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`;
    const redirected = await sessionRequest(session, 'GET', fullUrl);
    return redirected.data;
  }
  
  return response.data;
}

module.exports = { getCourses, getMaterials, fetchPage };
