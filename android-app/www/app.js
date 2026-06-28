/* ══════════════════════════════════════════════════════════════════
   ZenCalendar Mobile — app.js
   Fully offline, localStorage-based calendar for Android (Capacitor)
   No external dependencies. All logic self-contained.
   ══════════════════════════════════════════════════════════════════ */

// ── Capacitor Plugin References ──────────────────────────────────
const hasCapacitor = typeof window.Capacitor !== 'undefined';
const Plugins = hasCapacitor ? window.Capacitor.Plugins : {};
const Filesystem = Plugins.Filesystem;
const LocalNotifications = Plugins.LocalNotifications;

// ── Constants ────────────────────────────────────────────────────
const COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#06b6d4','#7c3aed','#ec4899','#64748b'
];
const MONTHS    = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
const DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── Helpers ──────────────────────────────────────────────────────
const pad      = n => String(n).padStart(2,'0');
const isSameDay = (a,b) =>
  a.getFullYear()===b.getFullYear() &&
  a.getMonth()===b.getMonth() &&
  a.getDate()===b.getDate();

function toLocalDT(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtTime(d) {
  let h=d.getHours(), m=pad(d.getMinutes()), ap=h>=12?'PM':'AM';
  h = h%12 || 12;
  return `${h}:${m} ${ap}`;
}
function uid() { return Math.random().toString(36).slice(2,11)+Date.now().toString(36); }
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

/** Consistent 32-bit positive integer hash of alphanumeric string for local notifications */
function stringToHash32(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash & 0x7FFFFFFF);
}

/** Return 42 Date objects covering the month grid (6×7) */
function getMonthDays(date) {
  const y=date.getFullYear(), m=date.getMonth();
  const startDay = new Date(y,m,1).getDay();
  const days=[];
  for(let i=0;i<42;i++) days.push(new Date(y,m,1-startDay+i));
  return days;
}

// ── LocalStorage Persistence ──────────────────────────────────────
const STORAGE_KEY = 'zencalendar_v2';
const DEFAULT_SETTINGS = {
  activeTab: 'calendar',
  theme: 'dark',
  remindersEnabled: true,
  reminderOffset: '15'
};
const DEFAULT_DATA = { events:[], tasks:[], settings: { ...DEFAULT_SETTINGS } };

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : { ...DEFAULT_DATA };
    parsed.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
    return parsed;
  } catch { return { ...DEFAULT_DATA }; }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    events:   state.events,
    tasks:    state.tasks,
    settings: state.settings
  }));
}

// ── Application State ─────────────────────────────────────────────
const state = {
  events:       [],
  tasks:        [],
  currentDate:  new Date(),
  activeTab:    'calendar',
  selectedDay:  null,
  selectedEvent: null,
  settings:     { ...DEFAULT_SETTINGS }
};

// ── DOM Shorthand ─────────────────────────────────────────────────
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ══════════════════════════════════════════════════════════════════
//  INITIALISATION
// ══════════════════════════════════════════════════════════════════
async function init() {
  const data = loadData();
  state.events = (data.events  || []);
  state.tasks  = (data.tasks   || []);
  state.settings = data.settings;
  state.activeTab = state.settings.activeTab;

  applyActiveTab();
  applyTheme();
  initSettingsUI();
  bindEvents();
  
  // Listen to system theme preference changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'system') applyTheme();
  });

  // Query permissions on startup
  updatePermissionStatus();

  render();
}

