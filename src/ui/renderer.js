'use strict';
/* global jwh */

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h2 = (n) => `${Number(n).toFixed(2)}h`;
const h1 = (n) => `${Number(n).toFixed(1)}h`;
const pct = (v, max) => `${Math.max(0, Math.min(100, max > 0 ? (v / max) * 100 : 0))}%`;
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const time = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

let current = null;
let firstRender = true;
let firstSetupFocus = true;
const DEPLOYMENT_NAMES = { cloud: 'Jira Cloud', server: 'Jira Data Center' };

// View state: which tab, which week (null = current) and which month
const view = {
  tab: 'week',
  weekStart: null,     // Monday "YYYY-MM-DD" of the week shown; null follows the current week
  weekReport: null,    // report of an older week (the current one comes with every update)
  month: null,         // { year, month } shown in the calendar
  monthData: null,
  loading: false,
  error: null,
  lastSeenUpdate: null,
  team: null,          // team week (admins)
  teamOverdue: null,   // { items } or { error }
  expanded: null,      // member row opened in the team grid
  overdue: null,       // my overdue tasks: { items } or { error }
  editingStart: false, // the "Edit start" field is open
};

const pad2 = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dateOf = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (key, n) => { const d = dateOf(key); d.setDate(d.getDate() + n); return keyOf(d); };
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const currentWeekStart = () => (current && current.report ? current.report.weekStart : null);
const viewingCurrentWeek = () => !view.weekStart || view.weekStart === currentWeekStart();
const shownReport = () => (viewingCurrentWeek() ? (current && current.report) : view.weekReport);

// ------------------------------------------------------------------ render
function render(s) {
  current = s;
  const r = s.report;
  const needsSetup = !!(s.error && s.error.kind === 'setup');
  const blocking = !!(s.error && !r);

  $('layout').hidden = blocking;
  $('setup').hidden = !needsSetup;
  $('problem').hidden = !blocking || needsSetup;

  // Banner: settings problems, or an error while older data is still shown
  const banner = $('banner');
  if (s.settingsWarning) {
    showBanner(s.settingsWarning, 'error');
  } else if (s.error && r) {
    showBanner(`Last update failed: ${s.error.message} Showing the data from before.`, 'error');
  } else if (banner.dataset.kind === 'error') {
    banner.hidden = true;
  }

  if (blocking && !needsSetup) renderProblem(s);
  if (needsSetup && firstSetupFocus) { firstSetupFocus = false; setTimeout(() => $('setup-url').focus(), 0); }
  $('tab-team').hidden = !s.isAdmin;
  if (view.tab === 'team' && !s.isAdmin) view.tab = 'week';
  if (r) {
    renderToday(r, s);
    renderOverdue();
    renderMain();
  } else if (!blocking) {
    $('days').innerHTML = '<p class="loading">Loading your worklogs…</p>';
  }

  let who = s.settings.demo ? 'Demo mode' : 'Not connected';
  if (r && r.demo) who = 'Demo mode - sample data';
  else if (r) who = `Connected as ${r.me.displayName} · ${DEPLOYMENT_NAMES[r.deployment] || 'Jira'} · ${hostOf(s.settings.baseUrl)}`;
  $('who').textContent = who;
  $('last').textContent = s.updating ? 'Updating…' : (s.lastUpdate ? `Last update ${time(s.lastUpdate)} (${s.lastReason})` : '');
  $('next').textContent = s.nextUpdate;

  const w = s.workday;
  const tip = w && w.running && !s.error ? `${s.tray.tooltip} \u00b7 at work ${fmtMin(w.elapsedHours * 60)}, ${fmtMin(w.openHours * 60)} not booked` : s.tray.tooltip;
  drawTrayIcon({ ...s.tray, tooltip: tip });

  // After every finished update, reload an older week or the calendar too
  if (!s.updating && s.lastUpdate && s.lastUpdate !== view.lastSeenUpdate) {
    const first = view.lastSeenUpdate === null;
    view.lastSeenUpdate = s.lastUpdate;
    if (r) loadOverdueCard();
    if (!first && r && (view.tab === 'calendar' || view.tab === 'team' || !viewingCurrentWeek())) loadView();
  }

  if (firstRender && r) {
    firstRender = false;
    if (s.startView === 'past') navigate(-1).then(() => jwh.rendered());
    else if (s.startView && s.startView !== 'week') switchTab(s.startView).then(() => jwh.rendered());
    else jwh.rendered();
  } else if (firstRender && blocking) {
    firstRender = false;
    jwh.rendered();
  }
}

function showBanner(text, kind) {
  const banner = $('banner');
  banner.className = `banner ${kind === 'ok' ? 'ok' : ''}`;
  banner.dataset.kind = kind;
  banner.textContent = text;
  banner.hidden = false;
  clearTimeout(showBanner.timer);
  if (kind === 'ok') showBanner.timer = setTimeout(() => { banner.hidden = true; banner.dataset.kind = ''; }, 7000);
}

