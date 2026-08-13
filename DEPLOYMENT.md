# Deployment

Timely Regulatory is a single Node process with an embedded SQLite database. It
has no external service dependencies — no Postgres, no Redis, no message queue.

## Before you deploy

1. **Set `SESSION_SECRET`.** Without it a random secret is generated at boot and
   every restart silently signs everyone out.
2. **Set `COOKIE_SECURE=1`** and terminate TLS in front of the app. Session
   cookies should never travel over plain HTTP.
3. **Give `data/` persistent storage.** The SQLite file holds every account and
   all feed history. On an ephemeral filesystem you lose both on each restart.
4. **Put a real contact address in `FEED_USER_AGENT`.** Authorities can then
   reach you instead of blocking an anonymous poller.
5. **Run `npm run probe`** from the deployment network to confirm outbound HTTPS
   to the authorities is permitted.

## Requirements

- Node.js **22.5+** (for `node:sqlite`)
- A writable directory for the database
- Outbound HTTPS to the authority domains

## Environment

```bash
NODE_ENV=production
PORT=3000
SESSION_SECRET=<64 random hex characters>
COOKIE_SECURE=1
DB_FILE=/var/lib/timely-regulatory/timely-regulatory.db
FEED_USER_AGENT="TimelyRegulatory/1.0 (+https://your-domain.example; ops@your-domain.example)"
ADMIN_EMAIL=you@your-domain.example
REQUIRE_APPROVAL=1
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Running it

### systemd

```ini
[Unit]
Description=Timely Regulatory
After=network-online.target

[Service]
Type=simple
User=timely-regulatory
WorkingDirectory=/opt/timely-regulatory
EnvironmentFile=/etc/timely-regulatory.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StateDirectory=timely-regulatory

[Install]
WantedBy=multi-user.target
```

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/timely-regulatory.db
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
```

Mount a real volume at `/data`, or you will lose every account on redeploy.

### Platforms with an ephemeral filesystem

Heroku, Cloud Run and similar reset the disk on each deploy. Either attach a
persistent volume, or point `DB_FILE` at network-backed storage. The included
`Procfile` runs `node server.js`.

## Reverse proxy

The app sets `trust proxy` to 1, so `req.ip` reflects `X-Forwarded-For` from the
first hop. Configure your proxy to set it.

```nginx
server {
  listen 443 ssl http2;
  server_name your-domain.example;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

The app already sends CSP, HSTS (when `COOKIE_SECURE=1`), `X-Content-Type-Options`,
`X-Frame-Options`, `Referrer-Policy` and `Permissions-Policy`. Do not add a
second, looser CSP at the proxy — it will widen what the page is allowed to load.

## Polling from cron instead of in-process

For multiple web replicas, let one scheduled job do the ingesting so replicas do
not all poll the same feeds:

```bash
# web processes
AUTO_INGEST=0 node server.js

# every 15 minutes, one worker
*/15 * * * * cd /opt/timely-regulatory && npm run ingest >> /var/log/dr-ingest.log 2>&1
```

Note that SQLite expects one writer at a time; keep a single ingest job, and put
all replicas on the same filesystem or move to a client/server database if you
need to scale writers.

## Monitoring

- `GET /api/health` — public liveness probe, no authentication, no content.
- `GET /api/status` — requires a session; reports item counts, how many feeds
  are reachable, and the last ingest time.
- The admin **Feed health** panel lists every source with its last status and
  last success. A source stuck on a non-200 usually means the endpoint moved —
  update it in `server/ingest/sources.js`.

## Backups

Back up the SQLite file. With the app running, use the online backup rather than
copying the file directly:

```bash
sqlite3 /var/lib/timely-regulatory/timely-regulatory.db ".backup '/backup/dr-$(date +%F).db'"
```

## First administrator

Set `ADMIN_EMAIL` before the first registration and register with that address —
it is promoted to administrator automatically. To promote later:

```bash
sqlite3 "$DB_FILE" "UPDATE users SET role='admin' WHERE email='you@example.com';"
```
