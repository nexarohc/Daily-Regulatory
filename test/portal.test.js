/**
 * Two-portal access control: subscriber and administrator sign-in, the
 * mandatory emailed passcode, password recovery, and the operator dashboard.
 *
 * The server runs with the console mail transport, so passcodes are captured
 * from its output rather than a mailbox.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(os.tmpdir(), `tr-portal-${process.pid}.db`);

let server;
let output = '';

/** The most recent passcode the server "sent". */
function latestPasscode() {
  const matches = [...output.matchAll(/passcode is: (\d{6})/g)];
  return matches.at(-1)?.[1] ?? null;
}

/** The most recent password-reset link. */
function latestResetToken() {
  const matches = [...output.matchAll(/\/reset\?token=([^\s]+)/g)];
  return matches.at(-1)?.[1] ?? null;
}

const post = (endpoint, body, cookie) =>
  fetch(BASE + endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const cookieOf = (response) => response.headers.getSetCookie().join('; ');

before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_FILE: dbFile,
      AUTO_INGEST: '0',
      SEED_WHEN_EMPTY: '0',
      SESSION_SECRET: 'portal-test-secret',
      ADMIN_EMAIL: 'owner@example.com',
      SMTP_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  server?.kill();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true });
});

// --------------------------------------------------------------- fixtures

const SUBSCRIBER = {
  username: 'acme.qa',
  name: 'Ravi Kumar',
  company: 'Acme Pharmaceuticals',
  country: 'India',
  email: 'ravi@acme.example',
  password: 'compliance2026',
};

const ADMIN = {
  username: 'owner',
  name: 'Site Owner',
  company: 'Timely Regulatory',
  country: 'India',
  email: 'owner@example.com',
  password: 'ownerpass2026',
};

/** Complete a two-step sign-in and return the session cookie + CSRF token. */
async function signIn({ identifier, password }, portal = 'subscriber') {
  const prefix = portal === 'admin' ? '/api/auth/admin' : '/api/auth';

  const step1 = await post(`${prefix}/login`, { identifier, password });
  assert.equal(step1.status, 200, `${portal} password step should succeed`);
  const { challengeId } = await step1.json();

  const code = latestPasscode();
  assert.ok(code, 'a passcode should have been issued');

  const step2 = await post(`${prefix}/verify`, { challengeId, code });
  assert.equal(step2.status, 200, `${portal} passcode step should succeed`);
  const body = await step2.json();
  return { cookie: cookieOf(step2), csrfToken: body.csrfToken, body };
}

// ------------------------------------------------------------------ tests

test('registration requires a username, company and strong password', async () => {
  const noCompany = await post('/api/auth/register', { ...SUBSCRIBER, company: '' });
  assert.equal(noCompany.status, 400);

  const badUsername = await post('/api/auth/register', { ...SUBSCRIBER, username: 'a b' });
  assert.equal(badUsername.status, 400);

  const weak = await post('/api/auth/register', { ...SUBSCRIBER, password: 'short1' });
  assert.equal(weak.status, 400);
});

test('registering does not by itself grant a session', async () => {
  const response = await post('/api/auth/register', SUBSCRIBER);
  assert.equal(response.status, 201);

  const body = await response.json();
  assert.equal(body.registered, true);
  // No session cookie: the passcode step still has to be completed.
  assert.equal(response.headers.getSetCookie().length, 0);
});

test('a correct password alone does not open the feed', async () => {
  const response = await post('/api/auth/login', {
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.passcodeRequired, true);
  assert.ok(body.challengeId);
  // The masked address must not reveal the whole mailbox.
  assert.ok(body.sentTo.includes('•'));
  assert.ok(!body.sentTo.startsWith(SUBSCRIBER.email));

  // Whatever cookie came back must not be a usable session.
  const feed = await fetch(`${BASE}/api/updates`, { headers: { cookie: cookieOf(response) } });
  assert.equal(feed.status, 401);
});

test('the passcode is never returned through the API', async () => {
  const response = await post('/api/auth/login', {
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });
  const raw = JSON.stringify(await response.json());
  const code = latestPasscode();
  assert.ok(code);
  assert.ok(!raw.includes(code), 'the response body must not contain the passcode');
});

test('an incorrect passcode is rejected and counted', async () => {
  const step1 = await post('/api/auth/login', {
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });
  const { challengeId } = await step1.json();

  const wrong = await post('/api/auth/verify', { challengeId, code: '000000' });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /Incorrect passcode/);
});

