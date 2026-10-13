import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { StudioError } from './paths.mjs';

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const DEFAULT_LINE_LIMIT = 256 * 1024;

function assertInvocation(executable, args) {
  if (typeof executable !== 'string' || executable.trim() === '' || executable.includes('\0')) {
    throw new StudioError('A valid executable is required.', {
      code: 'INVALID_EXECUTABLE',
    });
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new StudioError('Process arguments must be supplied as an array of strings.', {
      code: 'INVALID_PROCESS_ARGUMENTS',
    });
  }
}

function readLimit(value, fallback, name) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new StudioError(`${name} must be a non-negative integer.`, {
      code: 'INVALID_PROCESS_OPTION',
      details: { option: name },
    });
  }
  return limit;
}

class TailBuffer {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.length = 0;
    this.truncated = false;
  }

  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length === 0) return;
    if (this.limit === 0) {
      this.truncated = true;
      return;
    }
    this.chunks.push(buffer);
    this.length += buffer.length;
    while (this.length > this.limit && this.chunks.length > 0) {
      const overflow = this.length - this.limit;
      const first = this.chunks[0];
      if (first.length <= overflow) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.length -= overflow;
      }
      this.truncated = true;
    }
  }

  text() {
    return Buffer.concat(this.chunks, this.length).toString('utf8');
  }
}

/**
 * Spawn a process without a command shell. Only an executable plus an argument
 * array is accepted, preventing command-string interpretation.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, windowsHide?: boolean, signal?: AbortSignal}} [options]
 * @returns {import('node:child_process').ChildProcessWithoutNullStreams}
 */
export function spawnProcess(executable, args, options = {}) {
  assertInvocation(executable, args);
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide ?? true,
    detached: false,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  if (options.signal !== undefined) spawnOptions.signal = options.signal;

  try {
    return spawn(executable, [...args], spawnOptions);
  } catch (error) {
    throw new StudioError('Process could not be started.', {
      code: 'PROCESS_SPAWN_FAILED',
      details: { executable, args: [...args], cwd: options.cwd },
      cause: error,
    });
  }
}

function createLineReader(streamName, callback, specificCallback, maxLineChars, fail) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const emit = (line, truncated = false) => {
    try {
      callback?.(line, { stream: streamName, truncated });
      specificCallback?.(line, { truncated });
    } catch (error) {
      fail(error);
    }
  };

  const consume = (text) => {
    pending += text;
    const lines = pending.split(/\r\n|\n|\r/);
    pending = lines.pop() ?? '';
    for (const line of lines) emit(line);
    while (pending.length > maxLineChars) {
      emit(pending.slice(0, maxLineChars), true);
      pending = pending.slice(maxLineChars);
    }
  };

  return {
    data(chunk) {
      consume(decoder.write(chunk));
    },
    end() {
      consume(decoder.end());
      if (pending.length > 0) emit(pending);
      pending = '';
    },
  };
}

/**
 * Run a process to completion with bounded output capture, optional line
 * callbacks and a hard timeout. Output buffers retain the newest bytes so that
 * FFmpeg's final diagnostic remains available when earlier output is dropped.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   windowsHide?: boolean,
 *   signal?: AbortSignal,
 *   input?: string|Buffer,
 *   timeoutMs?: number,
 *   killGraceMs?: number,
 *   maxOutputBytes?: number,
 *   maxStdoutBytes?: number,
 *   maxStderrBytes?: number,
 *   maxLineChars?: number,
 *   onLine?: (line: string, info: {stream: 'stdout'|'stderr', truncated: boolean}) => void,
 *   onStdoutLine?: (line: string, info: {truncated: boolean}) => void,
 *   onStderrLine?: (line: string, info: {truncated: boolean}) => void
 * }} [options]
 * @returns {Promise<{
 *   executable: string,
 *   args: string[],
 *   pid: number|undefined,
 *   code: number,
 *   signal: NodeJS.Signals|null,
 *   stdout: string,
 *   stderr: string,
 *   stdoutTruncated: boolean,
 *   stderrTruncated: boolean,
 *   durationMs: number
 * }>}
 */
