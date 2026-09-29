'use strict';
// Run with: npm test   (Node 20+, no extra packages)
// Starts two small fake Jira servers - one like Jira Data Center, one like Jira Cloud -
// and checks that the app reads the same worklogs from both.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const core = require('../src/core');

const SPRINT_FIELD = { id: 'customfield_10020', name: 'Sprint', schema: { type: 'array', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } };
const LEGACY_SPRINT = 'com.atlassian.greenhopper.service.sprint.Sprint@5f1b[id=11,rapidViewId=7,state=CLOSED,name=Sprint 11,startDate=2026-09-01]';

// A fixed Friday keeps the test independent of today's date
const FRIDAY = new Date(2026, 8, 25, 15, 0);
const day = (offset) => { const d = new Date(2026, 8, 21 + offset); return `${core.dateKey(d)}T09:00:00.000+0200`; };

function fakeJira({ cloud, repeatPages = false }) {
  const me = cloud ? { accountId: 'acc-1', displayName: 'Alex Example' } : { name: 'alex', key: 'JIRAUSER1', displayName: 'Alex Example' };
  const other = cloud ? { accountId: 'acc-2' } : { name: 'sam', key: 'JIRAUSER2' };
  const issues = [
    { key: 'IT-101', fields: { summary: 'Firewall rule review', customfield_10020: [{ id: 11, name: 'Sprint 11' }, { id: 12, name: 'Sprint 12' }] } },
    { key: 'IT-104', fields: { summary: 'VPN client rollout', customfield_10020: cloud ? [{ id: 11, name: 'Sprint 11' }] : [LEGACY_SPRINT] } },
    { key: 'IT-117', fields: { summary: 'Admin work', customfield_10020: null } },
  ];
  const worklogs = {
    'IT-101': [
      { author: me, started: day(0), timeSpentSeconds: 4 * 3600, comment: cloud
        ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reviewed DMZ rules' }] }] }
        : 'Reviewed DMZ rules' },
      { author: other, started: day(0), timeSpentSeconds: 3600 },
    ],
    'IT-104': [{ author: me, started: day(0), timeSpentSeconds: 2.5 * 3600 }, { author: me, started: day(4), timeSpentSeconds: 2 * 3600 }],
    'IT-117': [{ author: me, started: day(4), timeSpentSeconds: 3 * 3600 }, { author: me, started: day(-7), timeSpentSeconds: 3600 }],
  };
  const seen = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url.pathname);
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const api = cloud ? '3' : '2';
    const p = url.pathname;

    if (p === '/rest/api/2/serverInfo') return json({ deploymentType: cloud ? 'Cloud' : 'DataCenter' });
    if (p === `/rest/api/${api}/myself`) return json(me);
    if (p === `/rest/api/${api}/field`) return json([{ id: 'summary', schema: { type: 'string' } }, SPRINT_FIELD]);
    if (cloud && p === '/rest/api/2/search') return json({ errorMessages: ['The requested API has been removed.'] }, 410);
    if (cloud && p === '/rest/api/3/search/jql') {
      // two pages, to test nextPageToken paging
      const second = url.searchParams.get('nextPageToken') === 'page2';
      return json(second ? { issues: issues.slice(2), isLast: true } : { issues: issues.slice(0, 2), nextPageToken: 'page2', isLast: false });
    }
    if (!cloud && p === '/rest/api/2/search') {
      const startAt = Number(url.searchParams.get('startAt') || 0);
      return json({ total: issues.length, issues: issues.slice(startAt, startAt + 2) });
    }
    const m = p.match(new RegExp(`^/rest/api/${api}/issue/([^/]+)/worklog$`));
    if (m) {
      // numbered like real Jira; a server that repeats pages must not double-count
      const logs = (worklogs[decodeURIComponent(m[1])] || []).map((w, i) => ({ id: `${m[1]}-${i}`, ...w }));
      return json({ total: repeatPages ? 99 : logs.length, worklogs: logs });
    }
    return json({ errorMessages: ['not found'] }, 404);
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}

