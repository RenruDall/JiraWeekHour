'use strict';
// Settings IT can fix centrally (for example with Intune) so users cannot change them:
//   HKEY_LOCAL_MACHINE\SOFTWARE\Policies\JiraWeekHours
//     AdminGroup  (REG_SZ)  Jira group whose members see the team dashboard
//     TeamGroup   (REG_SZ)  Jira group shown on the team dashboard
//     BaseUrl     (REG_SZ)  Jira address
//     JiraAdminsAreAdmins (REG_SZ) "1" = Jira administrators also see the team dashboard
// HKLM can only be written by administrators, so a normal user cannot make themselves admin here.
const { execFileSync } = require('child_process');

const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\JiraWeekHours';
const VALUES = { AdminGroup: 'adminGroup', TeamGroup: 'teamGroup', BaseUrl: 'baseUrl', JiraAdminsAreAdmins: 'jiraAdminsAreAdmins' };

// Parses the output of "reg query <key>"
function parseRegQuery(output) {
  const result = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
    if (m && VALUES[m[1]] && m[2].trim()) result[VALUES[m[1]]] = m[2].trim();
  }
  return result;
}

function readPolicy() {
  if (process.platform !== 'win32') return {};
  try {
    const output = execFileSync('reg', ['query', POLICY_KEY], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return parseRegQuery(output);
  } catch {
    return {}; // key not present: nothing is locked
  }
}

module.exports = { readPolicy, parseRegQuery, POLICY_KEY };
