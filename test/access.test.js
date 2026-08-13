/**
 * End-to-end access-control tests.
 *
 * These cover the property the product depends on: regulatory content is
 * readable only by an authenticated, active account.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const dbFile = path.join(os.tmpdir(), `dr-test-${process.pid}.db`);

let server;
let output = '';

/** Complete the two-step sign-in and return the session cookie. */
async function signIn(identifier, password) {
  const step1 = await post('/api/auth/login', { identifier, password });
  if (step1.status !== 200) return { status: step1.status, cookie: null };

  const body = await step1.json();
  const code = [...output.matchAll(/passcode is: (\d{6})/g)].at(-1)?.[1];
  const step2 = await post('/api/auth/verify', { challengeId: body.challengeId, code });
  const verified = await step2.json();
  return {
    status: step2.status,
    cookie: step2.headers.getSetCookie().join('; '),
    csrfToken: verified.csrfToken,
  };
}

before(async () => {
  server = spawn('node', ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_FILE: dbFile,
      AUTO_INGEST: '0',
      SEED_WHEN_EMPTY: '0',
      SESSION_SECRET: 'test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });

  // Wait for the listener to come up.
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => {
  server?.kill();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbFile}${suffix}`, { force: true });
  }
});

const GATED = [
  '/api/updates',
  '/api/stats',
  '/api/authorities',
  '/api/filters',
  '/api/status',
  '/api/admin/sources',
  '/api/admin/users',
];

test('gated endpoints reject anonymous requests', async () => {
  for (const endpoint of GATED) {
    const response = await fetch(BASE + endpoint);
    assert.equal(response.status, 401, `${endpoint} should require auth`);

    const body = await response.text();
    assert.ok(!body.includes('"items"'), `${endpoint} must not return feed items`);
  }
});

test('the dashboard page redirects anonymous visitors to sign in', async () => {
  const response = await fetch(`${BASE}/app`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') ?? '', /^\/\?next=/);
});

test('health and public summary stay reachable without an account', async () => {
  const health = await fetch(`${BASE}/api/health`);
  assert.equal(health.status, 200);

  const summary = await fetch(`${BASE}/api/public/summary`);
  assert.equal(summary.status, 200);

  const body = await summary.json();
  assert.ok(typeof body.authorities === 'number');
  assert.ok(typeof body.feeds === 'number');
  assert.ok(body.authorities >= body.feeds);
  // The public summary must expose counts only, never content.
  assert.ok(!('items' in body));
});

test('registration validates input', async () => {
  const short = await post('/api/auth/register', {
    email: 'a@b.co', name: 'A', company: 'C', username: 'shorty', password: 'short1',
  });
  assert.equal(short.status, 400);

  const noDigits = await post('/api/auth/register', {
    email: 'a@b.co', name: 'A', company: 'C', username: 'nodigits', password: 'onlylettershere',
  });
  assert.equal(noDigits.status, 400);

  const badEmail = await post('/api/auth/register', {
    email: 'not-an-email', name: 'A', company: 'C', username: 'bademail', password: 'validpass123',
  });
  assert.equal(badEmail.status, 400);
});

test('a registered subscriber can read the feed, and a wrong password cannot', async () => {
  const registration = await post('/api/auth/register', {
    email: 'customer@example.com',
    username: 'customer',
    name: 'Test Customer',
    company: 'Example Ltd',
    country: 'Ireland',
    password: 'validpass123',
  });
  assert.equal(registration.status, 201);

  const session = await signIn('customer', 'validpass123');
  assert.equal(session.status, 200);
  assert.match(session.cookie, /tr_session=/);
  assert.match(session.cookie, /HttpOnly/i);

  const feed = await fetch(`${BASE}/api/updates`, { headers: { cookie: session.cookie } });
  assert.equal(feed.status, 200);
  const body = await feed.json();
  assert.ok(Array.isArray(body.items));

  const wrong = await post('/api/auth/login', {
    identifier: 'customer',
    password: 'wrongpassword1',
  });
  assert.equal(wrong.status, 401);
});

test('a subscriber cannot reach administrator endpoints', async () => {
  const session = await signIn('customer', 'validpass123');
  const response = await fetch(`${BASE}/api/admin/sources`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(response.status, 403);
});

test('state-changing requests require a CSRF token', async () => {
  const session = await signIn('customer', 'validpass123');

  const without = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: session.cookie },
  });
  assert.equal(without.status, 403);

  const withToken = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
  });
  assert.equal(withToken.status, 200);

  // The session must be dead after logout.
  const after = await fetch(`${BASE}/api/updates`, { headers: { cookie: session.cookie } });
  assert.equal(after.status, 401);
});

test('a forged session cookie is rejected', async () => {
  const response = await fetch(`${BASE}/api/updates`, {
    headers: { cookie: 'tr_session=totally-made-up-session-id' },
  });
  assert.equal(response.status, 401);
});

function post(endpoint, body) {
  return fetch(BASE + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