// ══════════════════════════════════════════════════════════════════
//  EVENT BINDINGS
// ══════════════════════════════════════════════════════════════════
function bindEvents() {
  // Header navigation
  $('#btn-prev').onclick  = () => nav(-1);
  $('#btn-next').onclick  = () => nav(1);
  $('#btn-today').onclick = () => { state.currentDate = new Date(); render(); };
  $('#btn-settings').onclick = openSettings;

  // Bottom navigation tabs
  $$('.nav-tab').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  // FAB — opens type picker
  $('#fab-add').onclick = openTypePicker;

  // ── Day panel ──────────────────────────────────────────────────
  $('#day-panel-backdrop').onclick = closeDayPanel;
  $('#day-panel-close').onclick    = closeDayPanel;
  $('#day-panel-add').onclick = () => {
    closeDayPanel();
    openEventModal(null, state.selectedDay);
  };

  // ── Type picker ────────────────────────────────────────────────
  $('#type-picker-backdrop').onclick = closeTypePicker;
  $('#btn-pick-close').onclick        = closeTypePicker;
  $('#pick-event-btn').onclick = () => { closeTypePicker(); openEventModal(null); };
  $('#pick-task-btn').onclick  = () => { closeTypePicker(); openTaskModal();      };


  // ── Event modal ────────────────────────────────────────────────
  $('#event-modal-backdrop').onclick = closeEventModal;
  $('#btn-event-close').onclick      = closeEventModal;
  $('#btn-event-discard').onclick    = closeEventModal;
  $('#event-form').onsubmit          = handleSaveEvent;
  $('#btn-event-delete').onclick     = handleDeleteEvent;

  // ── Task modal ─────────────────────────────────────────────────
  $('#task-modal-backdrop').onclick = closeTaskModal;
  $('#btn-task-close').onclick      = closeTaskModal;
  $('#btn-task-discard').onclick    = closeTaskModal;
  $('#task-form').onsubmit          = handleSaveTask;

  // ── Event detail sheet ─────────────────────────────────────────
  $('#detail-backdrop').onclick    = closeDetailSheet;
  $('#detail-close-btn').onclick   = closeDetailSheet;
  $('#detail-edit-btn').onclick    = () => {
    closeDetailSheet();
    openEventModal(state.selectedEvent);
  };
  $('#detail-delete-btn').onclick  = () => {
    if (!state.selectedEvent) return;
    state.events = state.events.filter(e => e.id !== state.selectedEvent.id);
    state.selectedEvent = null;
    closeDetailSheet();
    render();
  };

  // ── Quick add task (inline input) ──────────────────────────────
  const qi = $('#quick-add-input');
  const doQuickAdd = () => {
    const val = qi.value.trim();
    if (!val) return;
    state.tasks.push({ id:uid(), title:val, completed:false, dueDate:null });
    qi.value = '';
    render();
  };
  qi.addEventListener('keydown', e => { if (e.key==='Enter') doQuickAdd(); });
  $('#quick-add-btn').onclick = doQuickAdd;
}

// ══════════════════════════════════════════════════════════════════
//  NAVIGATION & TAB SWITCHING
// ══════════════════════════════════════════════════════════════════
function nav(dir) {
  const d = state.currentDate;
  state.currentDate = new Date(d.getFullYear(), d.getMonth()+dir, 1);
  render();
}

function switchTab(tab) {
  state.activeTab = tab;
  applyActiveTab();
  render();
}

function applyActiveTab() {
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id===`tab-${state.activeTab}`));
  $$('.nav-tab').forEach(b  => b.classList.toggle('active', b.dataset.tab===state.activeTab));
}

// ══════════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════════
function render() {
  renderHeader();
  renderMonthGrid();
  renderTasks();
  renderFocus();
  saveData();
}

/** Header: month + year label */
function renderHeader() {
  $('#date-label').textContent =
    `${MONTHS[state.currentDate.getMonth()]} ${state.currentDate.getFullYear()}`;
}

