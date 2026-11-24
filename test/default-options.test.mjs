import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOptions } from '../src/editing.mjs';
import { templateOptions } from '../src/templates.mjs';
import { metadataDrafts } from '../src/publish.mjs';
import { buildAutoEdit } from '../src/autoedit.mjs';

// A source the auto-edit can work with, without FFmpeg.
function analyzedSource(duration) {
  const motion = [], audio = [];
  for (let t = 0; t < duration; t += 0.25) {
    motion.push({ time: t, value: (t > duration / 2 ? 0.9 : 0.3) * 40 });
    audio.push({ time: t, value: -30 });
  }
  return { file: `/v/${duration}.mp4`, duration, hasAudio: true, video: { width: 1920, height: 1080 }, motion, audio, scenes: [], black: [] };
}

// #104: the "PRE-ALPHA FOOTAGE" / "IN DEVELOPMENT" defaults were leftovers of the
// game-trailer origin and stamped every project that was not a game trailer.
test('a project without a template has no label and no end title by default', () => {
  const o = normalizeOptions({});
  assert.equal(o.label, '');
  assert.equal(o.endTitle, '');
  assert.equal(normalizeOptions({ title: 'Trip' }).endTitle, '');
});

test('the game-trailer template keeps its stamp, and explicit values are preserved', () => {
  const game = normalizeOptions(templateOptions('game-trailer'));
  assert.equal(game.label, 'PRE-ALPHA FOOTAGE');
  assert.equal(game.endTitle, 'Wishlist now');
  const explicit = normalizeOptions({ label: 'WORK IN PROGRESS', endTitle: 'Follow for more', title: 'Trip' });
  assert.equal(explicit.label, 'WORK IN PROGRESS');
  assert.equal(explicit.endTitle, 'Follow for more');
  // An existing project keeps what it stored, even an empty string.
  assert.equal(normalizeOptions({ label: '', endTitle: '' }).label, '');
});

test('a non-trailer auto-edit has no stamp, and a trailer can still ask for one', () => {
  const src = analyzedSource(20);
  const plain = buildAutoEdit({ sources: [src], options: normalizeOptions({}), goal: { platform: 'shorts' } });
  assert.equal(plain.options.label, '');
  assert.equal(plain.options.endTitle, '');
  const asked = buildAutoEdit({ sources: [src], options: normalizeOptions({}), goal: { platform: 'shorts', label: 'DEMO', cta: 'Subscribe' } });
  assert.equal(asked.options.label, 'DEMO');
  assert.equal(asked.options.endTitle, 'Subscribe');
});

test('publish drafts have no call to action when the project did not ask for one', () => {
  const o = normalizeOptions({});
  const drafts = metadataDrafts({ title: 'My Trip to Rome', brief: 'A short holiday clip.', cta: o.endTitle, tags: ['trip', 'rome'], platforms: ['youtube', 'x'] });
  assert.doesNotMatch(drafts.youtube.description, /IN DEVELOPMENT/);
  assert.doesNotMatch(drafts.x.description, /IN DEVELOPMENT/);
  assert.ok(drafts.youtube.description.includes('My Trip to Rome') || drafts.youtube.description.includes('A short holiday clip.'));
  const withCta = metadataDrafts({ title: 'T', brief: 'B.', cta: 'Wishlist now', tags: [], platforms: ['x'] });
  assert.match(withCta.x.description, /Wishlist now/, 'an explicit call to action still appears');
});
