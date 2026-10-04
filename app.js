'use strict';
/* =========================================================
   My Tracker — offline personal task, habit & goal tracker

   How this file is organised:
     1. Helpers       small reusable functions (dates, text)
     2. Database      saving to the phone (IndexedDB)
     3. Data changes  create / edit / change status (NO delete)
     4. Habits        daily logging, streaks, consistency
     5. Goals         progress from tasks or from a measured value (e.g. weight)
     6. Screens       Tasks, Goals, Stats, More
     7. Pop-up forms  add / edit task, habit, goal, weigh-in
     8. Analytics     the numbers behind the Stats screen
     9. Backup        export / import
    10. Start-up      runs when the app opens

   Rule of the app: nothing is ever deleted. Items move between
   statuses (active, done, paused, archived, cancelled) and every
   change is written to a permanent history log.
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
const num = v => Math.round(Number(v) * 100) / 100;                 // tidy decimals
const fmtNum = v => (v == null || v === '' ? '–' : num(v).toLocaleString());
const hasValue = v => v !== '' && v != null && !Number.isNaN(Number(v));

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
  habit: { active: 'Active', paused: 'Paused', archived: 'Archived' },
};
const FIELD_LABEL = {
  title: 'name', notes: 'notes', goalId: 'goal', dueDate: 'due date', priority: 'priority',
  category: 'category', targetDate: 'target date', metricUnit: 'unit', startValue: 'start value',
  targetValue: 'target value', type: 'type', target: 'daily target', unit: 'unit', step: 'quick-add amount',
};

/* ---------- 2. Database (IndexedDB = storage built into the browser) ---------- */
const DB_NAME = 'my-tracker';
const DB_VERSION = 2;   // v2 added habits, habitLogs, measurements
const STORES = ['goals', 'tasks', 'history', 'meta', 'habits', 'habitLogs', 'measurements'];
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Runs the first time, and when DB_VERSION goes up. It only ADDS missing
    // "tables", so your existing data is kept when the app is upgraded.
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of STORES) {
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
  goals: [], tasks: [], habits: [], measurements: [], history: [], meta: {},
  habitLogs: new Map(),   // key "habitId|YYYY-MM-DD" -> { value }
  view: 'tasks',
  taskFilter: 'active',   // active | done | closed
  goalFilter: 'active',
  search: '',
  statsRange: 90,         // days (0 = all time)
};
const STORE_OF = { task: 'tasks', goal: 'goals', habit: 'habits' };

async function loadAll() {
  state.goals = await getAll('goals');
  state.tasks = await getAll('tasks');
  state.habits = await getAll('habits');
  state.measurements = await getAll('measurements');
  state.history = await getAll('history');
  state.habitLogs = new Map((await getAll('habitLogs')).map(l => [l.id, l]));
  state.meta = Object.fromEntries((await getAll('meta')).map(m => [m.id, m.value]));
}

async function setMeta(key, value) {
  state.meta[key] = value;
  await putMany([['meta', { id: key, value }]]);
}

function addLog(kind, itemId, action, changes, ts = nowISO()) {
  return { id: uid(), ts, kind, itemId, action, changes };
}

async function createItem(kind, data) {
  const ts = nowISO();
  const item = { id: uid(), ...data, status: 'active', createdAt: ts, updatedAt: ts, completedAt: null };
  const log = addLog(kind, item.id, 'created', { title: { from: null, to: item.title } }, ts);
  await putMany([[STORE_OF[kind], item], ['history', log]]);
  state[STORE_OF[kind]].push(item);
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
  const log = addLog(kind, item.id, changes.status ? 'status' : 'edited', changes, ts);

  await putMany([[STORE_OF[kind], updated], ['history', log]]);
  Object.assign(item, updated);
  state.history.push(log);
  return true;
}

const setStatus = (kind, item, status) => updateItem(kind, item, { status });

/* ---------- Lookups used by several screens ---------- */
const goalById = id => state.goals.find(g => g.id === id);
const taskById = id => state.tasks.find(t => t.id === id);
const habitById = id => state.habits.find(h => h.id === id);
const itemById = (kind, id) => (kind === 'task' ? taskById(id) : kind === 'goal' ? goalById(id) : habitById(id));
const tasksOfGoal = goalId => state.tasks.filter(t => t.goalId === goalId);
const habitsOfGoal = goalId => state.habits.filter(h => h.goalId === goalId);

/* ---------- 4. Habits ---------- */
// A habit is created once and repeats every day. Each day gets one log
// record with a value: 1/0 for a checkbox habit, or a number (reps, minutes...).
const logKey = (habitId, day) => `${habitId}|${day}`;
const habitValue = (h, day) => (state.habitLogs.get(logKey(h.id, day)) || {}).value || 0;
const habitTarget = h => (h.type === 'count' ? Number(h.target) || 1 : 1);
const habitDone = (h, day) => habitValue(h, day) >= habitTarget(h);

async function setHabitValue(habit, day, value) {
  value = Math.max(0, num(value) || 0);
  const id = logKey(habit.id, day);
  const prev = state.habitLogs.get(id);
  const before = prev ? prev.value : 0;
  if (before === value) return false;
  const rec = { id, habitId: habit.id, date: day, value, updatedAt: nowISO() };
  const entries = [['habitLogs', rec]];
  // Normal logging for today isn't repeated in history (the log itself is the record).
  // Corrections (lowering a value, or changing a past day) ARE recorded, so nothing is lost.
  if (day !== todayKey() || value < before) {
    const h = addLog('habit', habit.id, 'log', { date: day, value: { from: before, to: value } }, rec.updatedAt);
    entries.push(['history', h]);
    state.history.push(h);
  }
  await putMany(entries);
  state.habitLogs.set(id, rec);
  return true;
}

// Was the habit being tracked on this day? (not before it was created, not while paused)
function habitTrackedOn(h) {
  const created = dayKey(h.createdAt);
  const events = state.history
    .filter(x => x.kind === 'habit' && x.itemId === h.id && x.changes && x.changes.status)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map(e => [dayKey(e.ts), e.changes.status.to]);
  return day => {
    if (day < created) return false;
    if (habitValue(h, day) > 0) return true;
    let status = 'active';
    for (const [d, to] of events) { if (d <= day) status = to; else break; }
    return status === 'active';
  };
}

