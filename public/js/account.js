/** Subscriber account page: profile, subscription, payments, feedback. */
const $ = (id) => document.getElementById(id);

let csrfToken = null;
let rating = 0;

init().catch((error) => showMessage(error.message || 'Could not load your account.'));

async function init() {
  const me = await api('/api/auth/me');
  csrfToken = me.csrfToken;
  $('user-name').textContent = me.user.name;
  $('avatar').textContent = initials(me.user.name);

  await Promise.all([loadAccount(), loadFeedback()]);
  wire();
}

async function loadAccount() {
  const data = await api('/api/account');
  const { profile, subscription, billing } = data;

  setText('a-username', profile.username || '—');
  setText('a-name', profile.name);
  setText('a-company', profile.company || '—');
  setText('a-country', profile.country || '—');
  setText('a-email', profile.email);
  setText('a-lastlogin', profile.lastLoginAt ? formatDateTime(profile.lastLoginAt) : 'First sign-in');
  setText('a-session', formatDateTime(profile.currentSessionSince));
  setText('a-since', formatDate(profile.memberSince));

  $('pw-changed').textContent = profile.passwordChangedAt
    ? `Password last changed ${formatDate(profile.passwordChangedAt)}.`
    : '';

  // Pre-fill the edit form.
  $('p-name').value = profile.name;
  $('p-company').value = profile.company || '';
  $('p-country').value = profile.country || '';

  // --- subscription ----------------------------------------------------
  const standing = $('sub-standing');
  if (subscription) {
    setText('s-plan', capitalise(subscription.plan));
    setText('s-status', capitalise(subscription.status));
    setText('s-started', subscription.startedAt ? formatDate(subscription.startedAt) : '—');
    setText('s-lastpaid', subscription.lastPaidAt ? formatDate(subscription.lastPaidAt) : 'No payment recorded');
    setText('s-renews', subscription.renewsAt ? formatDate(subscription.renewsAt) : '—');

    const labels = {
      active: ['Active', 'info'],
      trial: ['Trial', 'medium'],
      'due-soon': ['Renewal due', 'high'],
      expired: ['Expired', 'critical'],
    };
    const [label, tone] = labels[subscription.standing] ?? [capitalise(subscription.standing), ''];
    standing.textContent = label;
    standing.className = `tag ${tone}`;

    const callout = $('renewal-callout');
    const days = subscription.daysRemaining;
    if (subscription.standing === 'expired') {
      callout.className = 'banner';
      callout.innerHTML =
        '<div><strong>Your subscription has lapsed.</strong> Top up to restore full access.</div>';
    } else if (subscription.standing === 'due-soon') {
      callout.className = 'banner';
      callout.innerHTML =
        `<div><strong>Renewal due in ${days} day${days === 1 ? '' : 's'}.</strong> ` +
        'Top up now to avoid interruption.</div>';
    } else if (subscription.standing === 'trial' && days !== null) {
      callout.className = 'banner';
      callout.innerHTML =
        `<div><strong>Trial period.</strong> ${days} day${days === 1 ? '' : 's'} remaining.</div>`;
    } else {
      callout.className = 'banner hidden';
    }
  } else {
    standing.textContent = 'No subscription';
  }

  setText('s-total', formatMoney(billing.totalPaid, billing.currency));

  // --- payment link ----------------------------------------------------
  const topup = $('topup-btn');
  if (billing.paymentUrl) {
    topup.href = billing.paymentUrl;
    topup.classList.remove('hidden');
    $('topup-note').textContent = 'Opens your checkout page in a new tab.';
  } else {
    // No checkout configured yet: do not present a dead button.
    topup.classList.add('hidden');
    $('topup-note').textContent =
      'No payment link has been configured yet. Contact your account manager to renew.';
  }

  // --- payment history -------------------------------------------------
  const rows = $('payment-rows');
  if (billing.payments.length === 0) {
    rows.innerHTML = '<tr><td colspan="5" class="faint">No payments recorded yet.</td></tr>';
  } else {
    rows.innerHTML = billing.payments
      .map(
        (p) => `<tr>
          <td>${escapeHtml(formatDate(p.paid_at))}</td>
          <td>${escapeHtml(formatMoney(p.amount, p.currency))}</td>
          <td>${escapeHtml(p.method || '—')}</td>
          <td>${escapeHtml(p.reference || '—')}</td>
          <td>${p.period_from && p.period_to
            ? `${escapeHtml(formatDate(p.period_from))} – ${escapeHtml(formatDate(p.period_to))}`
            : '—'}</td>
        </tr>`,
      )
      .join('');
  }
}

