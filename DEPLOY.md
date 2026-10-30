# Deploying Workbase — Cloudflare + Railway

Workbase runs as a Node/Express service on **Railway** with a **PostgreSQL**
database, fronted by **Cloudflare** for DNS and SSL. Email (password resets)
goes through **Resend**. SSO is enabled at deployment time against the City's
own identity provider.

> Golden rule: real secrets (database URL, `SESSION_SECRET`, Resend key, SSO
> client secret) are typed by you directly into Railway's dashboard — never
> into chat, email, or the git repo. `.env.example` holds placeholders only.

## 1. Push the code to GitHub

1. Create a new **private** repository on GitHub (e.g. `workbase-city`).
2. From this folder:
   ```bash
   git init && git add . && git commit -m "Workbase — City build"
   git branch -M main
   git remote add origin https://github.com/<you>/workbase-city.git
   git push -u origin main
   ```
   Check that `Dockerfile` and `railway.json` sit at the repo root.

## 2. Create the Railway project

1. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
2. Railway builds with the repo's `Dockerfile` (per `railway.json`) and runs
   `npm start`.

## 3. Add PostgreSQL

1. In the same project: **New → Database → PostgreSQL**.
2. On the app service → **Variables**, add a reference variable:
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (Railway offers this as a
   shared/reference variable — use that rather than pasting the raw string).
3. Workbase creates its tables automatically on first boot.

## 4. Set the app service variables

In the app service → **Variables** (values from `.env.example`):

| Variable | Value |
|---|---|
| `DATABASE_URL` | reference to the Postgres service (step 3) |
| `SESSION_SECRET` | a long random string you generate (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `APP_URL` | your public URL, e.g. `https://app.example.com` (set after step 7) |
| `PUBLIC_SIGNUP` | `invite` |
| `SEAT_LIMIT` | `78` |
| `SEAT_PRICE_USD` | `15` |
| `RESEND_API_KEY` | from step 5 |
| `EMAIL_FROM` | e.g. `Workbase <noreply@example.com>` on your verified domain |
| `SSO_ENABLED` | `false` for first launch; `true` after step 6 |
| `PORT` | Railway injects this — do not set it |

Redeploy after changing variables.

## 5. Resend (password-reset email)

1. Create a Resend account and **verify your sending domain** (Resend →
   Domains → add the DNS records it gives you at your DNS host).
2. Create an API key and set it as `RESEND_API_KEY` in Railway (step 4), with
   `EMAIL_FROM` on the verified domain.
3. Until this is done, Workbase still works: forgot-password shows the reset
   token on screen with an "email not configured" note (fine for a pilot, not
   for production).

## 6. SSO with the City's identity provider

SSO is **enabled at deployment against the City's identity provider** — this
repo ships with `SSO_ENABLED=false` and email/password login working out of
the box.

When the City confirms its IdP (worked example: Microsoft Entra ID; Okta and
generic SAML/OIDC follow the same shape):

1. In the IdP admin console, register Workbase as an application
   (SAML or OIDC) for the City's tenant. Redirect/callback URL:
   `https://app.example.com/api/auth/sso/callback` (use your real `APP_URL`).
2. Record the provider, issuer URL, client ID and client secret.
3. Set in Railway: `SSO_ENABLED=true`, `SSO_PROVIDER`, `SSO_ISSUER_URL`,
   `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` (secret typed into Railway only).
4. Have your SSO integration reviewed against the IdP's current docs before
   enforcing SSO for all users; keep the Owner email/password account as a
   break-glass login until SSO sign-in is verified end-to-end with a City
   test account, then roll out department by department (pilot first).

> What is verified in this repo: the env configuration surface above and the
> full email/password auth system. The SSO handshake itself is completed
> during deployment with the City's live IdP tenant — there is no City IdP
> available in development, so it cannot be pre-verified here.

## 7. Cloudflare DNS + SSL

1. Add the domain to Cloudflare and point the registrar's nameservers at
   Cloudflare.
2. In Railway's app service → **Settings → Networking**, add the custom
   domain `app.example.com`; Railway shows the target to point at.
3. In Cloudflare **DNS**, add a **CNAME**: `app` → the Railway target
   (`<your-app>.up.railway.app`), **proxied** (orange cloud).
4. Cloudflare **SSL/TLS → Overview**: set encryption mode to **Full (strict)**.
5. Add a Cache Rule to **bypass cache for `/api/*`** (auth + API responses
   must never be edge-cached).
6. Set `APP_URL=https://app.example.com` in Railway and redeploy.
   (`wrangler.toml` in the repo documents this Cloudflare front-end setup.)

## 8. First run — create the Owner account

1. Open `https://app.example.com`. The first visitor creates the **Owner**
   account (name, work email, password ≥ 10 characters with a letter and a
   number). Starter projects/tasks/goals for Police, Parks and Marketing are
   seeded automatically.
2. From then on, signup is invite-only: the Owner/Admin creates each account
   in **Users & Login → Add user** (a temporary password is shown once).
3. Connect Teams: in Teams, create an incoming webhook for the channel, then
   paste it in **Chat — Microsoft Teams**, enable notifications, and use
   **Send test message**.
4. Smoke test: create an account, sign in as that user, create a task, run
   forgot-password and confirm the reset email arrives via Resend.

## Day-2 operations

- **Backups:** Railway Postgres — enable/schedule backups in the database
  service settings; the app itself is stateless apart from the database.
- **Seats:** active accounts count against the 78-seat limit; disable or
  delete accounts in Users & Login to free seats.
- **Updates:** push to `main` on GitHub → Railway redeploys automatically.
- **Logs:** Railway service logs; Workbase never logs passwords or tokens.
