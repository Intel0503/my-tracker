'use strict';
/* =========================================================
   My Tracker — offline personal task & goal tracker

   How this file is organised:
     1. Helpers       small reusable functions (dates, text)
     2. Database      saving to the phone (IndexedDB)
     3. Data changes  create / edit / change status (NO delete)
     4. Screens       Tasks, Goals, Stats, More
     5. Pop-up forms  add / edit task or goal
     6. Analytics     the numbers behind the Stats screen
     7. Backup        export / import
     8. Start-up      runs when the app opens

   Rule of the app: nothing is ever deleted. Items move between
   statuses (active, done, archived, cancelled) and every change
   is written to a permanent history log.
   ========================================================= */

/* ---------- 1. Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Escape text before putting it into HTML (stops typed "<" etc. from breaking the page)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const nowISO = () => new Date().toISOString();

// Dates are stored as "YYYY-MM-DD" in your local time
function dayKey(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayKey = () => dayKey(new Date());
function parseDay(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function daysBetween(aKey, bKey) { return Math.round((parseDay(bKey) - parseDay(aKey)) / 86400000); }
function fmtDay(k) {
  if (!k) return '';
  const diff = daysBetween(todayKey(), k);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const d = parseDay(k);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
function fmtDateTime(iso) {
  return new Date(iso).toLocaleString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const STATUS_LABEL = {
  task: { active: 'To do', done: 'Done', archived: 'Archived', cancelled: 'Cancelled' },
  goal: { active: 'Active', done: 'Achieved', archived: 'Archived', cancelled: 'Cancelled' },
};
const FIELD_LABEL = {
  title: 'title', notes: 'notes', goalId: 'goal', dueDate: 'due date',
  priority: 'priority', category: 'category', targetDate: 'target date',
};

/* ---------- 2. Database (IndexedDB = storage built into the browser) ---------- */
const DB_NAME = 'my-tracker';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Runs only the first time (or when DB_VERSION goes up): creates the "tables"
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['goals', 'tasks', 'history', 'meta']) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Saves several records in ONE transaction: either all are saved or none are.
// Note there is deliberately no "delete" function anywhere in this app.
function putMany(entries) {
  return new Promise((resolve, reject) => {
    const stores = [...new Set(entries.map(e => e[0]))];
    const t = db.transaction(stores, 'readwrite');
    for (const [store, obj] of entries) t.objectStore(store).put(obj);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* ---------- 3. Data changes ---------- */
// Everything the app knows, kept in memory while it's open
const state = {
  goals: [], tasks: [], history: [], meta: {},
  view: 'tasks',
  taskFilter: 'active',   // active | done | closed
  goalFilter: 'active',
  search: '',
  statsRange: 90,         // days (0 = all time)
};
const storeOf = kind => (kind === 'task' ? 'tasks' : 'goals');

async function loadAll() {
  state.goals = await getAll('goals');
  state.tasks = await getAll('tasks');
  state.history = await getAll('history');
  state.meta = Object.fromEntries((await getAll('meta')).map(m => [m.id, m.value]));
}

async function setMeta(key, value) {
  state.meta[key] = value;
  await putMany([['meta', { id: key, value }]]);
}

async function createItem(kind, data) {
  const ts = nowISO();
  const item = { id: uid(), ...data, status: 'active', createdAt: ts, updatedAt: ts, completedAt: null };
  const log = { id: uid(), ts, kind, itemId: item.id, action: 'created', changes: { title: { from: null, to: item.title } } };
  await putMany([[storeOf(kind), item], ['history', log]]);
  state[storeOf(kind)].push(item);
  state.history.push(log);
  return item;
}

// Applies changes to an item and records exactly what changed in the history log
async function updateItem(kind, item, patch) {
  const changes = {};
  for (const key of Object.keys(patch)) {
    const before = item[key] ?? '';
    const after = patch[key] ?? '';
    if (before !== after) changes[key] = { from: item[key] ?? null, to: patch[key] ?? null };
  }
  if (!Object.keys(changes).length) return false; // nothing actually changed

  const ts = nowISO();
  const updated = { ...item, ...patch, updatedAt: ts };
  if (changes.status) updated.completedAt = patch.status === 'done' ? ts : null;
  const log = { id: uid(), ts, kind, itemId: item.id, action: changes.status ? 'status' : 'edited', changes };

  await putMany([[storeOf(kind), updated], ['history', log]]);
  Object.assign(item, updated);
  state.history.push(log);
  return true;
}

const setStatus = (kind, item, status) => updateItem(kind, item, { status });

/* ---------- Lookups used by several screens ---------- */
const goalById = id => state.goals.find(g => g.id === id);
const taskById = id => state.tasks.find(t => t.id === id);
const tasksOfGoal = goalId => state.tasks.filter(t => t.goalId === goalId);

function goalProgress(goal) {
  // Archived and cancelled tasks don't count against you
  const relevant = tasksOfGoal(goal.id).filter(t => t.status === 'active' || t.status === 'done');
  const done = relevant.filter(t => t.status === 'done').length;
  const pct = goal.status === 'done' ? 100 : (relevant.length ? Math.round(done / relevant.length * 100) : 0);
  return { done, total: relevant.length, pct };
}

/* ---------- 4. Screens ---------- */
const TITLES = { tasks: 'Tasks', goals: 'Goals', stats: 'Stats', more: 'More' };

function render() {
  $('#view-title').textContent = TITLES[state.view];
  $$('.bottomnav button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#fab').classList.toggle('hidden', state.view === 'stats' || state.view === 'more');
  const views = { tasks: renderTasks, goals: renderGoals, stats: renderStats, more: renderMore };
  $('#view').innerHTML = views[state.view]();
  if (state.view === 'tasks') renderTaskList();
}

function segmented(name, current, options) {
  return `<div class="segmented" role="tablist">${options.map(([value, label]) =>
    `<button data-act="seg" data-name="${name}" data-value="${value}" class="${value === current ? 'active' : ''}">${label}</button>`
  ).join('')}</div>`;
}

function backupBanner() {
  const count = state.tasks.length + state.goals.length;
  if (count < 3) return '';
  const last = state.meta.lastBackup;
  const days = last ? daysBetween(dayKey(last), todayKey()) : Infinity;
  if (days < 14) return '';
  const msg = last ? `Last backup ${plural(days, 'day')} ago` : 'You have never backed up';
  return `<div class="banner"><span>${msg}</span><button data-act="export">Back up</button></div>`;
}

/* ----- Tasks screen ----- */
function renderTasks() {
  return `
    ${backupBanner()}
    <input class="search" id="search" type="search" placeholder="Search tasks" value="${esc(state.search)}" autocomplete="off">
    ${segmented('taskFilter', state.taskFilter, [['active', 'To do'], ['done', 'Done'], ['closed', 'Archived']])}
    <div id="task-list"></div>`;
}

// Only the list is redrawn while typing in search, so the keyboard stays open
function renderTaskList() {
  const q = state.search.trim().toLowerCase();
  let tasks = state.tasks.filter(t =>
    state.taskFilter === 'closed' ? (t.status === 'archived' || t.status === 'cancelled') : t.status === state.taskFilter);
  if (q) tasks = tasks.filter(t => (t.title + ' ' + (t.notes || '')).toLowerCase().includes(q));

  let html = '';
  if (!tasks.length) {
    const msgs = {
      active: ['Nothing to do', 'Tap + to add your first task.'],
      done: ['No finished tasks yet', 'Tick a task to mark it done.'],
      closed: ['Nothing archived', 'Archived and cancelled tasks show up here.'],
    };
    const [a, b] = q ? ['No matches', 'Try a different search.'] : msgs[state.taskFilter];
    html = `<div class="empty"><strong>${a}</strong>${b}</div>`;
  } else if (state.taskFilter === 'active') {
    const today = todayKey();
    const weekEnd = dayKey(addDays(new Date(), 7));
    const groups = { Overdue: [], Today: [], 'Next 7 days': [], Later: [], 'No due date': [] };
    for (const t of tasks) {
      if (!t.dueDate) groups['No due date'].push(t);
      else if (t.dueDate < today) groups.Overdue.push(t);
      else if (t.dueDate === today) groups.Today.push(t);
      else if (t.dueDate <= weekEnd) groups['Next 7 days'].push(t);
      else groups.Later.push(t);
    }
    const prio = { high: 0, normal: 1, low: 2 };
    for (const [name, list] of Object.entries(groups)) {
      if (!list.length) continue;
      list.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')
        || prio[a.priority || 'normal'] - prio[b.priority || 'normal']
        || a.createdAt.localeCompare(b.createdAt));
      html += `<div class="section-title"><span>${name}</span><span>${list.length}</span></div>
               <div class="list">${list.map(taskRow).join('')}</div>`;
    }
  } else {
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    html = `<div class="section-title"><span>${tasks.length} ${state.taskFilter === 'done' ? 'completed' : 'closed'}</span></div>
            <div class="list">${tasks.map(taskRow).join('')}</div>`;
  }
  $('#task-list').innerHTML = html;
}

function taskRow(t) {
  const goal = t.goalId ? goalById(t.goalId) : null;
  const meta = [];
  if (t.status === 'done') meta.push(`Done ${fmtDay(dayKey(t.completedAt))}`);
  else if (t.status !== 'active') meta.push(`<span class="chip">${STATUS_LABEL.task[t.status]}</span>`);
  if (t.dueDate && t.status === 'active') {
    const overdue = t.dueDate < todayKey();
    meta.push(`<span class="${overdue ? 'overdue' : ''}">${overdue ? 'Overdue · ' : 'Due '}${fmtDay(t.dueDate)}</span>`);
  }
  if (goal) meta.push(`◎ ${esc(goal.title)}`);
  if (t.priority === 'high') meta.push('<span class="chip warn">High</span>');
  if (t.priority === 'low') meta.push('<span class="chip">Low</span>');

  const checkClass = t.status === 'done' ? 'on' : t.status === 'active' ? (t.priority === 'high' ? 'high' : '') : 'off';
  const label = t.status === 'done' ? 'Mark as not done' : 'Mark as done';
  const checkBtn = (t.status === 'active' || t.status === 'done')
    ? `<button class="check ${checkClass}" data-act="toggle" data-id="${t.id}" aria-label="${label}">${ICON_CHECK}</button>`
    : `<span class="check off" aria-hidden="true"></span>`;
  return `<div class="row ${t.status === 'done' ? 'done' : ''}">
      ${checkBtn}
      <button class="row-body" data-act="edit-task" data-id="${t.id}">
        <div class="row-title">${esc(t.title)}</div>
        ${meta.length ? `<div class="row-meta">${meta.join('')}</div>` : ''}
      </button>
    </div>`;
}

/* ----- Goals screen ----- */
function renderGoals() {
  let goals = state.goals.filter(g =>
    state.goalFilter === 'closed' ? (g.status === 'archived' || g.status === 'cancelled') : g.status === state.goalFilter);
  goals.sort((a, b) => (a.targetDate || '9999').localeCompare(b.targetDate || '9999') || a.createdAt.localeCompare(b.createdAt));

  let html = segmented('goalFilter', state.goalFilter, [['active', 'Active'], ['done', 'Achieved'], ['closed', 'Archived']]);
  if (!goals.length) {
    const msgs = {
      active: ['No active goals', 'Tap + to set a long-term goal, then link tasks to it.'],
      done: ['No achieved goals yet', 'They will be celebrated here.'],
      closed: ['Nothing archived', 'Archived and cancelled goals show up here.'],
    };
    const [a, b] = msgs[state.goalFilter];
    return html + `<div class="empty"><strong>${a}</strong>${b}</div>`;
  }
  for (const g of goals) {
    const p = goalProgress(g);
    let when = '';
    if (g.status === 'done') when = `Achieved ${fmtDay(dayKey(g.completedAt))}`;
    else if (g.targetDate) {
      const left = daysBetween(todayKey(), g.targetDate);
      when = left < 0 ? `<span style="color:var(--warn)">${plural(-left, 'day')} past target</span>`
        : left === 0 ? 'Target is today' : `${plural(left, 'day')} left`;
    }
    html += `<button class="card goal-card" data-act="open-goal" data-id="${g.id}">
        <div class="top">
          <div class="title">${esc(g.title)}</div>
          ${g.category ? `<span class="chip accent">${esc(g.category)}</span>` : ''}
        </div>
        ${g.status !== 'active' && g.status !== 'done' ? `<span class="chip">${STATUS_LABEL.goal[g.status]}</span>` : ''}
        <div class="progress"><span style="width:${p.pct}%"></span></div>
        <div class="meta"><span>${p.pct}% · ${p.done}/${p.total} tasks</span><span>${when}</span></div>
      </button>`;
  }
  return html;
}

/* ----- Stats screen ----- */
function renderStats() {
  const s = computeStats(state.statsRange);
  const rangeLabel = state.statsRange ? `last ${state.statsRange} days` : 'all time';
  let html = segmented('statsRange', String(state.statsRange), [['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['0', 'All time']]);

  if (!state.tasks.length && !state.goals.length) {
    return html + `<div class="empty"><strong>No data yet</strong>Add and complete some tasks and your stats will appear here.</div>`;
  }

  const kpi = (label, value, sub = '') =>
    `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  html += `<div class="kpis">
    ${kpi('Tasks completed', s.doneInRange, rangeLabel)}
    ${kpi('Completion rate', s.completionRate == null ? '–' : s.completionRate + '%', `of ${plural(s.createdInRange, 'task')} added`)}
    ${kpi('Current streak', plural(s.currentStreak, 'day'), `best: ${plural(s.bestStreak, 'day')}`)}
    ${kpi('On time', s.onTimeRate == null ? '–' : s.onTimeRate + '%', 'done by due date')}
    ${kpi('Avg. time to finish', s.avgDays == null ? '–' : (s.avgDays < 1 ? '< 1 day' : plural(Math.round(s.avgDays), 'day')), 'from added to done')}
    ${kpi('Goals achieved', s.goalsAchieved, `${s.activeGoals} still active`)}
  </div>`;

  if (s.overdueNow) {
    html += `<div class="banner"><span>${plural(s.overdueNow, 'task')} overdue right now</span>
      <button data-act="goto-tasks">View</button></div>`;
  }

  html += `<div class="card"><h3>Completed per week</h3>${barChart(s.weekly.values, s.weekly.labels)}
    <p class="muted small" style="margin:6px 0 0">Last 12 weeks · ${s.weekly.values.reduce((a, b) => a + b, 0)} tasks</p></div>`;

  html += `<div class="card"><h3>Activity</h3>${heatmap(s.daily)}
    <div class="legend">Less <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> More</div></div>`;

  const best = s.weekday.values.indexOf(Math.max(...s.weekday.values));
  html += `<div class="card"><h3>Best day of the week</h3>${barChart(s.weekday.values, s.weekday.labels, best)}
    <p class="muted small" style="margin:6px 0 0">${s.doneInRange ? `You finish the most on <b>${s.weekday.full[best]}</b> (${rangeLabel})` : 'No completions in this period'}</p></div>`;

  const active = state.goals.filter(g => g.status === 'active');
  if (active.length) {
    html += `<div class="card"><h3>Goal progress</h3>${active.map(g => {
      const p = goalProgress(g);
      return `<div class="goal-progress-row"><div class="top"><span>${esc(g.title)}</span><b>${p.pct}%</b></div>
        <div class="progress"><span style="width:${p.pct}%"></span></div></div>`;
    }).join('')}</div>`;
  }

  html += `<div class="card"><h3>All-time totals</h3>
    <p class="small" style="margin:0">${plural(state.tasks.length, 'task')} and ${plural(state.goals.length, 'goal')} recorded
    ${s.firstDay ? ` since ${parseDay(s.firstDay).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}.
    ${plural(s.totalDone, 'task')} completed, ${plural(state.history.length, 'change')} logged.</p></div>`;
  return html;
}

// Simple bar chart drawn as SVG (no internet library needed, so it works offline)
function barChart(values, labels, highlight = -1) {
  const W = 320, H = 130, top = 16, bottom = 20;
  const max = Math.max(1, ...values);
  const slot = W / values.length;
  const bw = Math.min(26, slot * 0.62);
  let bars = '';
  values.forEach((v, i) => {
    const h = (v / max) * (H - top - bottom);
    const x = i * slot + (slot - bw) / 2;
    const y = H - bottom - h;
    const dim = highlight >= 0 && i !== highlight ? ' dim' : '';
    bars += `<rect class="bar${dim}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, v ? 2 : 0).toFixed(1)}" rx="3"/>`;
    if (v) bars += `<text class="val" x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${v}</text>`;
    bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(labels[i])}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">
    <line class="grid" x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}"/>${bars}</svg>`;
}

// Calendar heatmap: one square per day, darker = more tasks completed
function heatmap(daily) {
  const weeks = 18, cell = 15, gap = 3, left = 22, topPad = 14;
  const today = new Date();
  const mondayOffset = (today.getDay() + 6) % 7;            // days since Monday
  const start = addDays(today, -mondayOffset - (weeks - 1) * 7);
  let rects = '', months = '';
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      if (date > today) continue;
      const n = daily[dayKey(date)] || 0;
      const lvl = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 3 : 4;
      rects += `<rect class="h${lvl}" x="${left + w * (cell + gap)}" y="${topPad + d * (cell + gap)}" width="${cell}" height="${cell}" rx="3"><title>${dayKey(date)}: ${n}</title></rect>`;
      if (d === 0 && date.getMonth() !== lastMonth) {
        lastMonth = date.getMonth();
        months += `<text x="${left + w * (cell + gap)}" y="10">${date.toLocaleDateString(undefined, { month: 'short' })}</text>`;
      }
    }
  }
  const dayLbl = ['M', '', 'W', '', 'F', '', 'S'].map((l, i) =>
    l ? `<text x="0" y="${topPad + i * (cell + gap) + 11}">${l}</text>` : '').join('');
  const W = left + weeks * (cell + gap), H = topPad + 7 * (cell + gap);
  return `<svg class="chart heat" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily activity">${months}${dayLbl}${rects}</svg>`;
}

/* ----- More screen ----- */
function renderMore() {
  const last = state.meta.lastBackup;
  const canShare = !!(navigator.canShare && window.File);
  const recent = [...state.history].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 60);
  return `
    <div class="card">
      <h3>Backup</h3>
      <p class="small muted" style="margin:0">Your data lives only on this phone. Export a backup regularly and keep it somewhere safe (Google Drive, email to yourself). Importing never deletes anything; it only adds or updates.</p>
      <p class="small" style="margin:8px 0 0"><b>Last backup:</b> ${last ? fmtDateTime(last) : 'never'}</p>
      <div class="btn-row">
        <button class="btn primary" data-act="export">Download backup</button>
        ${canShare ? '<button class="btn" data-act="share">Share backup</button>' : ''}
        <button class="btn" data-act="import">Import backup</button>
      </div>
    </div>
    <div class="card">
      <h3>Storage</h3>
      <p class="small" style="margin:0" id="storage-info">Checking…</p>
    </div>
    <div class="section-title"><span>Change history</span><span>${state.history.length}</span></div>
    <div class="card">${recent.length ? `<ul class="log">${recent.map(logItem).join('')}</ul>` : '<p class="muted small" style="margin:0">No changes yet.</p>'}
      ${state.history.length > 60 ? '<p class="muted small" style="margin:8px 0 0">Showing the latest 60. The full history is kept and included in backups.</p>' : ''}</div>
    <p class="muted small" style="text-align:center">My Tracker · works offline · nothing is ever deleted</p>`;
}

// Turns one history record into a readable sentence
function describe(h, withName = true) {
  const item = h.kind === 'task' ? taskById(h.itemId) : goalById(h.itemId);
  const name = withName ? ` <b>${esc(item ? item.title : '(unknown)')}</b>` : '';
  const what = h.kind === 'task' ? 'task' : 'goal';
  if (h.action === 'created') return `Added ${what}${name}`;
  if (h.action === 'status') {
    const c = h.changes.status;
    return `${withName ? `${what[0].toUpperCase() + what.slice(1)}${name}: ` : ''}${STATUS_LABEL[h.kind][c.from]} → <b>${STATUS_LABEL[h.kind][c.to]}</b>`;
  }
  if (h.action === 'imported') return `Imported ${what}${name}`;
  const fields = Object.keys(h.changes).map(k => FIELD_LABEL[k] || k).join(', ');
  return `Edited ${fields}${withName ? ` of${name}` : ''}`;
}
const logItem = h => `<li>${describe(h)}<div class="when">${fmtDateTime(h.ts)}</div></li>`;

async function showStorageInfo() {
  const el = $('#storage-info');
  if (!el) return;
  let persisted = false;
  try { persisted = navigator.storage && await navigator.storage.persisted(); } catch (e) { /* not supported */ }
  let usage = '';
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      usage = ` Using about ${Math.max(1, Math.round((est.usage || 0) / 1024))} KB.`;
    }
  } catch (e) { /* not supported */ }
  el.innerHTML = persisted
    ? `✅ Protected: Android will not clear this data to free up space.${usage}`
    : `⚠️ Not protected yet. Install the app to your home screen to protect your data.${usage}`;
}

/* ---------- 5. Pop-up forms ---------- */
const sheet = $('#sheet');

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  if (!sheet.open) {
    sheet.showModal();
    // Lets the phone's Back button close the pop-up instead of leaving the app
    history.pushState({ sheet: true }, '');
  }
  sheet.scrollTop = 0;
}
function closeSheet(fromBack = false) {
  if (!sheet.open) return;
  sheet.close();
  if (!fromBack && history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => closeSheet(true));
sheet.addEventListener('cancel', e => { e.preventDefault(); closeSheet(); });
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); }); // tap the dark area to close

