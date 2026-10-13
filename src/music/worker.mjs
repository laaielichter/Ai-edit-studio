// Worker thread: composes and renders one piece without blocking the studio server.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import { generateMusic } from './engine.mjs';

const { spec, out } = workerData;
try {
  const res = generateMusic(spec);
  const partial = `${out}.partial`;
  await fs.writeFile(partial, res.wav); await fs.rename(partial, out);
  const stems = {};
  for (const [name, buf] of Object.entries(res.stems ?? {})) { const f = out.replace(/\.wav$/i, `-${name}.wav`); await fs.writeFile(f, buf); stems[name] = f; }
  parentPort.postMessage({ ok: true, report: res.report, stems });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e?.message ?? String(e) });
}
