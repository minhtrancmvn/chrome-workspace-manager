const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtimeFiles = ['manifest.json', 'background.js', 'browser-api.js', 'popup.html', 'popup.js',
  'popup.css', 'recovery.html', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'];
const outputNames = version => [
  `workspace-manager-v${version}-chromium.zip`,
  `workspace-manager-v${version}-firefox-unsigned.zip`,
  'SHA256SUMS'
];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'workspace-release-builder-'));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(`${directory}-output`, { recursive: true, force: true });
    fs.rmSync(path.join(directory, 'dist'), { recursive: true, force: true });
  });
  for (const file of [...runtimeFiles, 'package-extension.sh', 'scripts/prepare-browser.cjs']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  const version = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')).version;
  const builder = path.join(root, 'scripts/build-release.cjs');
  fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  if (fs.existsSync(builder)) fs.copyFileSync(builder, path.join(directory, 'scripts/build-release.cjs'));
  const output = `${directory}-output`;
  const run = (args = [], env = {}) => {
    let tag = `v${version}`;
    let target = output;
    const parsed = [...args];
    if (!args.includes('--tag')) parsed.push('--tag', tag);
    if (!args.includes('--output')) parsed.push('--output', target);
    return runRaw(parsed, env);
  };
  const runRaw = (args, env = {}) => {
    const result = spawnSync(process.execPath,
      [path.join(directory, 'scripts/build-release.cjs'), ...args], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, ...env }
      });
    return { ...result, status: result.status ?? 127, stderr: result.stderr || result.error?.message || '' };
  };
  return { directory, version, output, run, runRaw };
}

function archiveEntries(file) {
  const result = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').sort();
}

