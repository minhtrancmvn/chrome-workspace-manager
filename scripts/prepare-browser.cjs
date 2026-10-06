#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const browser = process.argv[2];
const destination = process.argv[3];
const allowedBrowsers = new Set(['firefox']);
const runtimeFiles = [
  'background.js',
  'browser-api.js',
  'popup.css',
  'popup.js',
  'popup.html',
  'recovery.html',
  'recovery.js',
  'recovery.css',
  'manifest.json'
];
const iconFiles = [
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!allowedBrowsers.has(browser)) {
  fail('Usage: node scripts/prepare-browser.cjs firefox <staging-directory>');
} else if (!destination) {
  fail('Provide staging directory outside the repository.');
} else {
  const output = path.resolve(destination);
  if (output === root || output.startsWith(`${root}${path.sep}`)) {
    fail('Staging directory must be outside the repository.');
  } else {
    prepareFirefox(output);
  }
}

function assertSafeDestination(output) {
  let stats;
  try {
    stats = fs.lstatSync(output);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Staging destination must be a real directory: ${output}`);
  }
  if (fs.readdirSync(output).length > 0) {
    throw new Error(`Staging destination must be empty; refusing to overwrite: ${output}`);
  }
}

function prepareFirefox(output) {
  assertSafeDestination(output);
  fs.mkdirSync(output, { recursive: true });
  const sourceManifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'));
  const { minimum_chrome_version: _minimumChromeVersion, ...browserManifest } = manifest;
  const firefoxManifest = {
    ...browserManifest,
    background: { scripts: ['browser-api.js', 'background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'workspace-manager@local',
        strict_min_version: '115.0'
      }
    }
  };

  for (const relativePath of [...runtimeFiles, ...iconFiles]) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source)) {
      if (['recovery.html', 'recovery.js', 'recovery.css'].includes(relativePath)) continue;
      throw new Error(`Required runtime file missing: ${relativePath}`);
    }
    const target = path.join(output, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (relativePath === 'manifest.json') {
      fs.writeFileSync(target, `${JSON.stringify(firefoxManifest, null, 2)}\n`);
      continue;
    }
    let contents = fs.readFileSync(source);
    if (relativePath === 'popup.html') {
      const html = contents.toString('utf8');
      if (!html.includes('<script src="popup.js"></script>')) {
        throw new Error('Expected popup.js script tag not found in popup.html');
      }
      if (!html.includes('<script src="browser-api.js"></script>')) {
        contents = Buffer.from(html.replace(
          '<script src="popup.js"></script>',
          '<script src="browser-api.js"></script>\n  <script src="popup.js"></script>'
        ));
      }
    }
    fs.writeFileSync(target, contents);
  }
  console.log(`Prepared Firefox runtime files at ${output}`);
}
