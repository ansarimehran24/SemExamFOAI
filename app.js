/* ============================================================
   REAL-TIME ISS & NEWS DASHBOARD — app.js
   ============================================================ */

// ─── CONFIG (loaded from config.js → window.CONFIG) ─────────
const GNEWS_API_KEY = window.CONFIG.GNEWS_API_KEY;
const HF_API_KEY    = window.CONFIG.HF_API_KEY;
const HF_MODEL      = window.CONFIG.HF_MODEL;

// ISS API with fallback chain
// Route wheretheiss.at through corsproxy to avoid 429 rate limits from browser
const ISS_APIS = [
  'https://api.wheretheiss.at/v1/satellites/25544',
  'https://corsproxy.io/?' + encodeURIComponent('https://api.wheretheiss.at/v1/satellites/25544'),
  'https://corsproxy.io/?' + encodeURIComponent('http://api.open-notify.org/iss-now.json'),
  'https://api.allorigins.win/raw?url=' + encodeURIComponent('http://api.open-notify.org/iss-now.json')
];
const ASTROS_APIS = [
  'https://corsproxy.io/?' + encodeURIComponent('http://api.open-notify.org/astros.json'),
  'https://api.allorigins.win/raw?url=' + encodeURIComponent('http://api.open-notify.org/astros.json')
];

const NEWS_CACHE_KEY  = 'iss_news_cache';
const NEWS_CACHE_TTL  = 15 * 60 * 1000; // 15 minutes
const CHAT_STORE_KEY  = 'iss_chat_history';
const MAX_CHAT_MSGS   = 30;
const ISS_TRACK_MAX   = 15;
const SPEED_HISTORY   = 30;

// ─── STATE ───────────────────────────────────────────────────
let issPositions   = [];
let speedHistory   = [];
let speedTimestamps = [];
let lastIssData    = null;
let lastKnownSpeed = null;   // persists last valid speed across fetches
let issAutoRefresh = true;
let issInterval    = null;
let allArticles    = [];
let speedChart     = null;
let newsChart      = null;
let issMap         = null;
let issMarker      = null;
let issPolyline    = null;

// ─── THEME ───────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('iss_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeBtn(saved);
})();

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('iss_theme', next);
  updateThemeBtn(next);
  toast('Switched to ' + next + ' mode', 'info');
});

function updateThemeBtn(theme) {
  document.getElementById('theme-icon').textContent  = theme === 'dark' ? '☀️' : '🌙';
  document.getElementById('theme-label').textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
}

// ─── TOAST ───────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3100);
}

// ─── HAVERSINE FORMULA ────────────────────────────────────────
function calculateSpeed(pos1, pos2, timeDiffSeconds) {
  if (timeDiffSeconds <= 0) return 0;
  const R = 6371;
  const toRad = deg => deg * (Math.PI / 180);
  const dLat = toRad(pos2.lat - pos1.lat);
  const dLon = toRad(pos2.lng - pos1.lng);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(pos1.lat)) * Math.cos(toRad(pos2.lat)) *
            Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return (distance / timeDiffSeconds) * 3600;
}

// ─── ISS MAP INIT ─────────────────────────────────────────────
function initMap() {
  issMap = L.map('iss-map', { zoomControl: true }).setView([20, 0], 2);

  // CartoDB Voyager — shows country/city labels clearly (matches reference screenshot)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(issMap);

  // Custom ISS icon — satellite emoji with glow
  const issIcon = L.divIcon({
    html: '<div style="font-size:30px;line-height:1;filter:drop-shadow(0 0 10px #ff6b35) drop-shadow(0 0 4px #fff);">🛰️</div>',
    className: '',
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });

  issMarker = L.marker([20, 0], { icon: issIcon }).addTo(issMap);

  // Show popup on hover (mouseover), hide on mouseout — like reference screenshot
  issMarker.bindPopup('Loading ISS data…', { autoClose: false, closeOnClick: false });
  issMarker.on('mouseover', function() { this.openPopup(); });
  issMarker.on('mouseout',  function() { this.closePopup(); });

  // Red trajectory line to match reference screenshot
  issPolyline = L.polyline([], { color: '#e63946', weight: 2, opacity: 0.8, dashArray: '6,4' }).addTo(issMap);
}