// Streaks and consistency for one habit. rangeDays = 0 means since it was created.
function habitStats(h, rangeDays = 30) {
  const today = todayKey();
  const tracked = habitTrackedOn(h);
  const created = dayKey(h.createdAt);
  let from = rangeDays ? dayKey(addDays(new Date(), -(rangeDays - 1))) : created;
  if (from < created) from = created;

  let trackedDays = 0, doneDays = 0, partialDays = 0, total = 0;
  for (let d = parseDay(from); dayKey(d) <= today; d = addDays(d, 1)) {
    const k = dayKey(d);
    const v = habitValue(h, k);
    total += v;
    if (!tracked(k)) continue;
    const done = v >= habitTarget(h);
    if (k === today && !done) continue;           // today isn't over yet
    trackedDays++;
    if (done) doneDays++; else if (v > 0) partialDays++;
  }

  // Current streak: count back from today (or yesterday if today isn't done yet). Paused days are skipped.
  let current = 0;
  let d = new Date();
  if (!habitDone(h, today)) d = addDays(d, -1);
  for (let i = 0; i < 4000; i++, d = addDays(d, -1)) {
    const k = dayKey(d);
    if (k < created) break;
    if (!tracked(k)) continue;
    if (habitDone(h, k)) current++; else break;
  }
  // Best streak ever
  let best = 0, run = 0;
  for (let day = parseDay(created); dayKey(day) <= today; day = addDays(day, 1)) {
    const k = dayKey(day);
    if (!tracked(k)) continue;
    if (habitDone(h, k)) { run++; best = Math.max(best, run); } else if (k !== today) run = 0;
  }
  return {
    trackedDays, doneDays, partialDays, total, current, best,
    pct: trackedDays ? Math.round(doneDays / trackedDays * 100) : null,
  };
}

const habitDescr = h => (h.type === 'count' ? `${fmtNum(h.target)} ${esc(h.unit || '')}`.trim() : 'Checkbox') + ' · daily';

/* ---------- 5. Goals ---------- */
const goalHasMetric = g => hasValue(g.startValue) && hasValue(g.targetValue) && Number(g.startValue) !== Number(g.targetValue);
const measurementsOf = goalId => state.measurements
  .filter(m => m.goalId === goalId)
  .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));

function goalProgress(goal) {
  if (goalHasMetric(goal)) {
    // Progress from a measured value, e.g. weight 85 kg -> 75 kg
    const start = Number(goal.startValue), target = Number(goal.targetValue);
    const list = measurementsOf(goal.id);
    const latest = list.length ? Number(list[list.length - 1].value) : start;
    let pct = Math.round((start - latest) / (start - target) * 100);
    pct = goal.status === 'done' ? 100 : Math.max(0, Math.min(100, pct));
    const unit = esc(goal.metricUnit || '');
    return { pct, latest, metric: true, label: `${fmtNum(latest)} ${unit} → ${fmtNum(target)} ${unit}` };
  }
  // Otherwise from linked tasks (archived and cancelled tasks don't count against you)
  const relevant = tasksOfGoal(goal.id).filter(t => t.status === 'active' || t.status === 'done');
  const done = relevant.filter(t => t.status === 'done').length;
  const pct = goal.status === 'done' ? 100 : (relevant.length ? Math.round(done / relevant.length * 100) : 0);
  return { pct, metric: false, label: `${done}/${relevant.length} tasks` };
}

async function saveMeasurement(goal, existing, data) {
  const ts = nowISO();
  const entries = [];
  let rec;
  if (existing) {
    const changes = {};
    for (const k of ['date', 'value', 'note']) if ((existing[k] ?? '') !== (data[k] ?? '')) changes[k] = { from: existing[k], to: data[k] };
    if (!Object.keys(changes).length) return false;
    rec = { ...existing, ...data, updatedAt: ts };
    entries.push(['history', addLog('goal', goal.id, 'measurement-edit', { measurementId: existing.id, ...changes }, ts)]);
  } else {
    rec = { id: uid(), goalId: goal.id, ...data, createdAt: ts, updatedAt: ts };
    entries.push(['history', addLog('goal', goal.id, 'measurement', { date: data.date, value: { from: null, to: data.value } }, ts)]);
  }
  entries.unshift(['measurements', rec]);
  await putMany(entries);
  if (existing) Object.assign(existing, rec); else state.measurements.push(rec);
  state.history.push(entries[1][1]);
  return true;
}

/* ---------- 6. Screens ---------- */
const TITLES = { tasks: 'Today', goals: 'Goals', stats: 'Stats', more: 'More' };

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
  const count = state.tasks.length + state.goals.length + state.habits.length;
  if (count < 3) return '';
  const last = state.meta.lastBackup;
  const days = last ? daysBetween(dayKey(last), todayKey()) : Infinity;
  if (days < 14) return '';
  const msg = last ? `Last backup ${plural(days, 'day')} ago` : 'You have never backed up';
  return `<div class="banner"><span>${msg}</span><button data-act="export">Back up</button></div>`;
}

/* ----- Today screen: habits + tasks ----- */
function renderTasks() {
  return `
    ${backupBanner()}
    ${renderHabitSection()}
    <div class="section-title" style="margin-top:${state.habits.length ? 22 : 4}px"><span>Tasks</span></div>
    <input class="search" id="search" type="search" placeholder="Search tasks" value="${esc(state.search)}" autocomplete="off">
    ${segmented('taskFilter', state.taskFilter, [['active', 'To do'], ['done', 'Done'], ['closed', 'Archived']])}
    <div id="task-list"></div>`;
}

function renderHabitSection() {
  if (!state.habits.length) return '';
  const today = todayKey();
  const active = state.habits.filter(h => h.status === 'active')
    .sort((a, b) => habitDone(a, today) - habitDone(b, today) || a.createdAt.localeCompare(b.createdAt));
  const doneCount = active.filter(h => habitDone(h, today)).length;
  const others = state.habits.length - active.length;
  return `
    <div class="section-title" style="margin-top:4px"><span>Daily habits · ${doneCount}/${active.length} done</span>
      <button class="link" data-act="all-habits">All habits${others ? ` (${state.habits.length})` : ''}</button></div>
    ${active.length ? `<div class="list">${active.map(h => habitRow(h, today)).join('')}</div>`
      : '<p class="muted small" style="margin:0 4px">All habits are paused or archived.</p>'}`;
}