const sheetHead = title => `<div class="sheet-head"><h2>${title}</h2>
  <button type="button" class="icon-btn" data-act="close" aria-label="Close">${ICON_CLOSE}</button></div>`;

function itemHistory(kind, id) {
  const logs = state.history.filter(h => h.kind === kind && h.itemId === id).sort((a, b) => b.ts.localeCompare(a.ts));
  return `<details class="hist"><summary>History (${logs.length})</summary>
    <ul class="log">${logs.map(h => `<li>${describe(h, false)}<div class="when">${fmtDateTime(h.ts)}</div></li>`).join('')}</ul></details>`;
}

// Buttons that move an item between statuses (this replaces "delete")
function statusButtons(kind, item) {
  const doneLabel = kind === 'goal' ? 'Mark achieved' : 'Mark done';
  const b = (status, label, cls = '') =>
    `<button type="button" class="btn ${cls}" data-act="set-status" data-kind="${kind}" data-id="${item.id}" data-status="${status}">${label}</button>`;
  if (item.status === 'active') return b('done', doneLabel, 'primary') + b('archived', 'Archive') + b('cancelled', 'Cancel', 'warn');
  if (item.status === 'done') return b('active', 'Reopen') + b('archived', 'Archive');
  return b('active', 'Restore');
}

