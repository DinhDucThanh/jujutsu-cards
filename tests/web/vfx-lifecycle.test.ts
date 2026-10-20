// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { advanceParticles, clearAllVfx, createCueBurst, createVfxLayer } from '../../src/web/vfx.js';
import { createPreviewFx } from '../../src/web/preview-fx.js';

/**
 * The effects layer must keep each cue's own choreography while never leaving a frame
 * running: this drives the real modules with a fake clock and a recording context.
 */

interface StubContext {
  clearRect: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  quadraticCurveTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

function stubContext(): StubContext {
  return {
    clearRect: vi.fn(),
    arc: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    globalAlpha: 1,
    setTransform: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
  };
}

function fakeCanvas(context: StubContext, width: number, height: number): HTMLCanvasElement {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;
}

describe('VFX frame lifecycle', () => {
  let now = 0;
  let pending: FrameRequestCallback[] = [];

  beforeEach(() => {
    now = 0;
    pending = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      pending = [];
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs every queued frame `count` times, `step` ms apart, the way a display would. */
  function frames(count: number, step = 16): void {
    for (let i = 0; i < count; i++) {
      now += step;
      const queued = pending;
      pending = [];
      for (const callback of queued) callback(now);
    }
  }

  it('keeps the four synergy cues on their own cinematic timeline', () => {
    const claw = createCueBurst('CLAW', 800, 600);
    const ratio = createCueBurst('RATIO', 800, 600);
    const clash = createCueBurst('CLASH', 800, 600);
    const eyes = createCueBurst('SIX_EYES', 800, 600);

    expect(claw.durationMs).toBe(800);
    expect(ratio.durationMs).toBe(850);
    expect(clash.durationMs).toBe(750);
    // Six Eyes stays up for the reveal window the engine grants.
    expect(eyes.durationMs).toBe(3000);
    for (const effect of [claw, ratio, clash, eyes]) {
      expect(effect.particles.length).toBeGreaterThan(0);
      expect(effect.particles.length).toBeLessThanOrEqual(42);
    }
  });

  it('keeps claws and rings when a large recipe is capped', () => {
    const kinds = new Set(createCueBurst('CLAW', 800, 600).particles.map((particle) => particle.kind));
    expect(kinds.has('streak')).toBe(true);
    expect(kinds.has('dot')).toBe(true);
    // The clap's rings are its identity: three outward shocks and the two that rush in.
    const clash = createCueBurst('CLASH', 800, 600);
    expect(clash.particles.filter((particle) => particle.kind === 'ring')).toHaveLength(5);
    expect(clash.particles.length).toBeLessThanOrEqual(42);
    expect(new Set(createCueBurst('RATIO', 800, 600).particles.map((p) => p.kind)).has('shard')).toBe(true);
  });

  it('paints a frame without drawing a connecting bezier', () => {
    const context = stubContext();
    const particles = [...createCueBurst('CLAW', 800, 600).particles];
    const alive = advanceParticles(context as unknown as CanvasRenderingContext2D, particles, 16);
    expect(alive.length).toBeGreaterThan(0);
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.quadraticCurveTo).not.toHaveBeenCalled();
  });

  it('cancels the loop and wipes the canvas once the cue’s deadline passes', () => {
    const context = stubContext();
    const canvas = fakeCanvas(context, 800, 600);
    const root = document.createElement('div');
    const vfx = createVfxLayer({ layer: root, canvas, shakeTargets: [] });

    vfx.play('CLAW');
    expect(pending.length).toBe(1);
    frames(2);
    expect(context.arc.mock.calls.length + context.stroke.mock.calls.length).toBeGreaterThan(0);

    frames(60);
    expect(pending.length).toBe(0);
    expect(context.clearRect).toHaveBeenCalled();
  });

  it('ends a codex preview at the shared 800ms canvas ceiling', () => {
    const context = stubContext();
    const canvas = fakeCanvas(context, 240, 76);
    const preview = createPreviewFx(canvas);

    preview.play('CLAW');
    frames(2);
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.quadraticCurveTo).not.toHaveBeenCalled();

    frames(60);
    expect(pending.length).toBe(0);

    // Six Eyes keeps a 3s overlay on the field; its canvas loop is cut at 800ms.
    preview.play('SIX_EYES');
    frames(60);
    expect(pending.length).toBe(0);
    const clears = context.clearRect.mock.calls.length;
    frames(5);
    expect(context.clearRect.mock.calls.length).toBe(clears);
  });

  it('never runs a canvas effect past its 800ms ceiling', () => {
    const context = stubContext();
    const canvas = fakeCanvas(context, 800, 600);
    const root = document.createElement('div');
    const vfx = createVfxLayer({ layer: root, canvas, shakeTargets: [] });

    vfx.play('SIX_EYES');
    frames(50); // 800ms
    expect(pending.length).toBe(0);
  });

  it('clearAllVfx stops and wipes every registered layer', () => {
    const context = stubContext();
    const canvas = fakeCanvas(context, 800, 600);
    const root = document.createElement('div');
    const vfx = createVfxLayer({ layer: root, canvas, shakeTargets: [] });

    vfx.play('DOMAIN');
    expect(pending.length).toBe(1);
    clearAllVfx();
    expect(pending.length).toBe(0);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
  });

  it('kills a running preview when its owner destroys it', () => {
    const context = stubContext();
    const preview = createPreviewFx(fakeCanvas(context, 240, 76));

    preview.play('RATIO');
    frames(2);
    expect(pending.length).toBe(1);

    preview.destroy();
    expect(pending.length).toBe(0);
  });
});