async function loadFeedback() {
  const items = await api('/api/account/feedback');
  const box = $('feedback-history');
  if (items.length === 0) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML =
    '<h4 style="font-size:13px;color:var(--text-dim);margin:0 0 10px">Your previous feedback</h4>' +
    items
      .map(
        (f) => `<div class="feedback-item">
          <div class="fi-head">
            <span>${'★'.repeat(f.rating ?? 0)}${'☆'.repeat(5 - (f.rating ?? 0))}</span>
            <span class="faint">${escapeHtml(formatDate(f.created_at))}</span>
            <span class="tag">${escapeHtml(f.status)}</span>
          </div>
          ${f.subject ? `<div class="fi-subject">${escapeHtml(f.subject)}</div>` : ''}
          <div class="fi-body">${escapeHtml(f.message)}</div>
        </div>`,
      )
      .join('');
}

function wire() {
  $('signout-btn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/';
  });

  $('edit-profile-btn').addEventListener('click', () => {
    $('profile-form').classList.toggle('hidden');
  });
  $('p-cancel').addEventListener('click', () => $('profile-form').classList.add('hidden'));

  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await guard($('p-submit'), 'Saving…', async () => {
      await api('/api/account/profile', {
        method: 'POST',
        body: JSON.stringify({
          name: $('p-name').value.trim(),
          company: $('p-company').value.trim(),
          country: $('p-country').value.trim(),
        }),
      });
      $('profile-form').classList.add('hidden');
      await loadAccount();
      showMessage('Details updated.', 'ok');
    });
  });

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('cp-new').value !== $('cp-confirm').value) {
      return showMessage('The new passwords do not match.');
    }
    await guard($('cp-submit'), 'Changing…', async () => {
      const result = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: $('cp-current').value,
          newPassword: $('cp-new').value,
        }),
      });
      $('password-form').reset();
      showMessage(result.message || 'Password changed.', 'ok');
      await loadAccount();
    });
  });

  // Star rating
  const stars = $('stars');
  stars.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-v]');
    if (!button) return;
    rating = Number(button.dataset.v);
    for (const b of stars.querySelectorAll('button')) {
      b.classList.toggle('on', Number(b.dataset.v) <= rating);
    }
  });

  $('feedback-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await guard($('fb-submit'), 'Sending…', async () => {
      const result = await api('/api/account/feedback', {
        method: 'POST',
        body: JSON.stringify({
          rating: rating || null,
          subject: $('fb-subject').value.trim(),
          message: $('fb-message').value.trim(),
        }),
      });
      $('feedback-form').reset();
      rating = 0;
      for (const b of stars.querySelectorAll('button')) b.classList.remove('on');
      showMessage(result.message, 'ok');
      await loadFeedback();
    });
  });
}

// --------------------------------------------------------------- helpers

async function guard(button, busyLabel, action) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    await action();
  } catch (error) {
    showMessage(error.message || 'Something went wrong.');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') {
    headers['x-csrf-token'] = csrfToken;
    if (options.body) headers['content-type'] = 'application/json';
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    location.href = '/?next=/account';
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
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (kind === 'ok') setTimeout(() => { el.className = 'msg'; }, 6000);
}

const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
const capitalise = (s) => String(s ?? '').charAt(0).toUpperCase() + String(s ?? '').slice(1);

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
}

function formatMoney(amount, currency) {
  const value = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' })
      .format(value);
  } catch {
    return `${currency || ''} ${value.toFixed(2)}`.trim();
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