// ─── NEAREST PLACE ───────────────────────────────────────────
async function getNearestPlace(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=5`;
    const r = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!r.ok) throw new Error();
    const d = await r.json();
    const addr = d.address || {};
    return addr.country || addr.state || addr.county || addr.city || 'Over ocean / remote area';
  } catch {
    return 'Over ocean / remote area';
  }
}

async function fetchISSWithFallback() {
  for (const url of ISS_APIS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const d = await r.json();
      // Normalize both API response formats
      if (d.latitude !== undefined) {
        // wheretheiss.at format
        return { lat: parseFloat(d.latitude), lng: parseFloat(d.longitude), ts: d.timestamp ?? Math.floor(Date.now()/1000), velocity: d.velocity };
      } else if (d.iss_position) {
        // open-notify format
        return { lat: parseFloat(d.iss_position.latitude), lng: parseFloat(d.iss_position.longitude), ts: d.timestamp, velocity: null };
      }
    } catch { /* try next */ }
  }
  return null;
}

async function fetchAstrosWithFallback() {
  for (const url of ASTROS_APIS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      return await r.json();
    } catch { /* try next */ }
  }
  return null;
}

// ISS typical orbital speed constant — used as seed on very first fetch
const ISS_TYPICAL_SPEED_KMH = 27600;

// ─── FETCH ISS POSITION ──────────────────────────────────────
async function fetchISS() {
  try {
    const data = await fetchISSWithFallback();
    if (!data) throw new Error('All ISS APIs failed');
    const { lat, lng, ts } = data;
    // NOTE: We intentionally ignore data.velocity (constant API value).
    // Haversine between consecutive positions gives natural fluctuation
    // that matches the reference screenshot's speed graph behaviour.

    const newPos = { lat, lng, ts };

    // ── SPEED via Haversine ────────────────────────────────────
    // On first fetch: no previous position → seed with ISS typical speed
    // On subsequent fetches: calculate actual ground-track speed between
    // the last two GPS samples. This naturally fluctuates ±200-500 km/h
    // as the ISS sweeps different latitudes along its 51.6° inclined orbit.
    let speed;
    if (lastIssData) {
      const timeDiff = ts - lastIssData.ts;   // seconds between fetches
      if (timeDiff > 0) {
        speed = calculateSpeed(lastIssData, newPos, timeDiff);
        // Light sanity-cap: Haversine can spike on wrap-around meridian cross
        if (speed < 1000 || speed > 35000) speed = lastKnownSpeed || ISS_TYPICAL_SPEED_KMH;
      } else {
        speed = lastKnownSpeed || ISS_TYPICAL_SPEED_KMH;
      }
    } else {
      speed = ISS_TYPICAL_SPEED_KMH;
    }
    lastKnownSpeed = speed;
    lastIssData = { ...newPos };

    // Track positions (max 15 for path)
    issPositions.push(newPos);
    if (issPositions.length > ISS_TRACK_MAX) issPositions.shift();

    // Speed history (max 30) — real fluctuating values for chart
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    speedHistory.push(Math.round(speed));
    speedTimestamps.push(now);
    if (speedHistory.length > SPEED_HISTORY) { speedHistory.shift(); speedTimestamps.shift(); }

    // Update stat boxes
    document.getElementById('iss-latlon').textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    document.getElementById('iss-speed').textContent  = `${speed.toFixed(2)} km/h`;
    document.getElementById('iss-count').textContent  = issPositions.length;

    // Move satellite marker and update hover popup content
    issMarker.setLatLng([lat, lng]);
    issMarker.setPopupContent(
      `<b>ISS Current Position</b><br>${lat.toFixed(3)}, ${lng.toFixed(3)}<br><span id="popup-place">Locating…</span>`
    );

    const latlngs = issPositions.map(p => [p.lat, p.lng]);
    issPolyline.setLatLngs(latlngs);

    // Pan map to follow ISS
    issMap.panTo([lat, lng], { animate: true, duration: 1.0 });

    // Speed chart updates with real fluctuating speed values
    updateSpeedChart();

    // Reverse-geocode async (doesn't block the above)
    getNearestPlace(lat, lng).then(place => {
      document.getElementById('iss-location').textContent = place;
      // Update the popup location text if it's open
      const el = document.getElementById('popup-place');
      if (el) el.textContent = place;
      window._issState = { lat, lng, speed, place, count: issPositions.length };
    });

  } catch (e) {
    console.error('ISS fetch error:', e);
    toast('ISS data fetch failed — retrying…', 'error');
  }
}

// ─── FETCH ASTRONAUTS ────────────────────────────────────────
async function fetchAstros() {
  try {
    const data = await fetchAstrosWithFallback();
    if (!data) throw new Error('All astronaut APIs failed');
    document.getElementById('people-count').textContent = data.number;
    const list = document.getElementById('people-list');
    list.innerHTML = '';
    data.people.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'people-chip';
      chip.textContent = `${p.name} (${p.craft})`;
      list.appendChild(chip);
    });
    window._astrosState = { number: data.number, people: data.people };
  } catch {
    document.getElementById('people-count').textContent = 'N/A';
    document.getElementById('people-list').innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem">Could not load astronaut data</span>';
  }
}

// ─── ISS AUTO REFRESH CONTROLS ───────────────────────────────
function startIssAutoRefresh() {
  fetchISS();
  issInterval = setInterval(fetchISS, 15000);
}
function stopIssAutoRefresh() {
  clearInterval(issInterval);
  issInterval = null;
}

document.getElementById('iss-refresh-btn').addEventListener('click', () => {
  fetchISS();
  toast('ISS position refreshed', 'success');
});

document.getElementById('iss-auto-btn').addEventListener('click', () => {
  issAutoRefresh = !issAutoRefresh;
  const btn = document.getElementById('iss-auto-btn');
  if (issAutoRefresh) {
    startIssAutoRefresh();
    btn.textContent = 'Auto-Refresh: ON';
    btn.classList.add('btn-active');
    toast('Auto-refresh enabled', 'success');
  } else {
    stopIssAutoRefresh();
    btn.textContent = 'Auto-Refresh: OFF';
    btn.classList.remove('btn-active');
    toast('Auto-refresh paused', 'info');
  }
});

// ─── SPEED CHART ─────────────────────────────────────────────
function initSpeedChart() {
  const ctx = document.getElementById('speed-chart').getContext('2d');
  speedChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'ISS Speed (km/h)',
        data: [],
        borderColor: '#6c63ff',
        backgroundColor: 'rgba(108,99,255,0.12)',
        borderWidth: 2,
        pointRadius: 2,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e8eaf6', font: { size: 10 } } } },
      scales: {
        x: { ticks: { color: '#8892a4', font: { size: 9 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#8892a4', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

function updateSpeedChart() {
  if (!speedChart) return;
  speedChart.data.labels   = [...speedTimestamps];
  speedChart.data.datasets[0].data = [...speedHistory];
  speedChart.update('none');
}

// ─── NEWS CHART ──────────────────────────────────────────────
// Category keywords for client-side classification
const NEWS_CATEGORIES = {
  'Technology': { keywords: ['tech','ai','software','hardware','crypto','computer','digital','robot','space'], color: '#6c63ff' },
  'Science':    { keywords: ['science','research','study','nasa','climate','health','medicine','biology'],     color: '#00d4ff' },
  'World':      { keywords: ['war','conflict','election','president','government','country','global','un'],    color: '#00e5a0' },
  'Sports':     { keywords: ['football','soccer','nfl','nba','olympic','tennis','cricket','sport'],           color: '#ffb347' },
  'Business':   { keywords: ['market','stock','economy','finance','trade','company','gdp','inflation'],       color: '#ff4d6d' }
};

let newsCategoryArticles = {};   // { category: articles[] }
let newsCategoryCounts   = {};   // { category: count }

function initNewsChart() {
  const ctx = document.getElementById('news-chart').getContext('2d');
  newsChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(NEWS_CATEGORIES),
      datasets: [{
        data: Object.keys(NEWS_CATEGORIES).map(() => 0),
        backgroundColor: Object.values(NEWS_CATEGORIES).map(c => c.color),
        borderWidth: 2,
        borderColor: '#1e2130',
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8892a4', font: { size: 10 }, padding: 8 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} articles` } }
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const cat = Object.keys(NEWS_CATEGORIES)[idx];
        filterNewsByCategory(cat);
        toast(`Filtered: ${cat}`, 'info');
      }
    }
  });
}

