import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readUserSettings } from './settings.mjs';

/** Absolute path to the application source tree. */
export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// An npm install lives in node_modules, which npm may replace; keep user data in the home folder then.
const INSTALLED_FROM_NPM = PROJECT_ROOT.split(path.sep).includes('node_modules');
const DEFAULT_WINDOWS_DATA_ROOT = path.join(os.homedir(), 'Documents', 'AI Edit Studio');
// The data folder chosen in the installer (src/settings.mjs) counts as explicitly selected.
const envDataRoot = process.env.GAME_TRAILER_STUDIO_DATA_ROOT?.trim();
const installedDataRoot = envDataRoot ? '' : String(readUserSettings().dataRoot ?? '').trim();
const configuredDataRoot = envDataRoot || installedDataRoot;

/**
 * Root for jobs, temporary render data and finished trailers.
 *
 * Order: GAME_TRAILER_STUDIO_DATA_ROOT, the folder chosen in the installer,
 * then Documents\AI Edit Studio on Windows, or on macOS/Linux ~/.ai-edit-studio for an npm install
 * and .studio-data next to the app otherwise.
 */
export const DATA_ROOT = path.resolve(
  configuredDataRoot ||
    (process.platform === 'win32'
      ? DEFAULT_WINDOWS_DATA_ROOT
      : INSTALLED_FROM_NPM
        ? path.join(os.homedir(), '.ai-edit-studio')
        : path.join(PROJECT_ROOT, '.studio-data')),
);

/** Extensions accepted by the media scanner, normalized to lowercase. */
export const MEDIA_EXTENSIONS = Object.freeze([
  '.avi',
  '.m2ts',
  '.m4v',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.mts',
  '.ts',
  '.webm',
  '.wmv',
]);

/** Still images usable as sources (virtual duration; rendered with -loop). */
export const STILL_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);
export const STILL_SECONDS = 60;
export const isStillFile = file => STILL_EXTENSIONS.includes(path.extname(String(file)).toLowerCase());
const MEDIA_EXTENSION_SET = new Set(MEDIA_EXTENSIONS);
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Error type used at the Studio boundary, with stable codes and safe details. */
export class StudioError extends Error {
  /**
   * Supports both `(message, options)` and `(code, message, options)`.
   */
  constructor(messageOrCode, optionsOrMessage = {}, legacyOptions = {}) {
    const legacy = typeof optionsOrMessage === 'string';
    const message = legacy ? optionsOrMessage : messageOrCode;
    const options = legacy ? legacyOptions : optionsOrMessage;
    const code = legacy ? messageOrCode : (options.code ?? 'STUDIO_ERROR');
    const cause = options.cause;
    const details = options.details ?? (legacy
      ? Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'cause'))
      : {});
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StudioError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve a path while guaranteeing that it remains inside root.
 *
 * @param {string} root Trusted root directory.
 * @param {...string} segments Untrusted or trusted relative path components.
 * @returns {string}
 */
export function safeResolveWithin(root, ...segments) {
  if (typeof root !== 'string' || root.trim() === '' || root.includes('\0')) {
    throw new StudioError('Invalid root directory.', { code: 'INVALID_ROOT' });
  }
  if (
    segments.some(
      (segment) => typeof segment !== 'string' || segment.includes('\0'),
    )
  ) {
    throw new StudioError('Invalid path segment.', { code: 'INVALID_PATH_SEGMENT' });
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, candidate);
  const escaped =
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);

  if (escaped) {
    throw new StudioError('The path falls outside the allowed root directory.', {
      code: 'PATH_OUTSIDE_ROOT',
      details: { root: resolvedRoot },
    });
  }
  return candidate;
}

