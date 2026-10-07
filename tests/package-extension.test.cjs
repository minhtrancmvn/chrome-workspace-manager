const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtimeFiles = ['manifest.json', 'background.js', 'browser-api.js', 'popup.html', 'popup.js',
  'popup.css', 'recovery.html', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'];

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-package-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of [...runtimeFiles, 'package-extension.sh']) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  const version = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')).version;
  const output = path.join(directory, 'releases', `workspace-manager-v${version}.zip`);
  return { directory, output, run: env => spawnSync('bash', ['package-extension.sh'], {
    cwd: directory, input: 'n\n', encoding: 'utf8', env: { ...process.env, ...env }
  }) };
}

function entries(file) {
  const result = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').sort();
}

test('package contains only exact runtime allowlist despite unrelated files', t => {
  const env = fixture(t);
  for (const file of ['tests/private.cjs', 'CLAUDE.md', 'AGENTS.md', 'task_plan.md',
    '.claude/settings.local.json', 'icons/private.txt', 'unrelated.js', '.env', 'scripts/tool.cjs']) {
    fs.mkdirSync(path.dirname(path.join(env.directory, file)), { recursive: true });
    fs.writeFileSync(path.join(env.directory, file), 'not runtime');
  }
  const result = env.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(entries(env.output), [...runtimeFiles].sort());
});

test('missing required runtime file fails and preserves existing release', t => {
  const env = fixture(t);
  fs.mkdirSync(path.dirname(env.output));
  fs.writeFileSync(env.output, 'previous release');
  fs.unlinkSync(path.join(env.directory, 'browser-api.js'));
  const result = env.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /browser-api.js/);
  assert.equal(fs.readFileSync(env.output, 'utf8'), 'previous release');
});

test('zip failure preserves existing release and reports failure', t => {
  const env = fixture(t);
  fs.mkdirSync(path.dirname(env.output));
  fs.writeFileSync(env.output, 'previous release');
  const bin = path.join(env.directory, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'zip'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
  const result = env.run({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(env.output, 'utf8'), 'previous release');
  assert.equal(result.stdout.includes('packaged successfully'), false);
});

test('successful rebuild replaces archive without stale old entries', t => {
  const env = fixture(t);
  fs.mkdirSync(path.dirname(env.output));
  fs.writeFileSync(path.join(env.directory, 'old.txt'), 'old');
  assert.equal(spawnSync('zip', [env.output, 'old.txt'], { cwd: env.directory }).status, 0);
  assert.equal(env.run().status, 0);
  assert.deepEqual(entries(env.output), [...runtimeFiles].sort());
});

test('symlinked runtime file is rejected without including external data', t => {
  const env = fixture(t);
  fs.writeFileSync(path.join(env.directory, 'private.txt'), 'private');
  fs.unlinkSync(path.join(env.directory, 'popup.js'));
  fs.symlinkSync('private.txt', path.join(env.directory, 'popup.js'));
  const result = env.run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(env.output), false);
});

test('packaging resolves runtime files relative to script when launched elsewhere', t => {
  const env = fixture(t);
  const result = spawnSync('bash', [path.join(env.directory, 'package-extension.sh')], {
    cwd: path.dirname(env.directory), input: '', encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(entries(env.output), [...runtimeFiles].sort());
  const manifest = spawnSync('unzip', ['-p', env.output, 'manifest.json'], { encoding: 'utf8' });
  assert.equal(manifest.stdout, fs.readFileSync(path.join(env.directory, 'manifest.json'), 'utf8'));
});

test('failed zip build cleans temporary directory without touching previous archive', t => {
  const env = fixture(t);
  fs.mkdirSync(path.dirname(env.output));
  fs.writeFileSync(env.output, 'previous release');
  const bin = path.join(env.directory, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'zip'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.notEqual(env.run({ PATH: `${bin}${path.delimiter}${process.env.PATH}` }).status, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(env.output)), [path.basename(env.output)]);
});

test('symlinked icon directory is rejected before release creation', t => {
  const env = fixture(t);
  fs.renameSync(path.join(env.directory, 'icons'), path.join(env.directory, 'external-icons'));
  fs.symlinkSync('external-icons', path.join(env.directory, 'icons'));
  assert.notEqual(env.run().status, 0);
  assert.equal(fs.existsSync(env.output), false);
});

test('symlinked release output is rejected without overwriting its target', t => {
  const env = fixture(t);
  fs.mkdirSync(path.dirname(env.output));
  const privateFile = path.join(env.directory, 'private.txt');
  fs.writeFileSync(privateFile, 'private');
  fs.symlinkSync(privateFile, env.output);
  assert.notEqual(env.run().status, 0);
  assert.equal(fs.readFileSync(privateFile, 'utf8'), 'private');
  assert.equal(fs.lstatSync(env.output).isSymbolicLink(), true);
});

test('archive file bytes match source runtime files and skipped changelog remains untouched', t => {
  const env = fixture(t);
  fs.mkdirSync(path.dirname(env.output));
  const changelog = path.join(env.directory, 'releases', 'CHANGELOG.md');
  fs.writeFileSync(changelog, '# Existing changelog\n');
  assert.equal(env.run().status, 0);
  for (const file of runtimeFiles) {
    const result = spawnSync('unzip', ['-p', env.output, file]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout, fs.readFileSync(path.join(env.directory, file)));
  }
  assert.equal(fs.readFileSync(changelog, 'utf8'), '# Existing changelog\n');
});

test('malformed manifest version fails before writing a release', t => {
  const env = fixture(t);
  fs.writeFileSync(path.join(env.directory, 'manifest.json'), JSON.stringify({ version: '../escape' }));
  assert.notEqual(env.run().status, 0);
  assert.equal(fs.existsSync(path.join(env.directory, 'releases')), false);
});
