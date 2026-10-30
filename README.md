# Workbase — City deployment build

Workbase is an all-in-one productivity and project platform: tasks, goals,
dashboards, team/seat management, real user accounts with roles, and
Microsoft Teams chat notifications — in a clean white, high-contrast UI.

This build is configured for one organization with **78 seats** across three
departments — **Police, Parks, and Marketing** — at **$15 per seat/month**
(config values, see `.env.example`).

## What's inside

- **Dashboard** — task counts by status, seat meter (X of 78 seats used), goals snapshot, recent activity.
- **Tasks** — full create/edit/delete with project, status (To do / In progress / Done), priority, assignee, start/due dates and progress — in **List, Board, Calendar and Gantt** views (Gantt is start→due bars; no dependencies or baselines).
- **Goals** — goals with current/target values and progress bars.
- **Team & Seats** — the member list synced from real accounts; each active account uses one seat; account creation is blocked once all 78 seats are used.
- **Users & Login** — real email/password accounts. The first visitor creates the **Owner** account; after that signup is **invite-only** (admins create accounts with a generated temporary password). Roles: **Owner, Admin, Member, Viewer** (Viewers are read-only). Login/logout, change password, forgot-password reset (single-use token, 60-minute expiry, emailed via Resend when configured).
- **Chat — Microsoft Teams** — save a Teams incoming-webhook URL, enable/disable notifications, choose which events post (task created, task completed, goal reached), and send a test message. Teams only — no Slack, no built-in messenger.

## Tech stack

- Node.js 20+ and Express; dependencies are just `express` and `pg`.
- **Storage:** PostgreSQL when `DATABASE_URL` is set (tables are created on boot). With no `DATABASE_URL`, it falls back to a local JSON file store (`data.json`, gitignored) — zero setup for local runs.
- **Security:** passwords are salted scrypt hashes (Node built-in `crypto`) — never stored or logged in plaintext. Sessions are random tokens stored hashed, carried in httpOnly cookies; logout and password resets invalidate sessions server-side.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000
```

No database needed locally — the JSON file store is used automatically.
Open the app, create the Owner account, and starter data (department
projects, sample tasks and goals) is seeded for you.

## Environment variables

Copy `.env.example` and fill in real values (on Railway, set them in the
service's Variables tab — never commit real secrets to git):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (unset = local JSON store) |
| `SESSION_SECRET` | Long random string used to sign session/reset tokens |
| `APP_URL` | Public URL of the deployment (used in reset email links) |
| `PUBLIC_SIGNUP` | `invite` (signup is invite-only after Owner creation) |
| `SEAT_LIMIT` | `78` |
| `SEAT_PRICE_USD` | `15` (config/display only) |
| `RESEND_API_KEY` | Enables emailed password resets via Resend |
| `EMAIL_FROM` | Sender for reset emails (verified domain in Resend) |
| `SSO_ENABLED`, `SSO_PROVIDER`, `SSO_ISSUER_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` | SSO enablement at deployment against the City's IdP — see DEPLOY.md |
| `TEAMS_WEBHOOK_URL` | Optional default Teams webhook (can also be set in-app) |

## Deploy

See **DEPLOY.md** for the full step-by-step: GitHub → Railway (Postgres + app
service) → Resend → SSO with the City's identity provider → Cloudflare
DNS/SSL → first Owner creation. See **USER-MANAGEMENT.md** for accounts,
roles, invite-only signup, password resets and seat counting.
