'use strict';
// Core logic without Electron: settings, dates, Jira loading (Cloud and Data Center),
// report building, tray info and demo data. Plain Node, covered by test/core.test.js.

const DEFAULTS = Object.freeze({
  baseUrl: '',                // empty until the user connects their Jira
  auth: 'browser',            // 'browser' = sign in once in a Jira window, 'token' = API token / personal access token
  email: '',                  // Jira Cloud API tokens need the account e-mail; leave empty for Data Center tokens
  targetHours: 8,
  categoryField: 'sprint',    // sprint, issuetype, project, components, labels or customfield_12345
  refreshTimes: ['12:00', '16:00'], // reminder times: update + notification if hours are missing
  autoRefreshMinutes: 60,     // silent background update; 0 = off
  overdueDays: 3,             // a task counts as overdue when its due date is more than this many days ago
  adminGroup: '',             // members of this Jira group see the team dashboard (empty = off)
  teamGroup: '',              // the Jira group whose members the team dashboard shows
  jiraAdminsAreAdmins: false, // also treat Jira administrators (global permission) as dashboard admins
  demo: false,
});

const REFRESH_CHOICES = [0, 15, 30, 60, 120, 240];

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

  const autoRefreshMinutes = Number(s.autoRefreshMinutes);
  if (!REFRESH_CHOICES.includes(autoRefreshMinutes)) throw new Error(`The refresh rate must be one of ${REFRESH_CHOICES.join(', ')} minutes.`);

  const overdueDays = Number(s.overdueDays);
  if (!(Number.isInteger(overdueDays) && overdueDays >= 0 && overdueDays <= 365)) throw new Error('"Overdue after" must be a whole number of days between 0 and 365.');
  const adminGroup = String(s.adminGroup || '').trim().slice(0, 255);
  const teamGroup = String(s.teamGroup || '').trim().slice(0, 255);

  const jiraAdminsAreAdmins = s.jiraAdminsAreAdmins === true || s.jiraAdminsAreAdmins === 'true' || s.jiraAdminsAreAdmins === '1' || s.jiraAdminsAreAdmins === 1;

  return { baseUrl, auth, email, targetHours, categoryField, refreshTimes, autoRefreshMinutes, overdueDays, adminGroup, teamGroup, jiraAdminsAreAdmins, demo: !!s.demo };
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

// Parses "2026-09-21" as a local date
function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ISO 8601 week number (weeks start on Monday, week 1 contains the first Thursday)
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

// The calendar grid for a month: whole weeks from the Monday before the 1st to the Sunday after the last day
function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const start = weekOf(first).days[0];
  const end = weekOf(last).days[6];
  return { from: dateKey(start), to: dateKey(end), start, end, first, last };
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
    for (let startAt = 0, guard = 0; guard < 200; guard++) {
      const page = await fetchJson(`/rest/api/2/search?${q}&startAt=${startAt}`);
      const got = Array.isArray(page.issues) ? page.issues : [];
      issues.push(...got);
      startAt += got.length;
      if (!got.length || startAt >= (page.total || 0)) break;
    }
  }
  // Never list the same issue twice, even if a server repeats a page
  const seen = new Set();
  return issues.filter((i) => i && i.key && !seen.has(i.key) && seen.add(i.key));
}

// Worklog comments: plain text on Data Center, Atlassian Document Format (JSON) on Cloud
function commentText(comment) {
  if (!comment) return '';
  if (typeof comment === 'string') return comment.trim();
  const parts = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && node.text) parts.push(node.text);
    if (node.type === 'hardBreak') parts.push('\n');
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
      if (['paragraph', 'heading', 'listItem'].includes(node.type)) parts.push('\n');
    }
  };
  walk(comment);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// Who we are and which Jira we talk to; done once per session, then reused for every date range
