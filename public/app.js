// ============================================
// AmbilAjah — Frontend Application Logic
// ============================================

// --- Application State ---
let sessionToken = null;
let currentUsername = '';
let currentCourses = [];
let currentMaterials = [];
let currentCourseName = '';

// On Vercel / Cloud, call Cloudflare Worker API directly from browser (bypasses all datacenter WAF blocks)
// On local dev, call local Express server
const CLOUD_API_BASE = 'https://ambilajah-proxy.donateme.workers.dev';
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? ''
  : CLOUD_API_BASE;

// --- API Request Helper ---
async function api(method, endpoint, body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (sessionToken) {
    options.headers['X-Session-Token'] = sessionToken;
  }

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(API_BASE + endpoint, options);
  let data;
  try {
    data = await response.json();
  } catch (e) {
    data = { error: `Server error (HTTP ${response.status})` };
  }

  if (!response.ok) {
    if (response.status === 401 && sessionToken) {
      sessionToken = null;
      currentUsername = '';
      showView('login');
      document.getElementById('user-controls').style.display = 'none';
    }
    throw new Error(data.error || `HTTP ${response.status}`);
  }

  return data;
}

// --- Toast Notifications ---
function showToast(type, title, message = '') {
  const container = document.getElementById('toast-container');
  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warning: '⚠️',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-msg">${escapeHtml(message)}</div>` : ''}
    </div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-leave');
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Password Visibility Toggle ---
function togglePassword() {
  const input = document.getElementById('input-password');
  const icon = document.getElementById('eye-icon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
  } else {
    input.type = 'password';
    icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  }
}

// --- Navigation Home ---
function goHome() {
  if (sessionToken) {
    backToCourses();
  }
}

// --- Login Flow ---
async function handleLogin(event) {
  event.preventDefault();

  const btn = document.getElementById('btn-login');
  const btnText = btn.querySelector('.btn-text');
  const btnLoader = btn.querySelector('.btn-loader');

  const username = document.getElementById('input-npm').value.trim();
  const password = document.getElementById('input-password').value;

  if (!username || !password) {
    showToast('warning', 'Lengkapi Form', 'NPM dan password wajib diisi');
    return;
  }

  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoader.style.display = 'inline-flex';

  try {
    const data = await api('POST', '/api/login', { username, password });
    sessionToken = data.token;
    currentUsername = username;

    // Save session in browser localStorage for anti-logout on refresh
    try {
      localStorage.setItem('ambilajah_session', JSON.stringify({
        token: sessionToken,
        username: currentUsername,
        timestamp: Date.now(),
      }));
    } catch (e) {
      // Storage quota or privacy mode
    }

    showToast('success', 'Login Berhasil!', `Selamat datang, ${username}`);

    document.getElementById('login-section').style.display = 'none';
    document.getElementById('dashboard-section').style.display = 'block';
    document.getElementById('user-controls').style.display = 'flex';
    document.getElementById('username-display').textContent = username;

    await loadCourses();
  } catch (error) {
    showToast('error', 'Login Gagal', error.message);
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline-flex';
    btnLoader.style.display = 'none';
  }
}

// --- Logout Flow ---
async function handleLogout() {
  try {
    await api('POST', '/api/logout');
  } catch (e) {
    // Ignore error
  }

  // Clear local storage session
  try {
    localStorage.removeItem('ambilajah_session');
  } catch (e) {
    // Ignore
  }

  sessionToken = null;
  currentUsername = '';
  currentCourses = [];
  currentMaterials = [];

  document.getElementById('login-section').style.display = 'block';
  document.getElementById('dashboard-section').style.display = 'none';
  document.getElementById('user-controls').style.display = 'none';

  document.getElementById('input-password').value = '';
  showToast('info', 'Logged out', 'Sesi telah diakhiri');
}

// --- Auto-Restore Session on Refresh ---
function initSession() {
  try {
    const saved = localStorage.getItem('ambilajah_session');
    if (!saved) return;

    const session = JSON.parse(saved);
    const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

    if (session && session.token && (Date.now() - session.timestamp < MAX_AGE_MS)) {
      sessionToken = session.token;
      currentUsername = session.username || '';

      document.getElementById('login-section').style.display = 'none';
      document.getElementById('dashboard-section').style.display = 'block';
      document.getElementById('user-controls').style.display = 'flex';
      document.getElementById('username-display').textContent = currentUsername;

      loadCourses();
    } else {
      localStorage.removeItem('ambilajah_session');
    }
  } catch (e) {
    localStorage.removeItem('ambilajah_session');
  }
}

// Auto-run on startup
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSession);
} else {
  initSession();
}