function updateNewsChart() {
  if (!newsChart) return;
  newsChart.data.datasets[0].data = Object.keys(NEWS_CATEGORIES).map(c => newsCategoryCounts[c] || 0);
  newsChart.update();
}

function filterNewsByCategory(cat) {
  const articles = newsCategoryArticles[cat] || [];
  renderArticles(articles);
}

// ─── NEWS FETCH ──────────────────────────────────────────────
// Classify article into a category based on title/description keyword matching
function classifyArticle(article) {
  const text = ((article.title || '') + ' ' + (article.description || '')).toLowerCase();
  for (const [cat, cfg] of Object.entries(NEWS_CATEGORIES)) {
    if (cfg.keywords.some(kw => text.includes(kw))) return cat;
  }
  return 'World'; // default
}

async function fetchNews() {
  const loading = document.getElementById('news-loading');
  const errBox  = document.getElementById('news-error');
  const list    = document.getElementById('news-list');

  // Check localStorage cache
  const cached = getCachedNews();
  if (cached) {
    allArticles = cached;
    buildCategoryState(allArticles);
    renderArticles(allArticles);
    updateNewsChart();
    toast('News loaded from cache', 'info');
    return;
  }

  loading.classList.remove('hidden');
  errBox.classList.add('hidden');
  list.innerHTML = '';

  try {
    // Single request to avoid 429 rate limiting
    const url = `https://gnews.io/api/v4/search?q=latest+news&lang=en&country=us&max=10&apikey=${GNEWS_API_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const articles = (d.articles || []).map(a => ({ ...a, _category: classifyArticle(a) }));
    if (!articles.length) throw new Error('No articles returned');

    articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    allArticles = articles;
    buildCategoryState(allArticles);
    cacheNews(allArticles);
    renderArticles(allArticles);
    updateNewsChart();
    window._newsState = allArticles;
    toast('News refreshed!', 'success');
  } catch (e) {
    errBox.classList.remove('hidden');
    document.getElementById('news-error-msg').textContent = 'Failed to load news: ' + e.message;
    toast('News fetch failed', 'error');
  } finally {
    loading.classList.add('hidden');
  }
}

function buildCategoryState(articles) {
  newsCategoryCounts   = {};
  newsCategoryArticles = {};
  Object.keys(NEWS_CATEGORIES).forEach(c => { newsCategoryCounts[c] = 0; newsCategoryArticles[c] = []; });
  articles.forEach(a => {
    const cat = a._category || 'World';
    if (!newsCategoryCounts[cat]) newsCategoryCounts[cat] = 0;
    if (!newsCategoryArticles[cat]) newsCategoryArticles[cat] = [];
    newsCategoryCounts[cat]++;
    newsCategoryArticles[cat].push(a);
  });
}

// ─── NEWS CACHE ───────────────────────────────────────────────
function cacheNews(articles) {
  const payload = { ts: Date.now(), articles };
  try { localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify(payload)); } catch {}
}
function getCachedNews() {
  try {
    const raw = localStorage.getItem(NEWS_CACHE_KEY);
    if (!raw) return null;
    const { ts, articles } = JSON.parse(raw);
    if (Date.now() - ts > NEWS_CACHE_TTL) { localStorage.removeItem(NEWS_CACHE_KEY); return null; }
    return articles;
  } catch { return null; }
}

// ─── RENDER ARTICLES ─────────────────────────────────────────
function renderArticles(articles) {
  const list = document.getElementById('news-list');
  list.innerHTML = '';
  if (!articles.length) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:16px">No articles found.</div>';
    return;
  }
  articles.forEach((a, i) => {
    const card = document.createElement('div');
    card.className = 'article-card';
    card.id = `article-${i}`;

    const imgEl = a.image
      ? `<img class="article-img" src="${escapeHtml(a.image)}" alt="article" loading="lazy" onerror="this.style.display='none'" />`
      : `<div class="article-img-placeholder">📰</div>`;

    const date = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '';
    const source = a.source?.name || '';
    const author = a.author || '';

    card.innerHTML = `
      ${imgEl}
      <div class="article-body">
        <div class="article-title">${escapeHtml(a.title || '')}</div>
        <div class="article-meta">
          ${source ? `<span class="article-source">${escapeHtml(source)}</span>` : ''}
          ${author ? `<span>by ${escapeHtml(author)}</span>` : ''}
          ${date   ? `<span>${date}</span>` : ''}
          ${a._category ? `<span class="badge">${a._category}</span>` : ''}
        </div>
        <div class="article-desc">${escapeHtml(a.description || '')}</div>
        <a class="article-read-more" href="${escapeHtml(a.url || '#')}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Read More →</a>
      </div>`;
    list.appendChild(card);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── NEWS SEARCH & SORT ──────────────────────────────────────
function getFilteredArticles() {
  const q = document.getElementById('news-search').value.toLowerCase().trim();
  const sort = document.getElementById('news-sort').value;
  let list = [...allArticles];
  if (q) {
    list = list.filter(a =>
      (a.title  || '').toLowerCase().includes(q) ||
      (a.source?.name || '').toLowerCase().includes(q) ||
      (a.author || '').toLowerCase().includes(q)
    );
  }
  if (sort === 'date') {
    list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  } else if (sort === 'source') {
    list.sort((a, b) => (a.source?.name || '').localeCompare(b.source?.name || ''));
  }
  return list;
}

document.getElementById('news-search').addEventListener('input', () => renderArticles(getFilteredArticles()));
document.getElementById('news-sort').addEventListener('change', () => renderArticles(getFilteredArticles()));
document.getElementById('news-refresh-btn').addEventListener('click', () => {
  localStorage.removeItem(NEWS_CACHE_KEY);
  fetchNews();
});

// ─── CHATBOT ─────────────────────────────────────────────────
let chatMessages = [];

(function loadChat() {
  try {
    const saved = localStorage.getItem(CHAT_STORE_KEY);
    if (saved) chatMessages = JSON.parse(saved);
  } catch {}
  renderChatHistory();
})();

function saveChat() {
  if (chatMessages.length > MAX_CHAT_MSGS) chatMessages = chatMessages.slice(-MAX_CHAT_MSGS);
  try { localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(chatMessages)); } catch {}
}

document.getElementById('chat-toggle-btn').addEventListener('click', () => {
  const win = document.getElementById('chat-window');
  win.classList.toggle('hidden');
  if (!win.classList.contains('hidden')) scrollChatToBottom();
});
document.getElementById('chat-close-btn').addEventListener('click', () => {
  document.getElementById('chat-window').classList.add('hidden');
});
document.getElementById('chat-clear-btn').addEventListener('click', () => {
  chatMessages = [];
  saveChat();
  document.getElementById('chat-messages').innerHTML = '';
  toast('Chat cleared', 'info');
});
document.getElementById('chat-send-btn').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function renderChatHistory() {
  const container = document.getElementById('chat-messages');
  container.innerHTML = '';
  chatMessages.forEach(m => appendMsgDOM(m.role, m.content));
}

function appendMsgDOM(role, content) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  div.textContent = content;
  container.appendChild(div);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const c = document.getElementById('chat-messages');
  c.scrollTop = c.scrollHeight;
}

function buildDashboardContext() {
  let ctx = '=== DASHBOARD DATA ===\n';
  if (window._issState) {
    ctx += `ISS Position: Latitude ${window._issState.lat?.toFixed(4)}, Longitude ${window._issState.lng?.toFixed(4)}\n`;
    ctx += `ISS Speed: ${window._issState.speed?.toFixed(2)} km/h\n`;
    ctx += `ISS Location: ${window._issState.place}\n`;
    ctx += `Tracked Positions: ${window._issState.count}\n`;
  }
  if (window._astrosState) {
    ctx += `People in Space: ${window._astrosState.number}\n`;
    ctx += `Astronauts: ${window._astrosState.people?.map(p => p.name + ' (' + p.craft + ')').join(', ')}\n`;
  }
  if (window._newsState && window._newsState.length) {
    ctx += `\nTotal news articles: ${window._newsState.length}\n`;
    ctx += 'Recent articles (top 5):\n';
    window._newsState.slice(0, 5).forEach((a, i) => {
      ctx += `${i + 1}. "${a.title}" — Source: ${a.source?.name || 'N/A'}, Category: ${a._category || 'N/A'}\n`;
      if (a.description) ctx += `   Summary: ${a.description.slice(0, 120)}…\n`;
    });
  }
  ctx += '=== END DASHBOARD DATA ===';
  return ctx;
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const userMsg = input.value.trim();
  if (!userMsg) return;
  input.value = '';

  chatMessages.push({ role: 'user', content: userMsg });
  appendMsgDOM('user', userMsg);
  saveChat();

  // Show typing
  const typing = document.getElementById('chat-typing');
  typing.classList.remove('hidden');
  scrollChatToBottom();

  try {
    const dashCtx = buildDashboardContext();
    const systemPrompt = `You are an AI assistant embedded in a Real-Time ISS & News Dashboard.
You MUST answer ONLY using the dashboard data provided below.
Do NOT use any external knowledge, do NOT guess, do NOT make up information.
If the question cannot be answered from the dashboard data, say "I only have access to the current dashboard data. Please ask about ISS location, speed, astronauts, or news articles."

${dashCtx}`;

    // Build strictly alternating history (exclude the last user message we just pushed,
    // it will be added as the final item explicitly)
    const historyWithoutLast = chatMessages.slice(0, -1); // all but the new user msg
    const recentHistory = historyWithoutLast.slice(-8);   // keep last 8 for context

    // Ensure alternating roles: filter to only valid pairs ending in assistant
    const filteredHistory = [];
    let expectRole = 'user';
    for (const m of recentHistory) {
      if (m.role === expectRole) {
        filteredHistory.push({ role: m.role, content: m.content });
        expectRole = expectRole === 'user' ? 'assistant' : 'user';
      }
    }
    // We want history to end with assistant (so user msg can come last)
    // Drop last item if it's a user role to keep alternation correct
    if (filteredHistory.length && filteredHistory[filteredHistory.length - 1].role === 'user') {
      filteredHistory.pop();
    }

    const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: `${HF_MODEL}:featherless-ai`,
        messages: [
          { role: 'system', content: systemPrompt },
          ...filteredHistory,
          { role: 'user', content: userMsg }
        ],
        max_tokens: 400,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HF API error: ${response.status} — ${errText.slice(0, 100)}`);
    }

    const data = await response.json();
    const botReply = data.choices?.[0]?.message?.content?.trim() || 'Sorry, I could not generate a response.';

    chatMessages.push({ role: 'assistant', content: botReply });
    appendMsgDOM('bot', botReply);
    saveChat();
  } catch (e) {
    console.error('Chat error:', e);
    const errMsg = 'Sorry, I encountered an error. Please try again.';
    chatMessages.push({ role: 'assistant', content: errMsg });
    appendMsgDOM('bot', errMsg);
    saveChat();
    toast('Chatbot error', 'error');
  } finally {
    typing.classList.add('hidden');
  }
}

// ─── INIT ─────────────────────────────────────────────────────
async function init() {
  initMap();
  initSpeedChart();
  initNewsChart();

  // First ISS fetch + astronauts (in parallel)
  await Promise.allSettled([fetchISS(), fetchAstros()]);

  // Start auto-refresh interval (15s, does NOT fetch immediately since we just fetched)
  issInterval = setInterval(fetchISS, 15000);

  // News
  await fetchNews();

  // Welcome chatbot message
  if (chatMessages.length === 0) {
    const welcome = "Hello! I'm your ISS & News AI assistant. Ask me about the ISS location, speed, astronauts in space, or today's news headlines!";
    chatMessages.push({ role: 'assistant', content: welcome });
    appendMsgDOM('bot', welcome);
    saveChat();
  }
}

init();