/** Month calendar grid with event dots */
function renderMonthGrid() {
  const grid  = $('#month-grid');
  grid.innerHTML = '';
  const days  = getMonthDays(state.currentDate);
  const today = new Date();
  const m     = state.currentDate.getMonth();

  days.forEach(day => {
    const cell = document.createElement('div');
    cell.className = 'month-cell';
    if (day.getMonth() !== m) cell.classList.add('other-month');

    // ── Day number ──
    const numWrap = document.createElement('div');
    numWrap.className = 'cell-num-wrap';
    const num = document.createElement('span');
    num.className = 'cell-num';
    num.textContent = day.getDate();
    if (isSameDay(day, today)) num.classList.add('today');
    else if (state.selectedDay && isSameDay(day, state.selectedDay)) num.classList.add('selected');
    numWrap.appendChild(num);
    cell.appendChild(numWrap);

    // ── Event dots ──
    const evs  = state.events.filter(e => isSameDay(new Date(e.start), day));
    const tsks = state.tasks.filter(t => t.dueDate && !t.completed && isSameDay(new Date(t.dueDate), day));
    const all  = [...evs, ...tsks.map(t => ({ color:'#64748b' }))];

    if (all.length > 0) {
      const dots = document.createElement('div');
      dots.className = 'event-dots';
      all.slice(0,3).forEach(item => {
        const dot = document.createElement('span');
        dot.className = 'event-dot';
        dot.style.background = item.color || COLORS[5];
        dots.appendChild(dot);
      });
      if (all.length > 3) {
        const extra = document.createElement('span');
        extra.className = 'event-dot more';
        dots.appendChild(extra);
      }
      cell.appendChild(dots);
    }

    cell.onclick = () => {
      state.selectedDay = day;
      renderMonthGrid();   // update selected highlight
      openDayPanel(day);
    };

    grid.appendChild(cell);
  });
}

/** Task list with completion toggle and delete */
function renderTasks() {
  const list = $('#task-list');
  list.innerHTML = '';
  const pending = state.tasks.filter(t => !t.completed).length;
  $('#task-count-badge').textContent = pending;

  if (state.tasks.length === 0) {
    list.innerHTML = `<div class="empty-tasks">
      <div class="empty-icon">✓</div>
      <p>No tasks yet.<br>Tap <strong>+</strong> to add one!</p>
    </div>`;
    return;
  }

  // Sort: incomplete → by due date; completed last
  const sorted = [...state.tasks].sort((a,b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.dueDate && b.dueDate) return new Date(a.dueDate)-new Date(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });

  sorted.forEach(task => {
    const item = document.createElement('div');
    item.className = 'task-item' + (task.completed ? ' completed' : '');

    // Checkbox button
    const cb = document.createElement('button');
    cb.className = 'task-check' + (task.completed ? ' checked' : '');
    cb.setAttribute('aria-label', task.completed ? 'Mark incomplete' : 'Mark complete');
    cb.innerHTML = task.completed
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
      : '';
    cb.onclick = () => { task.completed = !task.completed; render(); };

    // Content
    const content = document.createElement('div');
    content.className = 'task-content';
    const titleEl = document.createElement('span');
    titleEl.className = 'task-title';
    titleEl.textContent = task.title;
    content.appendChild(titleEl);
    if (task.dueDate && !task.completed) {
      const due = document.createElement('span');
      due.className = 'task-due';
      const dd = new Date(task.dueDate);
      due.textContent = `${MONTHS[dd.getMonth()].slice(0,3)} ${dd.getDate()} · ${fmtTime(dd)}`;
      content.appendChild(due);
    }

    // Delete button
    const del = document.createElement('button');
    del.className = 'task-delete';
    del.setAttribute('aria-label', 'Delete task');
    del.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    del.onclick = e => {
      e.stopPropagation();
      state.tasks = state.tasks.filter(t => t.id !== task.id);
      render();
    };

    item.append(cb, content, del);
    list.appendChild(item);
  });
}

/** Circular SVG focus ring + stats */
function renderFocus() {
  const total = state.tasks.length;
  const done  = state.tasks.filter(t => t.completed).length;
  const pct   = total ? Math.round(done/total*100) : 0;

  $('#focus-pct').textContent  = pct + '%';
  $('#stat-done').textContent  = done;
  $('#stat-left').textContent  = total - done;

  const circumference = 2 * Math.PI * 50;            // r=50 → 314.16
  const offset = circumference - (pct/100) * circumference;
  const ring = $('#focus-ring-fill');
  if (ring) ring.style.strokeDashoffset = offset;
}