function renderProblem(s) {
  const loginIssue = s.error.kind === 'login' || s.error.kind === 'auth';
  $('problem-title').textContent = loginIssue ? 'Sign in to Jira' : 'Jira not reachable';
  $('problem-text').textContent = s.error.message;
  $('problem-signin').hidden = !(s.settings.auth === 'browser');
  $('problem-demo').hidden = s.settings.demo;
  $('problem-retry').disabled = s.updating;
  $('problem-retry').textContent = s.updating ? 'Trying…' : 'Try again';
}

// Everything in the left column and the week-related cards on the right
function renderMain() {
  const r = current.report;
  const isCal = view.tab === 'calendar';
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === view.tab));
  $('days').hidden = view.tab !== 'week';
  renderWorkday();
  $('calendar').hidden = !isCal;
  $('log').hidden = view.tab !== 'log';
  $('team').hidden = view.tab !== 'team';
  $('demo-badge').hidden = !r.demo;
  $('export-btn').disabled = isCal || view.tab === 'team';

  // Navigation header
  if (isCal) {
    const m = view.month || defaultMonth();
    const label = dateOf(`${m.year}-${pad2(m.month + 1)}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const isNow = m.year === new Date().getFullYear() && m.month === new Date().getMonth();
    $('nav-title').textContent = label;
    $('range').textContent = view.monthData ? `${h2(view.monthData.monthTotal)} logged` : '';
    $('nav-prev').setAttribute('aria-label', 'Previous month');
    $('nav-next').setAttribute('aria-label', 'Next month');
    $('nav-next').disabled = isNow;
    $('nav-today').textContent = 'This month';
    $('nav-today').disabled = isNow;
  } else {
    const shown = shownReport();
    const isNow = viewingCurrentWeek();
    const wk = shown;
    $('nav-title').textContent = `${view.tab === 'team' ? 'Team · ' : ''}${isNow ? `This week · W${wk ? wk.weekNumber : ''}` : `Week ${wk ? wk.weekNumber : ''}`}`;
    $('range').textContent = wk ? wk.weekLabel : '';
    $('nav-prev').setAttribute('aria-label', 'Previous week');
    $('nav-next').setAttribute('aria-label', 'Next week');
    $('nav-next').disabled = isNow;
    $('nav-today').textContent = 'This week';
    $('nav-today').disabled = isNow;
  }

  const target = isCal ? $('calendar') : ({ log: $('log'), team: $('team') }[view.tab] || $('days'));
  if (view.loading) { target.innerHTML = '<p class="loading">Loading…</p>'; }
  else if (view.error) {
    target.innerHTML = `<div class="inline-error"><span>${esc(view.error)}</span><button type="button" class="btn btn-small" id="view-retry">Try again</button></div>`;
    $('view-retry').addEventListener('click', loadView);
  } else if (isCal) {
    renderCalendar(view.monthData);
  } else if (view.tab === 'log') {
    renderLog(shownReport());
  } else if (view.tab === 'team') {
    renderTeam(view.team);
  } else {
    renderWeek(shownReport());
  }

  if (isCal && view.monthData) renderMonthSide(view.monthData);
  else if (!isCal && shownReport()) renderSide(shownReport(), current);
  $('cats').hidden = isCal || view.tab === 'team';
  $('weekcard').hidden = view.tab === 'team';
}

// Calendar opens on today's month, or on the month of the older week being viewed
function defaultMonth() {
  if (view.weekStart && !viewingCurrentWeek()) return monthOfWeek(view.weekStart);
  const today = new Date();
  return { year: today.getFullYear(), month: today.getMonth() };
}

function monthOfWeek(weekStart) {
  // the month a week "belongs" to: the one containing its Thursday
  const d = dateOf(addDays(weekStart || keyOf(new Date()), 3));
  return { year: d.getFullYear(), month: d.getMonth() };
}

async function loadView() {
  if (view.tab === 'calendar') {
    if (!view.month) view.month = defaultMonth();
    view.loading = !view.monthData || view.monthData.year !== view.month.year || view.monthData.month !== view.month.month;
    view.error = null;
    renderMain();
    const res = await jwh.loadMonth(view.month.year, view.month.month);
    view.loading = false;
    if (res.ok) view.monthData = res.data; else view.error = res.message;
  } else if (view.tab === 'team') {
    const weekStart = view.weekStart || currentWeekStart();
    view.loading = !view.team || view.team.weekStart !== weekStart;
    view.error = null;
    renderMain();
    const [res, od] = await Promise.all([jwh.loadTeam(weekStart), jwh.loadOverdue('team')]);
    if (!viewingCurrentWeek() && (!view.weekReport || view.weekReport.weekStart !== weekStart)) {
      const wr = await jwh.loadWeek(weekStart); // keeps the week title right for older weeks
      if (wr.ok) view.weekReport = wr.data;
    }
    view.loading = false;
    if (res.ok) view.team = res.data; else view.error = res.message;
    view.teamOverdue = od.ok ? { items: od.data } : { error: od.message };
  } else if (!viewingCurrentWeek()) {
    view.loading = !view.weekReport || view.weekReport.weekStart !== view.weekStart;
    view.error = null;
    renderMain();
    const res = await jwh.loadWeek(view.weekStart);
    view.loading = false;
    if (res.ok) view.weekReport = res.data; else view.error = res.message;
  } else {
    view.error = null;
  }
  renderMain();
}

async function switchTab(tab) {
  view.tab = tab === 'team' && !(current && current.isAdmin) ? 'week' : tab;
  view.error = null;
  if (tab === 'calendar') view.month = defaultMonth();
  await loadView();
}

async function goWeek(weekStart) {
  view.weekStart = weekStart === currentWeekStart() ? null : weekStart;
  await loadView();
}

async function navigate(step) {
  if (!current || !current.report) return;
  if (view.tab === 'calendar') {
    const m = view.month || defaultMonth();
    const d = new Date(m.year, m.month + step, 1);
    view.month = { year: d.getFullYear(), month: d.getMonth() };
    await loadView();
  } else {
    const base = view.weekStart || currentWeekStart();
    const next = addDays(base, 7 * step);
    if (next > currentWeekStart()) return;
    await goWeek(next);
  }
}

async function navigateToday() {
  if (view.tab === 'calendar') {
    view.weekStart = null;
    view.month = defaultMonth();
    await loadView();
  } else {
    await goWeek(currentWeekStart());
  }
}

function renderWeek(r) {
  if (!r) return;

  $('days').innerHTML = r.days.filter((d) => d.visible).map((d) => {
    const done = d.isWorkday && d.total >= r.target;
    let pill = '<span class="pill none">-</span>';
    if (d.missing > 0) pill = `<span class="pill missing">\u2212${h2(d.missing)}</span>`;
    else if (done) pill = '<span class="pill done">done</span>';

    // Grouped by sprint (or the chosen category): a subtotal line, then its tickets
    const tickets = d.groups.length
      ? `<div class="tickets">${d.groups.map((g) => `
          <div class="group-name" title="${esc(g.name)}">${esc(g.name)}</div>
          <div class="group-hrs">${h2(g.hours)}</div>
          ${g.tickets.map((t) => `
          <div class="key">${esc(t.key)}</div>
          <div class="sum" title="${esc(t.summary)}">${esc(t.summary)}</div>
          <div class="hrs">${h2(t.hours)}</div>`).join('')}`).join('')}</div>`
      : (d.isFuture ? '' : '<div class="no-tickets">Nothing logged</div>');

    const classes = ['day', d.isToday ? 'is-today' : '', d.isToday && done ? 'done' : '', d.isFuture ? 'future' : ''].join(' ');
    return `<div class="${classes}">
      <div class="day-row">
        <div class="day-name">${esc(d.label)}</div>
        <div class="bar ${done ? 'done' : ''}" role="img" aria-label="${esc(h2(d.total))} of ${esc(r.target)}h"><div style="width:${pct(d.total, r.target)}"></div></div>
        <div class="day-hours">${h2(d.total)}</div>
        ${pill}
      </div>
      ${tickets}
    </div>`;
  }).join('');
}

const STATUS_TEXT = { done: 'target reached', partial: 'partly logged', missing: 'nothing logged', weekend: 'weekend', 'weekend-logged': 'weekend', future: 'upcoming', none: '' };

function renderCalendar(m) {
  if (!m) return;
  const selected = view.weekStart || currentWeekStart();
  $('calendar').innerHTML = `
    <div class="cal-head"><div>Wk</div>${DAY_SHORT.map((d) => `<div>${d}</div>`).join('')}<div>Total</div></div>
    <div class="cal-weeks">
      ${m.weeks.map((w) => `
        <button type="button" class="cal-week ${w.weekStart === selected ? 'selected' : ''}" data-week="${esc(w.weekStart)}"
          aria-label="Week ${w.weekNumber}, ${esc(h2(w.total))} logged. Open week"
          ${w.weekStart > currentWeekStart() ? 'disabled' : ''}>
          <span class="cal-wk">${w.weekNumber}</span>
          ${w.days.map((d) => `
            <span class="cal-day ${d.status} ${d.inMonth ? '' : 'out'} ${d.isToday ? 'today' : ''}" title="${esc(`${d.date}: ${h2(d.total)} ${STATUS_TEXT[d.status] ? `(${STATUS_TEXT[d.status]})` : ''}`)}">
              <span class="num">${d.day}</span>
              <span class="hrs">${d.total > 0 ? esc(h1(d.total)) : (d.status === 'missing' ? '0h' : '')}</span>
            </span>`).join('')}
          <span class="cal-total">${w.total > 0 ? esc(h1(w.total)) : ''}</span>
        </button>`).join('')}
    </div>
    <div class="cal-legend">
      <span><i style="background: var(--green-soft)"></i>Target reached</span>
      <span><i style="background: var(--amber-soft)"></i>Partly logged</span>
      <span><i style="background: var(--red-soft)"></i>Nothing logged</span>
      <span>Click a week to open it</span>
    </div>`;
  for (const btn of $('calendar').querySelectorAll('.cal-week')) {
    btn.addEventListener('click', async () => {
      view.tab = 'week';
      await goWeek(btn.dataset.week);
    });
  }
}

function renderLog(r) {
  if (!r) return;
  if (!r.log.length) { $('log').innerHTML = '<p class="empty">No worklogs in this week.</p>'; return; }
  const byDay = new Map();
  for (const e of r.log) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }
  $('log').innerHTML = [...byDay.entries()].map(([day, items]) => {
    const info = r.days.find((d) => d.date === day);
    const total = items.reduce((sum, e) => sum + e.hours, 0);
    return `<section class="log-day">
      <h3>${esc(info ? info.label : day)}<span>${h2(total)}</span></h3>
      ${items.map((e) => `
        <div class="log-row">
          <span class="t">${esc(e.time || '')}</span>
          <span class="d">${h2(e.hours)}</span>
          <span class="k">${esc(e.key)}</span>
          <span class="what">
            <span class="sum" title="${esc(e.summary)}">${esc(e.summary)}</span>
            ${e.comment ? `<span class="cmt">${esc(e.comment)}</span>` : '<span class="cmt none">No comment</span>'}
            <span class="tag">${esc(e.category)}</span>
          </span>
        </div>`).join('')}
    </section>`;
  }).join('');
}

const fmtMin = (min) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const PAUSE_TEXT = { lock: 'screen locked', sleep: 'PC asleep' };

// Today's work clock: time since the PC started, what is booked in Jira and what is still open
function renderWorkday() {
  const box = $('workday');
  const w = current && current.workday;
  const show = !!(w && current.report && view.tab === 'week' && viewingCurrentWeek());
  box.hidden = !show;
  if (!show || view.editingStart) return;

  if (!w.running) {
    box.innerHTML = `<div class="wd-head"><span class="card-title">Work clock</span><span class="since">Starts with your first activity today.</span></div>
      <div class="wd-actions"><button type="button" class="btn btn-small" id="wd-edit">Set start time</button></div>`;
    $('wd-edit').addEventListener('click', openStartEditor);
    return;
  }
  const span = Math.max(1, w.rangeTo - w.rangeFrom);
  const pos = (min) => `${((min - w.rangeFrom) / span) * 100}%`;
  const width = (a, b) => `${((b - a) / span) * 100}%`;
  const segs = w.segments.map((sg) => {
    const what = sg.kind === 'booked' ? `${sg.key}${sg.summary ? ` ${sg.summary}` : ''}` : (sg.kind === 'pause' ? 'Pause' : 'Not booked');
    return `<div class="wd-seg ${sg.kind}" style="left:${pos(sg.fromMin)};width:${width(sg.fromMin, sg.toMin)}" title="${esc(`${sg.from}–${sg.to} ${what} (${fmtMin(sg.minutes)})`)}"></div>`;
  }).join('');
  const nowMin = Number(w.now.slice(0, 2)) * 60 + Number(w.now.slice(3, 5));
  // whole-hour ticks, at most ~10 labels
  const firstHour = Math.ceil(w.rangeFrom / 60);
  const lastHour = Math.floor(w.rangeTo / 60);
  const step = Math.max(1, Math.ceil((lastHour - firstHour + 1) / 10));
  let ticks = '';
  for (let h = firstHour; h <= lastHour; h += step) ticks += `<span style="left:${pos(h * 60)}">${String(h).padStart(2, '0')}</span>`;

  const gaps = w.gaps.length
    ? `<div><strong>Not booked yet:</strong> ${w.gaps.map((g) => `<span class="chip open">${esc(g.from)}–${esc(g.to)} · ${fmtMin(g.minutes)}</span>`).join('')}</div>`
    : '<div><strong>Everything since the start is booked.</strong></div>';
  const pauses = w.pauses.length
    ? `<div>Pauses (counted as work time): ${w.pauses.map((p) => `<span class="chip pause">${esc(p.from)}–${esc(p.to || 'now')} · ${esc(PAUSE_TEXT[p.kind] || 'pause')}</span>`).join('')}</div>`
    : '';
  const openZero = w.openHours <= 0.01;

  box.innerHTML = `
    <div class="wd-head">
      <span class="card-title">Work clock</span>
      <span class="since">At work since <strong>${esc(w.start)}</strong>${w.manual ? ' (set by you)' : ''}</span>
    </div>
    <div class="wd-stats">
      <div class="wd-stat"><div class="label">At work</div><div class="value">${fmtMin(w.elapsedHours * 60)}</div></div>
      <div class="wd-stat booked"><div class="label">Booked in Jira</div><div class="value">${fmtMin(w.bookedHours * 60)}</div></div>
      <div class="wd-stat open ${openZero ? 'zero' : ''}"><div class="label">Not booked</div><div class="value">${openZero ? 'All booked' : fmtMin(w.openHours * 60)}</div></div>
    </div>
    <div>
      <div class="wd-track" role="img" aria-label="${esc(`Today from ${w.start} to ${w.now}: ${fmtMin(w.bookedHours * 60)} booked, ${fmtMin(w.openHours * 60)} not booked`)}">${segs}<div class="wd-now" style="left:${pos(nowMin)}" title="Now ${esc(w.now)}"></div></div>
      <div class="wd-axis">${ticks}</div>
    </div>
    <div class="cal-legend"><span><i style="background: var(--green)"></i>Booked</span><span><i style="background: var(--amber)"></i>Not booked</span><span><i style="background: repeating-linear-gradient(45deg, #c9c6bf 0 3px, #e7e5e0 3px 7px)"></i>Pause</span></div>
    <div class="wd-lists">${gaps}${pauses}</div>
    <div class="wd-actions">
      ${w.demo ? '' : '<button type="button" class="btn btn-small" id="wd-jira">Book in Jira</button>'}
      <button type="button" class="link-btn" id="wd-edit">Edit start</button>
      ${w.manual ? '<button type="button" class="link-btn" id="wd-reset">Use automatic start</button>' : ''}
    </div>`;
  const jira = $('wd-jira');
  if (jira) jira.addEventListener('click', () => jwh.openJira());
  $('wd-edit').addEventListener('click', openStartEditor);
  const reset = $('wd-reset');
  if (reset) reset.addEventListener('click', () => jwh.setClockStart(null));
}

function openStartEditor() {
  const w = current.workday || {};
  view.editingStart = true;
  const box = $('workday');
  box.innerHTML = `<form class="wd-edit" id="wd-form">
      <label for="wd-time">Today's work started at</label>
      <input id="wd-time" type="time" value="${esc(w.start || '')}" required>
      <button type="submit" class="btn btn-small btn-primary">Save</button>
      <button type="button" class="btn btn-small" id="wd-cancel">Cancel</button>
    </form><p class="wd-note" id="wd-error" role="alert"></p>`;
  $('wd-time').focus();
  $('wd-cancel').addEventListener('click', () => { view.editingStart = false; renderWorkday(); });
  $('wd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await jwh.setClockStart($('wd-time').value);
    if (res.ok) { view.editingStart = false; renderWorkday(); } else { $('wd-error').textContent = res.message; }
  });
}

async function loadOverdueCard() {
  const res = await jwh.loadOverdue('me');
  view.overdue = res.ok ? { items: res.data } : { error: res.message };
  renderOverdue();
}

function renderOverdue() {
  if (!current) return;
  const days = current.settings.overdueDays;
  const od = view.overdue;
  let body;
  if (!od) body = '<div class="note" style="margin-top:8px">Checking…</div>';
  else if (od.error) body = `<div class="note" style="margin-top:8px">Could not check: ${esc(od.error)}</div>`;
  else if (!od.items.length) body = `<div class="note" style="margin-top:8px">Nothing more than ${days} day${days === 1 ? '' : 's'} past its due date.</div>`;
  else {
    body = `<div class="od-list">${od.items.slice(0, 5).map((i) => `
      <div class="od-item" title="${esc(`${i.key} ${i.summary} - due ${i.due}, ${i.status}`)}">
        <span class="k">${esc(i.key)}</span>
        <span class="s">${esc(i.summary)}</span>
        <span class="d">${i.daysOverdue} d</span>
      </div>`).join('')}</div>${od.items.length > 5 ? `<div class="note" style="margin-top:6px">+ ${od.items.length - 5} more</div>` : ''}`;
  }
  const count = od && od.items ? od.items.length : null;
  $('overdue').innerHTML = `
    <div class="stat-row"><div class="card-title">Overdue tasks</div>${count === null ? '' : `<div class="count ${count ? '' : 'none'}">${count}</div>`}</div>
    ${body}`;
}

function renderTeam(t) {
  if (!t) return;
  const days = current.settings.overdueDays;
  const onTarget = t.totals.onTargetToday;
  const od = view.teamOverdue;
  const tiles = `<div class="team-tiles">
    <div class="team-tile"><div class="label">Team hours</div><div class="value">${esc(h1(t.totals.hours))} <small>${t.totals.members} people</small></div></div>
    <div class="team-tile"><div class="label">${onTarget === null ? 'Hours missing' : 'On target today'}</div><div class="value">${onTarget === null ? esc(h1(t.totals.missing)) : `${onTarget} <small>of ${t.totals.members}</small>`}</div></div>
    <div class="team-tile"><div class="label">Overdue tasks</div><div class="value">${od && od.items ? od.items.length : '–'} <small>&gt; ${days} days</small></div></div>
  </div>`;
  const notice = t.membersKnown ? '' : `<div class="notice">Jira does not allow listing the members of “${esc(current.settings.teamGroup)}” with your account, so only people who logged time in this week are shown.</div>`;
  const head = `<div class="tg-head"><div>Name</div>${t.dayLabels.slice(0, 5).map((d) => `<div>${esc(d)}</div>`).join('')}<div>Week</div><div>Missing</div></div>`;
  const groupWord = current.settings.categoryField === 'sprint' ? 'sprint' : 'category';

  const rows = t.rows.length ? t.rows.map((r) => {
    const open = view.expanded === r.id;
    const detail = open ? `<div class="tg-detail">
        <div><h4>By ${groupWord}</h4>${r.report.categories.map((c) => `<div class="line"><span>${esc(c.name)}</span><span>${esc(h2(c.hours))}</span></div>`).join('') || '<div class="note">Nothing logged</div>'}</div>
        <div><h4>Tickets</h4>${r.report.tickets.slice(0, 8).map((k) => `<div class="line"><span>${esc(k.key)} ${esc(k.summary)}</span><span>${esc(h2(k.hours))}</span></div>`).join('') || '<div class="note">Nothing logged</div>'}</div>
      </div>` : '';
    const cells = r.days.slice(0, 5).map((d) => `<span class="cal-day ${d.status} ${d.isToday ? 'today' : ''}" title="${esc(`${r.displayName}, ${d.date}: ${h2(d.total)}`)}"><span class="hrs">${d.total > 0 ? esc(h1(d.total)) : (d.status === 'missing' ? '0h' : '')}</span></span>`).join('');
    return `<button type="button" class="tg-row" data-member="${esc(r.id)}" aria-expanded="${open}">
        <span class="tg-name"><span>${esc(r.displayName)}</span></span>
        ${cells}
        <span class="tg-num">${esc(h1(r.total))}</span>
        <span class="tg-num ${r.missing > 0 ? 'miss' : 'ok'}">${r.missing > 0 ? esc(h1(r.missing)) : '✓'}</span>
      </button>${detail}`;
  }).join('') : '<p class="empty">Nobody in this group logged time in this week.</p>';

  let overdue = '';
  if (od && od.error) overdue = `<p class="empty">Could not load overdue tasks: ${esc(od.error)}</p>`;
  else if (od && od.items.length) {
    overdue = `<table class="od-table"><thead><tr><th>Ticket</th><th>Summary</th><th>Assignee</th><th>Due</th><th>Status</th><th style="text-align:right">Overdue</th></tr></thead><tbody>
      ${od.items.map((i) => `<tr><td class="k">${esc(i.key)}</td><td>${esc(i.summary)}</td><td>${esc(i.assignee)}</td><td>${esc(i.due)}</td><td>${esc(i.status)}</td><td class="n">${i.daysOverdue} d</td></tr>`).join('')}
    </tbody></table>`;
  } else if (od) overdue = `<p class="empty">No team task is more than ${days} days past its due date.</p>`;

  $('team').innerHTML = `${tiles}${notice}
    <div class="team-grid">${head}${rows}</div>
    <div class="cal-legend"><span><i style="background: var(--green-soft)"></i>${esc(t.target)}h reached</span><span><i style="background: var(--amber-soft)"></i>Partly logged</span><span><i style="background: var(--red-soft)"></i>Nothing logged</span><span>Click a name for details</span></div>
    <h2 class="section-title">Overdue tasks in the team <span class="muted" style="font-weight:400">(more than ${days} days past due)</span></h2>
    ${overdue}`;
  for (const btn of $('team').querySelectorAll('.tg-row')) {
    btn.addEventListener('click', () => {
      view.expanded = view.expanded === btn.dataset.member ? null : btn.dataset.member;
      renderTeam(view.team);
    });
  }
}

function renderMonthSide(m) {
  $('weekcard').innerHTML = `
    <div class="stat-row"><div class="card-title">Month</div><div class="val"><strong>${h2(m.monthTotal)}</strong></div></div>
    <div class="note" style="margin-top:8px">${monthNote(m)}</div>`;
}

function monthNote(m) {
  if (!m.pastWorkdays) return 'No workdays so far in this month';
  if (m.missingDays) return `${m.missingDays} of ${m.pastWorkdays} workdays below target`;
  return `All ${m.pastWorkdays} workdays reached the target`;
}
function renderToday(r, s) {
  const t = r.today;
  if (!t) return;
  const circumference = 2 * Math.PI * 56;
  const filled = Math.min(1, r.target > 0 ? t.logged / r.target : 0) * circumference;
  const done = !t.isWeekend && t.missing <= 0;
  const stroke = t.isWeekend ? '#9a9da1' : (done ? '#2e8b57' : '#d08a1c');

  let value;
  let sub;
  let valueClass = '';
  if (t.isWeekend) { value = h1(t.logged); sub = 'logged (weekend)'; valueClass = 'weekend'; }
  else if (done) { value = 'Done'; sub = `${h1(t.logged)} logged`; valueClass = 'done'; }
  else { value = h1(t.missing); sub = 'remaining'; }

  let since = '';
  if (s.sinceLast) since = `${s.sinceLast > 0 ? '+' : '−'}${h1(Math.abs(s.sinceLast))} since last update`;

  $('today').innerHTML = `
    <div class="card-title">Today · ${esc(t.label)}</div>
    <div class="ring">
      <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
        <circle cx="66" cy="66" r="56" fill="none" stroke="#efede8" stroke-width="12"></circle>
        <circle cx="66" cy="66" r="56" fill="none" stroke="${stroke}" stroke-width="12" stroke-linecap="round"
          stroke-dasharray="${filled.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 66 66)"></circle>
      </svg>
      <div class="ring-label"><div class="ring-value ${valueClass}">${esc(value)}</div><div class="ring-sub">${esc(sub)}</div></div>
    </div>
    <div><strong>${h1(t.logged)}</strong> of ${esc(r.target)}h logged</div>
    <div class="since ${s.sinceLast < 0 ? 'down' : ''}">${esc(since)}</div>
    <button class="btn btn-primary btn-block" id="update-btn" type="button" ${s.updating ? 'disabled' : ''}>${s.updating ? 'Updating…' : 'Update now'}</button>`;
  $('update-btn').addEventListener('click', () => jwh.refresh());
}

function renderSide(r, s) {
  const groupTitle = s.settings.categoryField === 'sprint' ? 'By sprint' : 'By category';
  const missingText = r.missingDays.length
    ? `Missing: ${r.missingDays.map((d) => `${d.label.slice(0, 3)} ${h2(d.missing)}`).join(', ')}`
    : (r.isCurrentWeek ? 'Nothing missing so far this week' : 'Nothing missing in this week');
  $('weekcard').innerHTML = `
    <div class="stat-row"><div class="card-title">${r.isCurrentWeek ? 'Week' : `Week ${r.weekNumber}`}</div><div class="val"><strong>${h2(r.weekTotal)}</strong> / ${esc(r.weekTarget)}h</div></div>
    <div class="thin-bar"><div style="width:${pct(r.weekTotal, r.weekTarget)}"></div></div>
    <div class="note">${esc(missingText)}</div>`;

  const max = r.categories.length ? r.categories[0].hours : 0;
  $('cats').innerHTML = `
    <div class="card-title">${esc(groupTitle)}</div>
    ${r.categories.length ? `<div class="cats">${r.categories.map((c) => `
      <div class="name" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="mini"><div style="width:${pct(c.hours, max)}"></div></div>
      <div class="hrs">${h2(c.hours)}</div>`).join('')}</div>` : '<div class="note" style="margin-top:8px">No hours logged in this week</div>'}`;
}

// ------------------------------------------------------------- tray icon
const ICON_COLORS = { amber: '#b86a00', green: '#217a4a', gray: '#6b6e72', red: '#b3261e' };

function drawTrayIcon(info) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = ICON_COLORS[info.color] || ICON_COLORS.gray;
  g.beginPath();
  g.arc(16, 16, 15.5, 0, Math.PI * 2);
  g.fill();

  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  if (info.text === 'check') {
    g.lineWidth = 3.6;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(8.5, 16.5);
    g.lineTo(13.5, 21.5);
    g.lineTo(23.5, 10.5);
    g.stroke();
  } else {
    const fontSize = info.text.length === 1 ? 21 : (info.text.length === 2 ? 17 : 13);
    g.font = `700 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(info.text, 16, 17);
  }
  jwh.setTrayIcon(canvas.toDataURL('image/png'), info.tooltip);
}