function openTaskForm(task = null, presetGoalId = '') {
  const t = task || { title: '', notes: '', goalId: presetGoalId, dueDate: '', priority: 'normal' };
  const goals = state.goals.filter(g => g.status === 'active' || g.id === t.goalId);
  openSheet(`
    ${sheetHead(task ? 'Edit task' : 'New task')}
    ${task ? `<div class="status-line"><span class="chip ${task.status === 'done' ? 'accent' : ''}">${STATUS_LABEL.task[task.status]}</span>
      <span class="muted small">Added ${fmtDateTime(task.createdAt)}</span></div>` : ''}
    <form id="task-form" autocomplete="off">
      <label class="field"><span>Task</span>
        <input name="title" required maxlength="200" value="${esc(t.title)}" placeholder="What needs doing?"></label>
      <label class="field"><span>Notes</span>
        <textarea name="notes" maxlength="5000" placeholder="Optional details">${esc(t.notes)}</textarea></label>
      <label class="field"><span>Goal</span>
        <select name="goalId"><option value="">No goal</option>
          ${goals.map(g => `<option value="${g.id}" ${g.id === t.goalId ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}
        </select></label>
      <div class="two-col">
        <label class="field"><span>Due date</span><input type="date" name="dueDate" value="${esc(t.dueDate)}"></label>
        <label class="field"><span>Priority</span>
          <select name="priority">
            ${['low', 'normal', 'high'].map(p => `<option value="${p}" ${p === (t.priority || 'normal') ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}
          </select></label>
      </div>
      <button class="btn primary block" type="submit">${task ? 'Save changes' : 'Add task'}</button>
    </form>
    ${task ? `<div class="btn-row">${statusButtons('task', task)}</div>${itemHistory('task', task.id)}` : ''}
  `);
  if (!task) setTimeout(() => $('#task-form [name=title]').focus(), 50);

  $('#task-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const data = {
      title: f.get('title').trim(),
      notes: f.get('notes').trim(),
      goalId: f.get('goalId') || '',
      dueDate: f.get('dueDate') || '',
      priority: f.get('priority'),
    };
    if (!data.title) return;
    if (task) { const changed = await updateItem('task', task, data); toast(changed ? 'Task saved' : 'No changes'); }
    else { await createItem('task', data); toast('Task added'); }
    closeSheet();
    render();
  });
}

