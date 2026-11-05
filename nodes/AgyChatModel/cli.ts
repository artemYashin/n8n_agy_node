import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable, launchError } from '../shared/runtime.js';

export interface CliOptions {
  executable?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onText?: (delta: string) => void;
}

export interface AgyResult {
  status: string;
  response: string;
  error?: string;
  conversation_id?: string;
  structured_output?: unknown;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
}

// Use stdin and argument arrays: prompts never pass through a shell or argv.
export async function runAgy(
  options: CliOptions,
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<AgyResult> {
  signal?.throwIfAborted();
  const executable = await resolveExecutable(options.executable);
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'n8n-agy-'));
  try {
    const agents = join(directory, '.agents', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, 'n8n-provider.md'), [
      '---', 'name: n8n-provider', 'description: Chat model adapter for n8n',
      'mainAgent: true', 'subagent: false', 'tools: []', '---',
      '# System Prompt', systemPrompt,
    ].join('\n'), { mode: 0o600 });
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeout) || timeout < 1) throw new Error('Timeout must be positive');
    const args = [
      '--agent=n8n-provider', '--input-format=stream-json', '--output-format=stream-json',
      '--disable-slash-commands', `--print-timeout=${timeout}ms`,
    ];
    if (options.model) args.push(`--model=${options.model}`);
    if (options.effort) args.push(`--effort=${options.effort}`);
    signal?.throwIfAborted();
    return await new Promise<AgyResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: directory, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
      let pending = '';
      let stderr = '';
      let bytes = 0;
      let result: AgyResult | undefined;
      let failure: Error | undefined;
      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Process may already have exited. */ }
      };
      const fail = (error: Error) => { failure ??= error; kill(); };
      const abort = () => fail(new Error('Agy request aborted'));
      const timer = setTimeout(() => fail(new Error(`Agy timed out after ${timeout} ms`)), timeout);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const parseLine = (line: string) => {
        if (!line.trim() || failure) return;
        try {
          const event = JSON.parse(line);
          if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' && typeof event.step_update.text_delta === 'string') {
            options.onText?.(event.step_update.text_delta);
          }
          if (event.event === 'result') {
            if (result) throw new Error('Multiple result events');
            result = event.result;
          }
        } catch { fail(new Error('Agy emitted invalid or unexpected JSON output')); }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > (options.maxOutputBytes ?? 16 * 1024 * 1024)) {
          fail(new Error('Agy output exceeded the configured size limit'));
          return;
        }
      });
      // StringDecoder via setEncoding preserves UTF-8 characters split across chunks.
      child.stdout.on('data', (chunk: string) => {
        if (failure) return;
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          parseLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', (error) => { failure = new Error(`Cannot start agy: ${launchError(error)}`); });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') fail(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        parseLine(pending);
        if (failure) return reject(failure);
        if (code !== 0 || !result || result.status !== 'SUCCESS') {
          return reject(new Error(`Agy failed (exit ${code}): ${result?.error || stderr.trim() || result?.status || 'missing result'}`));
        }
        if (typeof result.response !== 'string') return reject(new Error('Agy result has no response text'));
        resolve(result);
      });
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
