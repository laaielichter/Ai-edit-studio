// Builds the download: dist/AI-Edit-Studio-<version>.zip (+ .sha256). Only runtime files, docs for users
// and the installers go in — no tests or dev tools. No dependencies.
//   node tools/build-release.mjs [--out <dir>]
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STUDIO_VERSION } from '../src/agent-tools.mjs';
import { expectedFiles } from './sync-codex-plugin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RELEASE_FILES = [
  'cli.mjs', 'mcp.mjs', 'server.mjs', 'package.json',
  'LICENSE', 'INSTALL.md', 'SUPPORT.md', 'README.md', 'AGENTS.md', 'AGENT-GUIDE.md', 'CHANGELOG.md', 'TROUBLESHOOTING.md', 'PRIVACY.md', 'THIRD-PARTY-NOTICES.md',
  'Install-AI-Edit-Studio.cmd', 'install.ps1', 'install.sh', 'start.sh',
  'Start-AI-Edit-Studio.cmd', 'Start-Game-Trailer-Studio.cmd', 'Start-Game-Trailer-Studio.ps1', 'Start-Game-Trailer-Studio.vbs',
  'docs/INTEGRATIONS.md', 'docs/README.nl.md',
];
export const RELEASE_DIRS = ['src', 'public', 'plugin', 'plugins', 'skills', 'agents', '.claude-plugin', '.agents', 'examples/openai'];
const EXECUTABLE = new Set(['install.sh', 'start.sh']);
const SECRET = /\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bghp_[A-Za-z0-9]{30,}/;

async function walk(rel) {
  const out = [];
  for (const entry of await fs.readdir(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await walk(child));
    else if (entry.isFile() && !/(^|\/)(\.DS_Store|Thumbs\.db)$|\.(log|bak)$/.test(child)) out.push(child);
  }
  return out;
}

export async function releaseFileList() {
  const files = [...RELEASE_FILES];
  for (const dir of RELEASE_DIRS) files.push(...await walk(dir));
  return [...new Set(files)].sort();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { if (zlib.crc32) return zlib.crc32(buf); let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Minimal ZIP writer (deflate, UTF-8 names, Unix modes so install.sh stays executable). */
export function zip(entries, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Reads a ZIP made by zip() (or any plain deflate/stored ZIP): name → {data, mode}. */
export function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), mode = buf.readUInt32LE(p + 38) >>> 16, offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const body = buf.subarray(start, start + size);
    files.set(name, { data: method === 8 ? zlib.inflateRawSync(body) : body, mode });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

export async function buildRelease({ outDir = path.join(ROOT, 'dist') } = {}) {
  for (const [rel, content] of await expectedFiles()) {
    const current = await fs.readFile(path.join(ROOT, 'plugins', 'ai-edit-studio', rel), 'utf8').catch(() => null);
    if (current?.replace(/\r\n/g, '\n') !== content) throw new Error(`Codex plugin is stale (${rel}); run node tools/sync-codex-plugin.mjs first.`);
  }
  const top = `AI-Edit-Studio-${STUDIO_VERSION}`;
  const entries = [];
  for (const rel of await releaseFileList()) {
    const data = await fs.readFile(path.join(ROOT, rel));
    if (SECRET.test(data.toString('latin1'))) throw new Error(`Refusing to ship ${rel}: it looks like it contains a secret.`);
    entries.push({ name: `${top}/${rel}`, data, mode: EXECUTABLE.has(rel) ? 0o755 : 0o644 });
  }
  const archive = zip(entries);
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${top}.zip`);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await fs.writeFile(file, archive);
  await fs.writeFile(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`);
  return { file, sha256, files: entries.length, bytes: archive.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const opts = i > 0 ? { outDir: path.resolve(process.argv[i + 1]) } : {};
  const result = await buildRelease(opts);
  console.log(`${result.file}\n${result.files} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MB\nsha256 ${result.sha256}`);
}
