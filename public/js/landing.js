/** Landing page: hero globe, sign-in and registration. */
import { createGlobe } from './globe.js';

// A representative spread of authorities so the hero globe is populated before
// anyone signs in. Coordinates only - no regulatory content is exposed here.
const HERO_MARKERS = [
  { id: 'us', lat: 38.98, lon: -76.98, updateCount: 24, criticalCount: 2 },
  { id: 'ca', lat: 45.42, lon: -75.69, updateCount: 12, criticalCount: 0 },
  { id: 'mx', lat: 19.43, lon: -99.13, updateCount: 6, criticalCount: 0 },
  { id: 'br', lat: -15.79, lon: -47.89, updateCount: 9, criticalCount: 0 },
  { id: 'ar', lat: -34.6, lon: -58.38, updateCount: 4, criticalCount: 0 },
  { id: 'co', lat: 4.71, lon: -74.07, updateCount: 3, criticalCount: 0 },
  { id: 'uk', lat: 51.5, lon: -0.13, updateCount: 18, criticalCount: 1 },
  { id: 'eu', lat: 52.34, lon: 4.91, updateCount: 20, criticalCount: 0 },
  { id: 'be', lat: 50.85, lon: 4.35, updateCount: 5, criticalCount: 0 },
  { id: 'de', lat: 50.73, lon: 7.09, updateCount: 11, criticalCount: 0 },
  { id: 'fr', lat: 48.85, lon: 2.35, updateCount: 10, criticalCount: 0 },
  { id: 'es', lat: 40.41, lon: -3.7, updateCount: 7, criticalCount: 0 },
  { id: 'it', lat: 41.9, lon: 12.49, updateCount: 6, criticalCount: 0 },
  { id: 'ch', lat: 46.94, lon: 7.44, updateCount: 8, criticalCount: 0 },
  { id: 'se', lat: 59.85, lon: 17.63, updateCount: 4, criticalCount: 0 },
  { id: 'no', lat: 59.91, lon: 10.75, updateCount: 3, criticalCount: 0 },
  { id: 'ie', lat: 53.34, lon: -6.26, updateCount: 5, criticalCount: 0 },
  { id: 'tr', lat: 39.93, lon: 32.85, updateCount: 4, criticalCount: 0 },
  { id: 'za', lat: -25.74, lon: 28.22, updateCount: 5, criticalCount: 0 },
  { id: 'ng', lat: 9.07, lon: 7.39, updateCount: 4, criticalCount: 1 },
  { id: 'sa', lat: 24.71, lon: 46.67, updateCount: 6, criticalCount: 0 },
  { id: 'in', lat: 28.61, lon: 77.2, updateCount: 13, criticalCount: 0 },
  { id: 'cn', lat: 39.9, lon: 116.4, updateCount: 9, criticalCount: 0 },
  { id: 'jp', lat: 35.67, lon: 139.65, updateCount: 14, criticalCount: 0 },
  { id: 'kr', lat: 36.48, lon: 127.28, updateCount: 8, criticalCount: 0 },
  { id: 'tw', lat: 25.03, lon: 121.56, updateCount: 4, criticalCount: 0 },
  { id: 'hk', lat: 22.31, lon: 114.16, updateCount: 5, criticalCount: 0 },
  { id: 'sg', lat: 1.35, lon: 103.81, updateCount: 7, criticalCount: 0 },
  { id: 'my', lat: 3.13, lon: 101.68, updateCount: 3, criticalCount: 0 },
  { id: 'ph', lat: 14.59, lon: 120.98, updateCount: 5, criticalCount: 0 },
  { id: 'au', lat: -35.28, lon: 149.13, updateCount: 12, criticalCount: 1 },
  { id: 'nz', lat: -41.28, lon: 174.77, updateCount: 4, criticalCount: 0 },
  { id: 'who', lat: 46.23, lon: 6.13, updateCount: 16, criticalCount: 2 },
];

const AUTHORITY_CHIPS = [
  'FDA (United States)', 'EMA (European Union)', 'MHRA (United Kingdom)',
  'Health Canada', 'TGA (Australia)', 'PMDA (Japan)', 'MFDS (South Korea)',
  'HSA (Singapore)', 'Swissmedic', 'BfArM (Germany)', 'ANSM (France)',
  'AIFA (Italy)', 'AEMPS (Spain)', 'HPRA (Ireland)', 'CBG-MEB (Netherlands)',
  'Läkemedelsverket (Sweden)', 'ANVISA (Brazil)', 'COFEPRIS (Mexico)',
  'ANMAT (Argentina)', 'SFDA (Saudi Arabia)', 'SAHPRA (South Africa)',
  'NAFDAC (Nigeria)', 'Medsafe (New Zealand)', 'CDSCO (India)',
  'TİTCK (Türkiye)', 'WHO', 'ECDC', 'ICH', 'EDQM',
];

