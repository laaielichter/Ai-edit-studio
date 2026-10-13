import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  DATA_ROOT,
  StudioError,
  ensureDataRoot,
  safeResolveWithin,
  slugify,
  writeJsonAtomic,
} from './paths.mjs';
import { inspectFfmpeg, verifyVideo } from './ffmpeg.mjs';
import { runProcess } from './process.mjs';

const STATE_PATH = path.join(DATA_ROOT, 'capture-state.json');
const STARTUP_TIMEOUT_MS = 12_000;
const GRACEFUL_STOP_MS = 10_000;
const TERMINATE_STOP_MS = 5_000;
const FORCE_STOP_MS = 5_000;
const BUSY_STATES = new Set(['starting', 'recording', 'stopping', 'finalizing', 'orphaned']);

function powershellPath() {
  const system = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  return fsSync.existsSync(system) ? system : 'powershell.exe';
}

function normalizeWindowHandle(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const handle = BigInt(raw);
    return handle > 0n ? `0x${handle.toString(16).toUpperCase()}` : null;
  } catch {
    return null;
  }
}

function normalizeProcessList(parsed) {
  if (!parsed) return [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => {
    const pid = Number(item.Id);
    const executable = item.Path ? String(item.Path) : null;
    const startedAt = item.StartTime ? String(item.StartTime) : null;
    const windowHandle = normalizeWindowHandle(item.WindowHandle);
    const selectable = Number.isSafeInteger(pid) && pid > 0 && Boolean(startedAt && windowHandle);
    return {
      id: pid,
      pid,
      name: String(item.Name ?? item.ProcessName ?? ''),
      title: String(item.MainWindowTitle ?? ''),
      executable,
      exePath: executable,
      startedAt,
      windowHandle,
      selectable,
      reason: selectable ? null : 'Process identity or window handle cannot be read safely.',
    };
  }).filter((item) => item.id > 0 && item.name && item.title && item.windowHandle);
}

export async function listWindowProcesses(query = '') {
  if (process.platform !== 'win32') return [];
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |',
    "Select-Object Id,ProcessName,@{n='Name';e={$_.ProcessName}},MainWindowTitle,Path,@{n='StartTime';e={$_.StartTime.ToString('o')}},@{n='WindowHandle';e={'0x{0:X}' -f $_.MainWindowHandle.ToInt64()}} |",
    'ConvertTo-Json -Compress',
  ].join(' ');
  const result = await runProcess(powershellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { timeoutMs: 20_000, maxOutputBytes: 4 * 1024 * 1024 });
  let parsed;
  try {
    parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  } catch (error) {
    throw new StudioError('PROCESS_LIST_FAILED', 'Windows process list could not be read.', { cause: error });
  }
  const needle = String(query).trim().replace(/\.exe$/i, '').toLowerCase();
  return normalizeProcessList(parsed)
    .filter((item) => !needle
      || item.name.toLowerCase().includes(needle)
      || item.title.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

function sameStartTime(left, right) {
  if (!left || !right) return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime)
    ? leftTime === rightTime
    : String(left) === String(right);
}

async function resolveProcess(selector) {
  const all = await listWindowProcesses();
  const structured = selector && typeof selector === 'object' && !Array.isArray(selector);
  const raw = structured
    ? String(selector.pid ?? selector.id ?? selector.name ?? '').trim()
    : String(selector ?? '').trim();
  if (!raw) throw new StudioError('PROCESS_REQUIRED', 'Provide a process name or PID.');

  let matches;
  if (/^\d+$/.test(raw)) {
    matches = all.filter((item) => item.pid === Number(raw));
  } else {
    const name = raw.replace(/\.exe$/i, '').toLowerCase();
    matches = all.filter((item) => item.name.toLowerCase() === name);
    if (!matches.length) matches = all.filter((item) => item.name.toLowerCase().includes(name));
  }
  if (matches.length !== 1) {
    throw new StudioError(
      matches.length ? 'PROCESS_AMBIGUOUS' : 'PROCESS_NOT_FOUND',
      matches.length
        ? `Multiple windows match ${raw}; choose a PID.`
        : `No visible game window found for ${raw}.`,
      { matches },
    );
  }

  const match = matches[0];
  if (!match.selectable) {
    throw new StudioError(
      'PROCESS_IDENTITY_UNAVAILABLE',
      'PID, start time or window handle could not be read safely.',
      { target: match },
    );
  }
  if (structured && selector.startedAt && !sameStartTime(selector.startedAt, match.startedAt)) {
    throw new StudioError(
      'CAPTURE_TARGET_CHANGED',
      'The selected process has restarted; select the game window again.',
      { selected: selector, current: match },
    );
  }
  const requestedHandle = structured ? normalizeWindowHandle(selector.windowHandle) : null;
  if (requestedHandle && requestedHandle !== match.windowHandle) {
    throw new StudioError(
      'CAPTURE_TARGET_CHANGED',
      'The window handle of the selected process has changed.',
      { selected: selector, current: match },
    );
  }
  return match;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}