test('does not double-count when a server repeats worklog pages', async () => {
  const jira = await fakeJira({ cloud: true, repeatPages: true });
  try {
    const r = await reportFrom(jira);
    assert.strictEqual(r.days[0].total, 6.5);
    assert.strictEqual(r.weekTotal, 11.5);
  } finally {
    jira.server.close();
  }
});

async function reportFrom(jira, extra = {}) {
  const settings = core.normalizeSettings({ baseUrl: jira.baseUrl, ...extra });
  return core.loadReport(core.makeJsonFetcher(fetch, settings.baseUrl), settings, FRIDAY);
}

for (const cloud of [false, true]) {
  test(`reads worklogs from Jira ${cloud ? 'Cloud' : 'Data Center'}`, async () => {
    const jira = await fakeJira({ cloud });
    try {
      const r = await reportFrom(jira);
      assert.strictEqual(r.deployment, cloud ? 'cloud' : 'server');
      assert.strictEqual(r.me.displayName, 'Alex Example');

      const mon = r.days[0];
      assert.strictEqual(mon.total, 6.5, 'a colleague\'s hour on the same ticket is not counted');
      assert.deepStrictEqual(mon.groups.map((g) => [g.name, g.hours]), [['Sprint 12', 4], ['Sprint 11', 2.5]]);

      assert.strictEqual(r.today.label, 'Fri 25.09');
      assert.strictEqual(r.today.logged, 5);
      assert.strictEqual(r.today.missing, 3);
      assert.deepStrictEqual(r.days[4].groups.map((g) => g.name), ['No sprint', 'Sprint 11']);
      assert.strictEqual(r.weekTotal, 11.5, 'last week\'s entry is left out');
      assert.deepStrictEqual(r.categories.map((c) => c.name).sort(), ['No sprint', 'Sprint 11', 'Sprint 12']);

      if (cloud) assert.ok(!jira.seen.includes('/rest/api/2/search'), 'Cloud must use /search/jql');
      else assert.ok(!jira.seen.includes('/rest/api/3/search/jql'));
    } finally {
      jira.server.close();
    }
  });
}

test('groups by another field when chosen', async () => {
  const jira = await fakeJira({ cloud: false });
  try {
    const r = await reportFrom(jira, { categoryField: 'summary' });
    assert.ok(r.categories.some((c) => c.name === 'Firewall rule review'));
  } finally {
    jira.server.close();
  }
});

test('cleans up pasted Jira addresses', () => {
  const cases = [
    ['your-company.atlassian.net', 'https://your-company.atlassian.net'],
    ['https://your-company.atlassian.net/jira/software/projects/IT/boards/7', 'https://your-company.atlassian.net'],
    ['https://jira.example.com/secure/RapidBoard.jspa?rapidView=186', 'https://jira.example.com'],
    ['https://jira.example.com/browse/IT-101', 'https://jira.example.com'],
    ['https://example.com/jira/secure/Dashboard.jspa', 'https://example.com/jira'],
    ['https://jira.example.com/', 'https://jira.example.com'],
    ['', ''],
  ];
  for (const [input, expected] of cases) assert.strictEqual(core.cleanBaseUrl(input), expected, input);
  assert.throws(() => core.cleanBaseUrl('ftp://jira.example.com'), /https/);
  assert.throws(() => core.cleanBaseUrl('jira'), /incomplete/);
});

test('validates settings', () => {
  const s = core.normalizeSettings({ refreshTimes: '16:00, 12:00' });
  assert.deepStrictEqual(s.refreshTimes, ['12:00', '16:00']);
  assert.strictEqual(s.categoryField, 'sprint');
  assert.strictEqual(s.baseUrl, '');
  assert.throws(() => core.normalizeSettings({ refreshTimes: '25:00' }), /not a valid time/);
  assert.throws(() => core.normalizeSettings({ targetHours: 0 }), /between 0 and 24/);
  assert.throws(() => core.normalizeSettings({ email: 'not-an-email' }), /e-mail/);
});

