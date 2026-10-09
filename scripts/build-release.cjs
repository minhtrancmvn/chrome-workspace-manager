#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtimeFiles = ['manifest.json', 'background.js', 'browser-api.js', 'popup.html', 'popup.js',
  'popup.css', 'recovery.html', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'];
const releasePrefix = 'workspace-manager-v';

function fail(message) {
  throw new Error(message);
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--tag', '--output'].includes(key) || i + 1 >= args.length || Object.hasOwn(options, key) || !args[i + 1]) {
      fail('Usage: node scripts/build-release.cjs --tag vX.Y.Z --output <absolute-directory>');
    }
    options[key] = args[i + 1];
  }
  if (!options['--tag']) fail('Provide release tag with --tag vX.Y.Z.');
  const version = options['--tag'].match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)?.slice(1).join('.');
  if (!version) fail(`Invalid release tag: ${options['--tag']}`);
  const output = options['--output'] ? path.resolve(options['--output']) : path.join(root, 'dist');
  if (options['--output'] && !path.isAbsolute(options['--output'])) fail('--output must be an absolute path.');
  return { version, output };
}

function assertNoSymlinkAncestors(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`Symlink path is not allowed: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertSourceFile(file) {
  const absolute = path.join(root, file);
  assertNoSymlinkAncestors(absolute);
  let stats;
  try { stats = fs.lstatSync(absolute); } catch (error) {
    if (error.code === 'ENOENT') fail(`Required runtime file missing: ${file}`);
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`Required runtime file missing or symlinked: ${file}`);
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => entry.name).sort();
}

function assertExactFiles(directory, expected) {
  const actual = [];
  function collect(current, prefix = '') {
    for (const name of listFiles(current)) {
      const target = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = fs.lstatSync(target);
      if (stats.isSymbolicLink()) fail(`Staged symlink is not allowed: ${target}`);
      if (stats.isDirectory()) collect(target, relative);
      else if (stats.isFile()) actual.push(relative);
      else fail(`Unexpected staged filesystem entry: ${target}`);
    }
  }
  collect(directory);
  actual.sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail(`Unexpected staged files in ${directory}: ${actual.join(', ')}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    fail(`${command} failed${result.status === null ? '' : ` (${result.status})`}: ${result.error?.message || result.stderr || ''}`);
  }
  return result.stdout;
}

function zipEntries(file) {
  return run('unzip', ['-Z1', file]).trim().split('\n').sort();
}

function verifyArchive(file, stage, expected) {
  if (JSON.stringify(zipEntries(file)) !== JSON.stringify([...expected].sort())) fail(`Unexpected ZIP entries: ${file}`);
  for (const entry of expected) {
    const bytes = spawnSync('unzip', ['-p', file, entry]);
    if (bytes.error || bytes.status !== 0 || !bytes.stdout.equals(fs.readFileSync(path.join(stage, entry)))) {
      fail(`ZIP content mismatch: ${entry}`);
    }
  }
}

function runBuilder() {
  const { version, output } = parseArgs(process.argv.slice(2));
  const tagVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
  if (typeof tagVersion !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tagVersion)) {
    fail('manifest.version must use strict three-component semver.');
  }
  if (version !== tagVersion) fail(`Tag version ${version} does not match manifest.version ${tagVersion}.`);
  const defaultOutput = path.join(root, 'dist');
  if ((output === root || output.startsWith(`${root}${path.sep}`)) && output !== defaultOutput) {
    fail('Output directory cannot be inside the source root except default dist/.');
  }
  assertNoSymlinkAncestors(output);
  for (const file of runtimeFiles) assertSourceFile(file);
  for (const file of ['package-extension.sh', 'scripts/prepare-browser.cjs']) assertSourceFile(file);

  let outputExists = false;
  try {
    const stats = fs.lstatSync(output);
    outputExists = true;
    if (!stats.isDirectory() || stats.isSymbolicLink() || listFiles(output).length) {
      fail(`Output must be absent or an empty real directory: ${output}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workspace-release-builder-'));
  let createdOutput = false;
  const publishedFiles = [];
  const names = [
    `${releasePrefix}${version}-chromium.zip`,
    `${releasePrefix}${version}-firefox-unsigned.zip`,
    'SHA256SUMS'
  ];
  try {
    const chromium = path.join(temporary, 'chromium');
    fs.mkdirSync(chromium);
    for (const file of runtimeFiles) {
      const target = path.join(chromium, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    fs.copyFileSync(path.join(root, 'package-extension.sh'), path.join(chromium, 'package-extension.sh'));
    run('bash', ['package-extension.sh'], { cwd: chromium, input: 'n\n' });
    const chromiumZip = path.join(chromium, 'releases', `${releasePrefix}${version}.zip`);
    verifyArchive(chromiumZip, chromium, runtimeFiles);
    if (!fs.readFileSync(path.join(chromium, 'manifest.json')).equals(fs.readFileSync(path.join(root, 'manifest.json')))) {
      fail('Chromium manifest bytes differ from source manifest.');
    }

    const firefoxRoot = path.join(temporary, 'firefox-source');
    fs.mkdirSync(path.join(firefoxRoot, 'scripts'), { recursive: true });
    for (const file of runtimeFiles) {
      const target = path.join(firefoxRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    fs.copyFileSync(path.join(root, 'scripts/prepare-browser.cjs'), path.join(firefoxRoot, 'scripts/prepare-browser.cjs'));
    for (const optional of ['recovery.js', 'recovery.css']) {
      const source = path.join(root, optional);
      assertNoSymlinkAncestors(source);
      try {
        const stats = fs.lstatSync(source);
        if (stats.isSymbolicLink() || !stats.isFile()) fail(`Unexpected optional Firefox runtime entry: ${optional}`);
        fs.copyFileSync(source, path.join(firefoxRoot, optional));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const firefox = path.join(temporary, 'firefox');
    run(process.execPath, [path.join(firefoxRoot, 'scripts/prepare-browser.cjs'), 'firefox', firefox]);
    assertExactFiles(firefox, runtimeFiles);
    const firefoxZip = path.join(temporary, names[1]);
    run('zip', ['-q', firefoxZip, ...runtimeFiles], { cwd: firefox });
    verifyArchive(firefoxZip, firefox, runtimeFiles);

    const chromiumOutput = path.join(temporary, names[0]);
    fs.copyFileSync(chromiumZip, chromiumOutput);
    const sums = [chromiumOutput, firefoxZip].map(file =>
      `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`
    ).join('\n') + '\n';
    fs.writeFileSync(path.join(temporary, 'SHA256SUMS'), sums);
    for (const file of [chromiumOutput, firefoxZip]) verifyArchive(file,
      file === chromiumOutput ? chromium : firefox, runtimeFiles);

    if (!outputExists) {
      fs.mkdirSync(output);
      createdOutput = true;
    }
    for (const name of names) {
      fs.copyFileSync(path.join(temporary, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
      publishedFiles.push(name);
    }
    process.stdout.write(`Built release ${version} in ${output}\n${names.join('\n')}\n`);
  } catch (error) {
    for (const name of publishedFiles) fs.rmSync(path.join(output, name), { force: true });
    if (createdOutput) {
      try { fs.rmdirSync(output); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOTEMPTY' && cleanupError.code !== 'ENOENT') throw cleanupError;
      }
    }
    throw error;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  runBuilder();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
