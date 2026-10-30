'use strict';
/* Workbase frontend — vanilla JS SPA. Six areas: Dashboard, Tasks, Goals,
   Team & Seats, Users & Login, Chat — Microsoft Teams. */
const app = document.getElementById('app');
const state = {
  user: null, needsOwner: false, seatLimit: 78, seatPriceUsd: 15,
  departments: ['Police', 'Parks', 'Marketing'],
  view: 'dashboard', taskView: 'List', taskProject: 'All',
  members: [], tasks: [], goals: [], calCursor: null,
};
const STATUSES = ['To do', 'In progress', 'Done'];
const PRIORITIES = ['Low', 'Medium', 'High'];
const NAV = [
  ['dashboard', 'Dashboard'], ['tasks', 'Tasks'], ['goals', 'Goals'],
  ['team', 'Team & Seats'], ['users', 'Users & Login'], ['chat', 'Chat — Microsoft Teams'],
];

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const isAdmin = () => state.user && ['Owner', 'Admin'].includes(state.user.role);
const canWrite = () => state.user && state.user.role !== 'Viewer';
function pct(cur, tgt) { return tgt > 0 ? Math.min(100, Math.round((cur / tgt) * 100)) : 0; }
function fmtDate(d) { return d ? esc(d) : '—'; }

/* ---------------- auth screens ---------------- */
function renderAuth(mode, extra) {
  extra = extra || {};
  let inner = '';
  if (mode === 'owner') {
    inner = `
      <h1 class="brand">Work<span>base</span></h1>
      <p class="muted">Welcome. Create the Owner account to set up this workspace. After this, signup is invite-only — an admin creates every other account.</p>
      ${extra.error ? `<div class="error">${esc(extra.error)}</div>` : ''}
      <form id="auth-form">
        <label>Your name</label><input name="name" required autocomplete="name">
        <label>Work email</label><input name="email" type="email" required autocomplete="email">
        <label>Password</label><input name="password" type="password" required autocomplete="new-password">
        <p class="small muted">At least 10 characters, with a letter and a number.</p>
        <button class="btn" style="width:100%;margin-top:8px">Create Owner account</button>
      </form>`;
  } else if (mode === 'forgot') {
    inner = `
      <h1 class="brand">Work<span>base</span></h1>
      <p class="muted">Forgot your password? Enter your work email and we'll start a reset. Reset links expire in 60 minutes and work once.</p>
      ${extra.error ? `<div class="error">${esc(extra.error)}</div>` : ''}
      ${extra.notice ? `<div class="notice">${esc(extra.notice)}</div>` : ''}
      ${extra.devToken ? `<div class="notice"><strong>Email is not configured on this server</strong>, so here is your reset token (normally it would be emailed):<br><code>${esc(extra.devToken)}</code></div>
        <form id="reset-form">
          <label>New password</label><input name="password" type="password" required autocomplete="new-password">
          <button class="btn" style="width:100%;margin-top:10px">Set new password</button>
        </form>` : `
      <form id="forgot-form">
        <label>Work email</label><input name="email" type="email" required autocomplete="email">
        <button class="btn" style="width:100%;margin-top:12px">Send reset link</button>
      </form>`}
      <p style="margin-top:14px"><button class="link-btn" id="back-login">← Back to sign in</button></p>`;
  } else if (mode === 'reset') {
    inner = `
      <h1 class="brand">Work<span>base</span></h1>
      <p class="muted">Set a new password for your account.</p>
      ${extra.error ? `<div class="error">${esc(extra.error)}</div>` : ''}
      <form id="reset-form">
        <label>New password</label><input name="password" type="password" required autocomplete="new-password">
        <p class="small muted">At least 10 characters, with a letter and a number.</p>
        <button class="btn" style="width:100%;margin-top:8px">Set new password</button>
      </form>`;
  } else {
    inner = `
      <h1 class="brand">Work<span>base</span></h1>
      <p class="muted">Sign in to your workspace. Accounts are invite-only — ask an admin if you need one.</p>
      ${extra.error ? `<div class="error">${esc(extra.error)}</div>` : ''}
      ${extra.notice ? `<div class="notice">${esc(extra.notice)}</div>` : ''}
      <form id="auth-form">
        <label>Work email</label><input name="email" type="email" required autocomplete="email">
        <label>Password</label><input name="password" type="password" required autocomplete="current-password">
        <button class="btn" style="width:100%;margin-top:12px">Sign in</button>
      </form>
      <p style="margin-top:14px"><button class="link-btn" id="forgot-link">Forgot password?</button></p>`;
  }
  app.innerHTML = `<div class="auth-wrap"><div class="auth-card">${inner}</div></div>`;

  const form = document.getElementById('auth-form');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      if (mode === 'owner') {
        const r = await api('POST', '/api/auth/register-owner', f);
        state.user = r.user; boot();
      } else {
        const r = await api('POST', '/api/auth/login', f);
        state.user = r.user; boot();
      }
    } catch (err) { renderAuth(mode, { error: err.message }); }
  });
  const forgotLink = document.getElementById('forgot-link');
  if (forgotLink) forgotLink.addEventListener('click', () => renderAuth('forgot'));
  const back = document.getElementById('back-login');
  if (back) back.addEventListener('click', () => renderAuth('login'));
  const forgotForm = document.getElementById('forgot-form');
  if (forgotForm) forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(forgotForm));
    try {
      const r = await api('POST', '/api/auth/forgot', f);
      renderAuth('forgot', { notice: r.message, devToken: r.devToken });
      if (r.devToken) wireResetForm(r.devToken);
    } catch (err) { renderAuth('forgot', { error: err.message }); }
  });
  if (mode === 'reset') wireResetForm(new URLSearchParams(location.search).get('reset'));
  if (mode === 'forgot' && extra.devToken) wireResetForm(extra.devToken);
}
function wireResetForm(token) {
  const form = document.getElementById('reset-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      await api('POST', '/api/auth/reset', { token, password: f.password });
      history.replaceState({}, '', '/');
      renderAuth('login', { notice: 'Password updated. Sign in with your new password.' });
    } catch (err) {
      alert(err.message);
    }
  });
}

