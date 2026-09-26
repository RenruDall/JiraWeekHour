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
    'IT-101': [{ author: me, started: day(0), timeSpentSeconds: 4 * 3600 }, { author: other, started: day(0), timeSpentSeconds: 3600 }],
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