function habitRow(h, day) {
  const v = habitValue(h, day);
  const target = habitTarget(h);
  const done = v >= target;
  const pct = Math.min(100, Math.round(v / target * 100));
  const goal = h.goalId ? goalById(h.goalId) : null;
  const streak = habitStats(h, 30).current;
  const meta = [];
  if (h.type === 'count') meta.push(`<b>${fmtNum(v)}</b> / ${fmtNum(target)} ${esc(h.unit || '')}`);
  if (streak) meta.push(`🔥 ${plural(streak, 'day')}`);
  if (goal) meta.push(`◎ ${esc(goal.title)}`);
  const cls = done ? 'on' : v > 0 ? 'part' : '';
  return `<div class="row habit ${done ? 'complete' : ''}">
      <button class="check ${cls}" style="--p:${pct}%" data-act="habit-toggle" data-id="${h.id}" aria-label="${done ? 'Undo' : 'Mark complete'}">${ICON_CHECK}</button>
      <button class="row-body" data-act="open-habit" data-id="${h.id}">
        <div class="row-title">${esc(h.title)}</div>
        ${meta.length ? `<div class="row-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}
        ${h.type === 'count' && !done ? `<div class="progress thin"><span style="width:${pct}%"></span></div>` : ''}
      </button>
      ${h.type === 'count' ? `<button class="step-btn" data-act="habit-step" data-id="${h.id}">+${fmtNum(h.step || 1)}</button>` : ''}
    </div>`;
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
      active: ['Nothing to do', 'Tap + to add a task or a daily habit.'],
      done: ['No finished tasks yet', 'Tick a task to mark it done.'],
      closed: ['Nothing archived', 'Archived and cancelled tasks show up here.'],
    };
    const [a, b] = q ? ['No matches', 'Try a different search.'] : msgs[state.taskFilter];
    html = `<div class="empty"><strong>${a}</strong>${b}</div>`;
  } else if (state.taskFilter === 'active') {
    const today = todayKey();
    const weekEnd = dayKey(addDays(new Date(), 7));
    const groups = { Overdue: [], 'Due today': [], 'Next 7 days': [], Later: [], 'No due date': [] };
    for (const t of tasks) {
      if (!t.dueDate) groups['No due date'].push(t);
      else if (t.dueDate < today) groups.Overdue.push(t);
      else if (t.dueDate === today) groups['Due today'].push(t);
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
        ${meta.length ? `<div class="row-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>` : ''}
      </button>
    </div>`;
}

/* ----- Goals screen ----- */
function renderGoals() {
  const goals = state.goals.filter(g =>
    state.goalFilter === 'closed' ? (g.status === 'archived' || g.status === 'cancelled') : g.status === state.goalFilter);
  goals.sort((a, b) => (a.targetDate || '9999').localeCompare(b.targetDate || '9999') || a.createdAt.localeCompare(b.createdAt));

  let html = segmented('goalFilter', state.goalFilter, [['active', 'Active'], ['done', 'Achieved'], ['closed', 'Archived']]);
  if (!goals.length) {
    const msgs = {
      active: ['No active goals', 'Tap + to set a long-term goal. Link daily habits and tasks to it.'],
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
    const habits = habitsOfGoal(g.id).filter(h => h.status === 'active').length;
    html += `<button class="card goal-card" data-act="open-goal" data-id="${g.id}">
        <div class="top">
          <div class="title">${esc(g.title)}</div>
          ${g.category ? `<span class="chip accent">${esc(g.category)}</span>` : ''}
        </div>
        ${g.status !== 'active' && g.status !== 'done' ? `<span class="chip">${STATUS_LABEL.goal[g.status]}</span>` : ''}
        <div class="progress"><span style="width:${p.pct}%"></span></div>
        <div class="meta"><span>${p.pct}% · ${p.label}${habits ? ` · ${plural(habits, 'habit')}` : ''}</span><span>${when}</span></div>
      </button>`;
  }
  return html;
}

/* ----- Stats screen ----- */
function renderStats() {
  const s = computeStats(state.statsRange);
  const rangeLabel = state.statsRange ? `last ${state.statsRange} days` : 'all time';
  let html = segmented('statsRange', String(state.statsRange), [['30', '30 days'], ['90', '90 days'], ['365', '1 year'], ['0', 'All time']]);

  if (!state.tasks.length && !state.goals.length && !state.habits.length) {
    return html + `<div class="empty"><strong>No data yet</strong>Add tasks, habits and goals and your stats will appear here.</div>`;
  }

  const kpi = (label, value, sub = '') =>
    `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

  html += `<div class="kpis">
    ${state.habits.length ? kpi('Habit consistency', s.habitPct == null ? '–' : s.habitPct + '%', `of habit-days completed`) : ''}
    ${state.habits.length ? kpi('Perfect days', s.perfectDays, 'all habits done') : ''}
    ${kpi('Tasks completed', s.doneInRange, rangeLabel)}
    ${kpi('Completion rate', s.completionRate == null ? '–' : s.completionRate + '%', `of ${plural(s.createdInRange, 'task')} added`)}
    ${kpi('Task streak', plural(s.currentStreak, 'day'), `best: ${plural(s.bestStreak, 'day')}`)}
    ${kpi('On time', s.onTimeRate == null ? '–' : s.onTimeRate + '%', 'done by due date')}
    ${kpi('Avg. time to finish', s.avgDays == null ? '–' : (s.avgDays < 1 ? '< 1 day' : plural(Math.round(s.avgDays), 'day')), 'from added to done')}
    ${kpi('Goals achieved', s.goalsAchieved, `${s.activeGoals} still active`)}
  </div>`;

  if (s.overdueNow) {
    html += `<div class="banner"><span>${plural(s.overdueNow, 'task')} overdue right now</span>
      <button data-act="goto-tasks">View</button></div>`;
  }

  const habits = state.habits.filter(h => h.status !== 'archived');
  if (habits.length) {
    html += `<div class="card"><h3>Habits <span class="muted small" style="font-weight:500">· ${rangeLabel}</span></h3>${habits.map(h => {
      const hs = habitStats(h, state.statsRange);
      const totalTxt = h.type === 'count' ? `${fmtNum(hs.total)} ${esc(h.unit || '')} total` : `${plural(hs.doneDays, 'day')} done`;
      return `<button class="goal-progress-row plain" data-act="open-habit" data-id="${h.id}">
        <div class="top"><span>${esc(h.title)}${h.status === 'paused' ? ' <span class="chip">Paused</span>' : ''}</span><b>${hs.pct == null ? '–' : hs.pct + '%'}</b></div>
        <div class="progress"><span style="width:${hs.pct || 0}%"></span></div>
        <div class="sub muted small">🔥 ${plural(hs.current, 'day')} · best ${hs.best} · ${totalTxt}</div></button>`;
    }).join('')}</div>`;
  }

  html += `<div class="card"><h3>Tasks completed per week</h3>${barChart(s.weekly.values, s.weekly.labels)}
    <p class="muted small" style="margin:6px 0 0">Last 12 weeks · ${s.weekly.values.reduce((a, b) => a + b, 0)} tasks</p></div>`;

  html += `<div class="card"><h3>Activity</h3>${heatmap(s.daily)}
    <div class="legend">Less <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i> More</div>
    <p class="muted small" style="margin:6px 0 0">Tasks finished + habits completed each day</p></div>`;

  const best = s.weekday.values.indexOf(Math.max(...s.weekday.values));
  html += `<div class="card"><h3>Best day of the week</h3>${barChart(s.weekday.values, s.weekday.labels, best)}
    <p class="muted small" style="margin:6px 0 0">${s.doneInRange ? `You finish the most tasks on <b>${s.weekday.full[best]}</b> (${rangeLabel})` : 'No tasks completed in this period'}</p></div>`;

  const active = state.goals.filter(g => g.status === 'active');
  if (active.length) {
    html += `<div class="card"><h3>Goal progress</h3>${active.map(g => {
      const p = goalProgress(g);
      return `<button class="goal-progress-row plain" data-act="open-goal" data-id="${g.id}"><div class="top"><span>${esc(g.title)}</span><b>${p.pct}%</b></div>
        <div class="progress"><span style="width:${p.pct}%"></span></div><div class="sub muted small">${p.label}</div></button>`;
    }).join('')}</div>`;
  }

  html += `<div class="card"><h3>All-time totals</h3>
    <p class="small" style="margin:0">${plural(state.tasks.length, 'task')}, ${plural(state.habits.length, 'habit')} and ${plural(state.goals.length, 'goal')} recorded
    ${s.firstDay ? ` since ${parseDay(s.firstDay).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}` : ''}.
    ${plural(s.totalDone, 'task')} completed, ${plural(state.habitLogs.size, 'habit log')}, ${plural(state.measurements.length, 'measurement')}, ${plural(state.history.length, 'change')} in history.</p></div>`;
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

// Line chart for measurements (e.g. weight over time) with a dashed target line
function lineChart(points, target, unit) {
  const W = 320, H = 160, left = 36, right = 10, top = 14, bottom = 22;
  const vals = points.map(p => Number(p.value)).concat(hasValue(target) ? [Number(target)] : []);
  let min = Math.min(...vals), max = Math.max(...vals);
  const pad = (max - min) * 0.12 || 1;
  min -= pad; max += pad;
  const t0 = parseDay(points[0].date).getTime();
  const t1 = parseDay(points[points.length - 1].date).getTime();
  const x = t => (t1 === t0 ? left + (W - left - right) / 2 : left + (t - t0) / (t1 - t0) * (W - left - right));
  const y = v => top + (max - v) / (max - min) * (H - top - bottom);
  const pts = points.map(p => [x(parseDay(p.date).getTime()), y(Number(p.value))]);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  let svg = '';
  for (const v of [max - pad, (max + min) / 2, min + pad]) {
    svg += `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
            <text x="${left - 5}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmtNum(v)}</text>`;
  }
  if (hasValue(target)) {
    svg += `<line class="target" x1="${left}" x2="${W - right}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"/>
            <text class="target-lbl" x="${W - right}" y="${(y(target) - 4).toFixed(1)}" text-anchor="end">Target ${fmtNum(target)} ${esc(unit)}</text>`;
  }
  svg += `<path class="line" d="${path}"/>`;
  svg += pts.map(p => `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${points.length > 40 ? 2 : 3.5}"/>`).join('');
  svg += `<text x="${left}" y="${H - 5}">${fmtDay(points[0].date)}</text>`;
  if (points.length > 1) svg += `<text x="${W - right}" y="${H - 5}" text-anchor="end">${fmtDay(points[points.length - 1].date)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart">${svg}</svg>`;
}

// Calendar heatmap: one square per day, darker = more done
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
    <p class="muted small" style="text-align:center">My Tracker v2 · works offline · nothing is ever deleted</p>`;
}

// Turns one history record into a readable sentence
function describe(h, withName = true) {
  const item = itemById(h.kind, h.itemId);
  const name = withName ? ` <b>${esc(item ? item.title : '(unknown)')}</b>` : '';
  const what = h.kind;
  const What = what[0].toUpperCase() + what.slice(1);
  const unit = item ? esc(h.kind === 'goal' ? item.metricUnit || '' : item.unit || '') : '';
  switch (h.action) {
    case 'created': return `Added ${what}${name}`;
    case 'imported': return `Imported ${what}${name}`;
    case 'status': {
      const c = h.changes.status;
      return `${withName ? `${What}${name}: ` : ''}${STATUS_LABEL[h.kind][c.from] || c.from} → <b>${STATUS_LABEL[h.kind][c.to] || c.to}</b>`;
    }
    case 'log': {
      const c = h.changes.value;
      return `${withName ? `${name.trim()}: ` : ''}${fmtDay(h.changes.date)} changed ${fmtNum(c.from)} → <b>${fmtNum(c.to)}</b> ${item && item.type === 'count' ? unit : ''}`;
    }
    case 'measurement':
      return `Logged <b>${fmtNum(h.changes.value.to)} ${unit}</b>${withName ? ` for${name}` : ''} (${fmtDay(h.changes.date)})`;
    case 'measurement-edit': {
      const parts = Object.entries(h.changes).filter(([k]) => k !== 'measurementId')
        .map(([k, c]) => `${k} ${k === 'date' ? fmtDay(c.from) : fmtNum(c.from) === '–' ? '–' : esc(c.from)} → ${k === 'date' ? fmtDay(c.to) : esc(c.to)}`);
      return `Corrected a log${withName ? ` of${name}` : ''}: ${parts.join(', ')}`;
    }
    default: {
      const fields = Object.keys(h.changes).map(k => FIELD_LABEL[k] || k).join(', ');
      return `Edited ${fields}${withName ? ` of${name}` : ''}`;
    }
  }
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

/* ---------- 7. Pop-up forms ---------- */
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
  const b = (status, label, cls = '') =>
    `<button type="button" class="btn ${cls}" data-act="set-status" data-kind="${kind}" data-id="${item.id}" data-status="${status}">${label}</button>`;
  if (kind === 'habit') {
    if (item.status === 'active') return b('paused', 'Pause') + b('archived', 'Archive');
    if (item.status === 'paused') return b('active', 'Resume', 'primary') + b('archived', 'Archive');
    return b('active', 'Restore');
  }
  const doneLabel = kind === 'goal' ? 'Mark achieved' : 'Mark done';
  if (item.status === 'active') return b('done', doneLabel, 'primary') + b('archived', 'Archive') + b('cancelled', 'Cancel', 'warn');
  if (item.status === 'done') return b('active', 'Reopen') + b('archived', 'Archive');
  return b('active', 'Restore');
}

function goalOptions(selectedId) {
  const goals = state.goals.filter(g => g.status === 'active' || g.id === selectedId);
  return `<option value="">No goal</option>` +
    goals.map(g => `<option value="${g.id}" ${g.id === selectedId ? 'selected' : ''}>${esc(g.title)}</option>`).join('');
}

// "+" on the Today screen: choose what to add
function openAddChooser() {
  openSheet(`
    ${sheetHead('Add')}
    <div class="choice-list">
      <button class="choice" data-act="new-habit"><b>Daily habit</b><span>Repeats every day. e.g. Brisk walking 30 min, 100 squats, eat protein</span></button>
      <button class="choice" data-act="new-task"><b>Task</b><span>A one-time to-do, optionally with a due date</span></button>
    </div>`);
}

/* ----- Task form ----- */
function openTaskForm(task = null, presetGoalId = '') {
  const t = task || { title: '', notes: '', goalId: presetGoalId, dueDate: '', priority: 'normal' };
  openSheet(`
    ${sheetHead(task ? 'Edit task' : 'New task')}
    ${task ? `<div class="status-line"><span class="chip ${task.status === 'done' ? 'accent' : ''}">${STATUS_LABEL.task[task.status]}</span>
      <span class="muted small">Added ${fmtDateTime(task.createdAt)}</span></div>` : ''}
    <form id="task-form" autocomplete="off">
      <label class="field"><span>Task</span>
        <input name="title" required maxlength="200" value="${esc(t.title)}" placeholder="What needs doing?"></label>
      <label class="field"><span>Notes</span>
        <textarea name="notes" maxlength="5000" placeholder="Optional details">${esc(t.notes)}</textarea></label>
      <label class="field"><span>Goal</span><select name="goalId">${goalOptions(t.goalId)}</select></label>
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

/* ----- Habit form ----- */
function openHabitForm(habit = null, presetGoalId = '') {
  const h = habit || { title: '', goalId: presetGoalId, type: 'check', target: '', unit: '', step: '' };
  openSheet(`
    ${sheetHead(habit ? 'Edit habit' : 'New daily habit')}
    <form id="habit-form" autocomplete="off">
      <label class="field"><span>Habit</span>
        <input name="title" required maxlength="120" value="${esc(h.title)}" placeholder="e.g. Brisk walking"></label>
      <label class="field"><span>Goal</span><select name="goalId">${goalOptions(h.goalId)}</select></label>
      <div class="field"><span>How do you track it?</span>
        <div class="segmented" style="margin:0">
          <label class="seg-radio"><input type="radio" name="type" value="check" ${h.type !== 'count' ? 'checked' : ''}><span>Checkbox</span></label>
          <label class="seg-radio"><input type="radio" name="type" value="count" ${h.type === 'count' ? 'checked' : ''}><span>Count</span></label>
        </div>
      </div>
      <div id="count-fields" ${h.type === 'count' ? '' : 'hidden'}>
        <div class="two-col">
          <label class="field"><span>Daily target</span><input type="number" name="target" min="0.01" step="any" inputmode="decimal" value="${esc(h.target)}" placeholder="100"></label>
          <label class="field"><span>Unit</span><input name="unit" maxlength="20" value="${esc(h.unit)}" placeholder="reps, min, g"></label>
        </div>
        <label class="field"><span>Quick-add button amount</span><input type="number" name="step" min="0.01" step="any" inputmode="decimal" value="${esc(h.step)}" placeholder="e.g. 10 (a set of squats)"></label>
      </div>
      <button class="btn primary block" type="submit">${habit ? 'Save changes' : 'Add habit'}</button>
    </form>
  `);
  if (!habit) setTimeout(() => $('#habit-form [name=title]').focus(), 50);

  const form = $('#habit-form');
  form.addEventListener('change', e => {
    if (e.target.name === 'type') $('#count-fields').hidden = e.target.value !== 'count';
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    const type = f.get('type');
    const data = { title: f.get('title').trim(), goalId: f.get('goalId') || '', type, target: '', unit: '', step: '' };
    if (!data.title) return;
    if (type === 'count') {
      const target = num(f.get('target'));
      if (!(target > 0)) { toast('Enter a daily target, e.g. 100'); return; }
      data.target = target;
      data.unit = f.get('unit').trim();
      const step = num(f.get('step'));
      data.step = step > 0 ? step : (target >= 50 ? 10 : target >= 10 ? 5 : 1);
    }
    if (habit) { const changed = await updateItem('habit', habit, data); toast(changed ? 'Habit saved' : 'No changes'); openHabitDetail(habit); }
    else { await createItem('habit', data); toast('Habit added'); closeSheet(); }
    render();
  });
}

/* ----- Habit details: stats, calendar, log any day ----- */
function openHabitDetail(habit, selectedDay = todayKey()) {
  const s30 = habitStats(habit, 30);
  const all = habitStats(habit, 0);
  const goal = habit.goalId ? goalById(habit.goalId) : null;
  const tracked = habitTrackedOn(habit);
  const today = todayKey();
  const created = dayKey(habit.createdAt);

  // Last 5 weeks calendar, Monday first
  const now = new Date();
  const start = addDays(now, -((now.getDay() + 6) % 7) - 28);
  let cal = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span class="cal-h">${d}</span>`).join('');
  for (let i = 0; i < 35; i++) {
    const d = addDays(start, i);
    const k = dayKey(d);
    const v = habitValue(habit, k);
    let cls = 'future';
    if (k <= today) {
      if (v >= habitTarget(habit)) cls = 'done';
      else if (v > 0) cls = 'part';
      else if (k < created || !tracked(k)) cls = 'off';
      else cls = k === today ? 'todo' : 'miss';
    }
    if (k === selectedDay) cls += ' sel';
    cal += k <= today
      ? `<button class="cal-d ${cls}" data-act="pick-day" data-id="${habit.id}" data-day="${k}">${d.getDate()}</button>`
      : `<span class="cal-d ${cls}">${d.getDate()}</span>`;
  }

  const selVal = habitValue(habit, selectedDay);
  const isCount = habit.type === 'count';
  openSheet(`
    ${sheetHead(esc(habit.title))}
    <div class="status-line">
      <span class="chip ${habit.status === 'active' ? 'accent' : ''}">${STATUS_LABEL.habit[habit.status]}</span>
      <span class="muted small">${habitDescr(habit)}${goal ? ` · ◎ ${esc(goal.title)}` : ''}</span>
    </div>
    <div class="kpis mini">
      <div class="kpi"><div class="label">Current streak</div><div class="value">🔥 ${s30.current}</div><div class="sub">best: ${plural(all.best, 'day')}</div></div>
      <div class="kpi"><div class="label">Last 30 days</div><div class="value">${s30.pct == null ? '–' : s30.pct + '%'}</div><div class="sub">${s30.doneDays} of ${plural(s30.trackedDays, 'day')}</div></div>
      ${isCount ? `<div class="kpi"><div class="label">All-time total</div><div class="value">${fmtNum(all.total)}</div><div class="sub">${esc(habit.unit || '')}</div></div>
      <div class="kpi"><div class="label">Daily average</div><div class="value">${fmtNum(Math.round(s30.total / Math.min(30, daysBetween(created, today) + 1) * 10) / 10)}</div><div class="sub">last 30 days</div></div>` : ''}
    </div>
    <div class="cal">${cal}</div>
    <div class="legend" style="justify-content:flex-start;margin:8px 0 14px">
      <i class="cal-key done"></i> Done <i class="cal-key part"></i> Partial <i class="cal-key miss"></i> Missed <i class="cal-key off"></i> Not tracked</div>

    <form id="log-form" class="card log-card" autocomplete="off">
      <h3>Log for ${fmtDay(selectedDay)}</h3>
      <input type="hidden" name="day" value="${selectedDay}">
      ${isCount ? `
        <div class="stepper">
          <button type="button" class="btn" data-act="log-adj" data-delta="-${habit.step || 1}">−${fmtNum(habit.step || 1)}</button>
          <input type="number" name="value" min="0" step="any" inputmode="decimal" value="${selVal}">
          <button type="button" class="btn" data-act="log-adj" data-delta="${habit.step || 1}">+${fmtNum(habit.step || 1)}</button>
        </div>
        <p class="muted small" style="margin:6px 0 10px;text-align:center">Target ${fmtNum(habit.target)} ${esc(habit.unit || '')}</p>`
      : `<div class="segmented" style="margin:6px 0 10px">
          <label class="seg-radio"><input type="radio" name="value" value="1" ${selVal >= 1 ? 'checked' : ''}><span>Done</span></label>
          <label class="seg-radio"><input type="radio" name="value" value="0" ${selVal >= 1 ? '' : 'checked'}><span>Not done</span></label>
        </div>`}
      <button class="btn primary block" type="submit">Save log</button>
    </form>

    <div class="btn-row">
      <button type="button" class="btn" data-act="edit-habit" data-id="${habit.id}">Edit habit</button>
      ${statusButtons('habit', habit)}
    </div>
    <p class="muted small" style="margin:10px 0 0">Pausing stops the habit showing daily without breaking your streak. Archiving retires it. Its logs are always kept.</p>
    ${itemHistory('habit', habit.id)}
  `);

  $('#log-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const changed = await setHabitValue(habit, f.get('day'), f.get('value'));
    toast(changed ? 'Log saved' : 'No change');
    render();
    openHabitDetail(habit, f.get('day'));
  });
}

function openAllHabits() {
  const groups = ['active', 'paused', 'archived'].map(st => [st, state.habits.filter(h => h.status === st)]);
  openSheet(`
    ${sheetHead('All habits')}
    ${groups.filter(([, l]) => l.length).map(([st, list]) => `
      <div class="section-title"><span>${STATUS_LABEL.habit[st]}</span><span>${list.length}</span></div>
      <div class="list">${list.map(h => {
        const s = habitStats(h, 30);
        return `<div class="row"><button class="row-body" data-act="open-habit" data-id="${h.id}">
          <div class="row-title">${esc(h.title)}</div>
          <div class="row-meta">${habitDescr(h)} · 30 days: ${s.pct == null ? '–' : s.pct + '%'}</div></button></div>`;
      }).join('')}</div>`).join('')}
    <button class="btn primary block" style="margin-top:14px" data-act="new-habit">+ New habit</button>`);
}

/* ----- Goal form ----- */
function openGoalForm(goal = null) {
  const g = goal || { title: '', notes: '', category: '', targetDate: '', metricUnit: '', startValue: '', targetValue: '' };
  const categories = [...new Set(state.goals.map(x => x.category).filter(Boolean))];
  openSheet(`
    ${sheetHead(goal ? 'Edit goal' : 'New goal')}
    <form id="goal-form" autocomplete="off">
      <label class="field"><span>Goal</span>
        <input name="title" required maxlength="200" value="${esc(g.title)}" placeholder="e.g. Lose weight"></label>
      <label class="field"><span>Why it matters</span>
        <textarea name="notes" maxlength="5000" placeholder="Optional: your reason, or how you'll know it's done">${esc(g.notes)}</textarea></label>
      <div class="two-col">
        <label class="field"><span>Category</span>
          <input name="category" list="cat-list" maxlength="40" value="${esc(g.category)}" placeholder="e.g. Lifestyle">
          <datalist id="cat-list">${categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field"><span>Target date</span><input type="date" name="targetDate" value="${esc(g.targetDate)}"></label>
      </div>
      <fieldset class="metric-box">
        <legend>Measure progress (optional)</legend>
        <p class="muted small" style="margin:0 0 10px">For goals with a number, like body weight. You'll log the value over time and see a chart.</p>
        <div class="three-col">
          <label class="field"><span>Start</span><input type="number" name="startValue" step="any" inputmode="decimal" value="${esc(g.startValue)}" placeholder="85"></label>
          <label class="field"><span>Target</span><input type="number" name="targetValue" step="any" inputmode="decimal" value="${esc(g.targetValue)}" placeholder="75"></label>
          <label class="field"><span>Unit</span><input name="metricUnit" maxlength="12" value="${esc(g.metricUnit)}" placeholder="kg"></label>
        </div>
      </fieldset>
      <button class="btn primary block" type="submit">${goal ? 'Save changes' : 'Add goal'}</button>
    </form>
  `);
  if (!goal) setTimeout(() => $('#goal-form [name=title]').focus(), 50);

  $('#goal-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const numOrBlank = v => (v === '' || v == null ? '' : num(v));
    const data = {
      title: f.get('title').trim(),
      notes: f.get('notes').trim(),
      category: f.get('category').trim(),
      targetDate: f.get('targetDate') || '',
      startValue: numOrBlank(f.get('startValue')),
      targetValue: numOrBlank(f.get('targetValue')),
      metricUnit: f.get('metricUnit').trim(),
    };
    if (!data.title) return;
    if ((data.startValue === '') !== (data.targetValue === '')) { toast('Enter both a start and a target value'); return; }
    if (goal) { const changed = await updateItem('goal', goal, data); toast(changed ? 'Goal saved' : 'No changes'); openGoalDetail(goal); }
    else { const created = await createItem('goal', data); toast('Goal added'); openGoalDetail(created); }
    render();
  });
}

/* ----- Weigh-in / measurement form ----- */
function openMeasureForm(goal, m = null) {
  const list = measurementsOf(goal.id);
  const last = list.length ? list[list.length - 1].value : goal.startValue;
  openSheet(`
    ${sheetHead(m ? 'Edit log' : `Log ${esc(goal.metricUnit || 'value')}`)}
    <p class="muted small" style="margin:0 0 12px">${esc(goal.title)}</p>
    <form id="measure-form" autocomplete="off">
      <div class="two-col">
        <label class="field"><span>Value (${esc(goal.metricUnit || 'number')})</span>
          <input type="number" name="value" required step="any" inputmode="decimal" value="${m ? esc(m.value) : ''}" placeholder="${esc(fmtNum(last))}"></label>
        <label class="field"><span>Date</span><input type="date" name="date" required max="${todayKey()}" value="${m ? m.date : todayKey()}"></label>
      </div>
      <label class="field"><span>Note</span><input name="note" maxlength="200" value="${m ? esc(m.note) : ''}" placeholder="Optional, e.g. morning, after workout"></label>
      <button class="btn primary block" type="submit">${m ? 'Save changes' : 'Save'}</button>
    </form>
    ${m ? '<p class="muted small">Corrections are kept in the goal\'s history.</p>' : ''}
  `);
  if (!m) setTimeout(() => $('#measure-form [name=value]').focus(), 50);
  $('#measure-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const value = num(f.get('value'));
    if (!hasValue(f.get('value'))) return;
    const changed = await saveMeasurement(goal, m, { date: f.get('date'), value, note: f.get('note').trim() });
    toast(changed ? 'Logged' : 'No changes');
    render();
    openGoalDetail(goal);
  });
}

/* ----- Goal details ----- */
function openGoalDetail(goal) {
  const p = goalProgress(goal);
  const tasks = tasksOfGoal(goal.id);
  const habits = habitsOfGoal(goal.id).filter(h => h.status !== 'archived');
  const order = { active: 0, done: 1, archived: 2, cancelled: 3 };
  tasks.sort((a, b) => order[a.status] - order[b.status] || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const unit = esc(goal.metricUnit || '');

  let metricHtml = '';
  if (goalHasMetric(goal)) {
    const list = measurementsOf(goal.id);
    const start = Number(goal.startValue), target = Number(goal.targetValue);
    const change = num(p.latest - start);
    const left = num(Math.abs(target - p.latest));
    metricHtml = `
      <div class="card">
        <div class="metric-head">
          <div><div class="label">Latest</div><div class="big">${fmtNum(p.latest)} <small>${unit}</small></div></div>
          <div><div class="label">Change</div><div class="big">${change > 0 ? '+' : ''}${fmtNum(change)}</div></div>
          <div><div class="label">To go</div><div class="big">${p.pct >= 100 ? '🎉' : fmtNum(left)}</div></div>
        </div>
        ${list.length ? lineChart(list, target, goal.metricUnit || '') : '<p class="muted small">No logs yet. Add your first one below.</p>'}
        <button type="button" class="btn primary block" style="margin-top:10px" data-act="add-measure" data-id="${goal.id}">+ Log ${unit || 'value'}</button>
        ${list.length ? `<details class="hist"><summary>All logs (${list.length})</summary><div class="list" style="margin-top:6px">
          ${[...list].reverse().map(m => `<div class="row"><button class="row-body" data-act="edit-measure" data-id="${m.id}">
            <div class="row-title">${fmtNum(m.value)} ${unit}</div><div class="row-meta">${fmtDay(m.date)}${m.note ? ' · ' + esc(m.note) : ''}</div></button></div>`).join('')}
        </div></details>` : ''}
      </div>`;
  }

  const today = todayKey();
  openSheet(`
    ${sheetHead(esc(goal.title))}
    <div class="status-line">
      <span class="chip ${goal.status === 'done' ? 'accent' : ''}">${STATUS_LABEL.goal[goal.status]}</span>
      ${goal.category ? `<span class="chip accent">${esc(goal.category)}</span>` : ''}
      ${goal.targetDate ? `<span class="muted small">Target ${fmtDay(goal.targetDate)}</span>` : ''}
    </div>
    ${goal.notes ? `<p style="margin:0 0 10px; white-space:pre-wrap">${esc(goal.notes)}</p>` : ''}
    <div class="progress"><span style="width:${p.pct}%"></span></div>
    <p class="muted small" style="margin:0 0 12px">${p.pct}% · ${p.label}</p>
    ${metricHtml}

    <div class="section-title"><span>Daily habits</span><span>${habits.length}</span></div>
    ${habits.length ? `<div class="list">${habits.map(h => {
      const s = habitStats(h, 30);
      return `<div class="row"><button class="row-body" data-act="open-habit" data-id="${h.id}">
        <div class="row-title">${esc(h.title)} ${habitDone(h, today) ? '✅' : ''}</div>
        <div class="row-meta">${habitDescr(h)} · 30 days: ${s.pct == null ? '–' : s.pct + '%'} · 🔥 ${s.current}${h.status === 'paused' ? ' · Paused' : ''}</div></button></div>`;
    }).join('')}</div>` : '<p class="muted small">No habits linked yet.</p>'}

    <div class="section-title"><span>Tasks</span><span>${tasks.length}</span></div>
    ${tasks.length ? `<div class="list">${tasks.map(taskRow).join('')}</div>` : '<p class="muted small">No tasks linked yet.</p>'}

    <div class="btn-row">
      ${goal.status === 'active' ? `<button type="button" class="btn" data-act="add-habit-to-goal" data-id="${goal.id}">+ Habit</button>
        <button type="button" class="btn" data-act="add-task-to-goal" data-id="${goal.id}">+ Task</button>` : ''}
      <button type="button" class="btn" data-act="edit-goal" data-id="${goal.id}">Edit goal</button>
    </div>
    <div class="btn-row">${statusButtons('goal', goal)}</div>
    ${itemHistory('goal', goal.id)}
  `);
}

/* ---------- 8. Analytics ---------- */
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

  // Tasks completed per day (streaks) + habits completed per day (activity heatmap)
  const taskDaily = {};
  for (const t of done) { const k = dayKey(t.completedAt); taskDaily[k] = (taskDaily[k] || 0) + 1; }
  const daily = { ...taskDaily };
  for (const log of state.habitLogs.values()) {
    const h = habitById(log.habitId);
    if (h && log.value >= habitTarget(h)) daily[log.date] = (daily[log.date] || 0) + 1;
  }

  // Task streak = days in a row with at least one task done
  let currentStreak = 0;
  let d = new Date();
  if (!taskDaily[today]) d = addDays(d, -1);     // today isn't over yet, so don't break the streak
  while (taskDaily[dayKey(d)]) { currentStreak++; d = addDays(d, -1); }
  let bestStreak = 0, run = 0, prev = null;
  for (const k of Object.keys(taskDaily).sort()) {
    run = prev && daysBetween(prev, k) === 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    prev = k;
  }

  // Habits: overall consistency and "perfect days" (every tracked habit done)
  let habitTracked = 0, habitDoneDays = 0, perfectDays = 0;
  const trackers = state.habits.map(h => [h, habitTrackedOn(h)]);
  if (trackers.length) {
    const first = state.habits.map(h => dayKey(h.createdAt)).sort()[0];
    for (let day = parseDay(start > first ? start : first); dayKey(day) <= today; day = addDays(day, 1)) {
      const k = dayKey(day);
      let n = 0, ok = 0;
      for (const [h, tracked] of trackers) {
        if (!tracked(k)) continue;
        const isDone = habitDone(h, k);
        if (k === today && !isDone) continue;
        n++; if (isDone) ok++;
      }
      habitTracked += n; habitDoneDays += ok;
      if (n && ok === n) perfectDays++;
    }
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

  const allDates = [...state.tasks, ...state.goals, ...state.habits].map(x => x.createdAt).sort();

  return {
    doneInRange: doneInRange.length,
    totalDone: done.length,
    createdInRange: created.length,
    completionRate: created.length ? Math.round(createdDone / created.length * 100) : null,
    onTimeRate: withDue.length ? Math.round(onTime / withDue.length * 100) : null,
    avgDays: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    currentStreak, bestStreak, daily, weekly, weekday,
    habitPct: habitTracked ? Math.round(habitDoneDays / habitTracked * 100) : null,
    perfectDays,
    goalsAchieved: state.goals.filter(g => g.status === 'done' && inRange(g.completedAt)).length,
    activeGoals: state.goals.filter(g => g.status === 'active').length,
    overdueNow: state.tasks.filter(t => t.status === 'active' && t.dueDate && t.dueDate < today).length,
    firstDay: allDates.length ? dayKey(allDates[0]) : null,
  };
}

/* ---------- 9. Backup ---------- */
function backupFile() {
  const data = {
    app: 'my-tracker', format: 2, exportedAt: nowISO(),
    goals: state.goals, tasks: state.tasks, habits: state.habits,
    habitLogs: [...state.habitLogs.values()], measurements: state.measurements,
    history: state.history,
  };
  const name = `my-tracker-backup-${todayKey()}.json`;
  return { name, blob: new Blob([JSON.stringify(data)], { type: 'application/json' }) };
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

// Import MERGES: new records are added, and a record is only replaced if the backup's copy is newer.
// Works with backups from both v1 and v2 of the app.
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not a valid backup'); return; }
  if (!data || data.app !== 'my-tracker' || !Array.isArray(data.tasks) || !Array.isArray(data.goals)) {
    toast('That file is not a My Tracker backup'); return;
  }
  const entries = [];
  let added = 0, updated = 0;
  const mergeList = (store, list, valid) => {
    for (const incoming of (Array.isArray(list) ? list : [])) {
      if (!incoming || !incoming.id || !valid(incoming)) continue;
      const existing = state[store].find(x => x.id === incoming.id);
      if (!existing) { state[store].push(incoming); entries.push([store, incoming]); added++; }
      else if ((incoming.updatedAt || '') > (existing.updatedAt || '')) {
        Object.assign(existing, incoming); entries.push([store, existing]); updated++;
      }
    }
  };
  mergeList('goals', data.goals, x => x.title);
  mergeList('tasks', data.tasks, x => x.title);
  mergeList('habits', data.habits, x => x.title);
  mergeList('measurements', data.measurements, x => x.goalId && x.date);
  for (const log of (Array.isArray(data.habitLogs) ? data.habitLogs : [])) {
    if (!log || !log.id || !log.habitId || !log.date) continue;
    const existing = state.habitLogs.get(log.id);
    if (!existing || (log.updatedAt || '') > (existing.updatedAt || '')) {
      state.habitLogs.set(log.id, log); entries.push(['habitLogs', log]);
      existing ? updated++ : added++;
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

/* ---------- 10. Start-up & tap handling ---------- */
// Taps are handled one at a time, in order. Without this, tapping "+10" twice
// very fast could read the old value twice and only add 10 once.
let queue = Promise.resolve();

// One click listener for the whole app; buttons say what they do with data-act="..."
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act], .bottomnav button');
  if (!el) return;
  queue = queue.then(() => handleTap(el)).catch(err => { console.error(err); toast('Something went wrong'); });
});

async function handleTap(el) {

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
    case 'habit-toggle': {
      const h = habitById(id);
      const day = todayKey();
      const doneNow = habitDone(h, day);
      await setHabitValue(h, day, doneNow ? 0 : habitTarget(h));
      if (!doneNow) toast(`🔥 ${h.title}: ${plural(habitStats(h, 30).current, 'day')} streak`);
      render();
      break;
    }
    case 'habit-step': {
      const h = habitById(id);
      const day = todayKey();
      const wasDone = habitDone(h, day);
      await setHabitValue(h, day, habitValue(h, day) + Number(h.step || 1));
      if (!wasDone && habitDone(h, day)) toast(`🔥 ${h.title} done for today!`);
      render();
      break;
    }
    case 'log-adj': {
      const input = $('#log-form [name=value]');
      input.value = Math.max(0, num((Number(input.value) || 0) + Number(el.dataset.delta)));
      break;
    }
    case 'pick-day': openHabitDetail(habitById(id), el.dataset.day); break;
    case 'open-habit': openHabitDetail(habitById(id)); break;
    case 'edit-habit': openHabitForm(habitById(id)); break;
    case 'all-habits': openAllHabits(); break;
    case 'new-habit': openHabitForm(); break;
    case 'new-task': openTaskForm(); break;
    case 'edit-task': openTaskForm(taskById(id)); break;
    case 'open-goal': openGoalDetail(goalById(id)); break;
    case 'edit-goal': openGoalForm(goalById(id)); break;
    case 'add-task-to-goal': openTaskForm(null, id); break;
    case 'add-habit-to-goal': openHabitForm(null, id); break;
    case 'add-measure': openMeasureForm(goalById(id)); break;
    case 'edit-measure': {
      const m = state.measurements.find(x => x.id === id);
      openMeasureForm(goalById(m.goalId), m);
      break;
    }
    case 'set-status': {
      const kind = el.dataset.kind;
      const item = itemById(kind, id);
      await setStatus(kind, item, el.dataset.status);
      toast(`${kind[0].toUpperCase() + kind.slice(1)}: ${STATUS_LABEL[kind][item.status]}`);
      render();
      if (kind === 'goal') openGoalDetail(item);
      else if (kind === 'habit') openHabitDetail(item);
      else openTaskForm(item);
      break;
    }
    case 'close': closeSheet(); break;
    case 'export': exportBackup(); break;
    case 'share': shareBackup(); break;
    case 'import': $('#import-file').click(); break;
    case 'goto-tasks': state.view = 'tasks'; state.taskFilter = 'active'; render(); break;
  }
}

$('#fab').addEventListener('click', () => (state.view === 'goals' ? openGoalForm() : openAddChooser()));

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

  // A new day starts fresh habits: redraw when you come back to the app on a new day
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