/* ---------------- shell ---------------- */
function renderShell() {
  const u = state.user;
  app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Work<span>base</span></div>
      <div class="tagline">${state.seatLimit} seats • Police • Parks • Marketing • Teams chat</div>
      ${NAV.map(([key, label]) => `<button class="nav-item ${state.view === key ? 'active' : ''}" data-nav="${key}">${label}</button>`).join('')}
    </aside>
    <div class="main">
      <div class="topbar">
        <div><strong>${esc(NAV.find(n => n[0] === state.view)[1])}</strong></div>
        <div class="who">
          <span class="muted small" id="seat-chip"></span>
          <span>${esc(u.name)} <span class="pill">${esc(u.role)}</span></span>
          <button class="btn secondary small" id="logout">Log out</button>
        </div>
      </div>
      <div class="content" id="content"></div>
    </div>
  </div>`;
  document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.nav; renderShell(); renderView(); }));
  document.getElementById('logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    state.user = null; renderAuth('login');
  });
  renderView();
}
async function refreshSeatChip() {
  try {
    const r = await api('GET', '/api/members');
    state.members = r.members;
    const chip = document.getElementById('seat-chip');
    if (chip) chip.textContent = `${r.seatsUsed} of ${r.seatLimit} seats used`;
  } catch {}
}
async function renderView() {
  refreshSeatChip();
  const el = document.getElementById('content');
  if (state.view === 'dashboard') return viewDashboard(el);
  if (state.view === 'tasks') return viewTasks(el);
  if (state.view === 'goals') return viewGoals(el);
  if (state.view === 'team') return viewTeam(el);
  if (state.view === 'users') return viewUsers(el);
  if (state.view === 'chat') return viewChat(el);
}

/* ---------------- dashboard ---------------- */
async function viewDashboard(el) {
  const d = await api('GET', '/api/dashboard');
  el.innerHTML = `
    <h1>Dashboard</h1>
    <p class="muted">Tasks, goals and seats across Police, Parks and Marketing.</p>
    <div class="cards">
      <div class="card"><div class="num">${d.counts.total}</div><div class="lbl">Total tasks</div></div>
      <div class="card"><div class="num">${d.counts['To do']}</div><div class="lbl">To do</div></div>
      <div class="card"><div class="num">${d.counts['In progress']}</div><div class="lbl">In progress</div></div>
      <div class="card"><div class="num">${d.counts['Done']}</div><div class="lbl">Done</div></div>
      <div class="card"><div class="num">${d.seatsUsed} / ${d.seatLimit}</div><div class="lbl">Seats used ($${d.seatPriceUsd}/seat/mo)</div>
        <div class="meter" style="margin-top:8px"><div style="width:${Math.round(d.seatsUsed / d.seatLimit * 100)}%"></div></div></div>
    </div>
    <h2>Goals snapshot</h2>
    ${d.goals.length ? d.goals.map(g => `
      <div class="row-flex" style="padding:7px 0;border-bottom:1px solid var(--line)">
        <div style="min-width:260px"><strong>${esc(g.title)}</strong> <span class="pill">${esc(g.project)}</span></div>
        <div class="bar" style="flex:1"><div style="width:${pct(g.current, g.target)}%"></div></div>
        <div class="muted small">${esc(g.current)} / ${esc(g.target)} ${esc(g.unit)} (${pct(g.current, g.target)}%)</div>
      </div>`).join('') : '<p class="muted">No goals yet.</p>'}
    <h2>Recent activity</h2>
    ${d.activity.length ? d.activity.map(a => `<div class="activity-item">${esc(a.text)} <span class="muted small">— ${esc(new Date(a.at).toLocaleString())}</span></div>`).join('') : '<p class="muted">No activity yet.</p>'}`;
}

/* ---------------- tasks ---------------- */
function taskFormHtml(task) {
  task = task || {};
  const assignees = state.members.filter(m => !m.disabled);
  return `
    <div class="form-grid">
      <div style="grid-column:1/-1"><label>Title</label><input name="title" required value="${esc(task.title || '')}"></div>
      <div><label>Project</label><select name="project">${state.departments.map(d => `<option ${task.project === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div><label>Status</label><select name="status">${STATUSES.map(s => `<option ${task.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Priority</label><select name="priority">${PRIORITIES.map(p => `<option ${task.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div><label>Assignee</label><select name="assignee"><option value="">Unassigned</option>${assignees.map(m => `<option ${task.assignee === m.name ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div><label>Start date</label><input name="startDate" type="date" value="${esc(task.startDate || '')}"></div>
      <div><label>Due date</label><input name="dueDate" type="date" value="${esc(task.dueDate || '')}"></div>
      <div><label>Progress %</label><input name="progress" type="number" min="0" max="100" value="${task.progress ?? 0}"></div>
    </div>`;
}
function openTaskModal(task) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin-top:0">${task ? 'Edit task' : 'New task'}</h2>
    <form id="task-form">${taskFormHtml(task)}
    <div class="row-flex" style="margin-top:16px"><button class="btn">${task ? 'Save changes' : 'Create task'}</button>
    <button type="button" class="btn secondary" id="task-cancel">Cancel</button>
    <span class="spacer"></span><span class="error" id="task-err" style="display:none"></span></div></form></div>`;
  document.body.appendChild(bg);
  bg.querySelector('#task-cancel').addEventListener('click', () => bg.remove());
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  bg.querySelector('#task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.progress = parseInt(f.progress, 10) || 0;
    try {
      if (task) await api('PUT', `/api/tasks/${task.id}`, f);
      else await api('POST', '/api/tasks', f);
      bg.remove(); renderView();
    } catch (err) {
      const box = bg.querySelector('#task-err'); box.style.display = 'block'; box.textContent = err.message;
    }
  });
}
async function viewTasks(el) {
  const [tr] = await Promise.all([api('GET', '/api/tasks'), refreshSeatChip()]);
  state.tasks = tr.tasks;
  const tasks = state.taskProject === 'All' ? state.tasks : state.tasks.filter(t => t.project === state.taskProject);
  let body = '';
  if (state.taskView === 'List') {
    body = `<table><thead><tr><th>Task</th><th>Project</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Start</th><th>Due</th><th>Progress</th>${canWrite() ? '<th></th>' : ''}</tr></thead><tbody>
      ${tasks.map(t => `<tr>
        <td><strong>${esc(t.title)}</strong></td><td>${esc(t.project)}</td>
        <td>${canWrite() ? `<select data-status="${t.id}">${STATUSES.map(s => `<option ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>` : esc(t.status)}</td>
        <td><span class="pill ${t.priority === 'High' ? 'high' : ''}">${esc(t.priority)}</span></td>
        <td>${esc(t.assignee || '—')}</td><td>${fmtDate(t.startDate)}</td><td>${fmtDate(t.dueDate)}</td>
        <td><div class="row-flex"><div class="bar"><div style="width:${t.progress}%"></div></div><span class="small muted">${t.progress}%</span></div></td>
        ${canWrite() ? `<td><div class="row-flex"><button class="btn secondary small" data-edit="${t.id}">Edit</button><button class="btn danger small" data-del="${t.id}">Delete</button></div></td>` : ''}
      </tr>`).join('') || '<tr><td colspan="9" class="muted">No tasks in this project yet.</td></tr>'}
      </tbody></table>`;
  } else if (state.taskView === 'Board') {
    body = `<div class="board">${STATUSES.map(s => `
      <div class="board-col"><h3>${s}</h3>
      ${tasks.filter(t => t.status === s).map(t => `<div class="task-card"><strong>${esc(t.title)}</strong>
        <div class="small muted">${esc(t.project)} • ${esc(t.priority)} priority${t.assignee ? ` • ${esc(t.assignee)}` : ''}${t.dueDate ? ` • due ${esc(t.dueDate)}` : ''}</div>
        <div class="bar" style="margin-top:6px"><div style="width:${t.progress}%"></div></div>
        ${canWrite() ? `<div class="row-flex" style="margin-top:8px"><button class="btn secondary small" data-edit="${t.id}">Edit</button><button class="btn danger small" data-del="${t.id}">Delete</button></div>` : ''}
      </div>`).join('') || '<p class="muted small">No tasks</p>'}
      </div>`).join('')}</div>`;
  } else if (state.taskView === 'Calendar') {
    if (!state.calCursor) state.calCursor = new Date(); state.calCursor.setDate(1);
    const cur = state.calCursor;
    const year = cur.getFullYear(), month = cur.getMonth();
    const first = new Date(year, month, 1);
    const startDay = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const byDue = {};
    for (const t of tasks) if (t.dueDate) (byDue[t.dueDate] = byDue[t.dueDate] || []).push(t);
    let cells = '';
    for (let i = 0; i < startDay; i++) cells += '<div class="cal-cell dim"></div>';
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      cells += `<div class="cal-cell"><div class="d">${day}</div>${(byDue[key] || []).map(t => `<div class="cal-task">${esc(t.title)}</div>`).join('')}</div>`;
    }
    body = `<div class="row-flex"><button class="btn secondary small" id="cal-prev">← Prev</button>
      <strong>${first.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</strong>
      <button class="btn secondary small" id="cal-next">Next →</button>
      <span class="muted small">Tasks placed by due date</span></div>
      <div class="cal" style="margin-top:12px">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="cal-head">${d}</div>`).join('')}${cells}</div>`;
  } else if (state.taskView === 'Gantt') {
    const dated = tasks.filter(t => t.startDate && t.dueDate);
    if (!dated.length) { body = '<p class="muted">No tasks with both a start and a due date yet — add dates to see the Gantt chart.</p>'; }
    else {
      const min = Math.min(...dated.map(t => new Date(t.startDate).getTime()));
      const max = Math.max(...dated.map(t => new Date(t.dueDate).getTime()));
      const span = Math.max(1, max - min);
      body = dated.map(t => {
        const left = ((new Date(t.startDate).getTime() - min) / span * 100).toFixed(1);
        const width = Math.max(3, (new Date(t.dueDate).getTime() - new Date(t.startDate).getTime()) / span * 100).toFixed(1);
        return `<div class="gantt-row"><div><strong>${esc(t.title)}</strong><div class="small muted">${esc(t.project)}</div></div>
          <div class="gantt-track"><div class="gantt-bar" style="left:${left}%;width:${width}%"></div></div>
          <div class="small muted">${esc(t.startDate)} → ${esc(t.dueDate)}</div></div>`;
      }).join('') + '<p class="muted small" style="margin-top:10px">Bars run from start date to due date. Dependencies and baselines are not included.</p>';
    }
  }
  el.innerHTML = `
    <div class="row-flex"><div><h1>Tasks</h1><p class="muted" style="margin:0">Create, assign and track work across the three departments.</p></div>
    <span class="spacer"></span>
    <select id="task-project" style="width:auto">${['All', ...state.departments].map(d => `<option ${state.taskProject === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
    ${canWrite() ? '<button class="btn" id="new-task">+ New task</button>' : '<span class="pill">Read-only (Viewer)</span>'}</div>
    <div class="view-tabs">${['List', 'Board', 'Calendar', 'Gantt'].map(v => `<button data-tv="${v}" class="${state.taskView === v ? 'active' : ''}">${v}</button>`).join('')}</div>
    ${body}`;
  el.querySelector('#task-project').addEventListener('change', (e) => { state.taskProject = e.target.value; renderView(); });
  el.querySelectorAll('[data-tv]').forEach(b => b.addEventListener('click', () => { state.taskView = b.dataset.tv; renderView(); }));
  const nt = el.querySelector('#new-task'); if (nt) nt.addEventListener('click', () => openTaskModal(null));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openTaskModal(state.tasks.find(t => t.id === b.dataset.edit))));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this task?')) return;
    await api('DELETE', `/api/tasks/${b.dataset.del}`); renderView();
  }));
  el.querySelectorAll('[data-status]').forEach(sel => sel.addEventListener('change', async () => {
    const t = state.tasks.find(x => x.id === sel.dataset.status);
    await api('PUT', `/api/tasks/${t.id}`, { ...t, status: sel.value });
    renderView();
  }));
  const prev = el.querySelector('#cal-prev'), next = el.querySelector('#cal-next');
  if (prev) prev.addEventListener('click', () => { state.calCursor.setMonth(state.calCursor.getMonth() - 1); renderView(); });
  if (next) next.addEventListener('click', () => { state.calCursor.setMonth(state.calCursor.getMonth() + 1); renderView(); });
}

/* ---------------- goals ---------------- */
function openGoalModal(goal) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><h2 style="margin-top:0">${goal ? 'Edit goal' : 'New goal'}</h2>
    <form id="goal-form"><div class="form-grid">
      <div style="grid-column:1/-1"><label>Title</label><input name="title" required value="${esc(goal?.title || '')}"></div>
      <div><label>Project</label><select name="project">${state.departments.map(d => `<option ${goal?.project === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div><label>Current</label><input name="current" type="number" step="any" value="${goal?.current ?? 0}"></div>
      <div><label>Target</label><input name="target" type="number" step="any" required value="${goal?.target ?? ''}"></div>
      <div><label>Unit</label><input name="unit" value="${esc(goal?.unit || '')}" placeholder="events, parks, people…"></div>
    </div>
    <div class="row-flex" style="margin-top:16px"><button class="btn">${goal ? 'Save changes' : 'Create goal'}</button>
    <button type="button" class="btn secondary" id="goal-cancel">Cancel</button>
    <span class="error" id="goal-err" style="display:none"></span></div></form></div>`;
  document.body.appendChild(bg);
  bg.querySelector('#goal-cancel').addEventListener('click', () => bg.remove());
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  bg.querySelector('#goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.current = Number(f.current) || 0; f.target = Number(f.target) || 0;
    try {
      if (goal) await api('PUT', `/api/goals/${goal.id}`, f);
      else await api('POST', '/api/goals', f);
      bg.remove(); renderView();
    } catch (err) { const box = bg.querySelector('#goal-err'); box.style.display = 'block'; box.textContent = err.message; }
  });
}
async function viewGoals(el) {
  const gr = await api('GET', '/api/goals');
  state.goals = gr.goals;
  el.innerHTML = `
    <div class="row-flex"><div><h1>Goals</h1><p class="muted" style="margin:0">Track progress toward department goals.</p></div>
    <span class="spacer"></span>${canWrite() ? '<button class="btn" id="new-goal">+ New goal</button>' : '<span class="pill">Read-only (Viewer)</span>'}</div>
    <div style="margin-top:14px">
    ${state.goals.map(g => `<div class="row-flex" style="padding:10px 0;border-bottom:1px solid var(--line)">
      <div style="min-width:280px"><strong>${esc(g.title)}</strong> <span class="pill">${esc(g.project)}</span>
      ${g.current >= g.target && g.target > 0 ? '<span class="pill">Reached</span>' : ''}</div>
      <div class="bar" style="flex:1"><div style="width:${pct(g.current, g.target)}%"></div></div>
      <div class="muted small">${esc(g.current)} / ${esc(g.target)} ${esc(g.unit)} (${pct(g.current, g.target)}%)</div>
      ${canWrite() ? `<button class="btn secondary small" data-gedit="${g.id}">Edit</button><button class="btn danger small" data-gdel="${g.id}">Delete</button>` : ''}
    </div>`).join('') || '<p class="muted">No goals yet.</p>'}
    </div>`;
  const ng = el.querySelector('#new-goal'); if (ng) ng.addEventListener('click', () => openGoalModal(null));
  el.querySelectorAll('[data-gedit]').forEach(b => b.addEventListener('click', () => openGoalModal(state.goals.find(g => g.id === b.dataset.gedit))));
  el.querySelectorAll('[data-gdel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this goal?')) return;
    await api('DELETE', `/api/goals/${b.dataset.gdel}`); renderView();
  }));
}

/* ---------------- team & seats ---------------- */
async function viewTeam(el) {
  const r = await api('GET', '/api/members');
  state.members = r.members;
  const active = r.members.filter(m => !m.disabled);
  el.innerHTML = `
    <h1>Team & Seats</h1>
    <p class="muted">Named users across Police, Parks and Marketing. Each active account uses one seat; accounts are managed in <strong>Users & Login</strong>.</p>
    <div class="card" style="max-width:440px;margin:14px 0">
      <div class="num">${r.seatsUsed} / ${r.seatLimit}</div><div class="lbl">Seats used — $${state.seatPriceUsd} per seat/month</div>
      <div class="meter" style="margin-top:10px"><div style="width:${Math.round(r.seatsUsed / r.seatLimit * 100)}%"></div></div>
      <p class="small muted" style="margin:10px 0 0">${r.seatLimit - r.seatsUsed} seats remaining. New accounts are blocked once all ${r.seatLimit} seats are in use.</p>
    </div>
    <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>
    ${r.members.map(m => `<tr><td><strong>${esc(m.name)}</strong></td><td>${esc(m.email)}</td><td><span class="pill">${esc(m.role)}</span></td><td>${m.disabled ? 'Disabled' : 'Active'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No accounts yet.</td></tr>'}
    </tbody></table>
    <p class="small muted" style="margin-top:10px">${active.length} active account(s).</p>`;
}

/* ---------------- users & login ---------------- */
async function viewUsers(el) {
  const u = state.user;
  let adminHtml = '';
  if (isAdmin()) {
    const r = await api('GET', '/api/users');
    adminHtml = `
    <div class="panel">
      <h2 style="margin-top:0">Add user</h2>
      <p class="muted small">Signup is invite-only: admins create accounts here. The new user gets a generated temporary password, shown once — share it with them so they can sign in and change it.</p>
      <form id="add-user"><div class="form-grid">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Work email</label><input name="email" type="email" required></div>
        <div><label>Role</label><select name="role"><option>Member</option><option>Admin</option><option>Viewer</option></select></div>
      </div>
      <div id="add-result"></div>
      <button class="btn" style="margin-top:12px">Create account</button></form>
    </div>
    <div class="panel">
      <h2 style="margin-top:0">Accounts (${r.seatsUsed} of ${r.seatLimit} seats used)</h2>
      <table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${r.users.map(m => `<tr>
        <td><strong>${esc(m.name)}</strong></td><td>${esc(m.email)}</td>
        <td>${m.role === 'Owner' ? '<span class="pill">Owner</span>' : `<select data-role="${m.id}">${['Admin', 'Member', 'Viewer'].map(role => `<option ${m.role === role ? 'selected' : ''}>${role}</option>`).join('')}</select>`}</td>
        <td>${m.disabled ? 'Disabled' : 'Active'}</td>
        <td><div class="row-flex">
          ${m.role !== 'Owner' ? `<button class="btn secondary small" data-toggle="${m.id}">${m.disabled ? 'Enable' : 'Disable'}</button>
          <button class="btn secondary small" data-reset="${m.id}">Reset password</button>
          <button class="btn danger small" data-udel="${m.id}">Delete</button>` : '<span class="muted small">—</span>'}
        </div><div class="small" id="act-${m.id}"></div></td>
      </tr>`).join('')}
      </tbody></table>
    </div>`;
  }
  el.innerHTML = `
    <h1>Users & Login</h1>
    <p class="muted">Your account, sign-in security, and — for admins — account management.</p>
    <div class="panel">
      <h2 style="margin-top:0">My account</h2>
      <p style="margin:4px 0"><strong>${esc(u.name)}</strong></p>
      <p class="muted" style="margin:2px 0">${esc(u.email)} • <span class="pill">${esc(u.role)}</span></p>
      <form id="change-pw" style="max-width:420px">
        <label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password">
        <label>New password</label><input name="newPassword" type="password" required autocomplete="new-password">
        <p class="small muted">At least 10 characters, with a letter and a number.</p>
        <div id="pw-result"></div>
        <button class="btn">Change password</button>
      </form>
    </div>
    ${adminHtml}`;
  el.querySelector('#change-pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const box = el.querySelector('#pw-result');
    try { await api('POST', '/api/auth/change-password', f); box.innerHTML = '<div class="notice">Password changed.</div>'; e.target.reset(); }
    catch (err) { box.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  });
  if (!isAdmin()) return;
  el.querySelector('#add-user').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const box = el.querySelector('#add-result');
    try {
      const r = await api('POST', '/api/users', f);
      box.innerHTML = `<div class="notice">Account created for ${esc(r.user.name)}. Temporary password (shown once): <code>${esc(r.tempPassword)}</code></div>`;
      setTimeout(renderView, 2500);
    } catch (err) { box.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  });
  el.querySelectorAll('[data-role]').forEach(sel => sel.addEventListener('change', async () => {
    await api('PATCH', `/api/users/${sel.dataset.role}`, { role: sel.value }); renderView();
  }));
  el.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
    const r = await api('GET', '/api/users');
    const target = r.users.find(x => x.id === b.dataset.toggle);
    await api('PATCH', `/api/users/${target.id}`, { disabled: !target.disabled }); renderView();
  }));
  el.querySelectorAll('[data-udel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this account? This cannot be undone.')) return;
    await api('DELETE', `/api/users/${b.dataset.udel}`); renderView();
  }));
  el.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', async () => {
    const box = el.querySelector(`#act-${b.dataset.reset}`);
    try {
      const r = await api('POST', `/api/users/${b.dataset.reset}/reset`);
      box.innerHTML = r.emailed ? '<span class="notice" style="display:block">Reset link emailed.</span>'
        : `<span class="notice" style="display:block">Email not configured — reset token (60 min, single use): <code>${esc(r.devToken || '')}</code></span>`;
    } catch (err) { box.innerHTML = `<span class="error" style="display:block">${esc(err.message)}</span>`; }
  }));
}

