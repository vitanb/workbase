# User management in Workbase

## Accounts and first run

- The **first visitor** to a fresh deployment creates the **Owner** account
  (name, work email, password). Starter data (Police / Parks / Marketing
  projects, sample tasks and goals) is seeded at that moment.
- After the Owner exists, **public registration is closed**. Signup is
  invite-only: every further account is created by an Owner/Admin in
  **Users & Login → Add user**.

## Roles

| Role | Can do |
|---|---|
| **Owner** | Everything. The single top account; cannot be disabled, deleted, or demoted. |
| **Admin** | Everything except changing the Owner: create accounts, change roles, disable/enable, delete accounts, trigger password resets, change Teams settings. |
| **Member** | Full use of Dashboard, Tasks and Goals; can change their own password. |
| **Viewer** | Read-only: can view everything, cannot create/edit/delete tasks or goals, cannot manage accounts. |

## Creating accounts (admins)

1. Go to **Users & Login → Add user**, enter name, work email and role.
2. Workbase generates a **temporary password** and shows it **once** — give it
   to the user through a secure channel. They sign in with it and should
   change it immediately in **Users & Login → My account**.
3. If all 78 seats are in use, account creation is blocked until a seat is
   freed (disable or delete an account).

## Sign-in, sessions, sign-out

- Sign-in is email + password. Passwords are stored as salted scrypt hashes —
  never in plaintext, never logged.
- Sessions are random tokens, stored **hashed** server-side and carried in an
  httpOnly cookie (7-day lifetime).
- **Log out** invalidates that session on the server immediately.
- Disabling an account signs that user out everywhere and blocks sign-in.

## Password changes and resets

- **Change password** (signed in): Users & Login → My account. Requires the
  current password; other sessions for the account are signed out.
- **Forgot password** (signed out): enter the work email on the sign-in
  screen. A **single-use reset token** is created, valid for **60 minutes**.
  - If `RESEND_API_KEY` is configured, the reset link is **emailed via
    Resend**.
  - If email is **not** configured (local/dev), the token is **shown on
    screen** with a clear "email not configured" note — never use that mode
    in production.
- **Admin-triggered reset**: Users & Login → Accounts → **Reset password**
  creates the same kind of token for that user (emailed when Resend is
  configured, shown to the admin otherwise).
- Completing a reset **invalidates all existing sessions** for the account.
- Password rule everywhere: at least 10 characters, with a letter and a
  number.

## Seat counting

- Seat limit: **78** (`SEAT_LIMIT`), price reference **$15/seat/month**
  (`SEAT_PRICE_USD`, display/config only).
- Every **active** account uses one seat, including the Owner. Disabled
  accounts do not use a seat; deleted accounts free theirs immediately.
- The seat meter appears on the Dashboard and in Team & Seats
  ("X of 78 seats used").

## SSO

Single sign-on is enabled at deployment against the City's identity provider
(see DEPLOY.md, step 6). Email/password login described above is the built-in
system and remains the fallback/break-glass path for the Owner account.
