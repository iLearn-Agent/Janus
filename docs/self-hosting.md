# 🌍 Self-hosting Janus

[English](self-hosting.md) · [简体中文](self-hosting.zh-CN.md) · [Back to README](../README.md)

Janus Desktop can be used without operating a shared server. Deploy a private server when your organization needs shared accounts, member communication, cross-user delegation, synchronized collaboration, or organization-wide Agent evolution.

The public repository contains application source code only. It does not contain a runtime database, user records, credentials, production secrets, or an operator's deployment data.

> [!IMPORTANT]
> Keep every production environment file, database backup, private key, mail credential, and service token outside the Git repository.

## 🧭 Deployment overview

A practical deployment needs:

- a Linux application server;
- Node.js 22+ and npm;
- a dedicated application database;
- a private environment file;
- an email delivery service for account verification;
- HTTPS and a domain name;
- a process supervisor such as systemd;
- a separate Worker process if organization-wide Agent evolution is enabled.

For small internal tests, the API and database may run on the same trusted machine. For production, separate responsibilities according to your organization's security and availability requirements.

## 📦 1. Install the application

```bash
git clone https://github.com/iLearn-Agent/Janus.git
cd Janus
npm ci
```

Use a dedicated operating-system account for the service. Do not run the application as `root`.

## 🗄️ 2. Create an application database

PostgreSQL 14 or newer is recommended for the current server implementation. Create an empty database and a restricted application user. The user should own the Janus database but should not be a PostgreSQL superuser.

Example:

```sql
CREATE ROLE janus_app LOGIN PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE janus OWNER janus_app;
```

Connection example:

```bash
export DATABASE_URL='postgres://janus_app:replace-with-a-strong-password@127.0.0.1:5432/janus'
```

Recommendations:

- allow database connections only from the application host or private network;
- require TLS when the database is on another machine;
- use a unique password that is not shared with any other service;
- schedule encrypted backups and regularly test restoration;
- start from an empty database and let the migration command create the required application schema;
- never upload database files or dumps to GitHub.

## 🔐 3. Prepare a private environment

For an initial private test:

```bash
export DATABASE_URL='postgres://janus_app:replace-me@127.0.0.1:5432/janus'
export JWT_SECRET="$(openssl rand -hex 32)"
export EMAIL_CODE_SECRET="$(openssl rand -hex 32)"
export MAIL_PROVIDER=console
export MAIL_FROM='Janus <no-reply@localhost>'
export PORT=8787
```

`MAIL_PROVIDER=console` prints account verification codes in the server terminal. Use it only on a trusted development machine.

For production, put environment variables in a file outside the repository, for example `/etc/janus/api.env`, and restrict it:

```bash
sudo install -d -m 0700 /etc/janus
sudo touch /etc/janus/api.env
sudo chmod 0600 /etc/janus/api.env
```

Production configuration should include:

- the database connection;
- long, independently generated authentication and email-code secrets;
- real SMTP settings;
- the public server origin;
- feature-specific service credentials used by your deployment;
- conservative request limits and timeouts.

Do not reuse desktop model credentials as server credentials.

## 🚀 4. Initialize and start the API

Run the database migration before the first start and before each server upgrade:

```bash
npm run cloud:migrate
```

Start the API:

```bash
npm run cloud:start
```

Verify it from another terminal:

```bash
curl http://127.0.0.1:8787/healthz
```

Expected response shape:

```json
{
  "ok": true,
  "status": "ok"
}
```

If migration fails, stop the deployment and fix the database connection or permissions. Do not manually create internal application tables.

## ✉️ 5. Configure email for production

Example SMTP environment:

```bash
MAIL_PROVIDER=smtp
MAIL_FROM='Janus <no-reply@example.com>'
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=replace-me
SMTP_PASS=replace-me
```

You may use a single `SMTP_URL` instead of individual SMTP fields. Before inviting users, verify registration, email verification, password reset, and organization security emails.

## 🧬 6. Enable the Evolution Worker when required