/* ---------------- chat — Microsoft Teams ---------------- */
async function viewChat(el) {
  const r = await api('GET', '/api/settings/teams');
  const t = r.teams;
  el.innerHTML = `
    <h1>Chat — Microsoft Teams</h1>
    <p class="muted">Workbase posts notifications to a Microsoft Teams channel through an incoming webhook. There is no built-in messenger and no Slack integration in this deployment.</p>
    <div class="panel">
      <h2 style="margin-top:0">Teams webhook</h2>
      ${isAdmin() ? `
      <form id="teams-form">
        <label>Incoming webhook URL</label>
        <input name="webhookUrl" type="url" placeholder="https://…webhook.office.com/…" value="${esc(t.webhookUrl || '')}">
        <p class="small muted">In Teams: channel ••• → Connectors (or Workflows) → Incoming Webhook → create → paste the URL here.</p>
        <label class="checkbox"><input type="checkbox" name="enabled" ${t.enabled ? 'checked' : ''}> Enable Teams notifications</label>
        <label class="checkbox"><input type="checkbox" name="onTaskCreated" ${t.onTaskCreated ? 'checked' : ''}> Post when a task is created</label>
        <label class="checkbox"><input type="checkbox" name="onTaskCompleted" ${t.onTaskCompleted ? 'checked' : ''}> Post when a task is completed</label>
        <label class="checkbox"><input type="checkbox" name="onGoalReached" ${t.onGoalReached ? 'checked' : ''}> Post when a goal is reached</label>
        <div id="teams-result"></div>
        <div class="row-flex" style="margin-top:12px">
          <button class="btn">Save settings</button>
          <button type="button" class="btn secondary" id="teams-test">Send test message</button>
        </div>
      </form>` : `
      <p>Webhook configured: <strong>${t.webhookUrl ? 'Yes' : 'No'}</strong> • Notifications: <strong>${t.enabled ? 'On' : 'Off'}</strong></p>
      <p class="muted small">Only Owner/Admin accounts can change chat settings.</p>`}
    </div>`;
  if (!isAdmin()) return;
  el.querySelector('#teams-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      webhookUrl: fd.get('webhookUrl'),
      enabled: fd.get('enabled') === 'on',
      onTaskCreated: fd.get('onTaskCreated') === 'on',
      onTaskCompleted: fd.get('onTaskCompleted') === 'on',
      onGoalReached: fd.get('onGoalReached') === 'on',
    };
    const box = el.querySelector('#teams-result');
    try { await api('PUT', '/api/settings/teams', body); box.innerHTML = '<div class="notice">Settings saved.</div>'; }
    catch (err) { box.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  });
  el.querySelector('#teams-test').addEventListener('click', async () => {
    const box = el.querySelector('#teams-result');
    box.innerHTML = '<div class="notice">Sending…</div>';
    try { const r = await api('POST', '/api/settings/teams/test'); box.innerHTML = `<div class="notice">${esc(r.message)}</div>`; }
    catch (err) { box.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  const b = await api('GET', '/api/bootstrap');
  state.needsOwner = b.needsOwner;
  state.seatLimit = b.seatLimit; state.seatPriceUsd = b.seatPriceUsd;
  state.departments = b.departments || state.departments;
  const resetToken = new URLSearchParams(location.search).get('reset');
  if (resetToken && !b.user) return renderAuth('reset');
  if (b.user) { state.user = b.user; state.view = 'dashboard'; return renderShell(); }
  if (b.needsOwner) return renderAuth('owner');
  renderAuth('login');
}
boot().catch(() => { app.innerHTML = '<div class="auth-wrap"><div class="auth-card"><div class="error">Could not reach the Workbase server.</div></div></div>'; });
