'use strict';
const path = require('path');
const fs = require('fs');

// Electron ships 55 UI languages; the app only needs these (others fall back to English)
const KEEP_LOCALES = ['en-US.pak', 'de.pak', 'it.pak'];

module.exports = {
  packagerConfig: {
    name: 'Jira Week Hours',
    executableName: 'JiraWeekHours',
    icon: path.join(__dirname, 'src', 'ui', 'icon'), // .ico on Windows
    asar: true,
    ignore: [/^\/(test|docs|out|\.github)(\/|$)/, /^\/README\.md$/],
    win32metadata: {
      CompanyName: 'Michael Ladurner',
      FileDescription: 'Jira Week Hours',
      ProductName: 'Jira Week Hours',
      LegalCopyright: 'Copyright 2026 Michael Ladurner. Apache License 2.0.',
    },
  },
  hooks: {
    // Runs after Electron is unpacked and before the installer is built
    packageAfterExtract: async (_forgeConfig, buildPath) => {
      const dir = path.join(buildPath, 'locales');
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.pak') && !KEEP_LOCALES.includes(file)) fs.rmSync(path.join(dir, file), { force: true });
      }
    },
  },
  makers: [
    {
      // Windows installer: JiraWeekHours-Setup.exe, installs per user, no admin rights
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'JiraWeekHours',
        setupExe: 'JiraWeekHours-Setup.exe',
        authors: 'Michael Ladurner',
        setupIcon: path.join(__dirname, 'src', 'ui', 'icon.ico'),
      },
    },
  ],
};
