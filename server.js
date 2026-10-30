'use strict';
/*
 * Workbase — City deployment build.
 * Node.js + Express. PostgreSQL when DATABASE_URL is set, otherwise a local
 * JSON file store (data.json) so it runs anywhere with zero setup.
 *
 * Auth: salted scrypt password hashes, hashed session tokens in httpOnly
 * cookies, single-use 60-minute password reset tokens. First visitor creates
 * the Owner account; after that, signup is invite-only (admins create users).
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const SEAT_LIMIT = parseInt(process.env.SEAT_LIMIT || '78', 10);
const SEAT_PRICE_USD = parseInt(process.env.SEAT_PRICE_USD || '15', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Workbase <noreply@example.com>';
const DEPARTMENTS = ['Police', 'Parks', 'Marketing'];
const ROLES = ['Owner', 'Admin', 'Member', 'Viewer'];
const STATUSES = ['To do', 'In progress', 'Done'];
const PRIORITIES = ['Low', 'Medium', 'High'];
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

/* ---------------- crypto helpers ---------------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [, salt, hash] = String(stored).split(':');
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch { return false; }
}
function hashToken(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(token)).digest('hex');
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function uid() { return crypto.randomUUID(); }
function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 10 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}
function validEmail(e) { return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = 'Wb-';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

/* ---------------- stores ---------------- */
function defaultData() {
  return {
    users: [], sessions: [], resetTokens: [], tasks: [], goals: [],
    settings: { teams: { webhookUrl: process.env.TEAMS_WEBHOOK_URL || '', enabled: false, onTaskCreated: true, onTaskCompleted: true, onGoalReached: true } },
    activity: [],
  };
}