// ---------------------------------------------------------------- settings
function openSettings() {
  if (!current) return;
  const s = current.settings;
  $('f-url').value = s.baseUrl;
  for (const radio of document.querySelectorAll('input[name="auth"]')) radio.checked = radio.value === s.auth;
  $('f-token').value = '';
  $('f-email').value = s.email || '';
  $('disconnect').parentElement.hidden = !s.baseUrl;
  $('token-state').textContent = current.hasToken ? '(saved)' : '(not set)';
  $('f-target').value = s.targetHours;
  $('f-times').value = s.refreshTimes.join(', ');
  $('f-refresh').value = String(s.autoRefreshMinutes);
  $('f-overdue').value = String(s.overdueDays);
  const locked = new Set(current.policy || []);
  $('f-admin-group').value = s.adminGroup || '';
  $('f-team-group').value = s.teamGroup || '';
  $('f-admin-group').disabled = locked.has('adminGroup');
  $('f-team-group').disabled = locked.has('teamGroup');
  $('f-url').disabled = locked.has('baseUrl');
  $('lock-admin').textContent = locked.has('adminGroup') ? '(set by your IT)' : '';
  $('lock-team').textContent = locked.has('teamGroup') ? '(set by your IT)' : '';
  $('f-jira-admins').checked = !!s.jiraAdminsAreAdmins;
  $('f-jira-admins').disabled = locked.has('jiraAdminsAreAdmins');
  $('lock-jira-admins').textContent = locked.has('jiraAdminsAreAdmins') ? '(set by your IT)' : '';
  $('app-version').textContent = current.version ? `Jira Week Hours ${current.version}` : '';
  renderAccessDiag();
  const known = ['sprint', 'issuetype', 'project', 'components', 'labels'];
  $('f-category').value = known.includes(s.categoryField) ? s.categoryField : '__custom';
  $('f-custom').value = known.includes(s.categoryField) ? '' : s.categoryField;
  $('f-autostart').checked = !!current.autostart;
  $('autostart-row').hidden = current.platform !== 'win32';
  $('f-demo').checked = s.demo;
  $('settings-error').hidden = true;
  syncSettingsFields();
  $('drawer').hidden = false;
  $('drawer-backdrop').hidden = false;
  $('f-url').focus();
}