function openGoalForm(goal = null) {
  const g = goal || { title: '', notes: '', category: '', targetDate: '' };
  const categories = [...new Set(state.goals.map(x => x.category).filter(Boolean))];
  openSheet(`
    ${sheetHead(goal ? 'Edit goal' : 'New goal')}
    <form id="goal-form" autocomplete="off">
      <label class="field"><span>Goal</span>
        <input name="title" required maxlength="200" value="${esc(g.title)}" placeholder="What do you want to achieve?"></label>
      <label class="field"><span>Why it matters</span>
        <textarea name="notes" maxlength="5000" placeholder="Optional: your reason, or how you'll know it's done">${esc(g.notes)}</textarea></label>
      <div class="two-col">
        <label class="field"><span>Category</span>
          <input name="category" list="cat-list" maxlength="40" value="${esc(g.category)}" placeholder="e.g. Health">
          <datalist id="cat-list">${categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field"><span>Target date</span><input type="date" name="targetDate" value="${esc(g.targetDate)}"></label>
      </div>
      <button class="btn primary block" type="submit">${goal ? 'Save changes' : 'Add goal'}</button>
    </form>
  `);
  if (!goal) setTimeout(() => $('#goal-form [name=title]').focus(), 50);

  $('#goal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const data = {
      title: f.get('title').trim(),
      notes: f.get('notes').trim(),
      category: f.get('category').trim(),
      targetDate: f.get('targetDate') || '',
    };
    if (!data.title) return;
    if (goal) { const changed = await updateItem('goal', goal, data); toast(changed ? 'Goal saved' : 'No changes'); openGoalDetail(goal); }
    else { await createItem('goal', data); toast('Goal added'); closeSheet(); }
    render();
  });
}

