// The caption cap has to be visible on the path the issue's repro actually takes:
// importTranscript({captions:true}) -> editProject() -> studio_edit / studio_review.
// Before this, editProject() passed the {captions, dropped} object straight into
// normalizeCaptions() and every import failed with INVALID_CAPTIONS (#105, review on #131).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { reviewEdit } from '../public/insights.js';
import { LIMITS } from '../public/edit-ops.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-edit-caption-import-'));
process.env.GAME_TRAILER_STUDIO_DATA_ROOT = root;
const { importTranscript, importCaptionsFile, editProject, reviewProject, getProject } = await import('../src/studio.mjs');
const { validateClips } = await import('../src/editing.mjs');

const ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_SECONDS = LIMITS.editSeconds;
const sources = [{ name: 'talk.mp4', file: path.join(root, 'talk.mp4'), duration: SOURCE_SECONDS,
  hasAudio: true, audio: [], black: [], motion: [], scenes: [] }];

// 1300 single-word sentences, one every 0.9 s. The 0.7 s gap between words is
// longer than wordsToCaptions()'s 0.6 s pause, so each word becomes one cue:
// 1300 cues > LIMITS.captions, all inside the 1200 s edit the tool allows.
function denseTranscript(count = LIMITS.captions + 100) {
  return Array.from({ length: count }, (_, i) => {
    const start = +(i * 0.9).toFixed(3);
    return { start, end: +(start + 0.2).toFixed(3), text: `word${i}.` };
  });
}

async function seedProject() {
  const dir = path.join(root, 'studio', 'projects', ID);
  await fs.mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const project = {
    schemaVersion: 2, id: ID, revision: 1, name: 'long talk',
    options: { captions: [], autoCaptions: false },
    sources,
    plan: { ...validateClips([{ id: 'a', sourceIndex: 0, start: 0, end: SOURCE_SECONDS - 1 }], sources), style: 'flight' },
    status: 'draft', progress: 0, message: 'Sources linked.', warnings: [], exports: [],
    createdAt: now, updatedAt: now,
  };
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify(project));
  return project;
}