// Shows which Jira groups the user is in and whether that makes them a dashboard admin
function renderAccessDiag() {
  const box = $('access-diag');
  const a = current && current.access;
  const s = current && current.settings;
  if (!a || !s || s.demo) { box.hidden = true; return; }
  const groups = a.groups.length ? a.groups.map((g) => `<code>${esc(g)}</code>`).join(' ') : '<em>Jira did not report any groups</em>';
  let status;
  if (current.isAdmin) status = '<span class="yes">You see the Team tab.</span>';
  else if (!s.adminGroup && !s.jiraAdminsAreAdmins) status = '<span class="no">No admin group set, so nobody sees the Team tab.</span>';
  else if (s.adminGroup && !a.inAdminGroup) status = `<span class="no">You are not in \u201c${esc(s.adminGroup)}\u201d.</span> Pick one of your groups above, spelled exactly like that.`;
  else status = '<span class="no">You are not a Jira administrator.</span>';
  box.innerHTML = `Your Jira groups: ${groups}<br>Jira administrator: ${a.jiraAdmin ? 'yes' : 'no'}<br>${status}${current.isAdmin && !s.teamGroup ? '<br><span class="no">Set a team group to fill the dashboard.</span>' : ''}`;
  box.hidden = false;
}

function closeSettings() {
  $('drawer').hidden = true;
  $('drawer-backdrop').hidden = true;
}

