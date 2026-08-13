/**
 * Administrator portal sign-in.
 *
 * Deliberately separate from the subscriber flow: it posts to the /admin
 * endpoints, which refuse any account that is not an administrator.
 */
const $ = (id) => document.getElementById(id);

const formSignin = $('form-signin');
const formPasscode = $('form-passcode');
const formForgot = $('form-forgot');
const msgEl = $('auth-msg');

let challengeId = null;

function showPanel(which, { keepMessage = false } = {}) {
  formSignin.classList.toggle('hidden', which !== 'signin');
  formPasscode.classList.toggle('hidden', which !== 'passcode');
  formForgot.classList.toggle('hidden', which !== 'forgot');
  if (!keepMessage) clearMessage();
}

function showMessage(text, kind = 'error') {
  msgEl.textContent = text;
  msgEl.className = `msg show ${kind}`;
}
function clearMessage() {
  msgEl.className = 'msg';
  msgEl.textContent = '';
}

$('forgot-link').addEventListener('click', () => showPanel('forgot'));
$('fg-back').addEventListener('click', () => showPanel('signin'));
$('pc-back').addEventListener('click', () => {
  challengeId = null;
  showPanel('signin');
});

formSignin.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit($('ad-submit'), 'Checking…', async () => {
    const response = await postJson('/api/auth/admin/login', {
      identifier: $('ad-user').value.trim(),
      password: $('ad-password').value,
    });

    if (!response.passcodeRequired) {
      location.href = '/admin/dashboard';
      return response;
    }

    challengeId = response.challengeId;
    $('pc-target').textContent = response.sentTo;
    $('pc-expiry').textContent = `Expires in ${response.expiresInMinutes} minutes.`;
    showPanel('passcode');
    $('pc-code').focus();
    return response;
  });
});

formPasscode.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit($('pc-submit'), 'Verifying…', async () => {
    const response = await postJson('/api/auth/admin/verify', {
      challengeId,
      code: $('pc-code').value.trim(),
    });
    location.href = response.home || '/admin/dashboard';
    return response;
  });
});

$('pc-resend').addEventListener('click', async () => {
  try {
    const response = await postJson('/api/auth/resend', { challengeId });
    challengeId = response.challengeId;
    $('pc-code').value = '';
    showMessage(`A new passcode has been sent to ${response.sentTo}.`, 'ok');
  } catch (error) {
    showMessage(error.message);
  }
});

formForgot.addEventListener('submit', async (event) => {
  event.preventDefault();
  await submit($('fg-submit'), 'Sending…', async () => {
    const response = await postJson('/api/auth/forgot', {
      identifier: $('fg-user').value.trim(),
    });
    showPanel('signin', { keepMessage: true });
    showMessage(response.message, 'ok');
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
  } finally {
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
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
