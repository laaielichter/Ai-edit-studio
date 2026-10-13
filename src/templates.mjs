// Starting points for common creator deliverables. A template only sets
// options; it never invents footage, text or music.
export const TEMPLATES = Object.freeze([
  {
    id: 'shorts-hook', name: 'Shorts / Reels hook', emoji: '⚡', tagline: '15–30 s, vertical, strong opening',
    description: 'Short, fast edit for TikTok, Reels and YouTube Shorts. Bold captions high in frame, vivid colors.',
    options: { style: 'action', duration: 25, look: 'vivid', lookStrength: 0.6, fadeIn: 0, fadeOut: 0.3, duckMusic: true, musicGain: 0.3,
      captionStyle: 'bold', captionPosition: 'middle', exportVertical: true, exportShare: true, exportSquare: false, exportPortrait: false, masterFormat: 'landscape', label: '', endTitle: 'Follow for more' },
    formats: ['vertical', 'landscape'],
  },
  {
    id: 'game-trailer', name: 'Game trailer', emoji: '🎮', tagline: '60 s, cinema look, continuous finale',
    description: 'Builds with longer shots and a finale that holds. For Steam, itch.io and press releases.',
    options: { style: 'flight', duration: 60, finaleSeconds: 8, look: 'cinema', lookStrength: 0.6, fadeIn: 0.4, fadeOut: 0, duckMusic: true, musicGain: 0.28,
      captionStyle: 'box', captionPosition: 'low', exportVertical: true, exportShare: true, masterFormat: 'qhd', label: 'PRE-ALPHA FOOTAGE', endTitle: 'Wishlist now' },
    formats: ['qhd', 'vertical', 'whatsapp'],
  },
  {
    id: 'youtube-teaser', name: 'YouTube teaser', emoji: '▶', tagline: '30–45 s, widescreen, voice-over friendly',
    description: 'Teaser for a video or channel. Music ducks under speech, understated captions.',
    options: { style: 'flight', duration: 40, look: 'cinema', lookStrength: 0.4, fadeIn: 0.2, fadeOut: 0.6, duckMusic: true, musicGain: 0.2,
      captionStyle: 'minimal', captionPosition: 'low', exportVertical: false, exportShare: true, masterFormat: 'landscape', label: '', endTitle: 'Watch the full video' },
    formats: ['landscape', 'whatsapp'],
  },
  {
    id: 'devlog', name: 'Devlog update', emoji: '🛠', tagline: '45–90 s, honest and clear',
    description: 'Shows progress with natural colors, audible source audio and clear captions.',
    options: { style: 'flight', duration: 75, look: 'neutral', lookStrength: 0, fadeIn: 0.2, fadeOut: 0.5, duckMusic: true, musicGain: 0.16, gameGain: 1,
      captionStyle: 'box', captionPosition: 'low', exportVertical: false, exportShare: true, masterFormat: 'landscape', label: 'WORK IN PROGRESS', endTitle: '' },
    formats: ['landscape', 'whatsapp'],
  },
  {
    id: 'cinematic', name: 'Cinematic moment', emoji: '🎬', tagline: '30–90 s, long shots, noir or cinema',
    description: 'For an atmospheric moment or landing: few cuts, slow fades, no rush.',
    options: { style: 'flight', duration: 60, finaleSeconds: 12, look: 'cinema', lookStrength: 0.8, fadeIn: 1, fadeOut: 0, duckMusic: false, musicGain: 0.32,
      captionStyle: 'minimal', captionPosition: 'low', exportVertical: false, exportShare: true, masterFormat: 'qhd', label: '', endTitle: '' },
    formats: ['qhd', 'whatsapp'],
  },
  {
    id: 'square-post', name: 'Feed post 1:1 / 4:5', emoji: '◼', tagline: '15–30 s, for Instagram/LinkedIn feeds',
    description: 'Square and portrait for feeds, with the full frame on a blurred background.',
    options: { style: 'action', duration: 20, look: 'vivid', lookStrength: 0.4, fadeIn: 0, fadeOut: 0.4, duckMusic: true, musicGain: 0.26,
      captionStyle: 'bold', captionPosition: 'low', exportVertical: false, exportShare: false, exportSquare: true, exportPortrait: true, masterFormat: 'landscape', label: '', endTitle: '' },
    formats: ['square', 'portrait'],
  },
]);

export function templateOptions(id) {
  const template = TEMPLATES.find(t => t.id === id);
  return template ? { ...template.options, template: template.id } : null;
}