function archiveFile(file, entry) {
  const result = spawnSync('unzip', ['-p', file, entry]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test('default output builds only under repository dist', t => {
  const env = fixture(t);
  const result = env.runRaw(['--tag', `v${env.version}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(env.directory, 'dist')).sort(), outputNames(env.version).sort());
});

test('builds exact Chromium and Firefox archives plus matching SHA256SUMS', t => {
  const env = fixture(t);
  const result = env.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(env.output).sort(), outputNames(env.version).sort());
  const chromium = path.join(env.output, outputNames(env.version)[0]);
  const firefox = path.join(env.output, outputNames(env.version)[1]);
  assert.deepEqual(archiveEntries(chromium), [...runtimeFiles].sort());
  assert.deepEqual(archiveEntries(firefox), [...runtimeFiles].sort());
  for (const file of runtimeFiles.filter(file => file !== 'manifest.json')) {
    assert.deepEqual(archiveFile(chromium, file), fs.readFileSync(path.join(env.directory, file)));
  }
  assert.equal(JSON.parse(archiveFile(chromium, 'manifest.json')).version, env.version);
  const firefoxManifest = JSON.parse(archiveFile(firefox, 'manifest.json'));
  assert.equal(firefoxManifest.version, env.version);
  assert.deepEqual(firefoxManifest.background.scripts, ['browser-api.js', 'background.js']);
  assert.equal(Object.hasOwn(firefoxManifest, 'minimum_chrome_version'), false);
  assert.deepEqual(firefoxManifest.browser_specific_settings, {
    gecko: { id: 'workspace-manager@local', strict_min_version: '115.0' }
  });
  assert.equal(firefoxManifest.minimum_chrome_version, undefined);
  const expectedSums = [chromium, firefox].map(file =>
    `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`
  ).join('\n') + '\n';
  assert.equal(fs.readFileSync(path.join(env.output, 'SHA256SUMS'), 'utf8'), expectedSums);
});

test('rejects mismatched tag before creating output', t => {
  const env = fixture(t);
  const result = env.run(['--tag', 'v9.9.9']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /does not match manifest/);
  assert.equal(fs.existsSync(env.output), false);
});

test('rejects malformed tags and versions with leading zeros', t => {
  const env = fixture(t);
  assert.notEqual(env.run(['--tag', 'v01.2.3']).status, 0);
  fs.writeFileSync(path.join(env.directory, 'manifest.json'), JSON.stringify({ version: '1.02.3' }));
  assert.notEqual(env.run(['--tag', 'v1.2.3']).status, 0);
  assert.equal(fs.existsSync(env.output), false);
});

test('rejects nonempty and symlink output paths without overwriting', t => {
  const env = fixture(t);
  fs.mkdirSync(env.output);
  fs.writeFileSync(path.join(env.output, 'keep.txt'), 'keep');
  assert.notEqual(env.run().status, 0);
  assert.equal(fs.readFileSync(path.join(env.output, 'keep.txt'), 'utf8'), 'keep');
  fs.rmSync(env.output, { recursive: true });
  const external = path.join(env.directory, 'external');
  fs.mkdirSync(external);
  fs.symlinkSync(external, env.output);
  assert.notEqual(env.run().status, 0);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('rejects output inside source root except dist and rejects symlinked source runtime', t => {
  const env = fixture(t);
  const inside = path.join(env.directory, 'releases');
  assert.notEqual(env.run(['--output', inside]).status, 0);
  const dist = path.join(env.directory, 'dist');
  assert.equal(env.run(['--output', dist]).status, 0);
  fs.unlinkSync(path.join(env.directory, 'popup.js'));
  fs.symlinkSync(path.join(root, 'popup.js'), path.join(env.directory, 'popup.js'));
  assert.notEqual(env.run().status, 0);
  assert.equal(fs.existsSync(env.output), false);
});

test('rejects missing required runtime before creating output', t => {
  const env = fixture(t);
  fs.unlinkSync(path.join(env.directory, 'browser-api.js'));
  const result = env.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /browser-api\.js/);
  assert.equal(fs.existsSync(env.output), false);
});

test('rejects optional Firefox recovery files rather than silently archiving them', t => {
  const env = fixture(t);
  fs.writeFileSync(path.join(env.directory, 'recovery.js'), 'unexpected');
  assert.notEqual(env.run().status, 0);
  assert.equal(fs.existsSync(env.output), false);
});

test('cleans staging and leaves output empty after ZIP failure', t => {
  const env = fixture(t);
  fs.mkdirSync(env.output);
  const bin = path.join(env.directory, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'zip'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
  const result = env.run([], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.deepEqual(fs.readdirSync(env.output), []);
  assert.deepEqual(fs.readdirSync(env.directory).filter(name => name.startsWith('workspace-release-')), []);
});

test('does not remove a conflicting output file created during build', t => {
  const env = fixture(t);
  fs.mkdirSync(env.output);
  const bin = path.join(env.directory, 'bin');
  fs.mkdirSync(bin);
  const conflict = path.join(env.output, outputNames(env.version)[0]);
  fs.writeFileSync(path.join(bin, 'zip'), [
    '#!/bin/sh',
    'case "$*" in *releases/workspace-manager-v*) exec /usr/bin/zip "$@" ;; esac',
    'printf "existing\\n" > "$BUILD_OUTPUT/$BUILD_NAME"',
    'exit 17'
  ].join('\n'), { mode: 0o755 });
  const result = env.run([], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    BUILD_OUTPUT: env.output,
    BUILD_NAME: outputNames(env.version)[0]
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'existing\n');
  assert.deepEqual(fs.readdirSync(env.output), [path.basename(conflict)]);
});

test('keeps unrelated file in newly-created output after concurrent build conflict', t => {
  const env = fixture(t);
  const bin = path.join(env.directory, 'bin');
  fs.mkdirSync(bin);
  const conflict = path.join(env.directory, 'dist', outputNames(env.version)[0]);
  fs.writeFileSync(path.join(bin, 'zip'), [
    '#!/bin/sh',
    'case "$*" in *releases/workspace-manager-v*) exec /usr/bin/zip "$@" ;; esac',
    'mkdir -p "$BUILD_OUTPUT"',
    'printf "user-data\\n" > "$BUILD_OUTPUT/$BUILD_NAME"',
    'exit 17'
  ].join('\n'), { mode: 0o755 });
  const result = env.runRaw(['--tag', `v${env.version}`], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    BUILD_OUTPUT: path.join(env.directory, 'dist'),
    BUILD_NAME: outputNames(env.version)[0]
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'user-data\n');
  assert.deepEqual(fs.readdirSync(path.join(env.directory, 'dist')), [path.basename(conflict)]);
});

test('rejects unsafe and unknown CLI arguments', t => {
  const env = fixture(t);
  assert.notEqual(env.run(['--unknown']).status, 0);
  assert.notEqual(env.run(['--tag', '-n']).status, 0);
  assert.notEqual(env.run(['--tag', `v${env.version}`, '--tag', `v${env.version}`]).status, 0);
  assert.equal(fs.existsSync(env.output), false);
});

test('keeps fixture source root unchanged and omits private files from release output', t => {
  const env = fixture(t);
  for (const file of ['tests/private.cjs', 'CLAUDE.md', '.env', 'scripts/private.cjs']) {
    fs.mkdirSync(path.dirname(path.join(env.directory, file)), { recursive: true });
    fs.writeFileSync(path.join(env.directory, file), 'private');
  }
  const before = runtimeFiles.map(file => fs.readFileSync(path.join(env.directory, file)));
  assert.equal(env.run().status, 0);
  assert.deepEqual(runtimeFiles.map(file => fs.readFileSync(path.join(env.directory, file))), before);
  assert.equal(fs.readdirSync(env.output).some(name => /private|CLAUDE|env/i.test(name)), false);
});