test('a passcode cannot be replayed', async () => {
  const step1 = await post('/api/auth/login', {
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });
  const { challengeId } = await step1.json();
  const code = latestPasscode();

  const first = await post('/api/auth/verify', { challengeId, code });
  assert.equal(first.status, 200);

  const second = await post('/api/auth/verify', { challengeId, code });
  assert.equal(second.status, 401, 'a consumed challenge must not work twice');
});

test('a completed sign-in opens the feed and the account', async () => {
  const { cookie } = await signIn({
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });

  const feed = await fetch(`${BASE}/api/updates`, { headers: { cookie } });
  assert.equal(feed.status, 200);

  const account = await fetch(`${BASE}/api/account`, { headers: { cookie } });
  assert.equal(account.status, 200);

  const data = await account.json();
  assert.equal(data.profile.username, SUBSCRIBER.username);
  assert.equal(data.profile.company, SUBSCRIBER.company);
  assert.ok(data.subscription, 'a new subscriber should start on a trial');
  assert.equal(data.subscription.status, 'trial');
  assert.equal(data.billing.totalPaid, 0);
});

test('signing in with the email address also works', async () => {
  const { cookie } = await signIn({
    identifier: SUBSCRIBER.email,
    password: SUBSCRIBER.password,
  });
  const account = await fetch(`${BASE}/api/account`, { headers: { cookie } });
  assert.equal(account.status, 200);
});

test('the two portals refuse each other\'s accounts', async () => {
  await post('/api/auth/register', ADMIN);

  // A subscriber cannot use the administrator portal.
  const subAtAdmin = await post('/api/auth/admin/login', {
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });
  assert.equal(subAtAdmin.status, 403);

  // An administrator cannot use the subscriber portal.
  const adminAtSub = await post('/api/auth/login', {
    identifier: ADMIN.username,
    password: ADMIN.password,
  });
  assert.equal(adminAtSub.status, 403);
  assert.match((await adminAtSub.json()).error, /administrator portal/i);
});

test('a subscriber challenge cannot be completed at the admin portal', async () => {
  const step1 = await post('/api/auth/login', {
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });
  const { challengeId } = await step1.json();
  const code = latestPasscode();

  const crossed = await post('/api/auth/admin/verify', { challengeId, code });
  assert.equal(crossed.status, 401, 'a challenge is bound to the portal that raised it');
});

test('the administrator can sign in and read the dashboard', async () => {
  const { cookie, body } = await signIn(
    { identifier: ADMIN.username, password: ADMIN.password },
    'admin',
  );
  assert.equal(body.user.role, 'admin');
  assert.equal(body.home, '/admin/dashboard');

  const response = await fetch(`${BASE}/api/admin/dashboard`, { headers: { cookie } });
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.subscribers.total, 1, 'the admin account is not itself a subscriber');
  assert.deepEqual(
    data.byCountry.map((c) => c.country),
    ['India'],
  );
  assert.equal(data.revenue.total, 0);
  assert.equal(data.outstanding.length, 1);
  assert.equal(data.outstanding[0].neverPaid, true);
});

test('recording a payment updates revenue, arrears and the subscriber view', async () => {
  const admin = await signIn({ identifier: ADMIN.username, password: ADMIN.password }, 'admin');

  const subscribers = await (
    await fetch(`${BASE}/api/admin/subscribers`, { headers: { cookie: admin.cookie } })
  ).json();
  const target = subscribers.find((s) => s.username === SUBSCRIBER.username);
  assert.ok(target);

  const payment = await fetch(`${BASE}/api/admin/subscribers/${target.id}/payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: admin.cookie,
      'x-csrf-token': admin.csrfToken,
    },
    body: JSON.stringify({ amount: 4800, months: 12, reference: 'INV-001' }),
  });
  assert.equal(payment.status, 201);

  const dashboard = await (
    await fetch(`${BASE}/api/admin/dashboard`, { headers: { cookie: admin.cookie } })
  ).json();
  assert.equal(dashboard.revenue.total, 4800);
  assert.equal(dashboard.byCountry[0].revenue, 4800);
  assert.equal(dashboard.outstanding.length, 0, 'a paid subscriber leaves the arrears list');

  const subscriber = await signIn({
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });
  const account = await (
    await fetch(`${BASE}/api/account`, { headers: { cookie: subscriber.cookie } })
  ).json();
  assert.equal(account.subscription.standing, 'active');
  assert.equal(account.billing.totalPaid, 4800);
  assert.equal(account.billing.payments.length, 1);
});

test('recording a payment requires a CSRF token', async () => {
  const admin = await signIn({ identifier: ADMIN.username, password: ADMIN.password }, 'admin');
  const response = await fetch(`${BASE}/api/admin/subscribers/1/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: admin.cookie },
    body: JSON.stringify({ amount: 100 }),
  });
  assert.equal(response.status, 403);
});

