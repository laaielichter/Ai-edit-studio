import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseBlackIntervals, parseScenes, parseTimedMetadata } from '../src/analyze.mjs';
import { buildTrailerPlan } from '../src/planner.mjs';
import { DATA_ROOT, safeResolveWithin, slugify } from '../src/paths.mjs';

test('safeResolveWithin houdt uitvoer in de dataroot', () => {
  const inside = safeResolveWithin(DATA_ROOT, 'jobs', 'demo');
  assert.equal(path.relative(DATA_ROOT, inside), path.join('jobs', 'demo'));
  assert.throws(() => safeResolveWithin(DATA_ROOT, '..', 'C-schijf'), /outside/);
});

test('slugify maakt veilige Windows-namen', () => {
  assert.equal(slugify('  Air Réscue — 2026  '), 'air-rescue-2026');
  assert.equal(slugify('CON'), 'project-con');
});

test('FFmpeg metadata parsers halen tijden en waarden uit logs', () => {
  const metadata = 'frame:1 pts:0 pts_time:0.5\nlavfi.signalstats.YAVG=12.25\n';
  assert.deepEqual(parseTimedMetadata(metadata, 'lavfi.signalstats.YAVG'), [{ time: 0.5, value: 12.25 }]);
  assert.deepEqual(parseScenes('showinfo x pts_time: 1.25 y\nshowinfo x pts_time: 1.25 y'), [1.25]);
  assert.deepEqual(parseBlackIntervals('black_start:2 black_end:3.5 black_duration:1.5'), [
    { start: 2, end: 3.5, duration: 1.5 },
  ]);
});

test('planner ondersteunt korte bronnen en dupliceert geen tijdvakken', () => {
  const analysis = {
    sources: [{
      file: 'D:\\fixture\\short.mp4',
      duration: 2,
      video: { width: 1920, height: 1080 },
      scenes: [],
      black: [],
      motion: [{ time: 1, value: 20 }],
      audio: [{ time: 1, value: -10 }],
      hasAudio: true,
    }],
  };
  const plan = buildTrailerPlan(analysis, { duration: 5, style: 'showcase' });
  assert.equal(plan.clipCount, 1);
  assert.ok(plan.actualDuration >= 1.2 && plan.actualDuration <= 2);
  for (let i = 0; i < plan.clips.length; i += 1) {
    for (let j = i + 1; j < plan.clips.length; j += 1) {
      const a = plan.clips[i];
      const b = plan.clips[j];
      if (a.source !== b.source) continue;
      assert.ok(a.end <= b.start || b.end <= a.start);
    }
  }
});
