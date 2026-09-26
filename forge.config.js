'use strict';
const path = require('path');

module.exports = {
  packagerConfig: {
    name: 'Jira Week Hours',
    executableName: 'JiraWeekHours',
    icon: path.join(__dirname, 'src', 'ui', 'icon'), // .ico on Windows
    asar: true,
    ignore: [/^\/(test|docs|out|\.github)(\/|$)/, /^\/README\.md$/],
    win32metadata: {
      CompanyName: 'Jira Week Hours',
      FileDescription: 'Jira Week Hours',
      ProductName: 'Jira Week Hours',
    },
  },
  makers: [
    {
      // Windows installer: JiraWeekHours-Setup.exe, installs per user, no admin rights
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'JiraWeekHours',
        setupExe: 'JiraWeekHours-Setup.exe',
        setupIcon: path.join(__dirname, 'src', 'ui', 'icon.ico'),
      },
    },
    {
      // Portable zip: unzip and run JiraWeekHours.exe
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
    },
  ],
};
