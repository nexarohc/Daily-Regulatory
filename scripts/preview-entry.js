/**
 * Entry point for the standalone design preview.
 *
 * The preview is a single self-contained HTML file with no backend, so it
 * renders the hero globe and the landing layout with fixed figures and a
 * deliberately inert sign-in form. It exists to review the visual design; the
 * real application is the Express app in this repository.
 */
import { createGlobe } from '../public/js/globe.js';

const HERO_MARKERS = [
  { id: 'us', lat: 38.98, lon: -76.98, updateCount: 24, criticalCount: 2 },
  { id: 'ca', lat: 45.42, lon: -75.69, updateCount: 12, criticalCount: 0 },
  { id: 'mx', lat: 19.43, lon: -99.13, updateCount: 6, criticalCount: 0 },
  { id: 'br', lat: -15.79, lon: -47.89, updateCount: 9, criticalCount: 0 },
  { id: 'ar', lat: -34.6, lon: -58.38, updateCount: 4, criticalCount: 0 },
  { id: 'co', lat: 4.71, lon: -74.07, updateCount: 3, criticalCount: 0 },
  { id: 'pe', lat: -12.05, lon: -77.04, updateCount: 3, criticalCount: 0 },
  { id: 'cl', lat: -33.45, lon: -70.67, updateCount: 3, criticalCount: 0 },
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
  { id: 'pl', lat: 52.23, lon: 21.01, updateCount: 4, criticalCount: 0 },
  { id: 'ie', lat: 53.34, lon: -6.26, updateCount: 5, criticalCount: 0 },
  { id: 'pt', lat: 38.72, lon: -9.14, updateCount: 3, criticalCount: 0 },
  { id: 'tr', lat: 39.93, lon: 32.85, updateCount: 4, criticalCount: 0 },
  { id: 'ru', lat: 55.76, lon: 37.62, updateCount: 3, criticalCount: 0 },
  { id: 'za', lat: -25.74, lon: 28.22, updateCount: 5, criticalCount: 0 },
  { id: 'ng', lat: 9.07, lon: 7.39, updateCount: 4, criticalCount: 1 },
  { id: 'eg', lat: 30.04, lon: 31.24, updateCount: 4, criticalCount: 0 },
  { id: 'ke', lat: -1.29, lon: 36.82, updateCount: 3, criticalCount: 0 },
  { id: 'gh', lat: 5.6, lon: -0.19, updateCount: 3, criticalCount: 0 },
  { id: 'tz', lat: -6.79, lon: 39.21, updateCount: 2, criticalCount: 0 },
  { id: 'ma', lat: 34.02, lon: -6.84, updateCount: 2, criticalCount: 0 },
  { id: 'sa', lat: 24.71, lon: 46.67, updateCount: 6, criticalCount: 0 },
  { id: 'ae', lat: 24.45, lon: 54.38, updateCount: 4, criticalCount: 0 },
  { id: 'il', lat: 31.77, lon: 35.21, updateCount: 3, criticalCount: 0 },
  { id: 'in', lat: 28.61, lon: 77.2, updateCount: 13, criticalCount: 0 },
  { id: 'pk', lat: 33.68, lon: 73.05, updateCount: 4, criticalCount: 0 },
  { id: 'bd', lat: 23.81, lon: 90.41, updateCount: 3, criticalCount: 0 },
  { id: 'cn', lat: 39.9, lon: 116.4, updateCount: 9, criticalCount: 0 },
  { id: 'jp', lat: 35.67, lon: 139.65, updateCount: 14, criticalCount: 0 },
  { id: 'kr', lat: 36.48, lon: 127.28, updateCount: 8, criticalCount: 0 },
  { id: 'tw', lat: 25.03, lon: 121.56, updateCount: 4, criticalCount: 0 },
  { id: 'hk', lat: 22.31, lon: 114.16, updateCount: 5, criticalCount: 0 },
  { id: 'sg', lat: 1.35, lon: 103.81, updateCount: 7, criticalCount: 0 },
  { id: 'my', lat: 3.13, lon: 101.68, updateCount: 3, criticalCount: 0 },
  { id: 'th', lat: 13.76, lon: 100.5, updateCount: 4, criticalCount: 0 },
  { id: 'id', lat: -6.21, lon: 106.85, updateCount: 4, criticalCount: 0 },
  { id: 'vn', lat: 21.03, lon: 105.85, updateCount: 3, criticalCount: 0 },
  { id: 'ph', lat: 14.59, lon: 120.98, updateCount: 5, criticalCount: 0 },
  { id: 'au', lat: -35.28, lon: 149.13, updateCount: 12, criticalCount: 1 },
  { id: 'nz', lat: -41.28, lon: 174.77, updateCount: 4, criticalCount: 0 },
  { id: 'who', lat: 46.23, lon: 6.13, updateCount: 16, criticalCount: 2 },
];

