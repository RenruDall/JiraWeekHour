'use strict';
// Core logic without Electron: settings, dates, Jira loading (Cloud and Data Center),
// report building, tray info and demo data. Plain Node, covered by test/core.test.js.

const DEFAULTS = Object.freeze({
  baseUrl: '',                // empty until the user connects their Jira
  auth: 'browser',            // 'browser' = sign in once in a Jira window, 'token' = API token / personal access token
  email: '',                  // Jira Cloud API tokens need the account e-mail; leave empty for Data Center tokens
  targetHours: 8,
  categoryField: 'sprint',    // sprint, issuetype, project, components, labels or customfield_12345
  refreshTimes: ['12:00', '16:00'],
  demo: false,
});

class JiraError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'setup' | 'login' | 'auth' | 'http' | 'network' | 'data'
  }
}

// ---------------------------------------------------------------- settings
// Path segments that belong to Jira pages, not to the base address.
// ("/jira/..." pages only exist on Cloud, which is handled by its host name; on Data Center
// "/jira" is usually the context path itself, so it must not be cut.)
const JIRA_PATH_MARKERS = ['/secure/', '/browse/', '/projects/', '/rest/', '/login', '/plugins/', '/issues/', '/dashboards'];

// Turns whatever the user pastes (a board link, a ticket link, a bare host) into the Jira base address
function cleanBaseUrl(input) {
  let text = String(input || '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new Error('The Jira address is not a valid URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The Jira address must start with https://');
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new Error('The Jira address looks incomplete.');
  if (url.hostname.endsWith('.atlassian.net')) return url.origin;

  // Data Center can run under a context path like https://host/jira - keep it, drop the page part
  const path = url.pathname;
  let cut = -1;
  for (const marker of JIRA_PATH_MARKERS) {
    const i = path.indexOf(marker);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  const context = cut >= 0 ? path.slice(0, cut) : '';
  return url.origin + context.replace(/\/+$/, '');
}

function isCloudHost(baseUrl) {
  try { return new URL(baseUrl).hostname.endsWith('.atlassian.net'); } catch { return false; }
}

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const s = { ...DEFAULTS, ...src };

  const baseUrl = cleanBaseUrl(s.baseUrl);
  const auth = s.auth === 'token' ? 'token' : 'browser';
  const email = String(s.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('The e-mail address does not look right.');

  const targetHours = Number(s.targetHours);
  if (!(targetHours > 0 && targetHours <= 24)) throw new Error('The daily target must be between 0 and 24 hours.');

  const categoryField = String(s.categoryField || DEFAULTS.categoryField).trim();
  if (!/^[A-Za-z0-9_]+$/.test(categoryField)) throw new Error('The field may only contain letters, numbers and _ (for example sprint or customfield_12345).');

  let times = Array.isArray(s.refreshTimes) ? s.refreshTimes : String(s.refreshTimes || '').split(/[,; ]+/);
  times = times.map((t) => String(t).trim()).filter(Boolean);
  for (const t of times) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`"${t}" is not a valid time. Use 24h format like 12:00.`);
  }
  const refreshTimes = [...new Set(times)].sort();

  return { baseUrl, auth, email, targetHours, categoryField, refreshTimes, demo: !!s.demo };
}

