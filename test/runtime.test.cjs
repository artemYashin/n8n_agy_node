const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, readdir, rm, copyFile, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const tar = require('tar');
const { installRelease, platformKey, resolveExecutable, extractBinary } = require('../dist/nodes/shared/runtime.js');

test('selects static Linux builds for Alpine and maps supported architectures', () => {
  assert.equal(platformKey('linux', 'x64'), 'linux_amd64_musl');
  assert.equal(platformKey('linux', 'arm64'), 'linux_arm64_musl');
  assert.equal(platformKey('darwin', 'arm64'), 'darwin_arm64');
  assert.equal(platformKey('win32', 'x64'), 'windows_amd64');
  assert.throws(() => platformKey('linux', 'ia32'), /does not support/);
});

test('explicit executable overrides do not trigger downloads', async () => {
  assert.equal(await resolveExecutable('/my/custom/agy'), '/my/custom/agy');
});

test('verifies and extracts a download once for simultaneous requests, then reuses cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-runtime-test-'));
  try {
    await writeFile(join(root, 'antigravity'), 'test executable');
    const archive = join(root, 'fixture.tar.gz');
    await tar.c({ file: archive, cwd: root, gzip: true }, ['antigravity']);
    const sha512 = createHash('sha512').update(await readFile(archive)).digest('hex');
    const release = { version: 'test', url: 'https://example.invalid/fixture.tar.gz', sha512 };
    let downloads = 0;
    const download = async (_url, destination) => { downloads++; await copyFile(archive, destination); };
    const paths = await Promise.all(Array.from({ length: 4 }, () => installRelease(root, 'linux_amd64_musl', release, download)));
    assert.equal(new Set(paths).size, 1);
    assert.equal(downloads, 1);
    assert.equal(await readFile(paths[0], 'utf8'), 'test executable');
    assert.equal(await installRelease(root, 'linux_amd64_musl', release, download), paths[0]);
    assert.equal(downloads, 1);
    assert.deepEqual(await readdir(join(root, 'test', 'linux_amd64_musl')), ['agy']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checksum mismatch never installs a binary and permits retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-runtime-test-'));
  try {
    const bytes = Buffer.from('download');
    const release = { version: 'test', url: 'https://example.invalid/agy.exe', sha512: '0'.repeat(128) };
    const download = async (_url, destination) => writeFile(destination, bytes);
    await assert.rejects(installRelease(root, 'windows_amd64', release, download), /checksum mismatch/);
    assert.deepEqual(await readdir(join(root, 'test', 'windows_amd64')), []);
    release.sha512 = createHash('sha512').update(bytes).digest('hex');
    const binary = await installRelease(root, 'windows_amd64', release, download);
    assert.deepEqual(await readFile(binary), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download failure cleans staging and can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-runtime-test-'));
  try {
    const release = { version: 'test', url: 'https://example.invalid/agy.exe', sha512: '' };
    await assert.rejects(installRelease(root, 'windows_amd64', release, async () => { throw new Error('offline'); }), /offline/);
    assert.deepEqual(await readdir(join(root, 'test', 'windows_amd64')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive symlink is rejected instead of installed as an executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-runtime-test-'));
  try {
    await symlink('/etc/passwd', join(root, 'antigravity'));
    const archive = join(root, 'fixture.tar.gz');
    await tar.c({ file: archive, cwd: root, gzip: true }, ['antigravity']);
    const destination = await mkdtemp(join(root, 'extract-'));
    await assert.rejects(extractBinary(archive, destination), /Invalid Agy archive/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