// ══════════════════════════════════════════════════════════════════
//  DAY PANEL
// ══════════════════════════════════════════════════════════════════
function openDayPanel(day) {
  state.selectedDay = day;
  $('#day-panel-weekday').textContent = DAYS_FULL[day.getDay()];
  $('#day-panel-date').textContent =
    `${MONTHS[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`;
  renderDayEvents(day);
  showOverlay('#day-panel-overlay');
}

function closeDayPanel() {
  hideOverlay('#day-panel-overlay');
}

function renderDayEvents(day) {
  const list    = $('#day-events-list');
  list.innerHTML = '';

  const dayEvts = state.events
    .filter(e => isSameDay(new Date(e.start), day))
    .sort((a,b) => new Date(a.start)-new Date(b.start));

  const dayTsks = state.tasks
    .filter(t => t.dueDate && !t.completed && isSameDay(new Date(t.dueDate), day));

  if (!dayEvts.length && !dayTsks.length) {
    list.innerHTML = `<div class="day-empty">
      <p>Nothing scheduled.</p>
      <p class="day-empty-hint">Tap <strong>+</strong> to add an event.</p>
    </div>`;
    return;
  }

  if (dayEvts.length) {
    const h = document.createElement('div');
    h.className = 'day-section-header';
    h.textContent = 'Events';
    list.appendChild(h);

    dayEvts.forEach(ev => {
      const item = document.createElement('div');
      item.className = 'day-event-item';
      item.innerHTML = `
        <div class="day-event-color" style="background:${ev.color||COLORS[5]}"></div>
        <div class="day-event-info">
          <div class="day-event-title">${esc(ev.title)}</div>
          <div class="day-event-time">${fmtTime(new Date(ev.start))} – ${fmtTime(new Date(ev.end))}</div>
          ${ev.description ? `<div class="day-event-desc">${esc(ev.description)}</div>` : ''}
        </div>
        <button class="day-event-edit" aria-label="Edit event">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>`;

      // Edit button
      item.querySelector('.day-event-edit').onclick = e => {
        e.stopPropagation();
        closeDayPanel();
        openEventModal(ev);
      };
      // Tap whole row → detail sheet
      item.onclick = () => {
        closeDayPanel();
        state.selectedEvent = ev;
        openDetailSheet(ev);
      };
      list.appendChild(item);
    });
  }

  if (dayTsks.length) {
    const h = document.createElement('div');
    h.className = 'day-section-header';
    h.textContent = 'Due Tasks';
    list.appendChild(h);
    dayTsks.forEach(task => {
      const item = document.createElement('div');
      item.className = 'day-task-item';
      item.innerHTML = `<div class="day-task-dot"></div><span class="day-task-title">${esc(task.title)}</span>`;
      list.appendChild(item);
    });
  }
}

// ══════════════════════════════════════════════════════════════════
//  TYPE PICKER
// ══════════════════════════════════════════════════════════════════
function openTypePicker()  { showOverlay('#type-picker-overlay'); }
function closeTypePicker() { hideOverlay('#type-picker-overlay'); }