export function runProcess(executable, args, options = {}) {
  assertInvocation(executable, args);
  if (
    options.input !== undefined
    && typeof options.input !== 'string'
    && !Buffer.isBuffer(options.input)
    && !(options.input instanceof Uint8Array)
  ) {
    throw new StudioError('Process input must be a string, Buffer or Uint8Array.', {
      code: 'INVALID_PROCESS_OPTION',
      details: { option: 'input' },
    });
  }
  const sharedLimit = readLimit(options.maxOutputBytes, DEFAULT_OUTPUT_LIMIT, 'maxOutputBytes');
  const stdoutLimit = readLimit(options.maxStdoutBytes, sharedLimit, 'maxStdoutBytes');
  const stderrLimit = readLimit(options.maxStderrBytes, sharedLimit, 'maxStderrBytes');
  const timeoutMs = readLimit(options.timeoutMs, 0, 'timeoutMs');
  const killGraceMs = readLimit(options.killGraceMs, 2_000, 'killGraceMs');
  const maxLineChars = readLimit(options.maxLineChars, DEFAULT_LINE_LIMIT, 'maxLineChars');
  if (maxLineChars < 1) {
    throw new StudioError('maxLineChars must be at least 1.', {
      code: 'INVALID_PROCESS_OPTION',
      details: { option: 'maxLineChars' },
    });
  }
  for (const callbackName of ['onLine', 'onStdoutLine', 'onStderrLine']) {
    const callback = options[callbackName];
    if (callback !== undefined && typeof callback !== 'function') {
      throw new StudioError(`${callbackName} must be a function.`, {
        code: 'INVALID_PROCESS_OPTION',
        details: { option: callbackName },
      });
    }
  }

  const startedAt = Date.now();
  let child;
  try {
    child = spawnProcess(executable, args, options);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const stdout = new TailBuffer(stdoutLimit);
    const stderr = new TailBuffer(stderrLimit);
    let settled = false;
    let timedOut = false;
    let callbackError;
    let stdinError;
    let timeoutHandle;
    let forceKillHandle;

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceKillHandle = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, killGraceMs);
      forceKillHandle.unref?.();
    };

    const onCallbackFailure = (error) => {
      if (callbackError) return;
      callbackError = error;
      stop();
    };

    const stdoutLines = createLineReader(
      'stdout',
      options.onLine,
      options.onStdoutLine,
      maxLineChars,
      onCallbackFailure,
    );
    const stderrLines = createLineReader(
      'stderr',
      options.onLine,
      options.onStderrLine,
      maxLineChars,
      onCallbackFailure,
    );

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      stdoutLines.data(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      stderrLines.data(chunk);
    });
    child.stdout.on('end', () => stdoutLines.end());
    child.stderr.on('end', () => stderrLines.end());
    child.stdin.on('error', (error) => {
      // Closing an unused stdin after a very short process can legitimately
      // race with process exit. Never let EPIPE become an unhandled event.
      if (error?.code === 'EPIPE' && options.input === undefined) return;
      if (!stdinError) stdinError = error;
      stop();
    });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (error) reject(error);
      else resolve(result);
    };

    child.once('error', (error) => {
      finish(
        new StudioError('Process could not be started or run.', {
          code: 'PROCESS_SPAWN_FAILED',
          details: { executable, args: [...args], cwd: options.cwd },
          cause: error,
        }),
      );
    });

    child.once('close', (code, signal) => {
      const result = {
        executable,
        args: [...args],
        pid: child.pid,
        code: code ?? -1,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - startedAt,
      };

      if (callbackError) {
        finish(
          new StudioError('A process line callback failed.', {
            code: 'PROCESS_CALLBACK_FAILED',
            details: result,
            cause: callbackError,
          }),
        );
      } else if (stdinError) {
        finish(
          new StudioError('Process input could not be written completely.', {
            code: 'PROCESS_STDIN_FAILED',
            details: result,
            cause: stdinError,
          }),
        );
      } else if (timedOut) {
        finish(
          new StudioError(`Process exceeded the timeout of ${timeoutMs} ms.`, {
            code: 'PROCESS_TIMEOUT',
            details: { ...result, timeoutMs },
          }),
        );
      } else if (code !== 0) {
        finish(
          new StudioError(`Process exited with code ${code ?? 'unknown'}.`, {
            code: 'PROCESS_FAILED',
            details: result,
          }),
        );
      } else {
        finish(undefined, result);
      }
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    try {
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    } catch (error) {
      stdinError = error;
      stop();
    }
  });
}
