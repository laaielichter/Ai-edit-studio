import { validateClips } from './editing.mjs';
import { StudioError } from './paths.mjs';

/** Conservative proposal from measured 0.5-second RMS windows; not speech recognition. */
export function proposeSilenceCuts(plan, sources, { thresholdDb = -45, minSilence = 1.5, padding = 0.2, protectFinale = false } = {}) {
  if (!plan?.clips?.length) throw new StudioError('PLAN_REQUIRED', 'Create an edit proposal first.');
  if (!Number.isFinite(thresholdDb) || thresholdDb < -70 || thresholdDb > -20 || !Number.isFinite(minSilence) || minSilence < 1 || minSilence > 10
    || !Number.isFinite(padding) || padding < 0.1 || padding > 0.4) throw new StudioError('INVALID_OPTION', 'Invalid silence settings.');
  if (!sources.some(s => s.audio?.length)) throw new StudioError('ANALYSIS_REQUIRED', 'Analyze the sources first; there are no audio measurements.');
  const rows = [];
  for (const [index, clip] of plan.clips.entries()) {
    let intervals = [[clip.start, clip.end]];
    if (!(protectFinale && index === plan.clips.length - 1)) {
      const points = sources[clip.sourceIndex].audio || []; const quiet = []; let run = null;
      const flush = () => { if (run && run.end - run.start >= minSilence) quiet.push(run); run = null; };
      for (const p of points) {
        if (p.value <= thresholdDb) {
          if (run && p.time - run.end > 0.05) flush();
          if (!run) run = { start: p.time, end: p.time + 0.5 }; else run.end = p.time + 0.5;
        } else flush();
      }
      flush();
      for (const gap of quiet) intervals = intervals.flatMap(([a, b]) => {
        const lo = Math.max(a, gap.start + padding), hi = Math.min(b, gap.end - padding);
        if (hi <= lo) return [[a, b]];
        // Keep tiny edge fragments rather than turning pauses into clipped words.
        if ((lo > a && lo - a < 0.5) || (hi < b && b - hi < 0.5)) return [[a, b]];
        return [[a, lo], [hi, b]].filter(([x, y]) => y - x >= 0.5);
      });
    }
    rows.push(...intervals.map(([start, end]) => ({ ...clip, start, end })));
  }
  if (!rows.length) throw new StudioError('ALL_SILENT', 'Everything appears silent. No change applied; check the audio source.');
  const proposal = validateClips(rows, sources);
  return { plan: proposal, removedSeconds: Number((plan.actualDuration - proposal.actualDuration).toFixed(3)),
    warning: 'Proposal based on audio level, not language understanding. Listen to every transition. The saved project has not been changed yet.' };
}