// ══════════════════════════════════════════════════════════════════
//  EVENT MODAL
// ══════════════════════════════════════════════════════════════════
function openEventModal(ev, prefillDay) {
  state.selectedEvent = ev;

  $('#event-modal-heading').textContent = ev ? 'Edit Event' : 'New Event';
  $('#event-id').value           = ev ? ev.id  : '';
  $('#event-title-input').value  = ev ? ev.title : '';
  $('#event-notes').value        = ev ? (ev.description || '') : '';
  $('#event-recurrence').value   = ev ? (ev.recurrence || 'none') : 'none';

  // Default date = prefill or selected day or today
  const ref = prefillDay || state.selectedDay || state.currentDate;
  const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());

  $('#event-start').value = ev
    ? toLocalDT(new Date(ev.start))
    : toLocalDT(new Date(refDay.getTime() + 9*3600000));   // 09:00
  $('#event-end').value = ev
    ? toLocalDT(new Date(ev.end))
    : toLocalDT(new Date(refDay.getTime() + 10*3600000));  // 10:00

  // Colour swatches
  const cp = $('#color-picker');
  cp.innerHTML = '';
  const sel = ev ? ev.color : COLORS[5];
  COLORS.forEach(c => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'color-swatch' + (c===sel ? ' active' : '');
    sw.style.backgroundColor = c;
    sw.dataset.color = c;
    sw.onclick = () => { $$('.color-swatch').forEach(s => s.classList.remove('active')); sw.classList.add('active'); };
    cp.appendChild(sw);
  });

  $('#btn-event-delete').classList.toggle('hidden', !ev);

  showOverlay('#event-modal-overlay');
  setTimeout(() => $('#event-title-input').focus(), 380);
}

function closeEventModal() { hideOverlay('#event-modal-overlay'); }

async function handleSaveEvent(e) {
  e.preventDefault();
  const id         = $('#event-id').value;
  const title      = $('#event-title-input').value.trim();
  if (!title) return;

  const color      = $('.color-swatch.active')?.dataset.color || COLORS[5];
  const recurrence = $('#event-recurrence').value || 'none';
  const startVal   = $('#event-start').value;
  const endVal     = $('#event-end').value;

  if (!startVal || !endVal) return;

  const baseEvent = {
    id:          id || uid(),
    title,
    description: $('#event-notes').value.trim(),
    start:       new Date(startVal).toISOString(),
    end:         new Date(endVal).toISOString(),
    color,
    recurrence,
  };

  if (id) {
    // Update existing event
    state.events = state.events.map(ev => ev.id === id ? baseEvent : ev);
    await scheduleAlarmForEvent(baseEvent);
  } else {
    // Create new with recurrence expansion
    const limitMap = { none:1, daily:365, weekly:52, monthly:12, yearly:5 };
    const limit    = limitMap[recurrence] || 1;
    const startDt  = new Date(baseEvent.start);
    const duration = new Date(baseEvent.end).getTime() - startDt.getTime();
    const recId    = recurrence !== 'none' ? uid() : null;

    for (let i=0; i<limit; i++) {
      const instStart = new Date(startDt);
      if      (recurrence==='daily')   instStart.setDate(startDt.getDate() + i);
      else if (recurrence==='weekly')  instStart.setDate(startDt.getDate() + i*7);
      else if (recurrence==='monthly') instStart.setMonth(startDt.getMonth() + i);
      else if (recurrence==='yearly')  instStart.setFullYear(startDt.getFullYear() + i);

      const instEvent = {
        ...baseEvent,
        id:    uid(),
        start: instStart.toISOString(),
        end:   new Date(instStart.getTime() + duration).toISOString(),
        ...(recId ? { recurrenceId: recId } : {}),
      };
      state.events.push(instEvent);
      await scheduleAlarmForEvent(instEvent);
    }
  }

  state.selectedEvent = null;
  closeEventModal();
  render();
}

async function handleDeleteEvent() {
  const id = $('#event-id').value;
  if (!id) return;
  
  // Find event and cancel alarm
  const ev = state.events.find(e => e.id === id);
  if (ev) await cancelAlarmForEvent(ev);

  state.events = state.events.filter(e => e.id !== id);
  state.selectedEvent = null;
  closeEventModal();
  render();
}

// ══════════════════════════════════════════════════════════════════
//  TASK MODAL
// ══════════════════════════════════════════════════════════════════
function openTaskModal(prefillDay) {
  $('#task-id').value          = '';
  $('#task-title-input').value = '';
  if (prefillDay) {
    $('#task-due').value = toLocalDT(new Date(
      prefillDay.getFullYear(), prefillDay.getMonth(), prefillDay.getDate(), 9, 0));
  } else {
    $('#task-due').value = '';
  }
  showOverlay('#task-modal-overlay');
  setTimeout(() => $('#task-title-input').focus(), 380);
}