test('asks to connect when no Jira is set', async () => {
  await assert.rejects(core.loadReport(async () => {}, core.normalizeSettings({}), FRIDAY), (e) => e.kind === 'setup');
  assert.strictEqual(core.trayInfo(null, { kind: 'setup' }).text, '?');
});

test('recognises login pages and errors', async () => {
  const reply = (status, type) => async () => ({ ok: status < 400, status, headers: new Headers(type ? { 'content-type': type } : {}), json: async () => ({}) });
  await assert.rejects(core.makeJsonFetcher(reply(200, 'text/html'), 'https://x')('/a'), (e) => e.kind === 'login');
  await assert.rejects(core.makeJsonFetcher(reply(401), 'https://x')('/a'), (e) => e.kind === 'auth');
  await assert.rejects(core.makeJsonFetcher(reply(500, 'application/json'), 'https://x')('/a'), (e) => e.kind === 'http');
  await assert.rejects(core.makeJsonFetcher(async () => { throw new Error('ECONNREFUSED'); }, 'https://x')('/a'), (e) => e.kind === 'network');
});

test('tray icon states and demo data', () => {
  const settings = core.normalizeSettings({});
  const demo = core.demoReport(FRIDAY, 0, settings);
  assert.strictEqual(core.trayInfo(demo).text, '3');
  assert.strictEqual(core.trayInfo(core.demoReport(FRIDAY, 6, settings)).text, 'check');
  const saturday = new Date(2026, 8, 26, 10);
  assert.strictEqual(core.trayInfo(core.buildReport([], { displayName: 'x' }, settings, saturday)).text, '–');
  assert.strictEqual(core.trayInfo(null, { kind: 'network' }).text, '!');
  assert.strictEqual(core.formatRemaining(0.25), '0.3');
  assert.strictEqual(core.nextUpdateText(['12:00', '16:00'], new Date(2026, 8, 25, 17)), 'Next automatic update tomorrow 12:00');
});

test('reads any past week, with start times and comments', async () => {
  for (const cloud of [false, true]) {
    const jira = await fakeJira({ cloud });
    try {
      const settings = core.normalizeSettings({ baseUrl: jira.baseUrl });
      const fetchJson = core.makeJsonFetcher(fetch, settings.baseUrl);
      const ctx = await core.connect(fetchJson, settings);
      // the week before the test week: only IT-117's older entry
      const lastWeek = core.weekOf(new Date(2026, 8, 14));
      const past = core.buildReport(await core.loadEntriesRange(fetchJson, ctx, lastWeek.from, lastWeek.to), { displayName: ctx.displayName }, settings, FRIDAY, { weekDate: new Date(2026, 8, 14) });
      assert.strictEqual(past.weekTotal, 1);
      assert.strictEqual(past.isCurrentWeek, false);
      assert.strictEqual(past.today, null, 'today is not part of an older week');
      assert.strictEqual(past.weekNumber, 38);

      const week = core.weekOf(FRIDAY);
      const entries = await core.loadEntriesRange(fetchJson, ctx, week.from, week.to);
      const first = entries.find((e) => e.key === 'IT-101');
      assert.strictEqual(first.time, '09:00');
      assert.strictEqual(first.comment, 'Reviewed DMZ rules', cloud ? 'Cloud comment (document format) becomes text' : 'Data Center comment');
      const report = core.buildReport(entries, { displayName: 'x' }, settings, FRIDAY);
      assert.deepStrictEqual(report.log.map((e) => e.key), ['IT-101', 'IT-104', 'IT-104', 'IT-117']);
      assert.deepStrictEqual([report.tickets[0].key, report.tickets[0].hours], ['IT-104', 4.5], 'tickets sorted by hours');
    } finally {
      jira.server.close();
    }
  }
});

