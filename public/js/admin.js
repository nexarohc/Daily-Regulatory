/** Administrator dashboard: subscribers, geography, revenue and arrears. */
const $ = (id) => document.getElementById(id);

let csrfToken = null;
let currency = 'USD';
let countryChart = null;
let revenueChart = null;
let payingUserId = null;

init().catch((error) => showMessage(error.message || 'Could not load the dashboard.'));

async function init() {
  const me = await api('/api/auth/me');
  if (me.user.role !== 'admin') {
    location.href = '/admin';
    return;
  }
  csrfToken = me.csrfToken;
  $('user-name').textContent = me.user.name;
  $('avatar').textContent = initials(me.user.name);

  wire();
  await Promise.all([loadDashboard(), loadSubscribers(), loadFeedback()]);
}

async function loadDashboard() {
  const data = await api('/api/admin/dashboard');
  currency = data.revenue.currency;

  $('mail-banner').classList.toggle('hidden', data.mail.configured);

  // --- tiles -------------------------------------------------------------
  setText('t-subs', data.subscribers.total.toLocaleString());
  setText(
    't-subs-sub',
    `${data.subscribers.active} active · ${data.subscribers.pending} pending · ` +
      `${data.subscribers.suspended} suspended`,
  );
  setText('t-revenue', formatMoney(data.revenue.total, currency));
  setText('t-revenue-sub', `${data.revenue.payments} payment${data.revenue.payments === 1 ? '' : 's'} recorded`);
  setText('t-unpaid', String(data.outstanding.length));
  setText('t-new', String(data.subscribers.newLast30Days));

  setText('r-total', formatMoney(data.revenue.total, currency));
  setText('r-30', formatMoney(data.revenue.last30Days, currency));
  setText('r-count', String(data.revenue.payments));
  setText('r-latest', data.revenue.latestPaymentAt ? formatDate(data.revenue.latestPaymentAt) : '—');

  // --- countries ---------------------------------------------------------
  setText(
    'country-sub',
    `${data.byCountry.length} countr${data.byCountry.length === 1 ? 'y' : 'ies'} represented`,
  );
  $('country-rows').innerHTML =
    data.byCountry.length === 0
      ? '<tr><td colspan="3" class="faint">No subscribers yet.</td></tr>'
      : data.byCountry
          .map(
            (c) => `<tr>
              <td>${escapeHtml(c.country)}</td>
              <td>${c.subscribers}</td>
              <td>${escapeHtml(formatMoney(c.revenue, currency))}</td>
            </tr>`,
          )
          .join('');

  drawCountryChart(data.byCountry);
  drawRevenueChart(data.revenue.byMonth);

  // --- arrears -----------------------------------------------------------
  const rows = $('unpaid-rows');
  if (data.outstanding.length === 0) {
    rows.innerHTML =
      '<tr><td colspan="7" class="faint">Everyone is paid up. Nothing outstanding.</td></tr>';
  } else {
    rows.innerHTML = data.outstanding
      .map((s) => {
        const state = s.neverPaid
          ? '<span class="tag critical">never paid</span>'
          : s.daysOverdue
            ? `<span class="tag critical">${s.daysOverdue}d overdue</span>`
            : '<span class="tag high">due soon</span>';
        return `<tr>
          <td>${escapeHtml(s.company || '—')}</td>
          <td>${escapeHtml(s.name)}<div class="faint" style="font-size:11.5px">${escapeHtml(s.email)}</div></td>
          <td>${escapeHtml(s.country || '—')}</td>
          <td>${state}</td>
          <td>${s.renewsAt ? escapeHtml(formatDate(s.renewsAt)) : '—'}</td>
          <td>${escapeHtml(formatMoney(s.paidTotal, s.currency || currency))}</td>
          <td><button class="icon-btn record-pay" data-id="${s.id}"
                      data-name="${escapeHtml(s.company || s.name)}">Record payment</button></td>
        </tr>`;
      })
      .join('');
  }
}

async function loadSubscribers(query = '') {
  const params = query ? `?q=${encodeURIComponent(query)}` : '';
  const rows = await api(`/api/admin/subscribers${params}`);

  setText('subs-sub', `${rows.length} account${rows.length === 1 ? '' : 's'}`);
  $('sub-rows').innerHTML =
    rows.length === 0
      ? '<tr><td colspan="8" class="faint">No subscribers found.</td></tr>'
      : rows
          .map(
            (s) => `<tr>
              <td>${escapeHtml(s.company || '—')}<div class="faint" style="font-size:11.5px">${escapeHtml(s.name)}</div></td>
              <td>${escapeHtml(s.username || '—')}</td>
              <td>${escapeHtml(s.country || '—')}</td>
              <td><span class="tag ${s.status === 'active' ? 'info' : s.status === 'pending' ? 'medium' : 'critical'}">${escapeHtml(s.status)}</span></td>
              <td>${escapeHtml(formatDate(s.created_at))}</td>
              <td>${s.last_login_at ? escapeHtml(formatDate(s.last_login_at)) : 'never'}</td>
              <td>${escapeHtml(formatMoney(s.paid_total, s.currency || currency))}</td>
              <td>
                <button class="icon-btn record-pay" data-id="${s.id}"
                        data-name="${escapeHtml(s.company || s.name)}">Payment</button>
                <button class="icon-btn toggle-status" data-id="${s.id}"
                        data-status="${s.status === 'active' ? 'suspended' : 'active'}">
                  ${s.status === 'active' ? 'Suspend' : 'Activate'}
                </button>
              </td>
            </tr>`,
          )
          .join('');
}