function syncSettingsFields() {
  const auth = (document.querySelector('input[name="auth"]:checked') || {}).value;
  $('token-field').hidden = auth !== 'token';
  $('custom-field').hidden = $('f-category').value !== '__custom';
}

async function saveSettings(e) {
  e.preventDefault();
  const category = $('f-category').value === '__custom' ? $('f-custom').value.trim() : $('f-category').value;
  const result = await jwh.saveSettings({
    settings: {
      baseUrl: $('f-url').value.trim(),
      auth: (document.querySelector('input[name="auth"]:checked') || {}).value || 'browser',
      email: $('f-email').value.trim(),
      targetHours: Number($('f-target').value),
      refreshTimes: $('f-times').value,
      autoRefreshMinutes: Number($('f-refresh').value),
      overdueDays: Number($('f-overdue').value),
      adminGroup: $('f-admin-group').value.trim(),
      teamGroup: $('f-team-group').value.trim(),
      jiraAdminsAreAdmins: $('f-jira-admins').checked,
      categoryField: category,
      demo: $('f-demo').checked,
    },
    token: $('f-token').value,
    autostart: current && current.platform === 'win32' ? $('f-autostart').checked : undefined,
  });
  if (result.ok) {
    closeSettings();
  } else {
    $('settings-error').textContent = result.message;
    $('settings-error').hidden = false;
  }
}