test('month calendar marks days by logged hours', () => {
  const settings = core.normalizeSettings({});
  const entries = [
    { day: '2026-09-21', hours: 8, key: 'A', category: 'x' },
    { day: '2026-09-22', hours: 3, key: 'A', category: 'x' },
    { day: '2026-09-26', hours: 1, key: 'A', category: 'x' },
  ];
  const m = core.buildMonth(entries, settings, FRIDAY, 2026, 8);
  const days = Object.fromEntries(m.weeks.flatMap((w) => w.days).map((d) => [d.date, d.status]));
  assert.strictEqual(m.weeks[0].weekStart, '2026-08-31', 'grid starts on the Monday before the 1st');
  assert.strictEqual(days['2026-09-21'], 'done');
  assert.strictEqual(days['2026-09-22'], 'partial');
  assert.strictEqual(days['2026-09-23'], 'missing');
  assert.strictEqual(days['2026-09-26'], 'future');
  assert.strictEqual(days['2026-09-27'], 'future');
  assert.strictEqual(days['2026-09-20'], 'weekend');
  assert.strictEqual(m.monthTotal, 12);
  assert.strictEqual(core.isoWeek(new Date(2027, 0, 1)), 53);
});

test('CSV export opens cleanly in Excel', () => {
  const settings = core.normalizeSettings({});
  const report = core.buildReport([
    { id: '1', day: '2026-09-21', time: '08:30', key: 'IT-1', summary: 'Fix "printer"; urgent', category: 'Sprint 1', hours: 1.5, comment: 'Zeile 1\nZeile 2 – ü' },
  ], { displayName: 'x' }, settings, FRIDAY);
  const csv = core.exportCsv(report);
  assert.ok(csv.startsWith('﻿Date;Start;Ticket'));
  assert.ok(csv.includes('"Fix ""printer""; urgent"'));
  assert.ok(csv.includes(';1,50;'));
  assert.ok(csv.includes('"Zeile 1\nZeile 2 – ü"'));
});

test('refresh rate setting', () => {
  assert.strictEqual(core.normalizeSettings({}).autoRefreshMinutes, 60);
  assert.strictEqual(core.normalizeSettings({ autoRefreshMinutes: '30' }).autoRefreshMinutes, 30);
  assert.strictEqual(core.normalizeSettings({ autoRefreshMinutes: 0 }).autoRefreshMinutes, 0);
  assert.throws(() => core.normalizeSettings({ autoRefreshMinutes: 7 }), /refresh rate/);
});

test('demo data covers past weeks and months the same way every time', () => {
  const settings = core.normalizeSettings({});
  const a = core.demoReport(FRIDAY, 0, settings, new Date(2026, 7, 12));
  const b = core.demoReport(FRIDAY, 0, settings, new Date(2026, 7, 12));
  assert.ok(a.weekTotal > 30);
  assert.deepStrictEqual(a.log, b.log);
  const m = core.demoMonth(FRIDAY, 0, settings, 2026, 7);
  assert.ok(m.monthTotal > 100);
});

