/** Gated dashboard: live globe, charts and the filterable regulatory feed. */
import { createGlobe } from './globe.js';

const state = {
  user: null,
  csrfToken: null,
  authorities: [],
  filters: { region: 'all', category: 'all', severity: 'all', sourceId: 'all', q: '' },
  view: 'all',
  offset: 0,
  limit: 25,
  total: 0,
  loading: false,
  seenIds: new Set(),
};

let globe = null;
let volumeChart = null;
let categoryChart = null;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------- boot

init().catch((error) => {
  console.error(error);
  $('feed').innerHTML = renderEmpty('Could not load the feed. Try refreshing the page.');
});

async function init() {
  const me = await api('/api/auth/me');
  state.user = me.user;
  state.csrfToken = me.csrfToken;

  $('user-name').textContent = me.user.name;
  $('avatar').textContent = initials(me.user.name);

  setupGlobe();
  wireControls();

  await Promise.all([loadFilters(), loadAuthorities()]);
  await Promise.all([loadStats(), loadFeed({ reset: true })]);

  if (me.user.role === 'admin') {
    $('admin-panel').classList.remove('hidden');
    loadAdmin().catch(console.error);
  }

  // Refresh periodically so a long-lived tab keeps up with new publications.
  setInterval(() => {
    loadStats().catch(() => {});
    checkForNewItems().catch(() => {});
  }, 90_000);
}

// ------------------------------------------------------------------ globe

function setupGlobe() {
  const container = $('app-globe');
  const tip = $('globe-tip');

  globe = createGlobe(container, {
    interactive: true,
    distance: 3.3,
    onHover(authority, point) {
      if (!authority) {
        tip.classList.remove('show');
        return;
      }
      const rect = container.getBoundingClientRect();
      tip.querySelector('.t').textContent = `${authority.agency} · ${authority.country}`;
      tip.querySelector('.d').textContent =
        `${authority.updateCount} item${authority.updateCount === 1 ? '' : 's'}` +
        (authority.criticalCount ? ` · ${authority.criticalCount} critical` : '') +
        (authority.live ? '' : ' · not yet reached');
      tip.style.left = `${Math.min(point.x - rect.left + 14, rect.width - 250)}px`;
      tip.style.top = `${point.y - rect.top + 14}px`;
      tip.classList.add('show');
    },
    onSelect(authority) {
      // Clicking a marker filters the feed to that authority.
      state.filters.sourceId = authority.id;
      $('f-source').value = authority.id;
      loadFeed({ reset: true });
      $('feed').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });
}

// --------------------------------------------------------------- controls

function wireControls() {
  $('signout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });

  $('refresh-btn').addEventListener('click', async () => {
    const icon = $('refresh-icon');
    icon.classList.add('spin');
    await Promise.all([loadStats(), loadAuthorities(), loadFeed({ reset: true })]);
    icon.classList.remove('spin');
  });

  let searchTimer;
  $('f-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = event.target.value.trim();
      loadFeed({ reset: true });
    }, 280);
  });

  for (const [id, key] of [
    ['f-region', 'region'],
    ['f-category', 'category'],
    ['f-severity', 'severity'],
    ['f-source', 'sourceId'],
  ]) {
    $(id).addEventListener('change', (event) => {
      state.filters[key] = event.target.value;
      loadFeed({ reset: true });
    });
  }

  $('view-seg').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    for (const b of $('view-seg').querySelectorAll('button')) b.classList.remove('on');
    button.classList.add('on');
    state.view = button.dataset.view;
    loadFeed({ reset: true });
  });

  $('load-more').addEventListener('click', () => loadFeed({ reset: false }));

  $('poll-now')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Polling…';
    try {
      const result = await api('/api/admin/ingest', { method: 'POST' });
      button.textContent = `${result.reachable}/${result.sources} reachable · ${result.inserted} new`;
      await Promise.all([loadStats(), loadAuthorities(), loadFeed({ reset: true }), loadAdmin()]);
    } catch (error) {
      button.textContent = error.message.slice(0, 40);
    } finally {
      setTimeout(() => {
        button.disabled = false;
        button.textContent = 'Poll all feeds now';
      }, 4000);
    }
  });
}

// ------------------------------------------------------------------ loads

async function loadFilters() {
  const { regions, categories, severities } = await api('/api/filters');
  fillSelect($('f-region'), regions, 'All regions');
  fillSelect($('f-category'), categories, 'All categories');
  fillSelect(
    $('f-severity'),
    severities.map((s) => ({ value: s, label: capitalise(s) })),
    'All severities',
  );
}