async function connect(fetchJson, settings) {
  if (!settings.baseUrl) throw new JiraError('setup', 'No Jira connected yet.');
  const deployment = await detectDeployment(fetchJson, settings.baseUrl);
  const api = deployment === 'cloud' ? 3 : 2;
  const me = await fetchJson(`/rest/api/${api}/myself?expand=groups`);
  const category = await resolveCategoryField(fetchJson, api, settings.categoryField);
  const groupNames = (me.groups && Array.isArray(me.groups.items) ? me.groups.items : []).map((g) => String(g.name || '')).filter(Boolean).sort((a, b) => a.localeCompare(b));
  // Jira administrator (global "Administer Jira" permission), whatever the admin group is called
  let jiraAdmin = false;
  try {
    const perms = await fetchJson(`/rest/api/${api}/mypermissions?permissions=ADMINISTER`);
    jiraAdmin = !!(perms && perms.permissions && perms.permissions.ADMINISTER && perms.permissions.ADMINISTER.havePermission);
  } catch (err) {
    if (err.kind === 'network') throw err;
  }
  return { deployment, api, me, category, groupNames, groups: groupNames.map((g) => g.toLowerCase()), jiraAdmin, displayName: me.displayName || me.name || 'you' };
}

// Admin = member of the configured Jira group, or (if allowed in settings) a Jira administrator.
// Both are checked by Jira, not by the app.
function isAdminOf(ctx, adminGroup, allowJiraAdmins = false) {
  if (!ctx) return false;
  if (allowJiraAdmins && ctx.jiraAdmin) return true;
  return !!(adminGroup && Array.isArray(ctx.groups) && ctx.groups.includes(String(adminGroup).trim().toLowerCase()));
}

const userKey = (u) => (u ? String(u.accountId || u.key || u.name || '') : '');
const jqlString = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Members of a Jira group. Returns null when Jira does not allow listing groups (then the
// dashboard falls back to everyone who logged time).
async function loadGroupMembers(fetchJson, ctx, group) {
  const members = [];
  try {
    for (let startAt = 0, guard = 0; guard < 40; guard++) {
      const page = await fetchJson(`/rest/api/${ctx.api}/group/member?groupname=${encodeURIComponent(group)}&includeInactiveUsers=false&startAt=${startAt}&maxResults=50`);
      const values = Array.isArray(page.values) ? page.values : [];
      for (const u of values) {
        if (u.active === false) continue;
        members.push({ id: userKey(u), displayName: u.displayName || u.name || userKey(u) });
      }
      startAt += values.length;
      if (!values.length || page.isLast || startAt >= (page.total || 0)) break;
    }
  } catch (err) {
    if (err.kind === 'auth' || err.kind === 'http') return null;
    throw err;
  }
  return members.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// Worklogs between two dates (inclusive, "YYYY-MM-DD"): mine, or a whole group's (opts.group)
async function loadEntriesRange(fetchJson, ctx, from, to, opts = {}) {
  const who = opts.group ? `worklogAuthor in membersOf(${jqlString(opts.group)})` : 'worklogAuthor = currentUser()';
  const jql = `${who} AND worklogDate >= "${from}" AND worklogDate <= "${to}"`;
  const { category, me, api } = ctx;
  const issues = await searchIssues(fetchJson, ctx.deployment, jql, category.id ? `summary,${category.id}` : 'summary');

  const isMine = (a) => !!a && ((me.accountId && a.accountId === me.accountId) || (me.key && a.key === me.key) || (me.name && a.name === me.name));
  // Team mode: keep entries of group members (or of everyone found, when the member list is unknown)
  const memberIds = opts.members ? new Set(opts.members.map((m) => m.id)) : null;
  const wanted = opts.group ? (a) => !!a && (!memberIds || memberIds.has(userKey(a))) : isMine;
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
        if (!wanted(w.author)) continue;
        const started = String(w.started || '');
        const day = started.slice(0, 10);
        if (day < from || day > to) continue;
        entries.push({
          id: w.id !== undefined ? String(w.id) : `${issue.key}-${started}`,
          day,
          time: /T\d\d:\d\d/.test(started) ? started.slice(11, 16) : '',
          key: issue.key,
          summary,
          category: categoryText,
          hours: (Number(w.timeSpentSeconds) || 0) / 3600,
          comment: commentText(w.comment),
          user: userKey(w.author),
          userName: (w.author && (w.author.displayName || w.author.name)) || '',
        });
      }
      startAt += logs.length;
      if (!logs.length || startAt >= (wl.total || 0)) break;
    }
  }
  return entries;
}