// ------------------------------------------------------------------- dates
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = (d) => `${DAY_NAMES[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
const shortDate = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;

function weekOf(now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return {
    today,
    days,
    from: dateKey(days[0]),
    to: dateKey(days[6]),
    label: `${shortDate(days[0])} – ${shortDate(days[6])}.${days[6].getFullYear()}`,
  };
}

// Next automatic update, as text for the status bar
function nextUpdateText(times, now) {
  if (!times.length) return 'No automatic updates';
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const later = times.find((t) => t > hhmm);
  return later ? `Next automatic update ${later}` : `Next automatic update tomorrow ${times[0]}`;
}

// -------------------------------------------------------------------- Jira
// Turns any Jira field value (object, list, text) into readable text
function fieldText(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') {
    // Older Data Center versions send sprints as "com.atlassian.greenhopper...Sprint@1a2b[id=12,...,name=Sprint 12,...]"
    const sprint = value.match(/\[.*?\bname=([^,\]]*)/);
    if (value.includes('greenhopper') && sprint) return sprint[1];
    return value || '-';
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? value.map(fieldText).join(', ') : '-';
  for (const prop of ['name', 'value', 'displayName', 'key']) {
    if (value[prop] !== undefined && value[prop] !== null) return String(value[prop]);
  }
  return '-';
}

// Sprint: an issue carried over from earlier sprints lists them all; the last one is the current one
function sprintText(value) {
  if (Array.isArray(value)) return value.length ? fieldText(value[value.length - 1]) : 'No sprint';
  return value ? fieldText(value) : 'No sprint';
}

// Wraps a fetch function (Node fetch or Electron session.fetch) for Jira JSON calls
function makeJsonFetcher(fetchFn, baseUrl, extraHeaders = {}) {
  return async function fetchJson(path) {
    let res;
    try {
      res = await fetchFn(baseUrl + path, { headers: { Accept: 'application/json', ...extraHeaders } });
    } catch (err) {
      throw new JiraError('network', `Jira could not be reached (${err.message}). Check the address and your network or VPN.`);
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (res.status === 401 || res.status === 403) {
      throw new JiraError('auth', `Jira refused access (HTTP ${res.status}). Sign in again or check your token.`);
    }
    if (!res.ok) throw new JiraError('http', `Jira answered with HTTP ${res.status}.`);
    if (!type.includes('json')) {
      throw new JiraError('login', 'Jira showed a login page instead of data. Please sign in to Jira.');
    }
    try { return await res.json(); } catch { throw new JiraError('data', 'Jira sent data that could not be read.'); }
  };
}

// Jira Cloud and Data Center use different search endpoints; serverInfo tells which one we talk to
async function detectDeployment(fetchJson, baseUrl) {
  if (isCloudHost(baseUrl)) return 'cloud';
  try {
    const info = await fetchJson('/rest/api/2/serverInfo');
    return info && info.deploymentType === 'Cloud' ? 'cloud' : 'server';
  } catch (err) {
    if (err.kind === 'network') throw err;
    return 'server';
  }
}

// The Sprint field is a custom field with a different ID on every Jira; look it up by its type
async function resolveCategoryField(fetchJson, api, categoryField) {
  if (categoryField !== 'sprint') return { id: categoryField, isSprint: false };
  const fields = await fetchJson(`/rest/api/${api}/field`);
  const sprint = (Array.isArray(fields) ? fields : []).find((f) => f && f.schema && f.schema.custom === 'com.pyxis.greenhopper.jira:gh-sprint');
  return { id: sprint ? sprint.id : null, isSprint: true };
}

async function searchIssues(fetchJson, deployment, jql, fields) {
  const issues = [];
  const q = `jql=${encodeURIComponent(jql)}&fields=${encodeURIComponent(fields)}&maxResults=100`;
  if (deployment === 'cloud') {
    // Jira Cloud: /search/jql with token-based paging (the old /search endpoint was retired)
    let token = null;
    for (let guard = 0; guard < 100; guard++) {
      const page = await fetchJson(`/rest/api/3/search/jql?${q}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`);
      issues.push(...(Array.isArray(page.issues) ? page.issues : []));
      token = page.nextPageToken;
      if (!token || page.isLast) break;
    }
  } else {
    for (let startAt = 0; ;) {
      const page = await fetchJson(`/rest/api/2/search?${q}&startAt=${startAt}`);
      const got = Array.isArray(page.issues) ? page.issues : [];
      issues.push(...got);
      startAt += got.length;
      if (!got.length || startAt >= (page.total || 0)) break;
    }
  }
  return issues;
}

async function loadEntries(fetchJson, deployment, settings, week, me) {
  const api = deployment === 'cloud' ? 3 : 2;
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${week.from}" AND worklogDate <= "${week.to}"`;
  const category = await resolveCategoryField(fetchJson, api, settings.categoryField);
  const issues = await searchIssues(fetchJson, deployment, jql, category.id ? `summary,${category.id}` : 'summary');

  const isMine = (a) => !!a && ((me.accountId && a.accountId === me.accountId) || (me.key && a.key === me.key) || (me.name && a.name === me.name));
  const entries = [];
  for (const issue of issues) {
    const raw = issue.fields && category.id ? issue.fields[category.id] : null;
    const categoryText = category.isSprint ? sprintText(raw) : fieldText(raw);
    const summary = issue.fields && issue.fields.summary ? String(issue.fields.summary) : '';
    const seenIds = new Set();
    for (let startAt = 0; ;) {
      const wl = await fetchJson(`/rest/api/${api}/issue/${encodeURIComponent(issue.key)}/worklog?startAt=${startAt}&maxResults=1000`);
      const logs = Array.isArray(wl.worklogs) ? wl.worklogs : [];
      // Never count the same worklog twice, even if a page repeats
      const fresh = logs.filter((w) => w.id === undefined || !seenIds.has(String(w.id)));
      if (logs.length && !fresh.length) break;
      for (const w of fresh) {
        if (w.id !== undefined) seenIds.add(String(w.id));
        if (!isMine(w.author)) continue;
        const day = String(w.started || '').slice(0, 10);
        if (day < week.from || day > week.to) continue;
        entries.push({ day, key: issue.key, summary, category: categoryText, hours: (Number(w.timeSpentSeconds) || 0) / 3600 });
      }
      startAt += logs.length;
      if (!logs.length || startAt >= (wl.total || 0)) break;
    }
  }
  return entries;
}