test('feedback is stored and visible to the administrator', async () => {
  const subscriber = await signIn({
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });

  const sent = await fetch(`${BASE}/api/account/feedback`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: subscriber.cookie,
      'x-csrf-token': subscriber.csrfToken,
    },
    body: JSON.stringify({ rating: 5, subject: 'Very useful', message: 'The globe is great.' }),
  });
  assert.equal(sent.status, 201);

  const admin = await signIn({ identifier: ADMIN.username, password: ADMIN.password }, 'admin');
  const items = await (
    await fetch(`${BASE}/api/admin/feedback`, { headers: { cookie: admin.cookie } })
  ).json();
  assert.equal(items.length, 1);
  assert.equal(items[0].rating, 5);
  assert.equal(items[0].company, SUBSCRIBER.company);
});

test('forgotten password does not disclose whether an account exists', async () => {
  const known = await post('/api/auth/forgot', { identifier: SUBSCRIBER.email });
  const unknown = await post('/api/auth/forgot', { identifier: 'nobody@nowhere.example' });

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(await known.json(), await unknown.json());
});

test('a reset link sets a new password and revokes existing sessions', async () => {
  const session = await signIn({
    identifier: SUBSCRIBER.username,
    password: SUBSCRIBER.password,
  });

  await post('/api/auth/forgot', { identifier: SUBSCRIBER.email });
  const token = latestResetToken();
  assert.ok(token, 'a reset token should have been emailed');

  const weak = await post('/api/auth/reset', { token, password: 'short' });
  assert.equal(weak.status, 400);

  const reset = await post('/api/auth/reset', { token, password: 'newcompliance2026' });
  assert.equal(reset.status, 200);

  // The old session is gone.
  const stale = await fetch(`${BASE}/api/account`, { headers: { cookie: session.cookie } });
  assert.equal(stale.status, 401);

  // The token cannot be reused.
  const replay = await post('/api/auth/reset', { token, password: 'anothercompliance26' });
  assert.equal(replay.status, 400);

  // The new password works.
  const fresh = await signIn({
    identifier: SUBSCRIBER.username,
    password: 'newcompliance2026',
  });
  assert.ok(fresh.cookie);
});

test('changing the password requires the current one', async () => {
  const session = await signIn({
    identifier: SUBSCRIBER.username,
    password: 'newcompliance2026',
  });

  const wrong = await fetch(`${BASE}/api/auth/change-password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify({ currentPassword: 'notitatall1', newPassword: 'anothercompliance26' }),
  });
  assert.equal(wrong.status, 403);

  const ok = await fetch(`${BASE}/api/auth/change-password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify({
      currentPassword: 'newcompliance2026',
      newPassword: 'anothercompliance26',
    }),
  });
  assert.equal(ok.status, 200);
});

test('gated pages redirect the wrong audience', async () => {
  const admin = await signIn({ identifier: ADMIN.username, password: ADMIN.password }, 'admin');

  // Anonymous visitors are sent to the relevant sign-in page.
  const anonAccount = await fetch(`${BASE}/account`, { redirect: 'manual' });
  assert.equal(anonAccount.status, 302);

  const anonAdmin = await fetch(`${BASE}/admin/dashboard`, { redirect: 'manual' });
  assert.equal(anonAdmin.status, 302);
  assert.equal(anonAdmin.headers.get('location'), '/admin');

  // An administrator hitting the subscriber account page is redirected home.
  const adminAccount = await fetch(`${BASE}/account`, {
    headers: { cookie: admin.cookie },
    redirect: 'manual',
  });
  assert.equal(adminAccount.status, 302);
  assert.equal(adminAccount.headers.get('location'), '/admin/dashboard');
});