// Current week in one call (used by tests and the first load)
async function loadReport(fetchJson, settings, now) {
  const ctx = await connect(fetchJson, settings);
  const week = weekOf(now);
  const entries = await loadEntriesRange(fetchJson, ctx, week.from, week.to);
  const report = buildReport(entries, { displayName: ctx.displayName }, settings, now);
  report.deployment = ctx.deployment;
  return report;
}

// Unresolved tasks whose due date is more than settings.overdueDays days ago
async function loadOverdue(fetchJson, ctx, settings, now, opts = {}) {
  const who = opts.group ? `assignee in membersOf(${jqlString(opts.group)})` : 'assignee = currentUser()';
  const jql = `${who} AND resolution = Unresolved AND duedate < startOfDay("-${settings.overdueDays}d") ORDER BY duedate ASC`;
  const issues = await searchIssues(fetchJson, ctx.deployment, jql, 'summary,duedate,assignee,status,priority');
  return overdueItems(issues.map((i) => ({
    key: i.key,
    summary: (i.fields && i.fields.summary) || '',
    due: (i.fields && i.fields.duedate) || '',
    assignee: (i.fields && i.fields.assignee && (i.fields.assignee.displayName || i.fields.assignee.name)) || 'Unassigned',
    status: (i.fields && i.fields.status && i.fields.status.name) || '',
    priority: (i.fields && i.fields.priority && i.fields.priority.name) || '',
  })), settings, now);
}

function overdueItems(items, settings, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return items
    .map((it) => {
      const due = parseDateKey(String(it.due).slice(0, 10));
      return { ...it, due: due ? dateKey(due) : '', daysOverdue: due ? Math.round((today - due) / 86400000) : 0 };
    })
    .filter((it) => it.due && it.daysOverdue > settings.overdueDays)
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.key.localeCompare(b.key, undefined, { numeric: true }))
    .slice(0, 200);
}

// ------------------------------------------------------------------ report
const round2 = (n) => Math.round(n * 100) / 100;
const byTime = (a, b) => (a.day + a.time).localeCompare(b.day + b.time) || a.key.localeCompare(b.key, undefined, { numeric: true });