// ------------------------------------------------------------------- globe

const globeEl = document.getElementById('hero-globe');
let globe = null;
if (globeEl) {
  // On wide screens the globe sits to the right of the headline; on narrow
  // ones it centres behind the copy.
  const wide = window.innerWidth > 1080;
  globe = createGlobe(globeEl, {
    interactive: true,
    distance: wide ? 4.5 : 4.1,
    offsetX: wide ? 0.34 : 0,
  });
  globe.setAuthorities(HERO_MARKERS);

  // Idle arcs so the hero feels live without implying real traffic.
  setInterval(() => {
    const from = HERO_MARKERS[Math.floor(Math.random() * HERO_MARKERS.length)];
    globe.pulse(from.id);
  }, 2200);
}

// --------------------------------------------------------------- chrome

const strip = document.getElementById('authority-strip');
if (strip) {
  strip.innerHTML = AUTHORITY_CHIPS.map(
    (name) => `<span class="chip">${escapeHtml(name)}</span>`,
  ).join('');
}

// Show the real source count without exposing any regulatory data.
fetch('/api/public/summary')
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (!data) return;
    setText('stat-sources', data.sources);
    setText('stat-regions', data.regions);
    setText('stat-interval', `${data.pollMinutes} min`);
  })
  .catch(() => {});

// ---------------------------------------------------------------- tabs

const tabSignin = document.getElementById('tab-signin');
const tabRegister = document.getElementById('tab-register');
const formSignin = document.getElementById('form-signin');
const formRegister = document.getElementById('form-register');
const authTitle = document.getElementById('auth-title');

function selectTab(which) {
  const signin = which === 'signin';
  tabSignin.setAttribute('aria-selected', String(signin));
  tabRegister.setAttribute('aria-selected', String(!signin));
  formSignin.classList.toggle('hidden', !signin);
  formRegister.classList.toggle('hidden', signin);
  authTitle.textContent = signin ? 'Customer access' : 'Create your account';
  clearMessage();
}

tabSignin.addEventListener('click', () => selectTab('signin'));
tabRegister.addEventListener('click', () => selectTab('register'));

// -------------------------------------------------------------- messages

const msgEl = document.getElementById('auth-msg');

function showMessage(text, kind = 'error') {
  msgEl.textContent = text;
  msgEl.className = `msg show ${kind}`;
}
function clearMessage() {
  msgEl.className = 'msg';
  msgEl.textContent = '';
}

// ----------------------------------------------------------------- forms

const nextUrl = new URLSearchParams(location.search).get('next') || '/app';

formSignin.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('si-submit');
  await submit(button, 'Signing in…', async () => {
    const response = await postJson('/api/auth/login', {
      email: document.getElementById('si-email').value.trim(),
      password: document.getElementById('si-password').value,
    });
    location.href = nextUrl;
    return response;
  });
});

formRegister.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('rg-submit');
  await submit(button, 'Creating account…', async () => {
    const response = await postJson('/api/auth/register', {
      name: document.getElementById('rg-name').value.trim(),
      organisation: document.getElementById('rg-org').value.trim(),
      email: document.getElementById('rg-email').value.trim(),
      password: document.getElementById('rg-password').value,
    });

    // An account may need administrator approval before it can sign in.
    if (response.pending) {
      showMessage(response.message, 'ok');
      selectTab('signin');
      return response;
    }
    location.href = nextUrl;
    return response;
  });
});

async function submit(button, busyLabel, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  clearMessage();
  try {
    await action();
  } catch (error) {
    showMessage(error.message || 'Something went wrong. Please try again.');
    button.disabled = false;
    button.textContent = original;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !(response.status === 202 && data.pending)) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

// If a session is already active, skip straight to the dashboard.
fetch('/api/auth/me')
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (data?.user?.status === 'active') location.href = nextUrl;
  })
  .catch(() => {});

// ---------------------------------------------------------------- helpers

function setText(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) el.textContent = value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