// Goal details: progress, its tasks, and status buttons
function openGoalDetail(goal) {
  const p = goalProgress(goal);
  const tasks = tasksOfGoal(goal.id);
  const order = { active: 0, done: 1, archived: 2, cancelled: 3 };
  tasks.sort((a, b) => order[a.status] - order[b.status] || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  openSheet(`
    ${sheetHead(esc(goal.title))}
    <div class="status-line">
      <span class="chip ${goal.status === 'done' ? 'accent' : ''}">${STATUS_LABEL.goal[goal.status]}</span>
      ${goal.category ? `<span class="chip accent">${esc(goal.category)}</span>` : ''}
      ${goal.targetDate ? `<span class="muted small">Target ${fmtDay(goal.targetDate)}</span>` : ''}
    </div>
    ${goal.notes ? `<p style="margin:0 0 10px; white-space:pre-wrap">${esc(goal.notes)}</p>` : ''}
    <div class="progress"><span style="width:${p.pct}%"></span></div>
    <p class="muted small" style="margin:0 0 12px">${p.pct}% · ${p.done} of ${plural(p.total, 'task')} done</p>
    <div class="section-title"><span>Tasks</span><span>${tasks.length}</span></div>
    ${tasks.length ? `<div class="list">${tasks.map(taskRow).join('')}</div>` : '<p class="muted small">No tasks linked yet.</p>'}
    <div class="btn-row">
      ${goal.status === 'active' ? `<button type="button" class="btn primary" data-act="add-task-to-goal" data-id="${goal.id}">+ Add task</button>` : ''}
      <button type="button" class="btn" data-act="edit-goal" data-id="${goal.id}">Edit goal</button>
    </div>
    <div class="btn-row">${statusButtons('goal', goal)}</div>
    ${itemHistory('goal', goal.id)}
  `);
}

/* ---------- 6. Analytics ---------- */
function computeStats(range) {
  const today = todayKey();
  const start = range ? dayKey(addDays(new Date(), -(range - 1))) : '0000-00-00';
  const inRange = iso => iso && dayKey(iso) >= start;

  const done = state.tasks.filter(t => t.status === 'done' && t.completedAt);
  const doneInRange = done.filter(t => inRange(t.completedAt));

  // Completion rate: of tasks added in the period (not cancelled/archived), how many are done
  const created = state.tasks.filter(t => inRange(t.createdAt) && (t.status === 'active' || t.status === 'done'));
  const createdDone = created.filter(t => t.status === 'done').length;

  const withDue = doneInRange.filter(t => t.dueDate);
  const onTime = withDue.filter(t => dayKey(t.completedAt) <= t.dueDate).length;

  const durations = doneInRange.map(t => (new Date(t.completedAt) - new Date(t.createdAt)) / 86400000);

  // Completions per day (used by heatmap and streaks)
  const daily = {};
  for (const t of done) { const k = dayKey(t.completedAt); daily[k] = (daily[k] || 0) + 1; }

  // Streak = days in a row with at least one task done
  let currentStreak = 0;
  let d = new Date();
  if (!daily[today]) d = addDays(d, -1);     // today isn't over yet, so don't break the streak
  while (daily[dayKey(d)]) { currentStreak++; d = addDays(d, -1); }
  let bestStreak = 0, run = 0, prev = null;
  for (const k of Object.keys(daily).sort()) {
    run = prev && daysBetween(prev, k) === 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    prev = k;
  }

  // Last 12 weeks, Monday to Sunday
  const now = new Date();
  const thisMonday = addDays(now, -((now.getDay() + 6) % 7));
  const weekly = { values: [], labels: [] };
  for (let w = 11; w >= 0; w--) {
    const from = dayKey(addDays(thisMonday, -w * 7));
    const to = dayKey(addDays(thisMonday, -w * 7 + 6));
    weekly.values.push(done.filter(t => { const k = dayKey(t.completedAt); return k >= from && k <= to; }).length);
    const m = parseDay(from);
    weekly.labels.push(w === 0 ? 'Now' : (w % 3 === 0 ? `${m.getDate()}/${m.getMonth() + 1}` : ''));
  }

  const weekday = { values: [0, 0, 0, 0, 0, 0, 0], labels: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    full: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] };
  for (const t of doneInRange) weekday.values[(new Date(t.completedAt).getDay() + 6) % 7]++;

  const allDates = [...state.tasks, ...state.goals].map(x => x.createdAt).sort();

  return {
    doneInRange: doneInRange.length,
    totalDone: done.length,
    createdInRange: created.length,
    completionRate: created.length ? Math.round(createdDone / created.length * 100) : null,
    onTimeRate: withDue.length ? Math.round(onTime / withDue.length * 100) : null,
    avgDays: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    currentStreak, bestStreak, daily, weekly, weekday,
    goalsAchieved: state.goals.filter(g => g.status === 'done' && inRange(g.completedAt)).length,
    activeGoals: state.goals.filter(g => g.status === 'active').length,
    overdueNow: state.tasks.filter(t => t.status === 'active' && t.dueDate && t.dueDate < today).length,
    firstDay: allDates.length ? dayKey(allDates[0]) : null,
  };
}