/**
 * Convert a title to a Windows-safe, deterministic directory slug.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function slugify(value) {
  let slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  if (!slug) slug = 'untitled';
  if (WINDOWS_RESERVED_NAMES.test(slug)) slug = `project-${slug}`;
  return slug;
}

function normalizeByteRequirement(value) {
  if (value === undefined) return 0;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new StudioError('minFreeBytes must be a non-negative integer.', {
      code: 'INVALID_FREE_SPACE_REQUIREMENT',
    });
  }
  return bytes;
}

/**
 * Return available bytes for a path using the filesystem's statfs values.
 * Missing leaf paths are resolved to their nearest existing parent.
 *
 * @param {string} targetPath
 * @returns {Promise<number>}
 */
export async function getFreeBytes(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new StudioError('No valid path given for the free-space check.', {
      code: 'INVALID_FREE_SPACE_PATH',
    });
  }

  let probe = path.resolve(targetPath);
  while (true) {
    try {
      await stat(probe);
      break;
    } catch (error) {
      const parent = path.dirname(probe);
      if (parent === probe || error?.code !== 'ENOENT') {
        throw new StudioError('Free disk space could not be determined.', {
          code: 'FREE_SPACE_CHECK_FAILED',
          details: { path: targetPath },
          cause: error,
        });
      }
      probe = parent;
    }
  }

  try {
    const filesystem = await statfs(probe, { bigint: true });
    const available = filesystem.bavail * filesystem.bsize;
    const asNumber = Number(available);
    if (!Number.isSafeInteger(asNumber) || asNumber < 0) {
      throw new RangeError('Free space falls outside the safe integer range.');
    }
    return asNumber;
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError('Free disk space could not be determined.', {
      code: 'FREE_SPACE_CHECK_FAILED',
      details: { path: probe },
      cause: error,
    });
  }
}

/**
 * Validate, create and capacity-check the Studio data root.
 *
 * @param {number} [minFreeBytes=0] Required free bytes after creating the root.
 * @returns {Promise<{path: string, freeBytes: number}>}
 */
export async function ensureDataRoot(minFreeBytes = 0) {
  const requiredBytes = normalizeByteRequirement(minFreeBytes);

  try {
    await mkdir(DATA_ROOT, { recursive: true });
  } catch (error) {
    throw new StudioError('The Studio data folder could not be created.', {
      code: 'DATA_ROOT_UNAVAILABLE',
      details: { path: DATA_ROOT },
      cause: error,
    });
  }

  const freeBytes = await getFreeBytes(DATA_ROOT);
  if (freeBytes < requiredBytes) {
    throw new StudioError('Insufficient free space in the data folder for this task.', {
      code: 'INSUFFICIENT_FREE_SPACE',
      details: { path: DATA_ROOT, freeBytes, requiredBytes },
    });
  }

  return { path: DATA_ROOT, freeBytes };
}

/**
 * Create an isolated job directory and return all standard job paths.
 *
 * @param {unknown} project Project or game title.
 * @returns {Promise<{
 *   id: string,
 *   project: string,
 *   slug: string,
 *   root: string,
 *   input: string,
 *   work: string,
 *   output: string,
 *   logs: string,
 *   manifest: string,
 *   config: string
 * }>}
 */