// ------------------------------------------------------------------ wiring
$('open-settings').addEventListener('click', openSettings);
$('problem-settings').addEventListener('click', openSettings);
$('close-settings').addEventListener('click', closeSettings);
$('cancel-settings').addEventListener('click', closeSettings);
$('drawer-backdrop').addEventListener('click', closeSettings);
$('settings-form').addEventListener('submit', saveSettings);
$('settings-form').addEventListener('change', syncSettingsFields);
$('problem-signin').addEventListener('click', () => jwh.signIn());
$('problem-retry').addEventListener('click', () => jwh.refresh());
$('problem-demo').addEventListener('click', () => {
  if (!current) return;
  jwh.saveSettings({ settings: { ...current.settings, demo: true } });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drawer').hidden) closeSettings(); });

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const address = $('setup-url').value.trim();
  const error = $('setup-error');
  if (!address) { error.textContent = 'Please enter your Jira address.'; error.hidden = false; return; }
  $('setup-connect').disabled = true;
  const result = await jwh.connect(address);
  $('setup-connect').disabled = false;
  if (result.ok) { error.hidden = true; $('setup-url').value = result.baseUrl; }
  else { error.textContent = result.message; error.hidden = false; }
});
$('setup-demo').addEventListener('click', () => {
  if (!current) return;
  jwh.saveSettings({ settings: { ...current.settings, demo: true } });
});
$('disconnect').addEventListener('click', () => {
  closeSettings();
  firstSetupFocus = true;
  jwh.disconnect();
});

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => switchTab(tab.dataset.view));
$('nav-prev').addEventListener('click', () => navigate(-1));
$('nav-next').addEventListener('click', () => navigate(1));
$('nav-today').addEventListener('click', navigateToday);

function closeExportMenu() {
  $('export-menu').hidden = true;
  $('export-btn').setAttribute('aria-expanded', 'false');
}
$('export-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('export-menu').hidden;
  $('export-menu').hidden = !open;
  $('export-btn').setAttribute('aria-expanded', String(open));
  if (open) $('export-menu').querySelector('button').focus();
});
document.addEventListener('click', (e) => { if (!$('export-menu').contains(e.target)) closeExportMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExportMenu(); });
for (const item of $('export-menu').querySelectorAll('button')) {
  item.addEventListener('click', async () => {
    closeExportMenu();
    const shown = shownReport();
    if (!shown) return;
    showBanner(item.dataset.export === 'pdf' ? 'Creating the PDF report\u2026' : 'Creating the CSV\u2026', 'ok');
    const res = await jwh.exportReport(item.dataset.export, shown.weekStart);
    if (res.ok) showBanner(`Saved: ${res.filePath}`, 'ok');
    else if (res.canceled) $('banner').hidden = true;
    else showBanner(`Export failed: ${res.message}`, 'error');
  });
}

jwh.onState(render);
jwh.onOpenSettings(openSettings);
jwh.ready();
