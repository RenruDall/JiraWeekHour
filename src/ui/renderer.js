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
    banner.className = 'banner';
    banner.textContent = s.settingsWarning;
    banner.hidden = false;
  } else if (s.error && r) {
    banner.className = 'banner';
    banner.textContent = `Last update failed: ${s.error.message} Showing the data from before.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  if (blocking && !needsSetup) renderProblem(s);
  if (needsSetup && firstSetupFocus) { firstSetupFocus = false; setTimeout(() => $('setup-url').focus(), 0); }
  if (r) {
    renderWeek(r);
    renderToday(r, s);
    renderSide(r, s);
  } else if (!blocking) {
    $('days').innerHTML = '<p class="muted">Loading your worklogs…</p>';
  }

  let who = s.settings.demo ? 'Demo mode' : 'Not connected';
  if (r && r.demo) who = 'Demo mode - sample data';
  else if (r) who = `Connected as ${r.me.displayName} \u00b7 ${DEPLOYMENT_NAMES[r.deployment] || 'Jira'} \u00b7 ${hostOf(s.settings.baseUrl)}`;
  $('who').textContent = who;
  $('last').textContent = s.updating ? 'Updating…' : (s.lastUpdate ? `Last update ${time(s.lastUpdate)} (${s.lastReason})` : '');
  $('next').textContent = s.nextUpdate;

  drawTrayIcon(s.tray);
  if (firstRender) { firstRender = false; jwh.rendered(); }
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

function renderWeek(r) {
  $('range').textContent = r.weekLabel;
  $('demo-badge').hidden = !r.demo;

  $('days').innerHTML = r.days.filter((d) => d.visible).map((d) => {
    const done = d.isWorkday && d.total >= r.target;
    let pill = '<span class="pill none">-</span>';
    if (d.missing > 0) pill = `<span class="pill missing">−${h2(d.missing)}</span>`;
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

function renderToday(r, s) {
  const t = r.today;
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
    : 'Nothing missing so far this week';
  $('weekcard').innerHTML = `
    <div class="stat-row"><div class="card-title">Week</div><div class="val"><strong>${h2(r.weekTotal)}</strong> / ${esc(r.weekTarget)}h</div></div>
    <div class="thin-bar"><div style="width:${pct(r.weekTotal, r.weekTarget)}"></div></div>
    <div class="note">${esc(missingText)}</div>`;

  const max = r.categories.length ? r.categories[0].hours : 0;
  $('cats').innerHTML = `
    <div class="card-title">${esc(groupTitle)}</div>
    ${r.categories.length ? `<div class="cats">${r.categories.map((c) => `
      <div class="name" title="${esc(c.name)}">${esc(c.name)}</div>
      <div class="mini"><div style="width:${pct(c.hours, max)}"></div></div>
      <div class="hrs">${h2(c.hours)}</div>`).join('')}</div>` : '<div class="note" style="margin-top:8px">No hours logged yet this week</div>'}`;
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

jwh.onState(render);
jwh.onOpenSettings(openSettings);
jwh.ready();