function terminationText(termination) {
  if (termination.spawnError) return `FFmpeg could not be started: ${errorText(termination.spawnError)}`;
  return `FFmpeg exited with code ${termination.code ?? 'null'} (${termination.signal ?? 'no signal'}).`;
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export class CaptureManager {
  constructor() {
    this.child = null;
    this.session = null;
    this.finalizePromise = null;
    this.operationTail = Promise.resolve();
    this.persistTail = Promise.resolve();
    this.state = {
      schemaVersion: 1,
      sessionId: null,
      active: false,
      state: 'idle',
      status: 'idle',
      backend: 'ffmpeg-window',
      target: null,
      partial: null,
      output: null,
      path: null,
      warnings: [],
      error: null,
      errorCode: null,
    };
  }

  serialize(operation) {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.catch(() => {});
    return result;
  }

  persist() {
    const snapshot = { ...this.state, capturePid: this.child?.pid ?? null };
    const write = this.persistTail.then(async () => {
      await ensureDataRoot();
      await writeJsonAtomic(STATE_PATH, snapshot);
    });
    this.persistTail = write.catch(() => {});
    return write;
  }

  appendWarning(session, message) {
    if (!message || session.warnings.includes(message)) return;
    session.warnings.push(message);
    if (this.session === session) this.state.warnings = [...session.warnings];
  }

  settleStartup(session, event) {
    if (session.startupSettled) return;
    session.startupSettled = true;
    session.resolveStartup(event);
  }

  handleProgressLine(session, rawLine) {
    const line = String(rawLine).trim();
    const separator = line.indexOf('=');
    if (separator <= 0) return;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'frame') {
      const frame = Number(value);
      if (Number.isFinite(frame)) session.progress.frame = frame;
      if (frame > 0 && !session.firstFrameSeen) {
        session.firstFrameSeen = true;
        session.firstFrameAt = new Date().toISOString();
        this.settleStartup(session, { kind: 'frame', frame });
      }
    } else if (key === 'fps' || key === 'drop_frames' || key === 'dup_frames') {
      const number = Number(value);
      if (Number.isFinite(number)) session.progress[key] = number;
    } else if (key === 'out_time_us') {
      const microseconds = Number(value);
      if (Number.isFinite(microseconds)) session.progress.outTimeSeconds = microseconds / 1_000_000;
    } else if (key === 'progress') {
      session.progress.state = value;
    }
    if (this.session === session) this.state.progress = { ...session.progress };
  }

  handleStderr(session, chunk) {
    const text = String(chunk);
    session.logs.push(...text.split(/\r\n|\n|\r/).filter(Boolean));
    if (session.logs.length > 100) session.logs.splice(0, session.logs.length - 100);
    session.progressBuffer += text;
    const lines = session.progressBuffer.split(/\r\n|\n|\r/);
    session.progressBuffer = lines.pop() ?? '';
    if (session.progressBuffer.length > 32_768) {
      lines.push(session.progressBuffer.slice(0, 32_768));
      session.progressBuffer = '';
    }
    for (const line of lines) this.handleProgressLine(session, line);
    if (this.session === session) this.state.logTail = session.logs.slice(-20);
  }

  waitForStartup(session) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ kind: 'timeout' }), STARTUP_TIMEOUT_MS);
      timeout.unref?.();
      session.startupPromise.then((event) => {
        clearTimeout(timeout);
        resolve(event);
      });
    });
  }

  clearStopTimers(session) {
    for (const timer of [session.terminateTimer, session.forceTimer, session.orphanTimer]) {
      if (timer) clearTimeout(timer);
    }
    session.terminateTimer = null;
    session.forceTimer = null;
    session.orphanTimer = null;
  }

  scheduleStopEscalation(session) {
    if (session.terminateTimer || session.closed) return;
    session.terminateTimer = setTimeout(() => {
      if (session.closed || this.session !== session) return;
      const sent = session.child?.kill('SIGTERM') ?? false;
      if (!sent) this.appendWarning(session, 'FFmpeg did not respond to the terminate request.');
    }, GRACEFUL_STOP_MS);
    session.terminateTimer.unref?.();

    session.forceTimer = setTimeout(() => {
      if (session.closed || this.session !== session) return;
      const sent = session.child?.kill('SIGKILL') ?? false;
      if (!sent) this.appendWarning(session, 'FFmpeg could not be force-stopped.');
    }, GRACEFUL_STOP_MS + TERMINATE_STOP_MS);
    session.forceTimer.unref?.();

    session.orphanTimer = setTimeout(() => {
      if (session.closed || this.session !== session) return;
      this.state = {
        ...this.state,
        active: true,
        state: 'orphaned',
        status: 'orphaned',
        error: 'FFmpeg did not emit a close signal within the stop limit.',
        errorCode: 'CAPTURE_STOP_TIMEOUT',
        warnings: [...session.warnings],
      };
      this.persist().catch(() => {});
    }, GRACEFUL_STOP_MS + TERMINATE_STOP_MS + FORCE_STOP_MS);
    session.orphanTimer.unref?.();
  }

  async requestStop(session, reason = 'user') {
    if (this.session !== session || session.closed || session.stopRequested) return this.status();
    session.stopRequested = true;
    session.stopReason = reason;
    session.stopRequestedAt = new Date().toISOString();
    this.state = {
      ...this.state,
      active: true,
      state: 'stopping',
      status: 'stopping',
      stopRequestedAt: session.stopRequestedAt,
      stopReason: reason,
    };
    await this.persist().catch((error) => {
      this.appendWarning(session, `Stop state could not be saved: ${errorText(error)}`);
    });

    const stdin = session.child?.stdin;
    if (stdin?.writable && !stdin.destroyed) {
      try {
        stdin.write('q\n', (error) => {
          if (error) this.appendWarning(session, `FFmpeg did not accept the stop command: ${errorText(error)}`);
        });
      } catch (error) {
        this.appendWarning(session, `FFmpeg did not accept the stop command: ${errorText(error)}`);
      }
    } else {
      this.appendWarning(session, 'FFmpeg input was already closed; the bounded stop procedure has started.');
    }
    this.scheduleStopEscalation(session);
    return this.status();
  }

  beginFinalize(session, termination) {
    if (session.finalizePromise) return session.finalizePromise;
    session.closed = true;
    session.termination = termination;
    this.clearStopTimers(session);
    this.settleStartup(session, {
      kind: termination.spawnError ? 'error' : 'closed',
      error: termination.spawnError ?? null,
      code: termination.code,
      signal: termination.signal,
    });
    if (this.session === session) {
      this.child = null;
      this.state = {
        ...this.state,
        active: false,
        state: 'finalizing',
        status: 'finalizing',
        stoppedAt: new Date().toISOString(),
        termination: {
          code: termination.code ?? null,
          signal: termination.signal ?? null,
          message: terminationText(termination),
        },
        logTail: session.logs.slice(-20),
      };
    }

    const finalization = this.finalizeSession(session, termination).catch(async (error) => {
      if (this.session === session) {
        this.state = {
          ...this.state,
          active: false,
          state: 'failed',
          status: 'failed',
          error: `Unexpected finalization error: ${errorText(error)}`,
          errorCode: 'CAPTURE_FINALIZE_FAILED',
          warnings: [...session.warnings],
          logTail: session.logs.slice(-20),
        };
        this.session = null;
        this.child = null;
        await this.persist().catch(() => {});
      }
      return this.status();
    });
    session.finalizePromise = finalization;
    this.finalizePromise = finalization;
    finalization.then(
      () => { if (this.finalizePromise === finalization) this.finalizePromise = null; },
      () => { if (this.finalizePromise === finalization) this.finalizePromise = null; },
    );
    return finalization;
  }

  async finalizeSession(session, termination) {
    if (this.session === session) await this.persist().catch(() => {});
    let probe = null;
    let published = false;
    let partialPresent = false;
    let finalState = 'failed';
    let error = terminationText(termination);
    let errorCode = termination.spawnError ? 'CAPTURE_SPAWN_FAILED' : 'CAPTURE_PROCESS_FAILED';
    try {
      if (!session.partial) throw new StudioError('CAPTURE_EMPTY', 'FFmpeg did not create a recording file.');
      const partialInfo = await fs.lstat(session.partial);
      partialPresent = partialInfo.isFile() && !partialInfo.isSymbolicLink() && partialInfo.size > 0;
      if (!partialPresent) throw new StudioError('CAPTURE_EMPTY', 'FFmpeg did not create a usable recording file.');

      probe = await verifyVideo(session.partial, session.tools);
      try {
        await fs.link(session.partial, session.output);
      } catch (publishError) {
        if (publishError?.code === 'EEXIST') {
          throw new StudioError(
            'CAPTURE_OUTPUT_EXISTS',
            'The final recording path already exists; nothing was overwritten.',
            { output: session.output },
          );
        }
        throw publishError;
      }
      published = true;
      try {
        await fs.unlink(session.partial);
        partialPresent = false;
      } catch (unlinkError) {
        this.appendWarning(session, `The verified partial file could not be removed: ${errorText(unlinkError)}`);
      }

      const cleanExit = termination.code === 0 && !termination.spawnError;
      finalState = cleanExit ? 'complete' : 'recovered';
      error = cleanExit ? null : terminationText(termination);
      errorCode = cleanExit ? null : 'CAPTURE_RECOVERED_AFTER_PROCESS_FAILURE';
      if (!cleanExit) {
        this.appendWarning(session, 'FFmpeg exited abnormally, but the full video was verified and published safely.');
      } else if (!session.stopRequested) {
        this.appendWarning(session, 'FFmpeg ended the recording without an explicit stop command.');
      }
    } catch (finalizeError) {
      partialPresent = await pathExists(session.partial).catch(() => false);
      error = `Recording could not be published safely: ${errorText(finalizeError)}`;
      errorCode = finalizeError?.code === 'ENOENT'
        ? 'CAPTURE_EMPTY'
        : (finalizeError?.code ?? 'CAPTURE_VERIFY_FAILED');
      finalState = 'failed';
    }

    if (this.session === session) {
      this.state = {
        ...this.state,
        active: false,
        state: finalState,
        status: finalState,
        stoppedAt: this.state.stoppedAt ?? new Date().toISOString(),
        duration: probe?.duration ?? null,
        output: session.output,
        path: published ? session.output : session.partial,
        partial: session.partial,
        published,
        partialPresent,
        error,
        errorCode,
        warnings: [...session.warnings],
        logTail: session.logs.slice(-20),
      };
      this.session = null;
      this.child = null;
      await this.persist().catch(() => {});
    }
    return this.status();
  }

  async failBeforeSpawn(session, error) {
    if (this.session !== session) return;
    this.state = {
      ...this.state,
      active: false,
      state: 'failed',
      status: 'failed',
      stoppedAt: new Date().toISOString(),
      error: errorText(error),
      errorCode: error?.code ?? 'CAPTURE_START_FAILED',
      warnings: [...session.warnings],
    };
    this.session = null;
    this.child = null;
    await this.persist().catch(() => {});
  }

  start(options = {}) {
    return this.serialize(() => this.startLocked(options));
  }

  async startLocked({
    process: processSelector,
    target: targetSelector,
    project = 'Game capture',
    fps = 60,
    audioDevice = '',
  } = {}) {
    if (this.session || BUSY_STATES.has(this.state.state)) {
      throw new StudioError('CAPTURE_BUSY', 'A recording or finalization is already running.', {
        sessionId: this.state.sessionId,
        state: this.state.state,
      });
    }

    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      child: null,
      tools: null,
      partial: null,
      output: null,
      warnings: [],
      logs: [],
      progress: {},
      progressBuffer: '',
      firstFrameSeen: false,
      firstFrameAt: null,
      startupSettled: false,
      spawned: false,
      closed: false,
      stopRequested: false,
      finalizePromise: null,
    };
    session.startupPromise = new Promise((resolve) => { session.resolveStartup = resolve; });
    this.session = session;
    this.state = {
      schemaVersion: 1,
      sessionId,
      active: false,
      state: 'starting',
      status: 'starting',
      backend: 'ffmpeg-window',
      captureMethod: 'gdigrab-hwnd',
      target: null,
      process: null,
      processName: null,
      project: String(project ?? '').trim() || 'Game capture',
      fps: [30, 60, 120].includes(Number(fps)) ? Number(fps) : 60,
      audioDevice: audioDevice || null,
      requestedAt: new Date().toISOString(),
      startedAt: null,
      firstFrameAt: null,
      stoppedAt: null,
      partial: null,
      output: null,
      path: null,
      published: false,
      warnings: [],
      logTail: [],
      progress: {},
      error: null,
      errorCode: null,
    };

    try {
      await this.persist();
      let target = await resolveProcess(targetSelector ?? processSelector);
      await ensureDataRoot(5 * 1024 ** 3);
      const info = await inspectFfmpeg({ smokeTest: true });
      if (!info.capabilities.gdigrab) {
        throw new StudioError('CAPTURE_BACKEND_MISSING', 'FFmpeg has no gdigrab window capture.');
      }
      target = await resolveProcess({
        pid: target.pid,
        startedAt: target.startedAt,
        windowHandle: target.windowHandle,
      });

      const frameRate = this.state.fps;
      const captureRoot = safeResolveWithin(DATA_ROOT, 'captures', slugify(this.state.project));
      await fs.mkdir(captureRoot, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const baseName = `${stamp}-${slugify(target.name)}-${sessionId.replaceAll('-', '')}`;
      const partial = safeResolveWithin(captureRoot, `${baseName}.partial.mkv`);
      const output = safeResolveWithin(captureRoot, `${baseName}.mkv`);
      if (await pathExists(partial) || await pathExists(output)) {
        throw new StudioError(
          'CAPTURE_PATH_COLLISION',
          'Unique recording paths unexpectedly already exist; nothing was overwritten.',
          { partial, output },
        );
      }
      session.tools = info.tools;
      session.partial = partial;
      session.output = output;

      const args = [
        '-hide_banner', '-n', '-nostats',
        '-stats_period', '0.25', '-progress', 'pipe:2',
        '-thread_queue_size', '512',
        '-f', 'gdigrab', '-framerate', String(frameRate), '-draw_mouse', '0',
        '-i', `hwnd=${target.windowHandle}`,
      ];
      if (audioDevice) {
        if (!info.capabilities.dshow) {
          throw new StudioError('AUDIO_CAPTURE_MISSING', 'FFmpeg has no DirectShow audio capture.');
        }
        args.push(
          '-thread_queue_size', '512',
          '-f', 'dshow', '-i', `audio=${audioDevice}`,
          '-map', '0:v:0', '-map', '1:a:0',
        );
      } else {
        args.push('-an');
        this.appendWarning(
          session,
          'Process video is recorded without system audio. Use OBS later or specify a DirectShow audio device.',
        );
      }
      args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2');
      if (info.capabilities.nvencReady) {
        args.push(
          '-c:v', 'h264_nvenc',
          '-preset', 'p5', '-tune', 'hq',
          '-rc', 'vbr', '-cq', '19',
          '-b:v', '30M', '-maxrate', '90M',
        );
      } else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
      }
      args.push('-pix_fmt', 'yuv420p', '-fps_mode', 'cfr');
      if (audioDevice) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
      args.push('-f', 'matroska', partial);

      this.state = {
        ...this.state,
        active: true,
        target,
        process: target.name,
        processName: target.name,
        partial,
        output,
        path: output,
        warnings: [...session.warnings],
        startedAt: new Date().toISOString(),
      };

      let child;
      try {
        child = spawn(info.tools.ffmpeg, args, {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
      } catch (spawnError) {
        throw new StudioError('CAPTURE_SPAWN_FAILED', 'FFmpeg could not be started.', { cause: spawnError });
      }
      session.child = child;
      this.child = child;
      child.once('spawn', () => { session.spawned = true; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this.handleStderr(session, chunk));
      child.stdin.on('error', (stdinError) => {
        this.appendWarning(session, `FFmpeg input reported an error: ${errorText(stdinError)}`);
      });
      child.once('error', (spawnError) => {
        if (!session.spawned || !child.pid) {
          this.beginFinalize(session, { code: null, signal: null, spawnError });
        } else {
          this.appendWarning(session, `FFmpeg process error: ${errorText(spawnError)}`);
          this.settleStartup(session, { kind: 'error', error: spawnError });
        }
      });
      child.once('close', (code, signal) => {
        this.beginFinalize(session, { code, signal, spawnError: null });
      });
      await this.persist();

      const startup = await this.waitForStartup(session);
      if (startup.kind === 'frame' && this.session === session && !session.closed) {
        this.state = {
          ...this.state,
          active: true,
          state: 'recording',
          status: 'recording',
          firstFrameAt: session.firstFrameAt,
          progress: { ...session.progress },
          warnings: [...session.warnings],
        };
        await this.persist();
        return this.status();
      }
      if (startup.kind === 'timeout' && this.session === session && !session.closed) {
        this.appendWarning(session, 'No first video frame was confirmed within 12 seconds.');
        await this.requestStop(session, 'startup-timeout');
        throw new StudioError(
          'CAPTURE_START_TIMEOUT',
          'Window capture did not deliver a first frame in time.',
          { state: this.status() },
        );
      }
      throw new StudioError(
        'CAPTURE_START_FAILED',
        startup.error
          ? `Window capture could not start: ${errorText(startup.error)}`
          : 'Window capture stopped before the first frame was confirmed.',
        { state: this.status() },
      );
    } catch (error) {
      if (this.session === session && !session.child) {
        await this.failBeforeSpawn(session, error);
      } else if (this.session === session && session.child && !session.stopRequested && !session.closed) {
        await this.requestStop(session, 'start-failed');
      }
      throw error;
    }
  }

  stop(options = {}) {
    return this.serialize(async () => {
      const requestedSessionId = typeof options === 'string' ? options : options?.sessionId;
      if (requestedSessionId && requestedSessionId !== this.state.sessionId) {
        throw new StudioError(
          'CAPTURE_SESSION_MISMATCH',
          'The stop command does not belong to the current recording session.',
          { requestedSessionId, currentSessionId: this.state.sessionId },
        );
      }
      if (!this.session || this.session.closed || this.state.state === 'finalizing') return this.status();
      return this.requestStop(this.session, 'user');
    });
  }

  status() {
    let elapsedSeconds = Number(this.state.duration);
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      elapsedSeconds = 0;
      if (this.state.startedAt) {
        const start = Date.parse(this.state.startedAt);
        const end = this.state.stoppedAt ? Date.parse(this.state.stoppedAt) : Date.now();
        if (Number.isFinite(start) && Number.isFinite(end)) {
          elapsedSeconds = Math.max(0, (end - start) / 1000);
        }
      }
    }
    return {
      ...this.state,
      status: this.state.state,
      capturePid: this.child?.pid ?? null,
      elapsedSeconds: Number(elapsedSeconds.toFixed(1)),
      warnings: [...(this.state.warnings ?? [])],
    };
  }
}

export const captureManager = new CaptureManager();