async function loadAuthorities() {
  state.authorities = await api('/api/authorities');
  globe?.setAuthorities(state.authorities);

  fillSelect(
    $('f-source'),
    state.authorities.map((a) => ({
      value: a.id,
      label: `${a.agency} · ${a.topic}`,
    })),
    'All authorities',
  );
  $('f-source').value = state.filters.sourceId;
}

async function loadStats() {
  const stats = await api('/api/stats');

  setText('t-total', stats.total.toLocaleString());
  setText('t-24h', stats.last24h.toLocaleString());
  setText('t-critical', stats.criticalLast7d.toLocaleString());
  setText('t-sources', `${stats.sourcesLive}/${stats.sourcesTotal}`);

  $('sample-banner').classList.toggle('hidden', !stats.usingSampleData);

  const indicator = $('live-indicator');
  const label = $('live-label');
  if (stats.lastIngestAt) {
    const age = Date.now() - new Date(stats.lastIngestAt).getTime();
    label.textContent = `Updated ${relativeTime(stats.lastIngestAt)}`;
    indicator.classList.toggle('stale', age > 60 * 60 * 1000);
  } else {
    label.textContent = 'Awaiting first poll';
    indicator.classList.add('stale');
  }

  drawCharts(stats);
}

async function loadFeed({ reset }) {
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.seenIds.clear();
    $('feed').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  }

  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(state.offset),
  });
  for (const [key, value] of Object.entries(state.filters)) {
    if (value && value !== 'all') params.set(key, value);
  }
  if (state.view === 'critical') params.set('severity', 'critical');
  if (state.view === 'bookmarked') params.set('bookmarked', '1');

  try {
    const data = await api(`/api/updates?${params}`);
    state.total = data.total;

    const feed = $('feed');
    if (reset) feed.innerHTML = '';

    if (data.items.length === 0 && reset) {
      feed.innerHTML = renderEmpty(
        state.view === 'bookmarked'
          ? 'No saved items yet. Use the Save button on any notice to keep it here.'
          : 'No items match these filters yet.',
      );
    } else {
      for (const item of data.items) state.seenIds.add(item.id);
      feed.insertAdjacentHTML('beforeend', data.items.map(renderCard).join(''));
    }

    state.offset += data.items.length;
    $('load-more-wrap').classList.toggle('hidden', state.offset >= state.total);
    $('feed-count').textContent =
      `${state.total.toLocaleString()} item${state.total === 1 ? '' : 's'}` +
      (state.offset < state.total ? ` · showing ${state.offset}` : '');
  } finally {
    state.loading = false;
  }
}

/** Poll for anything published since the newest item currently shown. */
async function checkForNewItems() {
  const params = new URLSearchParams({ limit: '5', offset: '0' });
  const data = await api(`/api/updates?${params}`);
  const fresh = data.items.filter((item) => !state.seenIds.has(item.id));
  if (fresh.length === 0) return;

  for (const item of fresh) {
    state.seenIds.add(item.id);
    globe?.pulse(item.source.id);
  }
  // Only splice new items in on the default view, so filters are not disturbed.
  if (state.view === 'all' && !state.filters.q && state.filters.region === 'all') {
    $('feed').insertAdjacentHTML('afterbegin', fresh.map(renderCard).join(''));
  }
}

async function loadAdmin() {
  const sources = await api('/api/admin/sources');
  $('admin-rows').innerHTML = sources
    .map(
      (s) => `
      <tr>
        <td><span class="dot ${s.healthy ? 'ok' : 'bad'}"></span></td>
        <td><code style="font-size:11.5px">${escapeHtml(s.id)}</code></td>
        <td>${escapeHtml(s.agency)}</td>
        <td>${escapeHtml(s.region)}</td>
        <td>${s.stored}</td>
        <td>${escapeHtml(s.lastError || s.lastStatus || 'never polled')}</td>
        <td>${s.lastSuccessAt ? relativeTime(s.lastSuccessAt) : '—'}</td>
      </tr>`,
    )
    .join('');
}

// ----------------------------------------------------------------- charts