class JsonStore {
  constructor(file) { this.file = file; this.data = defaultData(); }
  async init() {
    try { this.data = Object.assign(defaultData(), JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { this.save(); }
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  async listUsers() { return this.data.users; }
  async getUserByEmail(email) { return this.data.users.find(u => u.email === email) || null; }
  async getUserById(id) { return this.data.users.find(u => u.id === id) || null; }
  async createUser(u) { this.data.users.push(u); this.save(); return u; }
  async updateUser(id, patch) { const u = await this.getUserById(id); if (u) { Object.assign(u, patch); this.save(); } return u; }
  async deleteUser(id) { this.data.users = this.data.users.filter(u => u.id !== id); this.data.sessions = this.data.sessions.filter(s => s.userId !== id); this.save(); }
  async createSession(s) { this.data.sessions.push(s); this.save(); }
  async getSession(hash) { return this.data.sessions.find(s => s.tokenHash === hash) || null; }
  async deleteSession(hash) { this.data.sessions = this.data.sessions.filter(s => s.tokenHash !== hash); this.save(); }
  async deleteSessionsForUser(userId, exceptHash) { this.data.sessions = this.data.sessions.filter(s => s.userId !== userId || s.tokenHash === exceptHash); this.save(); }
  async createResetToken(t) { this.data.resetTokens.push(t); this.save(); }
  async getResetToken(hash) { return this.data.resetTokens.find(t => t.tokenHash === hash) || null; }
  async markResetTokenUsed(hash) { const t = await this.getResetToken(hash); if (t) { t.used = true; this.save(); } }
  async listTasks() { return this.data.tasks; }
  async createTask(t) { this.data.tasks.push(t); this.save(); return t; }
  async getTask(id) { return this.data.tasks.find(t => t.id === id) || null; }
  async updateTask(id, patch) { const t = await this.getTask(id); if (t) { Object.assign(t, patch); this.save(); } return t; }
  async deleteTask(id) { this.data.tasks = this.data.tasks.filter(t => t.id !== id); this.save(); }
  async listGoals() { return this.data.goals; }
  async createGoal(g) { this.data.goals.push(g); this.save(); return g; }
  async getGoal(id) { return this.data.goals.find(g => g.id === id) || null; }
  async updateGoal(id, patch) { const g = await this.getGoal(id); if (g) { Object.assign(g, patch); this.save(); } return g; }
  async deleteGoal(id) { this.data.goals = this.data.goals.filter(g => g.id !== id); this.save(); }
  async getSetting(key) { return this.data.settings[key]; }
  async setSetting(key, value) { this.data.settings[key] = value; this.save(); }
  async listActivity() { return this.data.activity.slice(-100).reverse(); }
  async addActivity(text) { this.data.activity.push({ id: uid(), text, at: new Date().toISOString() }); this.save(); }
}

class PgStore {
  constructor(url) { const { Pool } = require('pg'); this.pool = new Pool({ connectionString: url }); }
  async init() {
    const q = this.pool;
    await q.query(`CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL, password_hash text NOT NULL, role text NOT NULL, disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id text NOT NULL, expires_at timestamptz NOT NULL)`);
    await q.query(`CREATE TABLE IF NOT EXISTS reset_tokens (token_hash text PRIMARY KEY, user_id text NOT NULL, expires_at timestamptz NOT NULL, used boolean NOT NULL DEFAULT false)`);
    await q.query(`CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY, title text NOT NULL, project text NOT NULL, status text NOT NULL, priority text NOT NULL, assignee text DEFAULT '', start_date text DEFAULT '', due_date text DEFAULT '', progress int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS goals (id text PRIMARY KEY, title text NOT NULL, project text NOT NULL, current numeric NOT NULL DEFAULT 0, target numeric NOT NULL DEFAULT 0, unit text DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL)`);
    await q.query(`CREATE TABLE IF NOT EXISTS activity (id text PRIMARY KEY, text text NOT NULL, at timestamptz NOT NULL DEFAULT now())`);
    const existing = await q.query(`SELECT value FROM settings WHERE key='teams'`);
    if (!existing.rows.length) {
      await this.setSetting('teams', defaultData().settings.teams);
    }
  }
  mapUser(r) { return { id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash, role: r.role, disabled: r.disabled, createdAt: r.created_at }; }
  async listUsers() { const r = await this.pool.query('SELECT * FROM users ORDER BY created_at'); return r.rows.map(x => this.mapUser(x)); }
  async getUserByEmail(email) { const r = await this.pool.query('SELECT * FROM users WHERE email=$1', [email]); return r.rows.length ? this.mapUser(r.rows[0]) : null; }
  async getUserById(id) { const r = await this.pool.query('SELECT * FROM users WHERE id=$1', [id]); return r.rows.length ? this.mapUser(r.rows[0]) : null; }
  async createUser(u) { await this.pool.query('INSERT INTO users (id,name,email,password_hash,role,disabled) VALUES ($1,$2,$3,$4,$5,$6)', [u.id, u.name, u.email, u.passwordHash, u.role, !!u.disabled]); return u; }
  async updateUser(id, patch) {
    const cols = { name: 'name', email: 'email', passwordHash: 'password_hash', role: 'role', disabled: 'disabled' };
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(patch)) { if (cols[k]) { vals.push(v); sets.push(`${cols[k]}=$${vals.length}`); } }
    if (sets.length) { vals.push(id); await this.pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length}`, vals); }
    return this.getUserById(id);
  }
  async deleteUser(id) { await this.pool.query('DELETE FROM sessions WHERE user_id=$1', [id]); await this.pool.query('DELETE FROM users WHERE id=$1', [id]); }
  async createSession(s) { await this.pool.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [s.tokenHash, s.userId, new Date(s.expiresAt)]); }
  async getSession(hash) { const r = await this.pool.query('SELECT * FROM sessions WHERE token_hash=$1', [hash]); return r.rows.length ? { tokenHash: r.rows[0].token_hash, userId: r.rows[0].user_id, expiresAt: r.rows[0].expires_at } : null; }
  async deleteSession(hash) { await this.pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash]); }
  async deleteSessionsForUser(userId, exceptHash) {
    if (exceptHash) await this.pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [userId, exceptHash]);
    else await this.pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
  }
  async createResetToken(t) { await this.pool.query('INSERT INTO reset_tokens (token_hash,user_id,expires_at,used) VALUES ($1,$2,$3,false)', [t.tokenHash, t.userId, new Date(t.expiresAt)]); }
  async getResetToken(hash) { const r = await this.pool.query('SELECT * FROM reset_tokens WHERE token_hash=$1', [hash]); return r.rows.length ? { tokenHash: r.rows[0].token_hash, userId: r.rows[0].user_id, expiresAt: r.rows[0].expires_at, used: r.rows[0].used } : null; }
  async markResetTokenUsed(hash) { await this.pool.query('UPDATE reset_tokens SET used=true WHERE token_hash=$1', [hash]); }
  mapTask(r) { return { id: r.id, title: r.title, project: r.project, status: r.status, priority: r.priority, assignee: r.assignee || '', startDate: r.start_date || '', dueDate: r.due_date || '', progress: r.progress }; }
  async listTasks() { const r = await this.pool.query('SELECT * FROM tasks ORDER BY created_at'); return r.rows.map(x => this.mapTask(x)); }
  async createTask(t) { await this.pool.query('INSERT INTO tasks (id,title,project,status,priority,assignee,start_date,due_date,progress) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [t.id, t.title, t.project, t.status, t.priority, t.assignee, t.startDate, t.dueDate, t.progress]); return t; }
  async getTask(id) { const r = await this.pool.query('SELECT * FROM tasks WHERE id=$1', [id]); return r.rows.length ? this.mapTask(r.rows[0]) : null; }
  async updateTask(id, patch) {
    const cur = await this.getTask(id); if (!cur) return null;
    const t = Object.assign({}, cur, patch);
    await this.pool.query('UPDATE tasks SET title=$1,project=$2,status=$3,priority=$4,assignee=$5,start_date=$6,due_date=$7,progress=$8 WHERE id=$9', [t.title, t.project, t.status, t.priority, t.assignee, t.startDate, t.dueDate, t.progress, id]);
    return t;
  }
  async deleteTask(id) { await this.pool.query('DELETE FROM tasks WHERE id=$1', [id]); }
  mapGoal(r) { return { id: r.id, title: r.title, project: r.project, current: Number(r.current), target: Number(r.target), unit: r.unit || '' }; }
  async listGoals() { const r = await this.pool.query('SELECT * FROM goals ORDER BY created_at'); return r.rows.map(x => this.mapGoal(x)); }
  async createGoal(g) { await this.pool.query('INSERT INTO goals (id,title,project,current,target,unit) VALUES ($1,$2,$3,$4,$5,$6)', [g.id, g.title, g.project, g.current, g.target, g.unit]); return g; }
  async getGoal(id) { const r = await this.pool.query('SELECT * FROM goals WHERE id=$1', [id]); return r.rows.length ? this.mapGoal(r.rows[0]) : null; }
  async updateGoal(id, patch) {
    const cur = await this.getGoal(id); if (!cur) return null;
    const g = Object.assign({}, cur, patch);
    await this.pool.query('UPDATE goals SET title=$1,project=$2,current=$3,target=$4,unit=$5 WHERE id=$6', [g.title, g.project, g.current, g.target, g.unit, id]);
    return g;
  }
  async deleteGoal(id) { await this.pool.query('DELETE FROM goals WHERE id=$1', [id]); }
  async getSetting(key) { const r = await this.pool.query('SELECT value FROM settings WHERE key=$1', [key]); return r.rows.length ? r.rows[0].value : undefined; }
  async setSetting(key, value) { await this.pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, JSON.stringify(value)]); }
  async listActivity() { const r = await this.pool.query('SELECT text, at FROM activity ORDER BY at DESC LIMIT 100'); return r.rows.map(x => ({ text: x.text, at: x.at })); }
  async addActivity(text) { await this.pool.query('INSERT INTO activity (id,text) VALUES ($1,$2)', [uid(), text]); }
}

const store = process.env.DATABASE_URL
  ? new PgStore(process.env.DATABASE_URL)
  : new JsonStore(path.join(__dirname, 'data.json'));

/* ---------------- seed data (on first Owner creation) ---------------- */
async function seed(owner) {
  const today = new Date();
  const d = (offset) => { const t = new Date(today); t.setDate(t.getDate() + offset); return t.toISOString().slice(0, 10); };
  const tasks = [
    ['Police', 'Review Q4 incident report workflow', 'In progress', 'High', 0, 10, 60],
    ['Police', 'Update community outreach schedule', 'To do', 'Medium', 1, 8, 0],
    ['Police', 'Audit body-camera footage requests', 'To do', 'High', 2, 14, 0],
    ['Parks', 'Plan spring park maintenance rota', 'In progress', 'Medium', -2, 12, 40],
    ['Parks', 'Order playground inspection kits', 'To do', 'Low', 0, 20, 0],
    ['Parks', 'Trail signage replacement — phase 1', 'Done', 'Medium', -14, -1, 100],
    ['Marketing', 'Draft city services campaign brief', 'In progress', 'High', -1, 6, 30],
    ['Marketing', 'Update city website events calendar', 'To do', 'Medium', 0, 5, 0],
    ['Marketing', 'Social media content plan — next month', 'To do', 'Low', 3, 17, 0],
  ];
  for (const [project, title, status, priority, s, e, progress] of tasks) {
    await store.createTask({ id: uid(), title, project, status, priority, assignee: owner.name, startDate: d(s), dueDate: d(e), progress });
  }
  const goals = [
    ['Police', 'Community engagement events held', 6, 12, 'events'],
    ['Parks', 'Parks passing safety inspection', 18, 24, 'parks'],
    ['Marketing', 'Campaign reach', 45000, 100000, 'people'],
    ['Marketing', 'Newsletter subscribers', 3200, 5000, 'subscribers'],
  ];
  for (const [project, title, current, target, unit] of goals) {
    await store.createGoal({ id: uid(), title, project, current, target, unit });
  }
  await store.addActivity(`Workspace created for ${owner.name} (Owner)`);
}

/* ---------------- Teams notifications ---------------- */
async function notifyTeams(kind, text) {
  try {
    const teams = await store.getSetting('teams');
    if (!teams || !teams.enabled || !teams.webhookUrl) return;
    const flag = { taskCreated: 'onTaskCreated', taskCompleted: 'onTaskCompleted', goalReached: 'onGoalReached' }[kind];
    if (flag && !teams[flag]) return;
    await fetch(teams.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `**Workbase:** ${text}` }),
    });
  } catch (e) { console.error('Teams notify failed:', e.message); }
}

/* ---------------- email (Resend) ---------------- */
async function sendResetEmail(email, token) {
  const link = `${APP_URL || ''}/?reset=${token}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: EMAIL_FROM, to: [email], subject: 'Reset your Workbase password',
      html: `<p>We received a request to reset your Workbase password.</p><p><a href="${link}">Reset your password</a></p><p>This link expires in 60 minutes and can be used once. If you did not request it, you can ignore this email.</p>`,
      text: `Reset your Workbase password: ${link} (expires in 60 minutes, single use).`,
    }),
  });
  if (!res.ok) throw new Error(`Resend API returned ${res.status}`);
}

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function currentUser(req) {
  const token = parseCookies(req).wb_session;
  if (!token) return null;
  const session = await store.getSession(hashToken(token));
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) { await store.deleteSession(hashToken(token)); return null; }
  const user = await store.getUserById(session.userId);
  if (!user || user.disabled) return null;
  return user;
}
async function requireAuth(req, res, next) {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user; next();
}
function requireAdmin(req, res, next) {
  if (!['Owner', 'Admin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required' });
  next();
}
function requireWriter(req, res, next) {
  if (req.user.role === 'Viewer') return res.status(403).json({ error: 'Viewers are read-only' });
  next();
}
function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, disabled: !!u.disabled }; }
async function startSession(req, res, user) {
  const token = newToken();
  await store.createSession({ tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  res.cookie('wb_session', token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS,
    secure: req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https',
  });
}
async function seatsUsed() { return (await store.listUsers()).filter(u => !u.disabled).length; }

/* -------- auth routes -------- */
app.get('/api/bootstrap', async (req, res) => {
  const users = await store.listUsers();
  const user = await currentUser(req);
  res.json({ needsOwner: users.length === 0, user: user ? publicUser(user) : null, seatLimit: SEAT_LIMIT, seatPriceUsd: SEAT_PRICE_USD, departments: DEPARTMENTS });
});

app.post('/api/auth/register-owner', async (req, res) => {
  const users = await store.listUsers();
  if (users.length > 0) return res.status(403).json({ error: 'An Owner account already exists. Signup is invite-only — ask an admin to create your account.' });
  const { name, email, password } = req.body || {};
  if (!name || !validEmail(email)) return res.status(400).json({ error: 'A name and a valid work email are required.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 10 characters and include a letter and a number.' });
  const user = { id: uid(), name: String(name).trim(), email: String(email).toLowerCase().trim(), passwordHash: hashPassword(password), role: 'Owner', disabled: false, createdAt: new Date().toISOString() };
  await store.createUser(user);
  await seed(user);
  await startSession(req, res, user);
  res.status(201).json({ user: publicUser(user) });
});

// Public self-registration: only ever open before the Owner exists (handled above).
app.post('/api/auth/register', async (req, res) => {
  const users = await store.listUsers();
  if (users.length > 0) return res.status(403).json({ error: 'Public registration is closed. Workbase is invite-only — an admin must create your account.' });
  res.status(403).json({ error: 'Create the Owner account first.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? await store.getUserByEmail(String(email).toLowerCase().trim()) : null;
  if (!user || user.disabled || !verifyPassword(String(password || ''), user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  await startSession(req, res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = parseCookies(req).wb_session;
  if (token) await store.deleteSession(hashToken(token));
  res.clearCookie('wb_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/forgot', async (req, res) => {
  const { email } = req.body || {};
  const user = email ? await store.getUserByEmail(String(email).toLowerCase().trim()) : null;
  if (!user || user.disabled) {
    // Generic response: do not reveal whether the account exists.
    return res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  }
  const token = newToken();
  await store.createResetToken({ tokenHash: hashToken(token), userId: user.id, expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(), used: false });
  if (RESEND_API_KEY) {
    try {
      await sendResetEmail(user.email, token);
      return res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
    } catch (e) {
      console.error('Resend send failed:', e.message);
      return res.status(502).json({ error: 'Email is configured but sending failed. Please try again or contact your admin.' });
    }
  }
  // Dev/preview mode: no email provider configured, surface the token on screen.
  return res.json({ ok: true, emailNotConfigured: true, devToken: token, message: 'Email is not configured on this server (RESEND_API_KEY is not set), so the reset token is shown here for local use. It expires in 60 minutes and works once.' });
});

app.post('/api/auth/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'A reset token is required.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 10 characters and include a letter and a number.' });
  const record = await store.getResetToken(hashToken(token));
  if (!record || record.used || new Date(record.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  }
  await store.markResetTokenUsed(hashToken(token));
  await store.updateUser(record.userId, { passwordHash: hashPassword(password) });
  await store.deleteSessionsForUser(record.userId); // a reset signs the account out everywhere
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (!validPassword(newPassword)) return res.status(400).json({ error: 'Password must be at least 10 characters and include a letter and a number.' });
  await store.updateUser(req.user.id, { passwordHash: hashPassword(newPassword) });
  const token = parseCookies(req).wb_session;
  await store.deleteSessionsForUser(req.user.id, token ? hashToken(token) : undefined);
  res.json({ ok: true });
});

/* -------- users -------- */
app.get('/api/members', requireAuth, async (req, res) => {
  const users = await store.listUsers();
  res.json({ members: users.map(publicUser), seatsUsed: await seatsUsed(), seatLimit: SEAT_LIMIT });
});

app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const users = await store.listUsers();
  res.json({ users: users.map(publicUser), seatsUsed: await seatsUsed(), seatLimit: SEAT_LIMIT });
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !validEmail(email)) return res.status(400).json({ error: 'A name and a valid work email are required.' });
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  if (role === 'Owner') return res.status(400).json({ error: 'There can only be one Owner account.' });
  const normalizedEmail = String(email).toLowerCase().trim();
  if (await store.getUserByEmail(normalizedEmail)) return res.status(409).json({ error: 'An account with that email already exists.' });
  if ((await seatsUsed()) >= SEAT_LIMIT) return res.status(409).json({ error: `All ${SEAT_LIMIT} seats are in use. Disable or delete an account to free a seat.` });
  const password = tempPassword();
  const user = { id: uid(), name: String(name).trim(), email: normalizedEmail, passwordHash: hashPassword(password), role: role || 'Member', disabled: false, createdAt: new Date().toISOString() };
  await store.createUser(user);
  await store.addActivity(`${req.user.name} added account ${user.name} (${user.role})`);
  res.status(201).json({ user: publicUser(user), tempPassword: password });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const target = await store.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  const { role, disabled, name } = req.body || {};
  const patch = {};
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });
    if (target.role === 'Owner' && role !== 'Owner') return res.status(400).json({ error: 'The Owner role cannot be changed.' });
    if (role === 'Owner' && target.role !== 'Owner') return res.status(400).json({ error: 'There can only be one Owner account.' });
    patch.role = role;
  }
  if (disabled !== undefined) {
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
    if (target.role === 'Owner') return res.status(400).json({ error: 'The Owner account cannot be disabled.' });
    if (disabled === false && target.disabled && (await seatsUsed()) >= SEAT_LIMIT) {
      return res.status(409).json({ error: `All ${SEAT_LIMIT} seats are in use.` });
    }
    patch.disabled = !!disabled;
  }
  if (name !== undefined && String(name).trim()) patch.name = String(name).trim();
  const updated = await store.updateUser(target.id, patch);
  if (patch.disabled) await store.deleteSessionsForUser(target.id);
  res.json({ user: publicUser(updated) });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const target = await store.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (target.role === 'Owner') return res.status(400).json({ error: 'The Owner account cannot be deleted.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  await store.deleteUser(target.id);
  await store.addActivity(`${req.user.name} deleted account ${target.name}`);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset', requireAuth, requireAdmin, async (req, res) => {
  const target = await store.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  const token = newToken();
  await store.createResetToken({ tokenHash: hashToken(token), userId: target.id, expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(), used: false });
  if (RESEND_API_KEY) {
    try { await sendResetEmail(target.email, token); return res.json({ ok: true, emailed: true }); }
    catch { return res.status(502).json({ error: 'Email is configured but sending failed.' }); }
  }
  return res.json({ ok: true, emailNotConfigured: true, devToken: token });
});

/* -------- tasks -------- */
function cleanTask(body, existing) {
  const t = Object.assign({}, existing || {}, body || {});
  return {
    title: String(t.title || '').trim(),
    project: DEPARTMENTS.includes(t.project) ? t.project : 'Police',
    status: STATUSES.includes(t.status) ? t.status : 'To do',
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'Medium',
    assignee: String(t.assignee || '').trim(),
    startDate: String(t.startDate || '').slice(0, 10),
    dueDate: String(t.dueDate || '').slice(0, 10),
    progress: Math.max(0, Math.min(100, parseInt(t.progress, 10) || 0)),
  };
}
app.get('/api/tasks', requireAuth, async (req, res) => res.json({ tasks: await store.listTasks() }));
app.post('/api/tasks', requireAuth, requireWriter, async (req, res) => {
  const fields = cleanTask(req.body);
  if (!fields.title) return res.status(400).json({ error: 'A task title is required.' });
  if (fields.status === 'Done') fields.progress = 100;
  const task = await store.createTask(Object.assign({ id: uid() }, fields));
  await store.addActivity(`${req.user.name} created task "${task.title}" (${task.project})`);
  notifyTeams('taskCreated', `Task created: "${task.title}" (${task.project})`);
  if (task.status === 'Done') notifyTeams('taskCompleted', `Task completed: "${task.title}" (${task.project})`);
  res.status(201).json({ task });
});
app.put('/api/tasks/:id', requireAuth, requireWriter, async (req, res) => {
  const existing = await store.getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  const fields = cleanTask(req.body, existing);
  if (!fields.title) return res.status(400).json({ error: 'A task title is required.' });
  if (fields.status === 'Done') fields.progress = 100;
  const task = await store.updateTask(existing.id, fields);
  if (existing.status !== 'Done' && task.status === 'Done') {
    await store.addActivity(`${req.user.name} completed task "${task.title}"`);
    notifyTeams('taskCompleted', `Task completed: "${task.title}" (${task.project})`);
  }
  res.json({ task });
});
app.delete('/api/tasks/:id', requireAuth, requireWriter, async (req, res) => {
  const existing = await store.getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  await store.deleteTask(existing.id);
  res.json({ ok: true });
});

/* -------- goals -------- */
function cleanGoal(body, existing) {
  const g = Object.assign({}, existing || {}, body || {});
  return {
    title: String(g.title || '').trim(),
    project: DEPARTMENTS.includes(g.project) ? g.project : 'Police',
    current: Number(g.current) || 0,
    target: Number(g.target) || 0,
    unit: String(g.unit || '').trim(),
  };
}
app.get('/api/goals', requireAuth, async (req, res) => res.json({ goals: await store.listGoals() }));
app.post('/api/goals', requireAuth, requireWriter, async (req, res) => {
  const fields = cleanGoal(req.body);
  if (!fields.title) return res.status(400).json({ error: 'A goal title is required.' });
  if (!(fields.target > 0)) return res.status(400).json({ error: 'A goal target must be greater than zero.' });
  const goal = await store.createGoal(Object.assign({ id: uid() }, fields));
  await store.addActivity(`${req.user.name} created goal "${goal.title}" (${goal.project})`);
  if (goal.current >= goal.target) notifyTeams('goalReached', `Goal reached: "${goal.title}" (${goal.project})`);
  res.status(201).json({ goal });
});
app.put('/api/goals/:id', requireAuth, requireWriter, async (req, res) => {
  const existing = await store.getGoal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Goal not found.' });
  const fields = cleanGoal(req.body, existing);
  if (!fields.title) return res.status(400).json({ error: 'A goal title is required.' });
  const goal = await store.updateGoal(existing.id, fields);
  const wasReached = existing.target > 0 && existing.current >= existing.target;
  const nowReached = goal.target > 0 && goal.current >= goal.target;
  if (!wasReached && nowReached) {
    await store.addActivity(`Goal reached: "${goal.title}" (${goal.project})`);
    notifyTeams('goalReached', `Goal reached: "${goal.title}" (${goal.project})`);
  }
  res.json({ goal });
});
app.delete('/api/goals/:id', requireAuth, requireWriter, async (req, res) => {
  const existing = await store.getGoal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Goal not found.' });
  await store.deleteGoal(existing.id);
  res.json({ ok: true });
});

/* -------- dashboard -------- */
app.get('/api/dashboard', requireAuth, async (req, res) => {
  const [tasks, goals, activity] = await Promise.all([store.listTasks(), store.listGoals(), store.listActivity()]);
  const counts = { 'To do': 0, 'In progress': 0, 'Done': 0, total: tasks.length };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  res.json({
    counts,
    seatsUsed: await seatsUsed(), seatLimit: SEAT_LIMIT, seatPriceUsd: SEAT_PRICE_USD,
    goals: goals.slice(0, 5), activity: activity.slice(0, 10),
  });
});

/* -------- Teams settings -------- */
app.get('/api/settings/teams', requireAuth, async (req, res) => {
  const teams = (await store.getSetting('teams')) || defaultData().settings.teams;
  res.json({ teams });
});
app.put('/api/settings/teams', requireAuth, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const teams = {
    webhookUrl: String(b.webhookUrl || '').trim(),
    enabled: !!b.enabled,
    onTaskCreated: b.onTaskCreated !== false,
    onTaskCompleted: b.onTaskCompleted !== false,
    onGoalReached: b.onGoalReached !== false,
  };
  if (teams.webhookUrl && !/^https:\/\//.test(teams.webhookUrl)) {
    return res.status(400).json({ error: 'The Teams webhook URL must start with https://' });
  }
  await store.setSetting('teams', teams);
  res.json({ teams });
});
app.post('/api/settings/teams/test', requireAuth, requireAdmin, async (req, res) => {
  const teams = (await store.getSetting('teams')) || defaultData().settings.teams;
  if (!teams.webhookUrl) return res.status(400).json({ error: 'No Teams webhook URL is saved yet.' });
  try {
    const r = await fetch(teams.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '**Workbase:** test message — Teams integration is connected.' }),
    });
    if (!r.ok) return res.status(502).json({ error: `Teams webhook returned HTTP ${r.status}.` });
    return res.json({ ok: true, message: 'Test message sent to Teams.' });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach the Teams webhook: ${e.message}` });
  }
});

/* -------- SPA fallback -------- */
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

store.init()
  .then(() => app.listen(PORT, () => console.log(`Workbase listening on port ${PORT} (${process.env.DATABASE_URL ? 'PostgreSQL' : 'JSON file store'})`)))
  .catch((e) => { console.error('Failed to start:', e); process.exit(1); });
