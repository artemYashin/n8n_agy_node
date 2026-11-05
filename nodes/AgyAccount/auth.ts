import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveExecutable, launchError } from '../shared/runtime.js';

const execFileAsync = promisify(execFile);
type Login = {
  owner: string;
  executable: string;
  child: ChildProcessWithoutNullStreams;
  url?: string;
  submitting: boolean;
  closed: Promise<number | null>;
  expiry?: NodeJS.Timeout;
};

// The CLI uses one host account. Serialize logins across credentials to prevent races.
// Pending OAuth state/PKCE verifier belongs to the CLI process, never workflow data.
let active: Login | undefined;

function kill(login: Login) {
  if (login.expiry) clearTimeout(login.expiry);
  if (active === login) active = undefined;
  try {
    if (process.platform !== 'win32' && login.child.pid) process.kill(-login.child.pid, 'SIGKILL');
    else login.child.kill('SIGKILL');
  } catch { /* Already exited. */ }
}

export function parseLoginUrl(text: string): string | undefined {
  for (const match of text.matchAll(/https:\/\/[^\s<>"\x1b]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.origin === 'https://accounts.google.com' &&
          ['/o/oauth2/auth', '/o/oauth2/v2/auth'].includes(url.pathname) &&
          url.searchParams.get('response_type') === 'code' &&
          url.searchParams.get('code_challenge_method') === 'S256' &&
          url.searchParams.has('code_challenge') && url.searchParams.has('state')) return url.toString();
    } catch { /* Ignore non-URL diagnostics. */ }
  }
  return undefined;
}

export async function startLogin(owner: string, executable = 'agy', lifetimeMs = 10 * 60_000): Promise<{ authorizationUrl: string; expiresInSeconds: number }> {
  if (!owner) throw new Error('Save and select an Agy CLI Account credential first.');
  const resolved = await resolveExecutable(executable);
  if (active && active.owner !== owner) throw new Error('Another credential is signing in on this server. Finish or cancel that sign-in first.');
  if (active?.submitting) throw new Error('Sign-in is already being completed. Wait for it to finish.');
  if (active) kill(active);
  const child = spawn(resolved, ['acp', '--login'], {
    shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const login: Login = { owner, executable, child, submitting: false,
    closed: new Promise((resolve) => child.once('close', resolve)),
  };
  active = login;
  login.expiry = setTimeout(() => kill(login), lifetimeMs);
  login.expiry.unref();
  return await new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const fail = (message: string) => {
      if (!settled) { settled = true; reject(new Error(message)); }
      kill(login);
    };
    const startup = setTimeout(() => fail('Agy did not provide a sign-in link within 20 seconds. Check that the CLI supports acp --login.'), Math.min(20_000, lifetimeMs));
    const consume = (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (output.length > 64 * 1024) return fail('Agy login produced unexpected output. Check the CLI installation.');
      // Parse complete lines only: an OAuth URL may be split across pipe chunks.
      const newline = output.lastIndexOf('\n');
      if (newline < 0) return;
      const url = parseLoginUrl(output.slice(0, newline));
      if (url) {
        settled = true;
        clearTimeout(startup);
        login.url = url;
        output = '';
        resolve({ authorizationUrl: url, expiresInSeconds: Math.floor(lifetimeMs / 1000) });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.stdin.on('error', () => { /* close handles a rejected/closed login session */ });
    child.on('error', (error) => {
      clearTimeout(startup);
      fail(`Cannot start Agy sign-in. ${launchError(error)}`);
    });
    child.once('close', () => {
      clearTimeout(startup);
      fail('Agy sign-in ended or expired. Run Start Sign-In again.');
    });
  });
}

export async function completeLogin(owner: string, executable: string, code: string): Promise<void> {
  const login = active;
  if (!login || login.owner !== owner || login.executable !== executable) {
    throw new Error('No matching sign-in is pending on this n8n process. Run Start Sign-In again with the same credential.');
  }
  if (login.submitting) throw new Error('Sign-in is already being completed.');
  const value = code.trim();
  if (!value || value.length > 8192 || /[\r\n\0]/.test(value)) {
    throw new Error('Enter a single authorization code or callback URL in the Agy CLI Account credential.');
  }
  login.submitting = true;
  const completionTimeout = setTimeout(() => kill(login), 60_000);
  try {
    login.child.stdin.end(value + '\n');
    const exitCode = await login.closed;
    if (exitCode !== 0) throw new Error('Agy could not complete sign-in. The code may be invalid or expired. Start a new sign-in and try again.');
  } finally {
    clearTimeout(completionTimeout);
    kill(login);
  }
}

export function cancelLogin(owner: string): boolean {
  if (!active || active.owner !== owner) return false;
  kill(active);
  return true;
}

export async function checkConnection(executable = 'agy'): Promise<{ connected: true; models: string[] }> {
  const models = await listModels(executable);
  return { connected: true, models: models.map((model) => model.value) };
}

export function parseModels(stdout: string): Array<{ name: string; value: string }> {
  return stdout.split(/\r?\n/).filter((line) => line.includes('\t')).map((line) => {
    const [id, ...label] = line.split('\t');
    return { value: id.trim(), name: label.join(' ').trim() || id.trim() };
  }).filter((model) => Boolean(model.value));
}

export async function listModels(executable = 'auto'): Promise<Array<{ name: string; value: string }>> {
  const resolved = await resolveExecutable(executable);
  try {
    const { stdout } = await execFileAsync(resolved, ['models'], { timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true });
    const models = parseModels(stdout);
    if (!models.length) throw new Error('No models');
    return models;
  } catch {
    // Never forward CLI output: authentication failures can include sensitive data.
    throw new Error('Cannot list Agy models. Check the executable path, network, and saved sign-in. Use Agy Account → Start Sign-In to connect.');
  }
}
