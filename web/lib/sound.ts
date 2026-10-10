// W-20 / I-14: a soft two-note chime for a new reply, synthesized with the Web Audio API (no
// audio files). Shared by the widget frame and the dashboard, so it imports nothing.
//
// Browsers only let a page make sound after the person has interacted with it, so the audio
// context is created (or resumed) on their first pointerdown/keydown in this document
// (`unlockSoundOnInteraction`), and `playChime` does nothing before that: someone who never
// touched the page never hears it. Anything missing or failing is silently nothing.

let context: AudioContext | null = null;
let unlocked = false;
let lastPlayed = 0;

/** At most one chime per this many milliseconds. */
export const CHIME_GAP_MS = 4_000;

/** Creates or resumes the audio context. Call it from inside a user gesture. */
export function unlockSound(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    if (context.state === "suspended") void context.resume().catch(() => {});
    unlocked = true;
  } catch {
    // No Web Audio here: no sound.
  }
}

let listening = false;
/** One listener for the first interaction with this document, removed after it. */
export function unlockSoundOnInteraction(): void {
  if (listening || unlocked) return;
  listening = true;
  const unlock = () => {
    unlockSound();
    document.removeEventListener("pointerdown", unlock, true);
    document.removeEventListener("keydown", unlock, true);
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);
}

/**
 * Plays the chime (about E5 then A5, each a quick attack and a ~250 ms decay, quiet). Returns
 * whether it played: not before the first interaction, nor within CHIME_GAP_MS of the last one.
 */
export function playChime(now = Date.now()): boolean {
  if (!unlocked || !context || now - lastPlayed < CHIME_GAP_MS) return false;
  try {
    if (context.state === "suspended") void context.resume().catch(() => {});
    const start = context.currentTime + 0.01;
    note(context, 659.25, start, 0.12);
    note(context, 880, start + 0.11, 0.1);
    lastPlayed = now;
    return true;
  } catch {
    return false;
  }
}

function note(ctx: AudioContext, frequency: number, at: number, gain: number): void {
  const osc = ctx.createOscillator();
  const level = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(frequency, at);
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  level.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
  osc.connect(level).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.3);
  osc.onended = () => level.disconnect();
}