// ---------------------------------------------------------------- team dashboard
function fakeTeamJira({ cloud, listGroups = true }) {
  const u = (id, name) => (cloud ? { accountId: `acc-${id}`, displayName: name } : { name: id, key: `KEY-${id}`, displayName: name });
  const lead = u('lead', 'Lena Lead');
  const anna = u('anna', 'Anna Berger');
  const tom = u('tom', 'Tom Huber');
  const outsider = u('olga', 'Olga Other');
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const jql = url.searchParams.get('jql') || '';
    seen.push(`${p} ${jql}`);
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const api = cloud ? '3' : '2';
    if (p === '/rest/api/2/serverInfo') return json({ deploymentType: cloud ? 'Cloud' : 'DataCenter' });
    if (p === `/rest/api/${api}/myself`) {
      return json({ ...lead, groups: url.searchParams.get('expand') === 'groups' ? { size: 2, items: [{ name: 'IT-Leads' }, { name: 'jira-users' }] } : undefined });
    }
    if (p === `/rest/api/${api}/field`) return json([SPRINT_FIELD]);
    if (p === `/rest/api/${api}/mypermissions`) {
      assert.strictEqual(url.searchParams.get('permissions'), 'ADMINISTER');
      return json({ permissions: { ADMINISTER: { key: 'ADMINISTER', havePermission: true } } });
    }
    if (p === `/rest/api/${api}/group/member`) {
      if (!listGroups) return json({ errorMessages: ['no permission'] }, 403);
      assert.strictEqual(url.searchParams.get('groupname'), 'it-italy');
      return json({ values: [anna, tom, { ...u('gone', 'Gone User'), active: false }], isLast: true, total: 3 });
    }
    const searchPath = cloud ? '/rest/api/3/search/jql' : '/rest/api/2/search';
    if (p === searchPath && jql.includes('duedate')) {
      assert.ok(jql.includes('startOfDay("-3d")'), jql);
      const team = jql.includes('membersOf("it-italy")');
      const issues = [
        { key: 'IT-76', fields: { summary: 'Patch firmware', duedate: '2026-09-10', assignee: tom, status: { name: 'Waiting' }, priority: { name: 'High' } } },
        { key: 'IT-88', fields: { summary: 'Renew certificate', duedate: '2026-09-20', assignee: lead, status: { name: 'Open' }, priority: { name: 'Medium' } } },
        // Jira gives only what the JQL asks for; this one is just 1 day late and must be filtered out anyway
        { key: 'IT-99', fields: { summary: 'Edge case', duedate: '2026-09-24', assignee: tom, status: { name: 'Open' } } },
      ];
      return json(cloud ? { issues: team ? issues : [issues[1]], isLast: true } : { total: 3, issues: team ? issues : [issues[1]] });
    }
    if (p === searchPath) {
      assert.ok(jql.startsWith('worklogAuthor in membersOf("it-italy")'), jql);
      const issues = [{ key: 'IT-1', fields: { summary: 'Shared ticket', customfield_10020: [{ name: 'Sprint 5' }] } }];
      return json(cloud ? { issues, isLast: true } : { total: 1, issues });
    }
    if (p === `/rest/api/${api}/issue/IT-1/worklog`) {
      return json({ total: 4, worklogs: [
        { id: 1, author: anna, started: day(0), timeSpentSeconds: 8 * 3600 },
        { id: 2, author: tom, started: day(0), timeSpentSeconds: 3 * 3600 },
        { id: 3, author: tom, started: day(1), timeSpentSeconds: 5 * 3600 },
        { id: 4, author: outsider, started: day(0), timeSpentSeconds: 2 * 3600 },
      ] });
    }
    return json({ errorMessages: ['not found'] }, 404);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` })));
}

for (const cloud of [false, true]) {
  test(`team dashboard on Jira ${cloud ? 'Cloud' : 'Data Center'}`, async () => {
    const jira = await fakeTeamJira({ cloud });
    try {
      const settings = core.normalizeSettings({ baseUrl: jira.baseUrl, adminGroup: 'it-leads', teamGroup: 'it-italy' });
      const fetchJson = core.makeJsonFetcher(fetch, settings.baseUrl);
      const ctx = await core.connect(fetchJson, settings);
      assert.ok(core.isAdminOf(ctx, settings.adminGroup), 'group names compare case-insensitively');
      assert.ok(!core.isAdminOf(ctx, 'it-italy'));
      assert.ok(!core.isAdminOf(ctx, ''), 'no admin group configured = nobody is admin');
      assert.ok(!core.isAdminOf(ctx, 'Administrator'), 'a wrong group name does not match');
      assert.ok(core.isAdminOf(ctx, 'Administrator', true), 'Jira administrators count when allowed');
      assert.ok(core.isAdminOf(ctx, '', true));
      assert.deepStrictEqual(ctx.groupNames, ['IT-Leads', 'jira-users'], 'original spelling kept for the settings hint');

      const members = await core.loadGroupMembers(fetchJson, ctx, settings.teamGroup);
      assert.deepStrictEqual(members.map((m) => m.displayName), ['Anna Berger', 'Tom Huber'], 'inactive users are left out');

      const week = core.weekOf(FRIDAY);
      const entries = await core.loadEntriesRange(fetchJson, ctx, week.from, week.to, { group: settings.teamGroup, members });
      const team = core.buildTeamWeek(entries, members, settings, FRIDAY);
      assert.deepStrictEqual(team.rows.map((r) => [r.displayName, r.total]), [['Anna Berger', 8], ['Tom Huber', 8]]);
      assert.strictEqual(team.rows[1].days[0].status, 'partial');
      assert.strictEqual(team.rows[0].days[0].status, 'done');
      assert.strictEqual(team.rows[0].days[1].status, 'missing');
      assert.strictEqual(team.totals.hours, 16, 'a non-member\'s worklog on the same ticket is not counted');
      assert.strictEqual(team.rows[0].report.categories[0].name, 'Sprint 5');

      const mine = await core.loadOverdue(fetchJson, ctx, settings, FRIDAY);
      assert.deepStrictEqual(mine.map((i) => [i.key, i.daysOverdue]), [['IT-88', 5]]);
      const teamOverdue = await core.loadOverdue(fetchJson, ctx, settings, FRIDAY, { group: settings.teamGroup });
      assert.deepStrictEqual(teamOverdue.map((i) => [i.key, i.assignee, i.daysOverdue]), [['IT-76', 'Tom Huber', 15], ['IT-88', 'Lena Lead', 5]]);
    } finally {
      jira.server.close();
    }
  });
}

test('team dashboard still works when Jira does not allow listing group members', async () => {
  const jira = await fakeTeamJira({ cloud: false, listGroups: false });
  try {
    const settings = core.normalizeSettings({ baseUrl: jira.baseUrl, adminGroup: 'it-leads', teamGroup: 'it-italy' });
    const fetchJson = core.makeJsonFetcher(fetch, settings.baseUrl);
    const ctx = await core.connect(fetchJson, settings);
    const members = await core.loadGroupMembers(fetchJson, ctx, settings.teamGroup);
    assert.strictEqual(members, null);
    const week = core.weekOf(FRIDAY);
    const entries = await core.loadEntriesRange(fetchJson, ctx, week.from, week.to, { group: settings.teamGroup, members: null });
    const team = core.buildTeamWeek(entries, null, settings, FRIDAY);
    assert.strictEqual(team.membersKnown, false);
    // without the member list, everyone Jira returned for membersOf() is shown
    assert.deepStrictEqual(team.rows.map((r) => r.displayName), ['Anna Berger', 'Olga Other', 'Tom Huber']);
  } finally {
    jira.server.close();
  }
});

test('overdue setting and group names in JQL', () => {
  assert.strictEqual(core.normalizeSettings({}).overdueDays, 3);
  assert.strictEqual(core.normalizeSettings({ overdueDays: 0 }).overdueDays, 0);
  assert.throws(() => core.normalizeSettings({ overdueDays: -1 }), /Overdue after/);
  assert.throws(() => core.normalizeSettings({ overdueDays: 2.5 }), /Overdue after/);
  assert.strictEqual(core.jqlString('it "team"'), '"it \\"team\\""', 'quotes inside a group name are escaped');
  const items = core.overdueItems([{ key: 'A-1', due: '2026-09-21' }, { key: 'A-2', due: '2026-09-22' }, { key: 'A-3', due: '' }], core.normalizeSettings({ overdueDays: 3 }), FRIDAY);
  assert.deepStrictEqual(items.map((i) => [i.key, i.daysOverdue]), [['A-1', 4]]);
});

test('reads IT policy from the registry output', () => {
  const { parseRegQuery } = require('../src/policy');
  const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\JiraWeekHours\r\n    AdminGroup    REG_SZ    it-leads\r\n    TeamGroup    REG_SZ    IT Italy\r\n    Other    REG_DWORD    0x1\r\n    BaseUrl    REG_SZ    \r\n';
  assert.deepStrictEqual(parseRegQuery(out), { adminGroup: 'it-leads', teamGroup: 'IT Italy' });
  assert.deepStrictEqual(parseRegQuery(''), {});
  assert.deepStrictEqual(parseRegQuery('    JiraAdminsAreAdmins    REG_SZ    1\r\n'), { jiraAdminsAreAdmins: '1' });
  assert.strictEqual(core.normalizeSettings({ jiraAdminsAreAdmins: '1' }).jiraAdminsAreAdmins, true);
  assert.strictEqual(core.normalizeSettings({}).jiraAdminsAreAdmins, false);
});

// ---------------------------------------------------------------- work clock
test('clock starts at the earliest sign of PC use today', () => {
  const now = new Date(2026, 8, 29, 14, 0);
  const at = (h, m, day = 29) => new Date(2026, 8, day, h, m);
  assert.deepStrictEqual(core.pickClockStart({ now, bootTime: at(7, 40), appStart: at(7, 42) }), at(7, 40));
  // PC booted days ago (fast startup / sleep): the app start or first unlock today counts
  assert.deepStrictEqual(core.pickClockStart({ now, bootTime: at(9, 0, 25), appStart: at(8, 5), firstActive: at(7, 58) }), at(7, 58));
  // a start corrected by hand wins
  assert.deepStrictEqual(core.pickClockStart({ now, bootTime: at(7, 40), manual: at(7, 15) }), at(7, 15));
  // nothing from today yet
  assert.strictEqual(core.pickClockStart({ now, bootTime: at(9, 0, 28), appStart: at(9, 0, 28) }), null);
});

test('workday timeline shows booked, not booked and pauses', () => {
  const now = new Date(2026, 8, 29, 14, 0);
  const entries = [
    { day: '2026-09-29', time: '08:30', hours: 2, key: 'IT-1', summary: 'A' },
    { day: '2026-09-29', time: '10:30', hours: 1.5, key: 'IT-2', summary: 'B' },
    { day: '2026-09-28', time: '09:00', hours: 8, key: 'IT-9', summary: 'yesterday' },
  ];
  const pauses = [{ from: new Date(2026, 8, 29, 12, 0), to: new Date(2026, 8, 29, 12, 30), kind: 'lock' }];
  const w = core.buildWorkday({ start: new Date(2026, 8, 29, 8, 0), now, pauses, entries });
  assert.strictEqual(w.start, '08:00');
  assert.strictEqual(w.elapsedHours, 6, 'pauses are not subtracted');
  assert.strictEqual(w.bookedHours, 3.5);
  assert.strictEqual(w.openHours, 2.5);
  assert.strictEqual(w.pauseMinutes, 30);
  assert.deepStrictEqual(w.segments.map((s) => `${s.kind}:${s.from}-${s.to}`), [
    'open:08:00-08:30', 'booked:08:30-10:30', 'booked:10:30-12:00', 'pause:12:00-12:30', 'open:12:30-14:00',
  ]);
  assert.deepStrictEqual(w.gaps, [{ from: '08:00', to: '08:30', minutes: 30 }, { from: '12:30', to: '14:00', minutes: 90 }]);
  assert.deepStrictEqual(w.pauses, [{ from: '12:00', to: '12:30', minutes: 30, kind: 'lock' }]);
});

test('workday: ongoing pause, bookings before the clock and without a time', () => {
  const now = new Date(2026, 8, 29, 10, 0);
  const entries = [
    { day: '2026-09-29', time: '07:00', hours: 1, key: 'IT-1' }, // booked before the PC started
    { day: '2026-09-29', time: '', hours: 0.5, key: 'IT-2' },     // no start time: counts, no block
  ];
  const w = core.buildWorkday({ start: new Date(2026, 8, 29, 8, 0), now, pauses: [{ from: new Date(2026, 8, 29, 9, 30), kind: 'sleep' }], entries });
  assert.strictEqual(w.bookedHours, 1.5);
  assert.strictEqual(w.openHours, 0.5);
  assert.deepStrictEqual(w.segments.map((s) => `${s.kind}:${s.from}-${s.to}`), ['booked:07:00-08:00', 'open:08:00-09:30', 'pause:09:30-10:00']);
  assert.deepStrictEqual(w.pauses, [{ from: '09:30', to: null, minutes: 30, kind: 'sleep' }]);
  assert.deepStrictEqual(core.buildWorkday({ start: null, now, entries }), { running: false, bookedHours: 1.5 });
  assert.strictEqual(core.formatMinutes(130), '2h 10m');
  assert.strictEqual(core.formatMinutes(45), '45m');
});
