import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions, validateClips, EXPORT_PRESETS, MASTER_FORMATS, SOCIAL_SIZES, socialFormat } from '../src/editing.mjs';
import { normalizeFinish } from '../src/finishing.mjs';
import { buildFilter } from '../src/render.mjs';
import { agentTools } from '../src/agent-tools.mjs';

const source = { file: 'test.mp4', duration: 60, hasAudio: true, black: [], audio: [], video: { width: 1920, height: 1080 }, motion: [], scenes: [] };
const clip = { sourceIndex: 0, start: 0, end: 10, speed: 1, gain: 1 };

test('every resolution exists: 720p, 1080p, 1440p, 4K, 21:9 and social shapes from 720 up', () => {
  const res = id => EXPORT_PRESETS[id].resolution;
  assert.equal(res('hd'), '1280x720'); assert.equal(res('landscape'), '1920x1080');
  assert.equal(res('qhd'), '2560x1440'); assert.equal(res('uhd'), '3840x2160'); assert.equal(res('ultrawide'), '2560x1080');
  assert.equal(res('vertical720'), '720x1280'); assert.equal(res('vertical1440'), '1440x2560'); assert.equal(res('vertical4k'), '2160x3840');
  assert.equal(res('square720'), '720x720'); assert.equal(res('square1440'), '1440x1440');
  assert.equal(res('portrait720'), '720x900'); assert.equal(res('portrait1440'), '1440x1800');
  assert.equal(EXPORT_PRESETS.hd.maxBytes, undefined, '720p has no size cap (WhatsApp does)');
  for (const [id, p] of Object.entries(EXPORT_PRESETS)) {
    const [w, h] = p.resolution.split('x').map(Number);
    assert.ok(w % 2 === 0 && h % 2 === 0 && w <= 7680 && h <= 4320, `${id} renders with the encoder limits`);
    assert.equal(Boolean(p.vertical), h > w || /^(square|portrait|vertical)/.test(id), `${id} vertical flag`);
  }
});

test('social size maps to the right format; square and portrait stop at 1440', () => {
  assert.equal(socialFormat('vertical', '720'), 'vertical720'); assert.equal(socialFormat('vertical', '1080'), 'vertical');
  assert.equal(socialFormat('vertical', '4k'), 'vertical4k'); assert.equal(socialFormat('square', '4k'), 'square1440');
  assert.equal(socialFormat('portrait', '1440'), 'portrait1440');
  for (const shape of ['vertical', 'square', 'portrait']) for (const size of SOCIAL_SIZES) assert.ok(EXPORT_PRESETS[socialFormat(shape, size)], `${shape} ${size}`);
});

test('options accept the new master formats and social sizes and reject others', () => {
  for (const masterFormat of MASTER_FORMATS) assert.equal(normalizeOptions({ masterFormat }).masterFormat, masterFormat);
  assert.equal(normalizeOptions({}).socialSize, '1080');
  assert.equal(normalizeOptions({ socialSize: '4k' }).socialSize, '4k');
  assert.throws(() => normalizeOptions({ masterFormat: 'vertical' }), /720p/);
  assert.throws(() => normalizeOptions({ socialSize: '480' }), /Social size/);
});

test('21:9 fills the frame (crop) instead of adding black bars; 16:9 keeps the full picture', () => {
  const plan = validateClips([clip], [source]);
  const base = { fps: 30, gameGain: 1, musicGain: 0.2, finish: normalizeFinish() };
  const wide = buildFilter(plan, { ...base, width: 2560, height: 1080, fill: true });
  assert.match(wide, /force_original_aspect_ratio=increase[^;]*crop=2560:1080/); assert.doesNotMatch(wide, /pad=2560:1080/);
  const hd = buildFilter(plan, { ...base, width: 1280, height: 720 });
  assert.match(hd, /pad=1280:720/);
});

test('agents see every format in the render schema', () => {
  const render = agentTools.find(t => t.name === 'studio_render');
  const items = render.inputSchema.properties.formats.items.enum;
  for (const id of [...Object.keys(EXPORT_PRESETS), 'stems']) assert.ok(items.includes(id), id);
  assert.ok(render.inputSchema.properties.formats.maxItems >= Object.keys(EXPORT_PRESETS).length - 3);
});