export async function createJobLayout(project) {
  await ensureDataRoot(0);
  const projectName = String(project ?? '').trim() || 'Untitled';
  const projectSlug = slugify(projectName);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `${stamp}-${randomBytes(4).toString('hex')}`;
  const jobsRoot = safeResolveWithin(DATA_ROOT, 'jobs');
  const root = safeResolveWithin(jobsRoot, projectSlug, id);
  const layout = {
    id,
    project: projectName,
    slug: projectSlug,
    root,
    input: safeResolveWithin(root, 'input'),
    work: safeResolveWithin(root, 'work'),
    output: safeResolveWithin(root, 'output'),
    logs: safeResolveWithin(root, 'logs'),
    manifest: safeResolveWithin(root, 'manifest.json'),
    config: safeResolveWithin(root, 'job.json'),
  };

  await Promise.all(
    [layout.input, layout.work, layout.output, layout.logs].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  return layout;
}

/**
 * Write formatted JSON through a same-directory temporary file and atomic rename.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(filePath, value) {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new StudioError('This value cannot be saved as JSON.', {
      code: 'JSON_SERIALIZE_FAILED',
      details: { path: target },
    });
  }

  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Keep the original write error.
    }
    await rm(temporary, { force: true }).catch(() => {});
    throw new StudioError('JSON file could not be saved atomically.', {
      code: 'JSON_WRITE_FAILED',
      details: { path: target },
      cause: error,
    });
  }
}

/**
 * Read and parse a UTF-8 JSON document.
 *
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
export async function readJson(filePath) {
  const target = path.resolve(filePath);
  let source;
  try {
    source = await readFile(target, 'utf8');
  } catch (error) {
    throw new StudioError('JSON file could not be read.', {
      code: 'JSON_READ_FAILED',
      details: { path: target },
      cause: error,
    });
  }

  try {
    return JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new StudioError('JSON file contains invalid JSON.', {
      code: 'JSON_INVALID',
      details: { path: target },
      cause: error,
    });
  }
}

function isAllowedMediaFile(filePath) {
  return MEDIA_EXTENSION_SET.has(path.extname(filePath).toLowerCase());
}

/**
 * Recursively list supported video files without following symbolic links or
 * Windows directory junctions.
 *
 * @param {string} input File or directory to scan.
 * @param {number} [maxFiles=500] Hard safety limit.
 * @returns {Promise<string[]>} Sorted absolute file paths.
 */
export async function listMediaFiles(input, maxFiles = 500) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new StudioError('maxFiles must be a positive integer.', {
      code: 'INVALID_MEDIA_LIMIT',
    });
  }

  const root = path.resolve(input);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    throw new StudioError('Media input does not exist or is not readable.', {
      code: 'MEDIA_INPUT_UNAVAILABLE',
      details: { path: root },
      cause: error,
    });
  }
  if (rootInfo.isSymbolicLink()) {
    throw new StudioError('Symlinks and junctions are not allowed as media input.', {
      code: 'MEDIA_INPUT_UNSAFE',
      details: { path: root },
    });
  }
  if (rootInfo.isFile()) return isAllowedMediaFile(root) ? [root] : [];
  if (!rootInfo.isDirectory()) return [];

  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new StudioError('A media folder could not be read.', {
        code: 'MEDIA_SCAN_FAILED',
        details: { path: directory },
        cause: error,
      });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = safeResolveWithin(root, path.relative(root, directory), entry.name);
      let info;
      try {
        info = await lstat(candidate);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw new StudioError('Media item could not be checked safely.', {
          code: 'MEDIA_SCAN_FAILED',
          details: { path: candidate },
          cause: error,
        });
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        pending.push(candidate);
      } else if (info.isFile() && isAllowedMediaFile(candidate)) {
        files.push(candidate);
        if (files.length > maxFiles) {
          throw new StudioError(`More than ${maxFiles} video files found.`, {
            code: 'MEDIA_LIMIT_EXCEEDED',
            details: { path: root, maxFiles },
          });
        }
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/**
 * Calculate a streaming SHA-256 hash without loading the media file in memory.
 *
 * @param {string} filePath
 * @returns {Promise<string>} Lowercase hexadecimal SHA-256 digest.
 */
export async function hashFile(filePath) {
  const target = path.resolve(filePath);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    throw new StudioError('File to hash is not readable.', {
      code: 'HASH_INPUT_UNAVAILABLE',
      details: { path: target },
      cause: error,
    });
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new StudioError('Only regular files can be hashed.', {
      code: 'HASH_INPUT_UNSAFE',
      details: { path: target },
    });
  }

  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    return hash.digest('hex');
  } catch (error) {
    throw new StudioError('SHA-256 hash could not be computed.', {
      code: 'HASH_FAILED',
      details: { path: target },
      cause: error,
    });
  }
}
