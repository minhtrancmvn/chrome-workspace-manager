#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function readVersion(file) {
  const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid manifest.version in ${file}; expected strict MAJOR.MINOR.PATCH.`);
  }
  return version;
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function main() {
  const [previousFile, currentFile, ...extra] = process.argv.slice(2);
  if (!previousFile || !currentFile || extra.length) {
    throw new Error('Usage: node scripts/release-version.cjs <previous-manifest.json> <current-manifest.json>');
  }
  const previous = readVersion(previousFile);
  const current = readVersion(currentFile);
  const comparison = compareVersions(previous, current);
  if (comparison > 0) {
    throw new Error(`manifest.version cannot decrease from ${previous} to ${current}.`);
  }
  process.stdout.write(`release=${comparison < 0}\nversion=${current}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