/* ---------- 7. Backup ---------- */
function backupFile() {
  const data = {
    app: 'my-tracker', format: 1, exportedAt: nowISO(),
    goals: state.goals, tasks: state.tasks, history: state.history,
  };
  const name = `my-tracker-backup-${todayKey()}.json`;
  return { name, blob: new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }) };
}

async function exportBackup() {
  const { name, blob } = backupFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  await setMeta('lastBackup', nowISO());
  toast('Backup saved to Downloads');
  render();
}

// Opens Android's share menu so you can send the backup straight to Drive, Gmail, etc.
async function shareBackup() {
  const { name, blob } = backupFile();
  const file = new File([blob], name, { type: 'application/json' });
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) { exportBackup(); return; }
  try {
    await navigator.share({ files: [file], title: name });
    await setMeta('lastBackup', nowISO());
    toast('Backup shared');
    render();
  } catch (e) {
    if (e.name !== 'AbortError') exportBackup();
  }
}

// Import MERGES: new items are added, and an item is only replaced if the backup's copy is newer.
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not a valid backup'); return; }
  if (!data || data.app !== 'my-tracker' || !Array.isArray(data.tasks) || !Array.isArray(data.goals)) {
    toast('That file is not a My Tracker backup'); return;
  }
  const entries = [];
  let added = 0, updated = 0;
  for (const [kind, list] of [['goal', data.goals], ['task', data.tasks]]) {
    const store = storeOf(kind);
    for (const incoming of list) {
      if (!incoming || !incoming.id || !incoming.title) continue;
      const existing = state[store].find(x => x.id === incoming.id);
      if (!existing) { state[store].push(incoming); entries.push([store, incoming]); added++; }
      else if ((incoming.updatedAt || '') > (existing.updatedAt || '')) {
        Object.assign(existing, incoming); entries.push([store, existing]); updated++;
      }
    }
  }
  const knownLogs = new Set(state.history.map(h => h.id));
  for (const h of (data.history || [])) {
    if (h && h.id && !knownLogs.has(h.id)) { state.history.push(h); entries.push(['history', h]); }
  }
  if (entries.length) await putMany(entries);
  toast(`Imported: ${added} new, ${updated} updated`);
  render();
}