// --- Load Courses ---
async function loadCourses() {
  const container = document.getElementById('courses-list');
  container.innerHTML = `
    <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--text-muted);">
      <span class="spinner" style="width: 28px; height: 28px; border-width: 3px; border-top-color: var(--accent-light);"></span>
      <p style="margin-top: 12px; font-weight: 500;">Mengambil daftar mata kuliah dari Class.tiflab...</p>
    </div>
  `;

  try {
    const data = await api('GET', '/api/courses');
    currentCourses = data.courses;

    if (!currentCourses || currentCourses.length === 0) {
      container.innerHTML = `
        <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: var(--text-muted);">
          <p style="font-size: 1.1rem; font-weight: 600; color: var(--text-white);">Tidak ada course ditemukan</p>
          <p style="margin-top: 6px;">Pastikan akunmu sudah terdaftar/enrolled di kelas semester ini.</p>
          <button class="btn btn-secondary btn-sm" onclick="loadCourses()" style="margin-top: 16px;">Coba Lagi</button>
        </div>
      `;
      return;
    }

    container.innerHTML = currentCourses.map((course, i) => `
      <div class="course-item-card" onclick="selectCourse(${i})" tabindex="0" role="button"
           onkeydown="if(event.key==='Enter')selectCourse(${i})">
        <div class="course-item-left">
          <span class="course-icon-badge">📖</span>
          <span class="course-title">${escapeHtml(course.name)}</span>
        </div>
        <div class="course-action-hint">
          <span>Lihat Materi</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </div>
      </div>
    `).join('');

    showToast('success', 'Course Siap', `${currentCourses.length} mata kuliah ditemukan`);
  } catch (error) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; padding: 40px; text-align: center;">
        <p style="color: var(--error); font-weight: 600;">Gagal memuat course: ${escapeHtml(error.message)}</p>
        <button class="btn btn-secondary btn-sm" onclick="loadCourses()" style="margin-top: 12px;">Coba Lagi</button>
      </div>
    `;
    showToast('error', 'Gagal memuat course', error.message);
  }
}

// --- Select Course ---
async function selectCourse(index) {
  const course = currentCourses[index];
  if (!course) return;

  currentCourseName = course.name;
  document.getElementById('materials-course-name').textContent = course.name;

  document.getElementById('courses-panel').style.display = 'none';
  document.getElementById('materials-panel').style.display = 'block';

  window.scrollTo({ top: 0, behavior: 'smooth' });

  await loadMaterials(course.url);
}

// --- Prominent Back to Courses ---
function backToCourses() {
  document.getElementById('materials-panel').style.display = 'none';
  document.getElementById('courses-panel').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Load Materials ---
async function loadMaterials(courseUrl) {
  const container = document.getElementById('materials-list');
  container.innerHTML = `
    <div style="padding: 50px 20px; text-align: center; color: var(--text-muted);">
      <span class="spinner" style="width: 28px; height: 28px; border-width: 3px; border-top-color: var(--accent-light);"></span>
      <p style="margin-top: 14px; font-weight: 500;">Mengambil materi kuliah...</p>
    </div>
  `;

  try {
    const encodedUrl = btoa(courseUrl);
    const data = await api('GET', `/api/materials?url=${encodedUrl}`);
    currentMaterials = data.materials;

    if (!currentMaterials || currentMaterials.length === 0) {
      container.innerHTML = `
        <div style="padding: 40px; text-align: center; color: var(--text-muted);">
          <p style="font-size: 1.1rem; font-weight: 600; color: var(--text-white);">Tidak ada materi dalam course ini</p>
          <p style="margin-top: 6px;">Materi mungkin belum diunggah oleh dosen.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = currentMaterials.map((mat, i) => `
      <div class="material-card" id="material-item-${i}">
        <div class="material-left">
          <div class="material-icon-box">${getTypeIcon(mat.type)}</div>
          <div class="material-text">
            <div class="material-name" title="${escapeHtml(mat.title)}">${escapeHtml(mat.title)}</div>
            <div class="material-type-tag">${mat.type.toUpperCase()} MATERI</div>
          </div>
        </div>

        <div class="material-button-group">
          <button class="btn btn-secondary btn-sm" onclick="previewMaterial(${i})" title="Lihat Tampilan Materi">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>Preview</span>
          </button>
          
          <button class="btn btn-primary btn-sm" onclick="triggerDirectDownload(${i})" id="btn-dl-${i}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            <span>Download</span>
          </button>
        </div>
      </div>
    `).join('');

    showToast('success', 'Materi Ditemukan', `${currentMaterials.length} materi tersedia`);
  } catch (error) {
    container.innerHTML = `
      <div style="padding: 40px; text-align: center;">
        <p style="color: var(--error); font-weight: 600;">Gagal memuat materi: ${escapeHtml(error.message)}</p>
      </div>
    `;
    showToast('error', 'Gagal memuat materi', error.message);
  }
}

