import type { VfxCue } from '../engine/index.js';
import { MAX_EFFECT_MS, advanceParticles, createCueBurst, type Particle } from './vfx.js';

/**
 * The Sorcery Codex replays a synergy cue inside its own card, not across the window.
 *
 * A preview is the real effect's choreography — the same `createCueBurst` the full-screen
 * layer uses — drawn on a canvas the card clips. Claw trails rake this box diagonally,
 * the ratio cut fractures at its 7:3 point and the clash rings explode from its centre.
 * The loop shares the field's 800ms canvas ceiling, clears every frame and cancels its
 * own frame, so a finished or dismissed preview leaves nothing running.
 */
const MAX_DPR = 2;
/** Kept as the outer bound the codex promises; the effect itself may end sooner. */
const PREVIEW_CAP_MS = 1_500;

export interface PreviewFx {
  /** Restarts the preview for one cue. */
  play(cue: VfxCue): void;
  /** Stops the loop and wipes the canvas; safe to call at any time. */
  destroy(): void;
}

export function createPreviewFx(canvas: HTMLCanvasElement): PreviewFx {
  const context = canvas.getContext('2d');
  let frame: number | null = null;
  let lastFrame = 0;
  let deadline = 0;
  let particles: Particle[] = [];

  const clear = (): void => {
    // Backing-store pixels, not CSS pixels: the DPR scale would leave the rest untouched.
    if (context) context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const stop = (): void => {
    if (frame !== null) globalThis.cancelAnimationFrame(frame);
    frame = null;
    particles = [];
    deadline = 0;
    clear();
  };

  /** Sizes the backing store to the box, capped so a 3x screen never triples the cost. */
  const resize = (): boolean => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return false;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    return true;
  };

  const draw = (now: number): void => {
    frame = null;
    if (!context) return;
    const dt = Math.min(48, now - lastFrame || 16);
    lastFrame = now;
    // Same contract as the full-screen layer: every frame starts from a clean canvas.
    context.clearRect(0, 0, canvas.width, canvas.height);
    particles = advanceParticles(context, particles, dt);
    if (now >= deadline || particles.length === 0) {
      stop();
      return;
    }
    frame = globalThis.requestAnimationFrame(draw);
  };

  const play = (cue: VfxCue): void => {
    stop();
    if (!resize()) return;
    const burst = createCueBurst(cue, canvas.clientWidth, canvas.clientHeight);
    particles = [...burst.particles];
    lastFrame = 0;
    deadline = performance.now() + Math.min(PREVIEW_CAP_MS, MAX_EFFECT_MS, burst.durationMs);
    frame = globalThis.requestAnimationFrame(draw);
  };

  return { play, destroy: stop };
}