async function loadFeedback() {
  const items = await api('/api/admin/feedback');
  setText('fb-sub', `${items.length} submission${items.length === 1 ? '' : 's'}`);

  $('fb-list').innerHTML =
    items.length === 0
      ? '<p class="faint">No feedback yet.</p>'
      : items
          .map(
            (f) => `<div class="feedback-item">
              <div class="fi-head">
                <span>${'★'.repeat(f.rating ?? 0)}${'☆'.repeat(5 - (f.rating ?? 0))}</span>
                <strong>${escapeHtml(f.company || f.name)}</strong>
                <span class="faint">${escapeHtml(f.country || '')}</span>
                <span class="faint">${escapeHtml(formatDate(f.created_at))}</span>
                <span class="spacer" style="flex:1"></span>
                <select class="fb-status" data-id="${f.id}">
                  ${['new', 'reviewed', 'actioned']
                    .map((s) => `<option value="${s}"${s === f.status ? ' selected' : ''}>${s}</option>`)
                    .join('')}
                </select>
              </div>
              ${f.subject ? `<div class="fi-subject">${escapeHtml(f.subject)}</div>` : ''}
              <div class="fi-body">${escapeHtml(f.message)}</div>
            </div>`,
          )
          .join('');
}

// ----------------------------------------------------------------- charts

function drawCountryChart(byCountry) {
  if (typeof Chart === 'undefined') return;
  const top = byCountry.slice(0, 10);
  if (countryChart) countryChart.destroy();

  countryChart = new Chart($('country-chart'), {
    type: 'bar',
    data: {
      labels: top.map((c) => c.country),
      datasets: [
        {
          data: top.map((c) => c.subscribers),
          backgroundColor: '#22d3ee',
          borderRadius: 5,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: 'rgba(120,160,220,.1)' },
          ticks: { color: '#97a6c4', precision: 0, font: { size: 10 } },
        },
        y: { grid: { display: false }, ticks: { color: '#97a6c4', font: { size: 10.5 } } },
      },
    },
  });
}

function drawRevenueChart(byMonth) {
  if (typeof Chart === 'undefined') return;
  if (revenueChart) revenueChart.destroy();

  revenueChart = new Chart($('revenue-chart'), {
    type: 'bar',
    data: {
      labels: byMonth.map((m) => m.month),
      datasets: [
        {
          data: byMonth.map((m) => m.total),
          backgroundColor: '#8b5cf6',
          borderRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => formatMoney(ctx.parsed.y, currency) },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#97a6c4', font: { size: 10 } } },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(120,160,220,.1)' },
          ticks: { color: '#97a6c4', font: { size: 10 } },
        },
      },
    },
  });
}

// ------------------------------------------------------------ interaction

function wire() {
  $('signout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/admin';
  });

  let searchTimer;
  $('sub-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadSubscribers(event.target.value.trim()), 260);
  });

  // Delegated: the payment button appears in two different tables.
  document.addEventListener('click', (event) => {
    const pay = event.target.closest('.record-pay');
    if (pay) return openPaymentDialog(pay.dataset.id, pay.dataset.name);

    const toggle = event.target.closest('.toggle-status');
    if (toggle) return setStatus(toggle.dataset.id, toggle.dataset.status);
  });

  document.addEventListener('change', async (event) => {
    const select = event.target.closest('.fb-status');
    if (!select) return;
    try {
      await api(`/api/admin/feedback/${select.dataset.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: select.value }),
      });
    } catch (error) {
      showMessage(error.message);
    }
  });

  $('pay-cancel').addEventListener('click', () => $('pay-dialog').close());
  $('pay-save').addEventListener('click', recordPayment);
}

function openPaymentDialog(id, name) {
  payingUserId = id;
  $('pay-title').textContent = `Record a payment — ${name}`;
  $('pay-currency').value = currency;
  $('pay-date').value = new Date().toISOString().slice(0, 10);
  $('pay-msg').className = 'msg';
  $('pay-dialog').showModal();
}

async function recordPayment() {
  const button = $('pay-save');
  button.disabled = true;
  try {
    await api(`/api/admin/subscribers/${payingUserId}/payments`, {
      method: 'POST',
      body: JSON.stringify({
        amount: Number($('pay-amount').value),
        currency: $('pay-currency').value.trim() || currency,
        months: Number($('pay-months').value) || 12,
        method: $('pay-method').value.trim(),
        reference: $('pay-ref').value.trim(),
        paidAt: $('pay-date').value || undefined,
      }),
    });
    $('pay-dialog').close();
    $('pay-form').reset();
    showMessage('Payment recorded and renewal date updated.', 'ok');
    await Promise.all([loadDashboard(), loadSubscribers($('sub-search').value.trim())]);
  } catch (error) {
    const msg = $('pay-msg');
    msg.textContent = error.message;
    msg.className = 'msg show error';
  } finally {
    button.disabled = false;
  }
}

async function setStatus(id, status) {
  try {
    await api(`/api/admin/users/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    await Promise.all([loadDashboard(), loadSubscribers($('sub-search').value.trim())]);
    showMessage(`Account ${status}.`, 'ok');
  } catch (error) {
    showMessage(error.message);
  }
}

// --------------------------------------------------------------- helpers

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') {
    headers['x-csrf-token'] = csrfToken;
    if (options.body) headers['content-type'] = 'application/json';
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    location.href = '/admin';
    throw new Error('Session expired');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showMessage(text, kind = 'error') {
  const el = $('page-msg');
  el.textContent = text;
  el.className = `msg show ${kind}`;
  if (kind === 'ok') setTimeout(() => { el.className = 'msg'; }, 6000);
}

const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatMoney(amount, cur) {
  const value = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(value);
  } catch {
    return `${cur || ''} ${value.toFixed(2)}`.trim();
  }
}

function initials(name) {
  return String(name).split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