function closeTaskModal() { hideOverlay('#task-modal-overlay'); }

function handleSaveTask(e) {
  e.preventDefault();
  const title = $('#task-title-input').value.trim();
  if (!title) return;
  const dt = $('#task-due').value;
  const task = {
    id:        $('#task-id').value || uid(),
    title,
    completed: false,
    dueDate:   dt ? new Date(dt).toISOString() : null,
  };
  const existing = $('#task-id').value;
  if (existing) {
    state.tasks = state.tasks.map(t => t.id===existing ? task : t);
  } else {
    state.tasks.push(task);
  }
  closeTaskModal();
  render();
}

// ══════════════════════════════════════════════════════════════════
//  EVENT DETAIL SHEET
// ══════════════════════════════════════════════════════════════════
function openDetailSheet(ev) {
  state.selectedEvent = ev;
  const s = new Date(ev.start);
  const content = $('#detail-content');
  content.innerHTML = `
    <div class="detail-color-bar" style="background:${ev.color||COLORS[5]}"></div>
    <div class="detail-body">
      <h2 class="detail-title">${esc(ev.title)}</h2>
      <div class="detail-time">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        ${fmtTime(new Date(ev.start))} – ${fmtTime(new Date(ev.end))}
      </div>
      <div class="detail-date">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        ${MONTHS[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()}
      </div>
      ${ev.description ? `<p class="detail-desc">${esc(ev.description)}</p>` : ''}
      ${ev.recurrence && ev.recurrence!=='none'
        ? `<div class="detail-recurrence">🔁 Repeats ${ev.recurrence}</div>` : ''}
    </div>`;
  showOverlay('#detail-overlay');
}

function closeDetailSheet() { hideOverlay('#detail-overlay'); }

// ══════════════════════════════════════════════════════════════════
//  SETTINGS SHEET MANAGEMENT
// ══════════════════════════════════════════════════════════════════
function openSettings() {
  // Clear any status messages
  const msg = $('#backup-status-msg');
  msg.textContent = '';
  msg.className = 'backup-status-msg';

  updatePermissionStatus();
  showOverlay('#settings-overlay');
}

function closeSettings() {
  hideOverlay('#settings-overlay');
}

function initSettingsUI() {
  // Pre-fill theme
  $('#settings-theme').value = state.settings.theme || 'dark';
  $('#settings-theme').onchange = (e) => {
    state.settings.theme = e.target.value;
    applyTheme();
    saveData();
  };

  // Pre-fill reminders status
  $('#settings-reminders-enabled').checked = state.settings.remindersEnabled;
  $('#settings-reminders-enabled').onchange = async (e) => {
    state.settings.remindersEnabled = e.target.checked;
    saveData();
    if (state.settings.remindersEnabled) {
      const granted = await requestNotificationPermission();
      if (!granted) {
        e.target.checked = false;
        state.settings.remindersEnabled = false;
        saveData();
        alert('Notification permission is required to enable reminders.');
      } else {
        await rescheduleAllAlarms();
      }
    } else {
      // Cancel all scheduled notifications
      if (LocalNotifications) {
        try {
          const pending = await LocalNotifications.getPending();
          if (pending.notifications && pending.notifications.length > 0) {
            await LocalNotifications.cancel(pending);
          }
        } catch (err) {}
      }
    }
  };

  // Pre-fill offset
  $('#settings-reminder-offset').value = state.settings.reminderOffset || '15';
  $('#settings-reminder-offset').onchange = async (e) => {
    state.settings.reminderOffset = e.target.value;
    saveData();
    if (state.settings.remindersEnabled) {
      await rescheduleAllAlarms();
    }
  };

  // Bind settings sheets buttons
  $('#settings-backdrop').onclick = closeSettings;
  $('#settings-close-btn').onclick   = closeSettings;

  // Permissions buttons
  $('#btn-request-perm-notification').onclick = async () => {
    await requestNotificationPermission();
    updatePermissionStatus();
  };
  $('#btn-request-perm-storage').onclick = async () => {
    await requestStoragePermission();
    updatePermissionStatus();
  };

  // Backup & Import buttons
  $('#btn-backup-export').onclick = exportBackup;
  $('#btn-backup-import').onclick = () => $('#backup-file-input').click();
  $('#backup-file-input').onchange = handleImportBackup;
}