/* ---------- 8. Start-up & tap handling ---------- */
// One click listener for the whole app; buttons say what they do with data-act="..."
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act], .bottomnav button');
  if (!el) return;

  if (el.dataset.view) {
    state.view = el.dataset.view;
    render();
    window.scrollTo(0, 0);
    if (state.view === 'more') showStorageInfo();
    return;
  }

  const { act, id } = el.dataset;
  switch (act) {
    case 'seg': {
      const val = el.dataset.value;
      state[el.dataset.name] = el.dataset.name === 'statsRange' ? Number(val) : val;
      render();
      break;
    }
    case 'toggle': {
      const t = taskById(id);
      await setStatus('task', t, t.status === 'done' ? 'active' : 'done');
      if (t.status === 'done') toast('Nice! Task done');
      render();
      if (sheet.open && t.goalId && goalById(t.goalId)) openGoalDetail(goalById(t.goalId));
      break;
    }
    case 'edit-task': openTaskForm(taskById(id)); break;
    case 'open-goal': openGoalDetail(goalById(id)); break;
    case 'edit-goal': openGoalForm(goalById(id)); break;
    case 'add-task-to-goal': openTaskForm(null, id); break;
    case 'set-status': {
      const kind = el.dataset.kind;
      const item = kind === 'task' ? taskById(id) : goalById(id);
      await setStatus(kind, item, el.dataset.status);
      toast(`${kind === 'task' ? 'Task' : 'Goal'}: ${STATUS_LABEL[kind][item.status]}`);
      render();
      if (kind === 'goal') openGoalDetail(item);
      else openTaskForm(item);
      break;
    }
    case 'close': closeSheet(); break;
    case 'export': exportBackup(); break;
    case 'share': shareBackup(); break;
    case 'import': $('#import-file').click(); break;
    case 'goto-tasks': state.view = 'tasks'; state.taskFilter = 'active'; render(); break;
  }
});

$('#fab').addEventListener('click', () => (state.view === 'goals' ? openGoalForm() : openTaskForm()));

$('#view').addEventListener('input', e => {
  if (e.target.id === 'search') { state.search = e.target.value; renderTaskList(); }
});

$('#import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) importBackup(file);
  e.target.value = '';
});

function updateTodayLabel() {
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

async function start() {
  updateTodayLabel();
  try {
    db = await openDB();
    await loadAll();
  } catch (err) {
    $('#view').innerHTML = `<div class="empty"><strong>Storage is not available</strong>
      Open the app from its web address (not as a file), and make sure you're not in Incognito mode.</div>`;
    return;
  }
  render();

  // Ask Android not to clear our data when the phone is low on space
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* ignore */ }

  // Service worker = the part that makes the app open with no internet
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Refresh "Today", overdue labels, etc. when you come back to the app on a new day
  let lastDay = todayKey();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && todayKey() !== lastDay) {
      lastDay = todayKey();
      updateTodayLabel();
      render();
    }
  });
}

start();