function drawCharts(stats) {
  if (typeof Chart === 'undefined') return;

  const grid = 'rgba(120,160,220,0.1)';
  const tickColour = '#97a6c4';

  // Fill gaps so the volume line spans a continuous 14 days.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const found = stats.perDay.find((p) => p.day === d);
    days.push({ day: d, n: found ? found.n : 0 });
  }

  if (volumeChart) volumeChart.destroy();
  volumeChart = new Chart($('volume-chart'), {
    type: 'line',
    data: {
      labels: days.map((d) => d.day.slice(5)),
      datasets: [
        {
          data: days.map((d) => d.n),
          borderColor: '#22d3ee',
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            if (!chart.chartArea) return 'rgba(34,211,238,0.15)';
            const g = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom);
            g.addColorStop(0, 'rgba(34,211,238,0.34)');
            g.addColorStop(1, 'rgba(34,211,238,0.01)');
            return g;
          },
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: tickColour, maxTicksLimit: 7, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: grid }, ticks: { color: tickColour, precision: 0, font: { size: 10 } } },
      },
    },
  });

  const categories = stats.byCategory.slice(0, 7);
  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart($('category-chart'), {
    type: 'bar',
    data: {
      labels: categories.map((c) => c.category),
      datasets: [
        {
          data: categories.map((c) => c.n),
          backgroundColor: [
            '#ff3b5c', '#ff8a3d', '#ffd166', '#4ade80',
            '#22d3ee', '#8b5cf6', '#64748b',
          ],
          borderRadius: 5,
          borderWidth: 0,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, grid: { color: grid }, ticks: { color: tickColour, precision: 0, font: { size: 10 } } },
        y: { grid: { display: false }, ticks: { color: tickColour, font: { size: 10.5 } } },
      },
    },
  });
}

// ---------------------------------------------------------------- render

function renderCard(item) {
  const when = relativeTime(item.publishedAt);
  return `
    <article class="card sev-${item.severity}" data-id="${escapeHtml(item.id)}">
      <div class="card-top">
        <span class="tag ${item.severity}">${escapeHtml(item.severity)}</span>
        <span class="tag">${escapeHtml(item.category)}</span>
        ${item.isSample ? '<span class="tag sample">sample</span>' : ''}
      </div>
      <h4>${escapeHtml(item.title)}</h4>
      ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
      <div class="card-foot">
        <span class="authority">${escapeHtml(item.source.agency)}</span>
        <span>${escapeHtml(item.source.country)}</span>
        <span title="${escapeHtml(item.publishedAt)}">${escapeHtml(when)}</span>
        <span class="spacer"></span>
        <button class="icon-btn bookmark ${item.bookmarked ? 'on' : ''}" data-id="${escapeHtml(item.id)}">
          <svg viewBox="0 0 24 24" fill="${item.bookmarked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
            <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
          </svg>
          ${item.bookmarked ? 'Saved' : 'Save'}
        </button>
        <a class="icon-btn" href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">
          Open source
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>
          </svg>
        </a>
      </div>
    </article>`;
}

// Bookmark toggling is delegated so it survives feed re-renders.
$('feed').addEventListener('click', async (event) => {
  const button = event.target.closest('.bookmark');
  if (!button) return;

  const id = button.dataset.id;
  const on = button.classList.contains('on');
  button.disabled = true;
  try {
    await api(`/api/bookmarks/${encodeURIComponent(id)}`, {
      method: on ? 'DELETE' : 'POST',
    });
    button.classList.toggle('on', !on);
    button.lastChild.textContent = !on ? ' Saved ' : ' Save ';
    button.querySelector('svg').setAttribute('fill', !on ? 'currentColor' : 'none');
    if (on && state.view === 'bookmarked') button.closest('.card').remove();
  } finally {
    button.disabled = false;
  }
});

function renderEmpty(message) {
  return `
    <div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
      </svg>
      <div>${escapeHtml(message)}</div>
    </div>`;
}

// --------------------------------------------------------------- helpers

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') {
    headers['x-csrf-token'] = state.csrfToken;
    if (options.body) headers['content-type'] = 'application/json';
  }

  const response = await fetch(url, { ...options, headers });

  // A dropped or expired session sends the customer back to sign in.
  if (response.status === 401) {
    location.href = '/?next=/app';
    throw new Error('Session expired');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function fillSelect(select, values, allLabel) {
  const options = values.map((v) =>
    typeof v === 'string' ? { value: v, label: v } : v,
  );
  select.innerHTML =
    `<option value="all">${escapeHtml(allLabel)}</option>` +
    options
      .map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`)
      .join('');
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function initials(name) {
  return String(name)
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