// --- DIRECT INSTANT DOWNLOAD FLOW ---
function downloadFileHelper(data) {
  if (data.isBinary && (data.base64 || data.contentBase64)) {
    const b64 = data.base64 || data.contentBase64;
    const byteCharacters = atob(b64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: data.mimeType || 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = data.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
  } else if (data.content) {
    const blob = new Blob([data.content], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = data.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
  } else {
    const downloadLink = document.createElement('a');
    downloadLink.href = `/api/downloads/${encodeURIComponent(data.filename)}`;
    downloadLink.download = data.filename;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
  }
}

function previewFileHelper(data) {
  if (data.isBinary && (data.base64 || data.contentBase64)) {
    const b64 = data.base64 || data.contentBase64;
    const byteCharacters = atob(b64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: data.mimeType || 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);
    const newTab = window.open(blobUrl, '_blank');
    if (!newTab) {
      const tempLink = document.createElement('a');
      tempLink.href = blobUrl;
      tempLink.target = '_blank';
      document.body.appendChild(tempLink);
      tempLink.click();
      tempLink.remove();
    }
  } else if (data.content) {
    const blob = new Blob([data.content], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const newTab = window.open(blobUrl, '_blank');
    if (!newTab) {
      const tempLink = document.createElement('a');
      tempLink.href = blobUrl;
      tempLink.target = '_blank';
      document.body.appendChild(tempLink);
      tempLink.click();
      tempLink.remove();
    }
  } else {
    const cleanFileUrl = `/api/downloads/${encodeURIComponent(data.filename)}`;
    const newTab = window.open(cleanFileUrl, '_blank');
    if (!newTab) {
      const tempLink = document.createElement('a');
      tempLink.href = cleanFileUrl;
      tempLink.target = '_blank';
      document.body.appendChild(tempLink);
      tempLink.click();
      tempLink.remove();
    }
  }
}

async function triggerDirectDownload(index) {
  const material = currentMaterials[index];
  if (!material) return;

  const btn = document.getElementById(`btn-dl-${index}`);
  const originalHtml = btn.innerHTML;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> <span>Mengunduh...</span>';

  try {
    const encodedUrl = btoa(material.url);
    const data = await api('POST', '/api/download', {
      url: encodedUrl,
      title: material.title,
    });

    // Directly trigger browser download!
    downloadFileHelper(data);

    btn.innerHTML = '<span>✅ Terunduh!</span>';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');

    showToast('success', 'Download Sukses!', `${material.title} langsung tersimpan di browsermu.`);

    setTimeout(() => {
      btn.innerHTML = originalHtml;
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
      btn.disabled = false;
    }, 2500);

  } catch (error) {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    showToast('error', 'Download Gagal', error.message);
  }
}

// --- Download All Materials Instantly ---
async function downloadAllMaterials() {
  if (!currentMaterials || currentMaterials.length === 0) {
    showToast('warning', 'Tidak ada materi untuk didownload');
    return;
  }

  const btn = document.getElementById('btn-download-all');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> <span>Mendownload Semua...</span>';

  let success = 0;
  let failed = 0;

  for (let i = 0; i < currentMaterials.length; i++) {
    try {
      const material = currentMaterials[i];
      const matBtn = document.getElementById(`btn-dl-${i}`);
      if (matBtn) {
        matBtn.disabled = true;
        matBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span>';
      }

      const encodedUrl = btoa(material.url);
      const data = await api('POST', '/api/download', {
        url: encodedUrl,
        title: material.title,
      });

      // Trigger direct file download in browser
      downloadFileHelper(data);

      if (matBtn) {
        matBtn.innerHTML = '<span>✅</span>';
      }
      success++;

      // Small delay between downloads to prevent browser blocking
      await new Promise(r => setTimeout(r, 400));
    } catch (error) {
      failed++;
    }
  }

  btn.disabled = false;
  btn.innerHTML = originalHtml;

  showToast(
    failed === 0 ? 'success' : 'warning',
    'Batch Download Selesai',
    `${success} file berhasil diunduh ke komputermu.`
  );
}

// --- Direct New Tab Preview Logic ---
async function previewMaterial(index) {
  const material = currentMaterials[index];
  if (!material) return;

  const matCard = document.getElementById(`material-item-${index}`);
  const previewBtn = matCard ? matCard.querySelector('button.btn-secondary') : null;
  let originalHtml = '';
  
  if (previewBtn) {
    originalHtml = previewBtn.innerHTML;
    previewBtn.disabled = true;
    previewBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> <span>Membuka...</span>';
  }

  showToast('info', 'Menyiapkan Preview', `Membuka ${material.title} di tab baru...`);

  try {
    const encodedUrl = btoa(material.url);
    const data = await api('POST', '/api/download', {
      url: encodedUrl,
      title: material.title,
    });

    // Direct open in a new tab!
    previewFileHelper(data);
  } catch (error) {
    showToast('error', 'Gagal Membuka Preview', error.message);
  } finally {
    if (previewBtn) {
      previewBtn.innerHTML = originalHtml;
      previewBtn.disabled = false;
    }
  }
}

// --- Donate Modal Logic ---
function openDonateModal() {
  document.getElementById('donate-modal').style.display = 'flex';
}

function closeDonateModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('donate-modal').style.display = 'none';
}

// --- Helper Functions ---
function getTypeIcon(type) {
  const icons = {
    html: '📝',
    pdf: '📕',
    ppt: '📊',
    doc: '📘',
    video: '🎥',
  };
  return icons[type] || '📄';
}

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDonateModal();
  }
});

// --- Initial Setup ---
window.addEventListener('DOMContentLoaded', () => {
  const npmInput = document.getElementById('input-npm');
  if (npmInput) npmInput.focus();
});