const AUTHORITY_CHIPS = [
  'FDA (United States)', 'EMA (European Union)', 'MHRA (United Kingdom)',
  'Health Canada', 'TGA (Australia)', 'PMDA (Japan)', 'MFDS (South Korea)',
  'NMPA (China)', 'HSA (Singapore)', 'Swissmedic', 'BfArM (Germany)',
  'ANSM (France)', 'AIFA (Italy)', 'AEMPS (Spain)', 'HPRA (Ireland)',
  'CBG-MEB (Netherlands)', 'ANVISA (Brazil)', 'COFEPRIS (Mexico)',
  'ANMAT (Argentina)', 'INVIMA (Colombia)', 'SFDA (Saudi Arabia)',
  'SAHPRA (South Africa)', 'NAFDAC (Nigeria)', 'EFDA (Ethiopia)',
  'TMDA (Tanzania)', 'Medsafe (New Zealand)', 'CDSCO (India)',
  'DRAP (Pakistan)', 'BPOM (Indonesia)', 'Thai FDA', 'TİTCK (Türkiye)',
  'WHO', 'ECDC', 'ICH', 'EDQM', 'PIC/S',
];

const globeEl = document.getElementById('hero-globe');
if (globeEl) {
  const wide = window.innerWidth > 1080;
  const globe = createGlobe(globeEl, {
    interactive: true,
    distance: wide ? 4.5 : 4.1,
    offsetX: wide ? 0.34 : 0,
  });
  globe.setAuthorities(HERO_MARKERS);

  setInterval(() => {
    const from = HERO_MARKERS[Math.floor(Math.random() * HERO_MARKERS.length)];
    globe.pulse(from.id);
  }, 2000);
}

const strip = document.getElementById('authority-strip');
if (strip) {
  strip.innerHTML = AUTHORITY_CHIPS.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join('');
}

const ticker = document.getElementById('ticker');
if (ticker) {
  ticker.innerHTML = [...AUTHORITY_CHIPS, ...AUTHORITY_CHIPS]
    .map((n) => `<span class="chip">${escapeHtml(n)}</span>`)
    .join('');
}

// Figures matching the current registry.
for (const [id, value] of [
  ['stat-authorities', 205],
  ['stat-countries', 180],
  ['stat-sources', 53],
]) {
  countUp(id, value);
}

const interval = document.getElementById('stat-interval');
if (interval) interval.textContent = '15 min';

function countUp(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = String(target);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / 900, 1);
    el.textContent = String(Math.round(target * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The two tabs still switch, so both panels can be reviewed. The passcode and
// password-reset panels need a server, so they stay hidden in the preview.
const tabSignin = document.getElementById('tab-signin');
const tabRegister = document.getElementById('tab-register');
const formSignin = document.getElementById('form-signin');
const formRegister = document.getElementById('form-register');

function selectTab(which) {
  const signin = which === 'signin';
  tabSignin.setAttribute('aria-selected', String(signin));
  tabRegister.setAttribute('aria-selected', String(!signin));
  formSignin.classList.toggle('hidden', !signin);
  formRegister.classList.toggle('hidden', signin);
}
tabSignin?.addEventListener('click', () => selectTab('signin'));
tabRegister?.addEventListener('click', () => selectTab('register'));

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
