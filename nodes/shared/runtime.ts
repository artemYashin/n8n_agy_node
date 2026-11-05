import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extract } from 'tar';
import { releases } from './releases.js';

export type Release = { version: string; url: string; sha512: string };
const installs = new Map<string, Promise<string>>();
const maxDownload = 300 * 1024 * 1024;

export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : '';
  const os = platform === 'win32' ? 'windows' : platform;
  if (!cpu || !['linux', 'darwin', 'windows'].includes(os)) {
    throw new Error(`Automatic Agy installation does not support ${platform}/${arch}. Set CLI Executable to a compatible binary.`);
  }
  // Google's Linux musl builds are static and work on both Alpine and glibc Linux.
  return `${os}_${cpu}${os === 'linux' ? '_musl' : ''}`;
}

export async function verifyChecksum(path: string, expected: string): Promise<void> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected) throw new Error('Agy download checksum mismatch. The downloaded file was rejected.');
}

export async function extractBinary(archive: string, directory: string): Promise<string> {
  let invalidEntry = false;
  await extract({
    file: archive, cwd: directory, strict: true, preservePaths: false,
    filter: (path, entry) => {
      if (path !== 'antigravity' && path !== './antigravity') return false;
      if (!('type' in entry) || entry.type !== 'File' || entry.size > 512 * 1024 * 1024) {
        invalidEntry = true;
        return false;
      }
      return true;
    },
  });
  if (invalidEntry) throw new Error('Invalid Agy archive entry');
  const binary = join(directory, 'antigravity');
  if (!(await stat(binary)).isFile()) throw new Error('Agy archive contains no executable');
  return binary;
}

async function download(url: string, destination: string): Promise<void> {
  if (!url.startsWith('https://storage.googleapis.com/antigravity-public/antigravity-cli/')) {
    throw new Error('Untrusted Agy download location');
  }
  const signal = AbortSignal.timeout(180_000);
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Agy download failed (HTTP ${response.status}). Allow access to storage.googleapis.com.`);
  if (Number(response.headers.get('content-length')) > maxDownload) throw new Error('Agy download exceeds the size limit');
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maxDownload ? new Error('Agy download exceeds the size limit') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), limit,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
}

async function usable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

// Exported for offline tests of integrity, extraction and simultaneous installs.
export async function installRelease(root: string, key: string, release: Release,
  downloadFile: (url: string, destination: string) => Promise<void> = download): Promise<string> {
  const directory = join(root, release.version, key);
  const binary = join(directory, key.startsWith('windows_') ? 'agy.exe' : 'agy');
  if (await usable(binary)) return binary;
  const existing = installs.get(binary);
  if (existing) return await existing;
  const installation = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(directory, '.install-'));
    try {
      const payload = join(staging, 'download');
      await downloadFile(release.url, payload);
      await verifyChecksum(payload, release.sha512);
      const extracted = release.url.endsWith('.tar.gz') ? await extractBinary(payload, staging) : payload;
      await chmod(extracted, 0o755);
      // Only verified, complete files become visible. Separate workers may download
      // concurrently; each gets a private staging directory and identical release.
      try { await rename(extracted, binary); }
      catch (error) { if (!(await usable(binary))) throw error; }
      return binary;
    } finally { await rm(staging, { recursive: true, force: true }); }
  })();
  installs.set(binary, installation);
  try { return await installation; }
  finally { installs.delete(binary); }
}

export async function resolveExecutable(requested?: string): Promise<string> {
  const value = requested?.trim();
  // Treat the old default "agy" as automatic too, so existing credentials work.
  if (value && value !== 'auto' && value !== 'agy') return value;
  const key = platformKey();
  const release = releases[key];
  const root = resolve(process.env.AGY_CLI_CACHE_DIR || join(homedir(), '.n8n', 'agy-runtime'));
  try { return await installRelease(root, key, release); }
  catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown installation error';
    throw new Error(`Automatic Agy installation failed: ${detail}. The n8n user needs a writable cache (${root}) and internet access. Set AGY_CLI_CACHE_DIR to change the cache location.`);
  }
}

export function launchError(error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') return 'Executable or its system loader was not found. Set CLI Executable to auto to install the compatible Agy build.';
  if (error.code === 'EACCES') return 'Permission denied. The CLI file must be executable and its filesystem must allow execution.';
  return `Unable to launch Agy (${error.code || 'unknown OS error'}). Check the executable path and platform compatibility.`;
}