test('reviewEdit reports CAPTIONS_LIMIT and names the sources that lost lines', () => {
  const clips = [{ id: 'a', sourceIndex: 0, start: 0, end: 30 }];
  const srcs = [{ duration: 30, hasAudio: false }];
  const clean = reviewEdit({ clips, sources: srcs, options: {}, analyzed: false });
  assert.equal(clean.issues.some(i => i.code === 'CAPTIONS_LIMIT'), false, 'no warning when nothing was dropped');

  const cut = reviewEdit({ clips, sources: srcs, options: {}, analyzed: false,
    captionsDropped: 100, captionsDroppedSources: [0, 2] });
  const issue = cut.issues.find(i => i.code === 'CAPTIONS_LIMIT');
  assert.ok(issue, 'studio_review must surface the cut even when nothing else is wrong');
  assert.equal(issue.severity, 'warning');
  assert.match(issue.message, /100 caption\(s\) were not added: at most 1200 lines/);
  assert.match(issue.message, /Sources that lost lines: #0, #2/);
  assert.equal(cut.counts.warning, clean.counts.warning + 1);
  assert.equal(cut.score, clean.score - 7, 'a warning costs the same as any other warning');
});

test('importTranscript({captions:true}) succeeds, keeps 1200 cues and reports the cut (#105)', async () => {
  await seedProject();
  const words = denseTranscript();
  // Before the fix this threw INVALID_CAPTIONS ("At most 1200 caption lines.")
  // because editProject() handed normalizeCaptions() the whole {captions, dropped} object.
  const result = await importTranscript(ID, { sourceIndex: 0, words, captions: true, revision: 1 });
  assert.equal(result.words, words.length);
  assert.deepEqual(result.warnings, [`${words.length - LIMITS.captions} caption(s) were not added: at most ${LIMITS.captions} lines.`]);
  assert.equal(result.project.options.captions.length, LIMITS.captions, 'the cap still holds');
  assert.equal(result.project.captionsDropped, words.length - LIMITS.captions);
  assert.deepEqual(result.project.captionsDroppedSources, [0]);
  assert.ok(result.project.options.captions.at(-1).end > 1000, 'captions reach the end of the kept range');

  const stored = await getProject(ID);
  assert.equal(stored.captionsDropped, words.length - LIMITS.captions, 'the count is persisted, not just returned');

  // An agent that only calls studio_review still sees it.
  const review = await reviewProject(ID);
  const issue = review.issues.find(i => i.code === 'CAPTIONS_LIMIT');
  assert.ok(issue, 'studio_review must not stay silent about the lost captions');
  assert.match(issue.message, /Sources that lost lines: #0/);
});

test('a later studio_edit keeps reporting the cut, and clearing it removes the note', async () => {
  const project = await getProject(ID);
  const again = await editProject(ID, { revision: project.revision, operations: [{ op: 'set_options', options: { captionOffset: 0 } }] });
  assert.deepEqual(again.warnings, [`${denseTranscript().length - LIMITS.captions} caption(s) were not added: at most ${LIMITS.captions} lines.`],
    'the autoCaptions rebuild in editProject() reports the cut too');

  const cleared = await editProject(ID, { revision: again.project.revision, operations: [{ op: 'set_options', options: { autoCaptions: false } }] });
  assert.equal('warnings' in cleared, false, 'no stale warning once autoCaptions is off');
  assert.equal(cleared.project.captionsDropped, 0);
  const review = await reviewProject(ID);
  assert.equal(review.issues.some(i => i.code === 'CAPTIONS_LIMIT'), false, 'the review note clears with the cut');
});

// studio_captions_import took SRT only, although the studio writes VTT itself and the transcript
// import already reads it (#140). The same captions in SRT and in WebVTT must import the same way.
const SRT_CAPTIONS = '1\n00:00:01,000 --> 00:00:03,000\nHello & welcome\n\n2\n00:00:04,500 --> 00:00:06,000\nSecond cue\n';
const VTT_CAPTIONS = 'WEBVTT\nKind: captions\nLanguage: en\n\nNOTE this block is not a cue\n\nintro-id\n00:01.000 --> 00:03.000 line:0 position:50%\nHello &amp; welcome\n\n00:04.500 --> 00:06.000\nSecond cue\n';

test('captions_import reads a WebVTT file as the same captions as its SRT (#140)', async () => {
  const existing = await getProject(ID);
  const srt = path.join(root, 'captions.srt');
  const vtt = path.join(root, 'captions.vtt');
  await fs.writeFile(srt, SRT_CAPTIONS);
  await fs.writeFile(vtt, VTT_CAPTIONS);

  const fromSrt = await importCaptionsFile(ID, { revision: existing.revision, file: srt });
  const srtCaptions = structuredClone((await getProject(ID)).options.captions);
  const fromVtt = await importCaptionsFile(ID, { revision: fromSrt.project.revision, file: vtt });
  const vttCaptions = structuredClone((await getProject(ID)).options.captions);

  assert.equal(fromSrt.imported, 2);
  assert.equal(fromVtt.imported, 2, 'a .vtt file is not refused on its extension any more');
  assert.deepEqual(vttCaptions, srtCaptions, 'header lines, cue ids and cue settings change nothing');
  assert.deepEqual(vttCaptions.map(c => c.text), ['Hello & welcome', 'Second cue'], 'entities decode like the transcript import');
});

test('a WebVTT file is held to the caption limits, and a broken one names the mistake (#140)', async () => {
  const existing = await getProject(ID);
  const stamp = s => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000`;
  const many = 'WEBVTT\n\n' + Array.from({ length: LIMITS.captions + 1 }, (_, i) => `${stamp(i * 2)} --> ${stamp(i * 2 + 1)}\nline ${i}`).join('\n\n');
  const tooMany = path.join(root, 'many.vtt');
  await fs.writeFile(tooMany, many);
  await assert.rejects(() => importCaptionsFile(ID, { revision: existing.revision, file: tooMany }),
    e => e.code === 'INVALID_CAPTIONS' && /At most 1200 caption lines/.test(e.message),
    'the caption limits apply to VTT too, not only to SRT');

  const broken = path.join(root, 'broken.vtt');
  await fs.writeFile(broken, 'WEBVTT\n\n00:00 --> 00:02\nno milliseconds\n');
  await assert.rejects(() => importCaptionsFile(ID, { revision: existing.revision, file: broken }),
    e => e.code === 'INVALID_CAPTIONS' && /VTT requires times like 00:00:04\.000/.test(e.message),
    'a broken VTT gives INVALID_CAPTIONS with the reason, not a stack trace');
});