async function loadReport(fetchJson, settings, now) {
  if (!settings.baseUrl) throw new JiraError('setup', 'No Jira connected yet.');
  const deployment = await detectDeployment(fetchJson, settings.baseUrl);
  const me = await fetchJson(`/rest/api/${deployment === 'cloud' ? 3 : 2}/myself`);
  const week = weekOf(now);
  const entries = await loadEntries(fetchJson, deployment, settings, week, me);
  const report = buildReport(entries, { displayName: me.displayName || me.name || 'you' }, settings, now);
  report.deployment = deployment;
  return report;
}

// ------------------------------------------------------------------ report
const round2 = (n) => Math.round(n * 100) / 100;

function buildReport(entries, me, settings, now, opts = {}) {
  const week = weekOf(now);
  const target = settings.targetHours;
  const todayKey = dateKey(week.today);

  const days = week.days.map((d, i) => {
    const key = dateKey(d);
    const byTicket = new Map();
    for (const e of entries) {
      if (e.day !== key) continue;
      const t = byTicket.get(e.key) || { key: e.key, summary: e.summary, category: e.category, hours: 0 };
      t.hours += e.hours;
      byTicket.set(e.key, t);
    }
    const tickets = [...byTicket.values()].map((t) => ({ ...t, hours: round2(t.hours) })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    const total = round2(tickets.reduce((sum, t) => sum + t.hours, 0));

    // Per day: one group per sprint (or chosen field), biggest first
    const groupMap = new Map();
    for (const t of tickets) {
      const g = groupMap.get(t.category) || { name: t.category, hours: 0, tickets: [] };
      g.hours += t.hours;
      g.tickets.push(t);
      groupMap.set(t.category, g);
    }
    const groups = [...groupMap.values()].map((g) => ({ ...g, hours: round2(g.hours) })).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name));

    const isToday = key === todayKey;
    const isWorkday = i < 5 || (isToday && opts.forceWorkday);
    const isFuture = key > todayKey;
    const missing = isWorkday && !isFuture && total < target ? round2(target - total) : 0;
    return { date: key, label: dayLabel(d), isToday, isWorkday, isFuture, total, missing, tickets, groups, visible: isWorkday || total > 0 };
  });

  const today = days.find((d) => d.isToday);
  const categories = new Map();
  for (const e of entries) categories.set(e.category, (categories.get(e.category) || 0) + e.hours);

  return {
    me,
    demo: !!opts.demo,
    weekLabel: week.label,
    target,
    days,
    today: {
      label: today.label,
      logged: today.total,
      missing: today.isWorkday ? round2(Math.max(0, target - today.total)) : 0,
      isWeekend: !today.isWorkday,
    },
    weekTotal: round2(days.reduce((sum, d) => sum + d.total, 0)),
    weekTarget: target * 5,
    categories: [...categories.entries()].map(([name, hours]) => ({ name, hours: round2(hours) })).sort((a, b) => b.hours - a.hours),
    missingDays: days.filter((d) => d.missing > 0).map((d) => ({ label: d.label, missing: d.missing })),
  };
}