// Week report for the week containing opts.weekDate (default: the current week)
function buildReport(entries, me, settings, now, opts = {}) {
  const week = weekOf(opts.weekDate || now);
  const current = weekOf(now);
  const target = settings.targetHours;
  const todayKey = dateKey(current.today);
  const weekEntries = entries.filter((e) => e.day >= week.from && e.day <= week.to);

  const days = week.days.map((d, i) => {
    const key = dateKey(d);
    const byTicket = new Map();
    for (const e of weekEntries) {
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

  const sumBy = (field) => {
    const map = new Map();
    for (const e of weekEntries) {
      const k = e[field];
      const cur = map.get(k) || { name: k, hours: 0, summary: e.summary, category: e.category };
      cur.hours += e.hours;
      map.set(k, cur);
    }
    return [...map.values()].map((x) => ({ ...x, hours: round2(x.hours) })).sort((a, b) => b.hours - a.hours || String(a.name).localeCompare(String(b.name)));
  };

  // Today always refers to the real today, even while an older week is shown
  const todayEntries = entries.filter((e) => e.day === todayKey);
  const todayLogged = round2(todayEntries.reduce((sum, e) => sum + e.hours, 0));
  const todayIsWorkday = ((current.today.getDay() + 6) % 7) < 5 || !!opts.forceWorkday;
  const todayInWeek = week.from === current.from;

  return {
    me,
    demo: !!opts.demo,
    weekStart: week.from,
    weekEnd: week.to,
    weekNumber: isoWeek(week.days[0]),
    weekLabel: week.label,
    isCurrentWeek: todayInWeek,
    isFutureWeek: week.from > current.from,
    target,
    days,
    today: todayInWeek ? {
      label: dayLabel(current.today),
      logged: todayLogged,
      missing: todayIsWorkday ? round2(Math.max(0, target - todayLogged)) : 0,
      isWeekend: !todayIsWorkday,
    } : null,
    weekTotal: round2(days.reduce((sum, d) => sum + d.total, 0)),
    weekTarget: target * 5,
    categories: sumBy('category').map(({ name, hours }) => ({ name, hours })),
    tickets: sumBy('key').map(({ name, hours, summary, category }) => ({ key: name, hours, summary, category })),
    missingDays: days.filter((d) => d.missing > 0).map((d) => ({ label: d.label, missing: d.missing })),
    log: [...weekEntries].sort(byTime).map((e) => ({ ...e, hours: round2(e.hours) })),
  };
}

// Month calendar: every day of the grid with its total and a status for colouring
function buildMonth(entries, settings, now, year, month) {
  const grid = monthGrid(year, month);
  const todayKey = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const totals = new Map();
  for (const e of entries) totals.set(e.day, (totals.get(e.day) || 0) + e.hours);

  const weeks = [];
  for (let d = new Date(grid.start); d <= grid.end; d.setDate(d.getDate() + 7)) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(d);
      day.setDate(d.getDate() + i);
      const key = dateKey(day);
      const total = round2(totals.get(key) || 0);
      const isWorkday = i < 5;
      const isFuture = key > todayKey;
      let status = 'none';
      if (isFuture) status = 'future';
      else if (!isWorkday) status = total > 0 ? 'weekend-logged' : 'weekend';
      else if (total >= settings.targetHours) status = 'done';
      else if (total > 0) status = 'partial';
      else status = 'missing';
      days.push({ date: key, day: day.getDate(), inMonth: day.getMonth() === month, isToday: key === todayKey, total, status });
    }
    const monday = new Date(d);
    weeks.push({
      weekStart: dateKey(monday),
      weekNumber: isoWeek(monday),
      total: round2(days.reduce((s, x) => s + x.total, 0)),
      days,
    });
  }
  const inMonth = weeks.flatMap((w) => w.days).filter((x) => x.inMonth);
  return {
    year,
    month,
    label: new Date(year, month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    weeks,
    monthTotal: round2(inMonth.reduce((s, x) => s + x.total, 0)),
    missingDays: inMonth.filter((x) => x.status === 'missing' || x.status === 'partial').length,
    pastWorkdays: inMonth.filter((x) => ['done', 'missing', 'partial'].includes(x.status)).length,
  };
}

// Team dashboard: one row per member, one cell per day, plus each member's own week report
function buildTeamWeek(entries, members, settings, now, opts = {}) {
  const week = weekOf(opts.weekDate || now);
  const current = weekOf(now);
  const todayKey = dateKey(current.today);
  const knownMembers = members && members.length ? members : null;
  const list = knownMembers || [...new Map(entries.map((e) => [e.user, { id: e.user, displayName: e.userName || e.user }])).values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const rows = list.map((m) => {
    const mine = entries.filter((e) => e.user === m.id && e.day >= week.from && e.day <= week.to);
    const report = buildReport(mine, { displayName: m.displayName }, settings, now, { weekDate: week.days[0] });
    const days = report.days.map((d, i) => {
      const isWorkday = i < 5;
      let status;
      if (d.isFuture) status = 'future';
      else if (!isWorkday) status = d.total > 0 ? 'weekend-logged' : 'weekend';
      else if (d.total >= settings.targetHours) status = 'done';
      else if (d.total > 0) status = 'partial';
      else status = 'missing';
      return { date: d.date, total: d.total, status, isToday: d.date === todayKey };
    });
    return {
      id: m.id,
      displayName: m.displayName,
      days,
      total: report.weekTotal,
      missing: round2(report.missingDays.reduce((s, d) => s + d.missing, 0)),
      today: days.find((d) => d.isToday) || null,
      report,
    };
  });

  const isCurrent = week.from === current.from;
  return {
    weekStart: week.from,
    weekNumber: isoWeek(week.days[0]),
    weekLabel: week.label,
    isCurrentWeek: isCurrent,
    dayLabels: week.days.map((d) => dayLabel(d)),
    target: settings.targetHours,
    membersKnown: !!knownMembers,
    rows,
    totals: {
      hours: round2(rows.reduce((s, r) => s + r.total, 0)),
      missing: round2(rows.reduce((s, r) => s + r.missing, 0)),
      onTargetToday: isCurrent ? rows.filter((r) => r.today && r.today.total >= settings.targetHours).length : null,
      members: rows.length,
    },
  };
}

// ---------------------------------------------------------------- work clock
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
const hhmm = (min) => `${pad(Math.floor(Math.round(min) / 60) % 24)}:${pad(Math.round(min) % 60)}`;

// When did today's work start? The earliest sign of the PC being in use today:
// Windows start (if it was today), the app starting, or the first unlock / wake-up today.
// A start the user corrected by hand always wins.
function pickClockStart({ now, bootTime, appStart, firstActive, manual }) {
  const todayKey = dateKey(now);
  const isToday = (d) => d instanceof Date && !Number.isNaN(d.getTime()) && dateKey(d) === todayKey && d <= now;
  if (isToday(manual)) return manual;
  const candidates = [bootTime, appStart, firstActive].filter(isToday);
  return candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : null;
}

// Today's timeline from the clock start until now: booked in Jira (green), not booked (amber),
// pauses (screen locked / PC asleep: shown, not subtracted) and breaks (the Pause button:
// subtracted from the time at work).
function buildWorkday({ start, now, pauses = [], entries = [] }) {
  const todayKey = dateKey(now);
  const nowMin = minutesOf(now);
  const today = entries.filter((e) => e.day === todayKey);
  const bookedHours = round2(today.reduce((s, e) => s + e.hours, 0));
  if (!start) return { running: false, bookedHours };

  const startMin = dateKey(start) === todayKey ? minutesOf(start) : 0;
  const booked = today
    .filter((e) => /^\d\d:\d\d$/.test(e.time || ''))
    .map((e) => {
      const from = Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3, 5));
      return { from, to: Math.min(24 * 60, from + e.hours * 60), key: e.key, summary: e.summary };
    })
    .sort((a, b) => a.from - b.from);
  const pauseIv = pauses
    .map((p) => {
      const from = p.from ? (dateKey(p.from) === todayKey ? minutesOf(p.from) : 0) : null;
      const to = p.to ? (dateKey(p.to) === todayKey ? minutesOf(p.to) : null) : nowMin;
      // a pause that started this very minute is still a pause (length 0 for now)
      if (from === null || to === null || to < from || (to === from && p.to)) return null;
      return { from: Math.max(from, startMin), to: Math.min(to, nowMin), kind: p.kind || 'lock', ongoing: !p.to };
    })
    .filter((p) => p && (p.to > p.from || p.ongoing));

  const rangeFrom = Math.min(startMin, ...booked.map((b) => b.from));
  const rangeTo = Math.max(nowMin, ...booked.map((b) => b.to));
  const points = new Set([rangeFrom, rangeTo, startMin, nowMin]);
  for (const iv of [...booked, ...pauseIv]) { points.add(iv.from); points.add(iv.to); }
  const sorted = [...points].filter((x) => x >= rangeFrom && x <= rangeTo).sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b - a < 0.01) continue;
    const mid = (a + b) / 2;
    const bk = booked.find((x) => x.from <= mid && x.to > mid);
    let seg;
    if (bk) seg = { kind: 'booked', key: bk.key, summary: bk.summary };
    else if (mid < startMin || mid > nowMin) continue; // outside the workday, nothing booked
    else if (pauseIv.some((p) => p.kind === 'manual' && p.from <= mid && p.to > mid)) seg = { kind: 'break' };
    else if (pauseIv.some((p) => p.from <= mid && p.to > mid)) seg = { kind: 'pause' };
    else seg = { kind: 'open' };
    const last = segments[segments.length - 1];
    if (last && last.kind === seg.kind && last.key === seg.key && Math.abs(last.toMin - a) < 0.01) last.toMin = b;
    else segments.push({ ...seg, fromMin: a, toMin: b });
  }
  for (const sg of segments) {
    sg.from = hhmm(sg.fromMin);
    sg.to = hhmm(sg.toMin);
    sg.minutes = Math.round(sg.toMin - sg.fromMin);
  }

  const auto = pauseIv.filter((p) => p.kind !== 'manual');
  const manual = pauseIv.filter((p) => p.kind === 'manual');
  const breakMinutes = Math.round(manual.reduce((s, p) => s + (p.to - p.from), 0));
  const elapsedHours = round2(Math.max(0, nowMin - startMin - breakMinutes) / 60);
  const pauseMinutes = Math.round(auto.reduce((s, p) => s + (p.to - p.from), 0));
  const onBreak = manual.find((p) => p.ongoing);
  return {
    running: true,
    start: hhmm(startMin),
    now: hhmm(nowMin),
    elapsedHours,
    bookedHours,
    openHours: round2(Math.max(0, elapsedHours - bookedHours)),
    pauseMinutes,
    breakMinutes,
    onBreak: onBreak ? hhmm(onBreak.from) : null,
    rangeFrom,
    rangeTo,
    segments,
    gaps: segments.filter((sg) => sg.kind === 'open' && sg.minutes >= 5).map(({ from, to, minutes }) => ({ from, to, minutes })),
    pauses: auto.map((p) => ({ from: hhmm(p.from), to: p.ongoing ? null : hhmm(p.to), minutes: Math.round(p.to - p.from), kind: p.kind })),
    breaks: manual.map((p) => ({ from: hhmm(p.from), to: p.ongoing ? null : hhmm(p.to), minutes: Math.round(p.to - p.from) })),
  };
}