Shared accounts and communication can run without the Evolution Worker. Start it only when your deployment is ready to operate organization-wide evolution.

```bash
npm run cloud:evolution-worker
```

Production recommendations:

- run the Worker as a separate operating-system service;
- give it a separate database login with only the permissions it needs;
- keep its model-service credentials and evolution secrets out of the API environment;
- restrict its private environment file to the Worker service account;
- monitor every restart and the first processing cycle after an upgrade;
- test evolution changes in a staging environment before enabling them for users.

The Worker is responsible for advanced evolution processing. Its private governance configuration should be managed as deployment infrastructure, not documented in a public repository.

## ⚙️ 7. Run services with systemd

Example API unit:

```ini
[Unit]
Description=Janus API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=janus
WorkingDirectory=/opt/janus
EnvironmentFile=/etc/janus/api.env
ExecStart=/usr/bin/npm run cloud:start
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Create a second unit for the Worker with its own user or environment file and this start command:

```ini
ExecStart=/usr/bin/npm run cloud:evolution-worker
```

After installing or changing a unit:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now janus-api.service
sudo systemctl status janus-api.service
```

Adapt `User`, `WorkingDirectory`, Node/npm paths, and environment-file paths to your server.

## 🔒 8. Put the API behind HTTPS

Minimal Nginx example:

```nginx
server {
    listen 443 ssl http2;
    server_name janus.example.com;

    ssl_certificate     /etc/letsencrypt/live/janus.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/janus.example.com/privkey.pem;

    proxy_read_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
    }
}
```

Use a valid TLS certificate. Do not expose the database port or private service ports to the public internet.

## 🔗 9. Connect a desktop client

For a source checkout:

```bash
JANUS_AUTH_URL=https://janus.example.com \
JANUS_PACKAGED_CLOUD_URL=https://janus.example.com \
npm run dev:open-source
```

Use a fresh desktop profile when validating a new server:

```bash
JANUS_HOME=/path/to/test-profile \
JANUS_AUTH_URL=https://janus.example.com \
JANUS_PACKAGED_CLOUD_URL=https://janus.example.com \
npm run dev:open-source
```

For distributed desktop packages, configure the same public server origin during your private packaging process.

## ✅ 10. Production checklist

- [ ] Application runs under a dedicated non-root user.
- [ ] Database user is restricted and the database is not publicly reachable.
- [ ] Database backups and restoration have been tested.
- [ ] Environment files are outside Git and use mode `0600`.
- [ ] Real SMTP delivery has been tested.
- [ ] HTTPS is enabled and HTTP redirects to HTTPS.
- [ ] API health checks and service restart alerts are configured.
- [ ] Worker credentials are separated from API credentials.
- [ ] A staging deployment is used before production upgrades.
- [ ] Runtime databases, user data, logs, and credentials are excluded from every source release.

## 🔄 Upgrade procedure

1. Back up the application database and private deployment configuration.
2. Stop the Evolution Worker if it is enabled.
3. Update the source and run `npm ci`.
4. Run `npm run cloud:migrate` with the deployment database account.
5. Restart the API and verify `/healthz`.
6. Restart the Worker and inspect its first processing cycle.
7. Validate registration, login, messaging, delegation, and one controlled Agent task.

## 🛠️ Troubleshooting

### 🔎 `DATABASE_URL is required`

The API or migration process did not receive its private database connection environment variable.

### 🔎 `JWT_SECRET must be at least 32 characters`

Generate a long random secret and restart the service. Do not use example text in production.

### 🔎 Database migration fails

Confirm that the application user can connect to the intended empty database and create schema objects. Do not grant superuser permissions merely to bypass an unknown migration error.

### 🔎 Registration does not deliver a code

Check SMTP connectivity, sender authorization, `MAIL_PROVIDER`, and service logs. Console delivery is intended only for private development.

### 🔎 Desktop connects to the wrong server

Check `JANUS_AUTH_URL`, `JANUS_PACKAGED_CLOUD_URL`, the packaged server origin, and persisted desktop account state. Validate with a fresh `JANUS_HOME` profile.