// ---------------------------------------------------------------- tray info
function formatRemaining(hours) {
  const up = Math.ceil(hours * 10 - 1e-9) / 10; // round up: 0.25h left shows 0.3
  return Number.isInteger(up) ? String(up) : up.toFixed(1);
}

function trayInfo(report, error) {
  if (error && error.kind === 'setup') return { text: '?', color: 'gray', tooltip: 'Jira Week Hours: click to connect your Jira' };
  if (error) return { text: '!', color: 'red', tooltip: 'Jira hours: not reachable - click for details' };
  if (!report) return { text: '…', color: 'gray', tooltip: 'Jira hours: loading…' };
  const t = report.today;
  if (t.isWeekend) return { text: '–', color: 'gray', tooltip: `Jira hours: weekend (${t.logged.toFixed(1)}h logged)` };
  if (t.missing <= 0) return { text: 'check', color: 'green', tooltip: `Jira hours: ${t.logged.toFixed(1)}h logged - done for today` };
  return { text: formatRemaining(t.missing), color: 'amber', tooltip: `Jira hours: ${t.logged.toFixed(1)}h logged - ${t.missing.toFixed(1)}h remaining` };
}

// -------------------------------------------------------------------- demo
const DEMO_TICKETS = {
  'IT-101': { summary: 'Firewall rule review', category: 'Task', sprint: 'Sprint 12' },
  'IT-104': { summary: 'VPN client rollout', category: 'Change', sprint: 'Sprint 12' },
  'IT-117': { summary: 'Endpoint compliance policy', category: 'Task', sprint: 'Sprint 11' },
  'IT-123': { summary: 'Print server outage', category: 'Incident', sprint: 'No sprint' },
};
const DEMO_WEEK = [
  [['IT-101', 4], ['IT-104', 2.5]],
  [['IT-101', 3], ['IT-117', 5]],
  [['IT-117', 2], ['IT-123', 6]],
  [['IT-101', 2.75], ['IT-123', 4.5]],
  [['IT-101', 4], ['IT-117', 4]],
  [],
  [],
];

// Sample week around today; each manual update in demo mode adds 0.5h to today
function demoReport(now, bumps, settings) {
  const week = weekOf(now);
  const todayIndex = (week.today.getDay() + 6) % 7;
  const entries = [];
  const add = (dayIndex, key, hours) => {
    const t = DEMO_TICKETS[key];
    entries.push({ day: dateKey(week.days[dayIndex]), key, hours, summary: t.summary, category: settings.categoryField === 'sprint' ? t.sprint : t.category });
  };
  for (let i = 0; i < todayIndex; i++) for (const [key, hours] of DEMO_WEEK[i]) add(i, key, hours);
  add(todayIndex, 'IT-104', 2);
  add(todayIndex, 'IT-117', 3);
  if (bumps > 0) add(todayIndex, 'IT-123', Math.min(bumps * 0.5, 6));
  const report = buildReport(entries, { displayName: 'Demo user' }, settings, now, { forceWorkday: true, demo: true });
  report.deployment = 'demo';
  return report;
}

module.exports = {
  DEFAULTS, JiraError, cleanBaseUrl, normalizeSettings, weekOf, dateKey, nextUpdateText, fieldText, sprintText,
  makeJsonFetcher, detectDeployment, loadReport, buildReport, trayInfo, formatRemaining, demoReport,
};