// ── App Theme application ──
function applyTheme() {
  const body = document.body;
  const theme = state.settings.theme;

  body.classList.remove('light-theme');

  if (theme === 'light') {
    body.classList.add('light-theme');
  } else if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (!prefersDark) {
      body.classList.add('light-theme');
    }
  }
}

// ── Permission Status checkers ──
async function updatePermissionStatus() {
  const notifStatus = $('#perm-notification-status');
  const storageStatus = $('#perm-storage-status');

  // Check notification permission
  if (LocalNotifications) {
    try {
      const status = await LocalNotifications.checkPermissions();
      const st = status.display;
      notifStatus.textContent = st;
      notifStatus.className = 'permission-status ' + (st === 'granted' ? 'granted' : 'denied');
      $('#btn-request-perm-notification').style.display = st === 'granted' ? 'none' : 'block';
    } catch {
      notifStatus.textContent = 'Prompt';
      notifStatus.className = 'permission-status';
    }
  } else {
    notifStatus.textContent = 'Supported (Browser)';
    notifStatus.className = 'permission-status granted';
    $('#btn-request-perm-notification').style.display = 'none';
  }

  // Check storage status
  if (Filesystem) {
    try {
      const status = await Filesystem.checkPermissions();
      const st = status.publicStorage;
      storageStatus.textContent = st;
      storageStatus.className = 'permission-status ' + (st === 'granted' ? 'granted' : 'denied');
      $('#btn-request-perm-storage').style.display = st === 'granted' ? 'none' : 'block';
    } catch {
      storageStatus.textContent = 'Granted';
      storageStatus.className = 'permission-status granted';
      $('#btn-request-perm-storage').style.display = 'none';
    }
  } else {
    storageStatus.textContent = 'Supported (Browser)';
    storageStatus.className = 'permission-status granted';
    $('#btn-request-perm-storage').style.display = 'none';
  }
}

async function requestNotificationPermission() {
  if (!LocalNotifications) return true;
  try {
    const status = await LocalNotifications.requestPermissions();
    return status.display === 'granted';
  } catch { return false; }
}

async function requestStoragePermission() {
  if (!Filesystem) return true;
  try {
    const status = await Filesystem.requestPermissions();
    return status.publicStorage === 'granted';
  } catch { return false; }
}

// ── Export / Backup data ──
async function exportBackup() {
  const data = {
    events: state.events,
    tasks: state.tasks,
    settings: {
      viewMode: 'month',
      theme: state.settings.theme
    }
  };
  const jsonStr = JSON.stringify(data, null, 2);

  const statusMsg = $('#backup-status-msg');
  statusMsg.className = 'backup-status-msg';
  statusMsg.textContent = 'Backing up...';

  if (hasCapacitor && Filesystem) {
    try {
      // 1. Create ZenCalendar directory in DOCUMENTS
      try {
        await Filesystem.mkdir({
          path: 'ZenCalendar',
          directory: 'DOCUMENTS',
          recursive: true
        });
      } catch (e) {
        // Folder exists, continue
      }

      // 2. Write file
      await Filesystem.writeFile({
        path: 'ZenCalendar/zencalendar_data.json',
        data: jsonStr,
        directory: 'DOCUMENTS',
        encoding: 'utf8'
      });

      statusMsg.className = 'backup-status-msg success';
      statusMsg.textContent = 'Backup saved: Documents/ZenCalendar/zencalendar_data.json';
    } catch (err) {
      statusMsg.className = 'backup-status-msg error';
      statusMsg.textContent = 'Backup failed: ' + err.message;
    }
  } else {
    // Web browser fallback download
    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'zencalendar_data.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      statusMsg.className = 'backup-status-msg success';
      statusMsg.textContent = 'Backup downloaded as zencalendar_data.json';
    } catch (err) {
      statusMsg.className = 'backup-status-msg error';
      statusMsg.textContent = 'Backup failed: ' + err.message;
    }
  }
}

