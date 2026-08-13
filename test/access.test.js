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
    stdio: 'ignore',
  });

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
    email: 'a@b.co', name: 'A', password: 'short1',
  });
  assert.equal(short.status, 400);

  const noDigits = await post('/api/auth/register', {
    email: 'a@b.co', name: 'A', password: 'onlylettershere',
  });
  assert.equal(noDigits.status, 400);

  const badEmail = await post('/api/auth/register', {
    email: 'not-an-email', name: 'A', password: 'validpass123',
  });
  assert.equal(badEmail.status, 400);
});

test('a registered customer can read the feed, and a wrong password cannot', async () => {
  const registration = await post('/api/auth/register', {
    email: 'customer@example.com',
    name: 'Test Customer',
    organisation: 'Example Ltd',
    password: 'validpass123',
  });
  assert.equal(registration.status, 201);

  const cookie = registration.headers.getSetCookie().join('; ');
  assert.match(cookie, /dr_session=/);
  assert.match(cookie, /HttpOnly/i);

  const feed = await fetch(`${BASE}/api/updates`, { headers: { cookie } });
  assert.equal(feed.status, 200);
  const body = await feed.json();
  assert.ok(Array.isArray(body.items));

  const wrong = await post('/api/auth/login', {
    email: 'customer@example.com',
    password: 'wrongpassword1',
  });
  assert.equal(wrong.status, 401);
});

test('a customer cannot reach administrator endpoints', async () => {
  const login = await post('/api/auth/login', {
    email: 'customer@example.com',
    password: 'validpass123',
  });
  const cookie = login.headers.getSetCookie().join('; ');

  const response = await fetch(`${BASE}/api/admin/sources`, { headers: { cookie } });
  assert.equal(response.status, 403);
});

test('state-changing requests require a CSRF token', async () => {
  const login = await post('/api/auth/login', {
    email: 'customer@example.com',
    password: 'validpass123',
  });
  const cookie = login.headers.getSetCookie().join('; ');
  const { csrfToken } = await login.json();

  const without = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(without.status, 403);

  const withToken = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrfToken },
  });
  assert.equal(withToken.status, 200);

  // The session must be dead after logout.
  const after = await fetch(`${BASE}/api/updates`, { headers: { cookie } });
  assert.equal(after.status, 401);
});

test('a forged session cookie is rejected', async () => {
  const response = await fetch(`${BASE}/api/updates`, {
    headers: { cookie: 'dr_session=totally-made-up-session-id' },
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
