export class EditHistory {
  constructor(limit = 80) { this.limit = limit; this.states = []; this.index = -1; }
  reset(state) { this.states = [structuredClone(state)]; this.index = 0; }
  commit(state) {
    if (JSON.stringify(this.states[this.index]) === JSON.stringify(state)) return;
    this.states = this.states.slice(0, this.index + 1);
    this.states.push(structuredClone(state));
    if (this.states.length > this.limit) this.states.shift();
    this.index = this.states.length - 1;
  }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.states.length - 1; }
  undo() { if (!this.canUndo) return null; return structuredClone(this.states[--this.index]); }
  redo() { if (!this.canRedo) return null; return structuredClone(this.states[++this.index]); }
}

export function splitClip(clips, index, time) {
  const clip = clips[index];
  if (!clip || !Number.isFinite(time) || time - clip.start < 0.5 || clip.end - time < 0.5) {
    throw new Error('Choose a cut point at least 0.5 s from start and end.');
  }
  if (clips.length >= 48) throw new Error('At most 48 clips per edit.');
  const rows = structuredClone(clips);
  rows.splice(index, 1, { ...clip, end: time }, { ...clip, start: time });
  return rows;
}

export function availableClip(clips, sourceIndex, duration) {
  const used = clips.filter(c => c.sourceIndex === sourceIndex).sort((a, b) => a.start - b.start);
  let start = 0;
  for (const row of [...used, { start: duration, end: duration }]) {
    if (row.start - start >= 0.5) return { sourceIndex, start, end: Math.min(row.start, start + 8), speed: 1, gain: 1 };
    start = Math.max(start, row.end);
  }
  throw new Error('All footage from this source is already used.');
}