// ── Restore / Import data ──
async function handleImportBackup(e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusMsg = $('#backup-status-msg');
  statusMsg.className = 'backup-status-msg';
  statusMsg.textContent = 'Importing...';

  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const parsed = JSON.parse(evt.target.result);
      if (!parsed.events || !parsed.tasks) {
        throw new Error('Invalid schema. Make sure file contains events and tasks.');
      }

      // Overwrite local calendar data
      state.events = parsed.events;
      state.tasks = parsed.tasks;
      if (parsed.settings?.theme) {
        state.settings.theme = parsed.settings.theme;
        $('#settings-theme').value = state.settings.theme;
        applyTheme();
      }

      // Save to localStorage
      saveData();

      // Reset alarms for new events
      await rescheduleAllAlarms();

      statusMsg.className = 'backup-status-msg success';
      statusMsg.textContent = `Imported successfully! Loaded ${state.events.length} events and ${state.tasks.length} tasks.`;
      
      // Clear file input selection
      e.target.value = '';

      render();
    } catch (err) {
      statusMsg.className = 'backup-status-msg error';
      statusMsg.textContent = 'Import failed: ' + err.message;
    }
  };
  reader.readAsText(file);
}

// ── Reminders & Alarm Scheduling logic ──
async function scheduleAlarmForEvent(event) {
  if (!LocalNotifications) return;

  const notificationId = stringToHash32(event.id);
  
  // Cancel previous alarm
  try {
    await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
  } catch (err) {}

  if (!state.settings.remindersEnabled) return;

  const eventStart = new Date(event.start);
  const offsetMins = parseInt(state.settings.reminderOffset, 10);
  const alarmTime = new Date(eventStart.getTime() - offsetMins * 60000);

  // If reminder is scheduled in the past, skip it
  if (alarmTime <= new Date()) return;

  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          title: 'ZenCalendar Alarm',
          body: `Upcoming: ${event.title}${event.description ? ' - ' : ''}${event.description || ''}`,
          id: notificationId,
          schedule: { at: alarmTime },
          sound: 'default',
          actionTypeId: 'OPEN_APP',
          extra: { eventId: event.id }
        }
      ]
    });
  } catch (err) {
    console.error('Failed to schedule alarm:', err);
  }
}

async function cancelAlarmForEvent(event) {
  if (!LocalNotifications) return;
  const notificationId = stringToHash32(event.id);
  try {
    await LocalNotifications.cancel({ notifications: [{ id: notificationId }] });
  } catch (err) {}
}

async function rescheduleAllAlarms() {
  if (!LocalNotifications) return;

  // Clear all pending notifications
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications && pending.notifications.length > 0) {
      await LocalNotifications.cancel(pending);
    }
  } catch (err) {}

  if (!state.settings.remindersEnabled) return;

  // Schedule alarms for all events
  for (const event of state.events) {
    await scheduleAlarmForEvent(event);
  }
}

// ══════════════════════════════════════════════════════════════════
//  OVERLAY HELPERS (slide-up animation)
// ══════════════════════════════════════════════════════════════════
function showOverlay(selector) {
  const el = $(selector);
  el.classList.remove('hidden');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('open'));
  });
}

function hideOverlay(selector) {
  const el = $(selector);
  el.classList.remove('open');
  setTimeout(() => el.classList.add('hidden'), 330);
}

// ══════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', init);

