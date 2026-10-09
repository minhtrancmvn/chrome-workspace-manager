const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'release-version.cjs');

function fixture(t, beforeVersion, afterVersion) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const previous = path.join(directory, 'previous.json');
  const current = path.join(directory, 'current.json');
  fs.writeFileSync(previous, JSON.stringify({ version: beforeVersion }));
  fs.writeFileSync(current, JSON.stringify({ version: afterVersion }));
  return spawnSync(process.execPath, [script, previous, current], { encoding: 'utf8' });
}

test('detects a greater patch version', t => {
  const result = fixture(t, '2.3.18', '2.3.19');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'release=true\nversion=2.3.19\n');
});

test('skips unchanged and lower versions lexically and numerically', t => {
  const unchanged = fixture(t, '2.3.18', '2.3.18');
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(unchanged.stdout, 'release=false\nversion=2.3.18\n');
  const lower = fixture(t, '2.4.0', '2.3.99');
  assert.notEqual(lower.status, 0);
  assert.match(lower.stderr, /cannot decrease/);
});

test('accepts major and minor releases as increases', t => {
  for (const [before, after] of [['1.9.99', '2.0.0'], ['2.3.18', '2.4.0']]) {
    const result = fixture(t, before, after);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `release=true\nversion=${after}\n`);
  }
});

test('rejects malformed and leading-zero versions', t => {
  for (const [before, after] of [['2.3.18', '02.3.19'], ['2.3', '2.3.19'], ['v2.3.18', '2.3.19']]) {
    assert.notEqual(fixture(t, before, after).status, 0);
  }
});

test('rejects missing arguments', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:/);
});