const formatMinutes = (min) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`;
};

// ---------------------------------------------------------------- tray info
function formatRemaining(hours) {
  const up = Math.ceil(hours * 10 - 1e-9) / 10; // round up: 0.25h left shows 0.3
  return Number.isInteger(up) ? String(up) : up.toFixed(1);
}

function trayInfo(report, error) {
  if (error && error.kind === 'setup') return { text: '?', color: 'gray', tooltip: 'Jira Week Hours: click to connect your Jira' };
  if (error) return { text: '!', color: 'red', tooltip: 'Jira hours: not reachable - click for details' };
  if (!report || !report.today) return { text: '\u2026', color: 'gray', tooltip: 'Jira hours: loading\u2026' };
  const t = report.today;
  if (t.isWeekend) return { text: '\u2013', color: 'gray', tooltip: `Jira hours: weekend (${t.logged.toFixed(1)}h logged)` };
  if (t.missing <= 0) return { text: 'check', color: 'green', tooltip: `Jira hours: ${t.logged.toFixed(1)}h logged - done for today` };
  return { text: formatRemaining(t.missing), color: 'amber', tooltip: `Jira hours: ${t.logged.toFixed(1)}h logged - ${t.missing.toFixed(1)}h remaining` };
}

// -------------------------------------------------------------------- export
const csvCell = (v) => {
  const text = String(v === undefined || v === null ? '' : v);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// Semicolon-separated with a BOM, so Excel in German/Italian locales opens it in columns with umlauts intact
function exportCsv(report) {
  const rows = [['Date', 'Start', 'Ticket', 'Summary', 'Sprint / category', 'Hours', 'Comment']];
  for (const e of report.log) rows.push([e.day, e.time, e.key, e.summary, e.category, e.hours.toFixed(2).replace('.', ','), e.comment]);
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

// -------------------------------------------------------------------- demo
const DEMO_TICKETS = {
  'IT-101': { summary: 'Firewall rule review', category: 'Task', sprint: 'Sprint 12' },
  'IT-104': { summary: 'VPN client rollout', category: 'Change', sprint: 'Sprint 12' },
  'IT-117': { summary: 'Endpoint compliance policy', category: 'Task', sprint: 'Sprint 11' },
  'IT-123': { summary: 'Print server outage', category: 'Incident', sprint: 'No sprint' },
  'IT-130': { summary: 'Backup restore test', category: 'Task', sprint: 'Sprint 11' },
  'IT-135': { summary: 'Onboarding new laptops', category: 'Service request', sprint: 'Sprint 12' },
};
const DEMO_COMMENTS = {
  'IT-101': ['Reviewed inbound rules for the DMZ', 'Cleaned up unused NAT rules', 'Change request prepared'],
  'IT-104': ['Rolled out to pilot group', 'Fixed MFA prompt issue', 'Updated rollout guide'],
  'IT-117': ['Compliance baseline drafted', 'Tested policy on test devices', 'Exceptions documented'],
  'IT-123': ['Spooler restarted, queue cleared', 'Root cause: driver update', 'Monitoring added'],
  'IT-130': ['Restored file server share to test VM', 'Verified restore times'],
  'IT-135': ['Prepared 4 laptops', 'Autopilot profile assigned'],
};
// Typical days: [ticket, hours, start time]
const DEMO_DAYS = [
  [['IT-101', 4, '08:30'], ['IT-104', 2.5, '13:30']],
  [['IT-101', 3, '08:15'], ['IT-117', 5, '11:30']],
  [['IT-117', 2, '08:45'], ['IT-123', 6, '10:45']],
  [['IT-101', 2.75, '08:30'], ['IT-123', 4.5, '11:30']],
  [['IT-101', 4, '08:00'], ['IT-117', 4, '12:30']],
  [['IT-130', 3.5, '08:30'], ['IT-135', 4.5, '12:30']],
  [['IT-104', 5, '08:15'], ['IT-130', 3, '13:45']],
  [['IT-135', 2, '08:30'], ['IT-101', 3.5, '10:45'], ['IT-117', 2.5, '14:30']],
];

// Same date, same demo day: a small stable hash of the date picks the pattern
function demoPattern(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

// Sample worklogs for any date range; today has 5h plus 0.5h per manual update
function demoEntries(from, to, now, bumps) {
  const todayKey = dateKey(now);
  const entries = [];
  const add = (day, key, hours, time) => {
    const t = DEMO_TICKETS[key];
    const comments = DEMO_COMMENTS[key] || [''];
    const comment = comments[demoPattern(day + key) % comments.length];
    entries.push({ id: `${day}-${key}-${time}`, day, time, key, hours, summary: t.summary, category: t.category, sprint: t.sprint, comment });
  };
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = dateKey(d);
    if (key > todayKey) break;
    if (key === todayKey) {
      // today's sample bookings never reach past the current time
      const nowMin = now.getHours() * 60 + now.getMinutes();
      for (const [ticket, hours, time] of [['IT-104', 2, '08:30'], ['IT-117', 3, '10:45']]) {
        const startMin = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
        const upToNow = Math.floor(((nowMin - startMin) / 60) * 4) / 4;
        if (upToNow > 0) add(key, ticket, Math.min(hours, upToNow), time);
      }
      if (bumps > 0) add(key, 'IT-123', Math.min(bumps * 0.5, 6), '14:00');
      continue;
    }
    if ((d.getDay() + 6) % 7 >= 5) continue; // no weekend work in the demo
    for (const [ticket, hours, time] of DEMO_DAYS[demoPattern(key) % DEMO_DAYS.length]) add(key, ticket, hours, time);
  }
  return entries;
}

function demoForSettings(entries, settings) {
  return entries.map((e) => ({ ...e, category: settings.categoryField === 'sprint' ? e.sprint : e.category }));
}

function demoReport(now, bumps, settings, weekDate) {
  const week = weekOf(weekDate || now);
  const current = weekOf(now);
  const from = week.from < current.from ? week.from : current.from;
  const to = week.to > current.to ? week.to : current.to;
  const entries = demoForSettings(demoEntries(from, to, now, bumps), settings);
  const report = buildReport(entries, { displayName: 'Demo user' }, settings, now, { forceWorkday: true, demo: true, weekDate });
  report.deployment = 'demo';
  return report;
}

const DEMO_TEAM = [
  { id: 'demo-anna', displayName: 'Anna Berger' },
  { id: 'demo-luca', displayName: 'Luca Rossi' },
  { id: 'demo-me', displayName: 'Demo user' },
  { id: 'demo-sara', displayName: 'Sara Kofler' },
  { id: 'demo-tom', displayName: 'Tom Huber' },
];

// Each demo colleague has a habit: some always complete, some forget Fridays, one logs short days
function demoTeamEntries(from, to, now, bumps, settings) {
  const entries = [];
  const todayKey = dateKey(now);
  for (const m of DEMO_TEAM) {
    const base = m.id === 'demo-me' ? demoEntries(from, to, now, bumps) : demoEntries(from, to, now, 0);
    const dayTotals = new Map();
    for (const e of base) dayTotals.set(e.day, (dayTotals.get(e.day) || 0) + e.hours);
    for (const e of demoForSettings(base, settings)) {
      const weekday = (parseDateKey(e.day).getDay() + 6) % 7;
      let hours = e.hours;
      if (m.id === 'demo-luca' && weekday === 4 && e.day !== todayKey) continue;   // forgets Fridays
      if (m.id === 'demo-tom') hours = Math.round(hours * 0.8 * 4) / 4;           // short days
      if (m.id === 'demo-sara' && e.day === todayKey) continue;                     // hasn't logged today yet
      if (m.id === 'demo-anna' && e.day !== todayKey) hours = (e.hours * 8) / dayTotals.get(e.day); // always complete
      entries.push({ ...e, id: `${m.id}-${e.id}`, hours, user: m.id, userName: m.displayName });
    }
  }
  return entries;
}

function demoTeamWeek(now, bumps, settings, weekDate) {
  const week = weekOf(weekDate || now);
  return buildTeamWeek(demoTeamEntries(week.from, week.to, now, bumps, settings), DEMO_TEAM, settings, now, { weekDate });
}

function demoOverdue(now, settings, team) {
  const ago = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return dateKey(d); };
  const all = [
    { key: 'IT-88', summary: 'Renew wildcard TLS certificate', due: ago(12), assignee: 'Demo user', status: 'In Progress', priority: 'High' },
    { key: 'IT-97', summary: 'Decommission old file server', due: ago(5), assignee: 'Demo user', status: 'Open', priority: 'Medium' },
    { key: 'IT-102', summary: 'Update network documentation', due: ago(2), assignee: 'Demo user', status: 'Open', priority: 'Low' },
    { key: 'IT-76', summary: 'Patch firewall firmware', due: ago(20), assignee: 'Tom Huber', status: 'Waiting', priority: 'High' },
    { key: 'IT-91', summary: 'Printer rollout floor 2', due: ago(8), assignee: 'Luca Rossi', status: 'In Progress', priority: 'Medium' },
    { key: 'IT-99', summary: 'Access review Q3', due: ago(4), assignee: 'Sara Kofler', status: 'Open', priority: 'High' },
  ];
  return overdueItems(team ? all : all.filter((i) => i.assignee === 'Demo user'), settings, now);
}

function demoMonth(now, bumps, settings, year, month) {
  const grid = monthGrid(year, month);
  return buildMonth(demoForSettings(demoEntries(grid.from, grid.to, now, bumps), settings), settings, now, year, month);
}

module.exports = {
  DEFAULTS, REFRESH_CHOICES, JiraError, cleanBaseUrl, normalizeSettings, weekOf, dateKey, parseDateKey, isoWeek, monthGrid,
  nextUpdateText, fieldText, sprintText, commentText, makeJsonFetcher, detectDeployment, connect, loadEntriesRange,
  loadReport, buildReport, buildMonth, trayInfo, formatRemaining, exportCsv, demoEntries, demoReport, demoMonth,
  pickClockStart, buildWorkday, formatMinutes, isAdminOf, userKey, jqlString, loadGroupMembers, loadOverdue, overdueItems, buildTeamWeek, demoTeamWeek, demoOverdue, DEMO_TEAM,
};
