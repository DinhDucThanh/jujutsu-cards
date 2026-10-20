import { GAME_PACING, type VfxCue } from '../engine/index.js';

type ParticleKind = 'dot' | 'shard' | 'ring' | 'streak';

/**
 * Hard ceilings. A burst is decoration, not a simulation: forty-two particles read the
 * same as four hundred at card size and cost a fraction of the fill time on mobile.
 */
const MAX_PARTICLES = 42;
const MAX_DPR = 2;
/**
 * Hard ceiling for a canvas effect. Six Eyes keeps its caption and reveal overlay for the
 * engine's 3s window, but the particle loop itself never runs longer than this.
 */
export const MAX_EFFECT_MS = 800;

/**
 * Timeline of each cue in milliseconds. The four synergy cues are cut to the exact beats
 * their choreography needs; the rest follow the engine's banner pacing.
 */
const CUE_MS: Readonly<Partial<Record<VfxCue, number>>> = {
  CLAW: 800,
  RATIO: 850,
  CLASH: 750,
};

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: ParticleKind;
  angle: number;
  spin: number;
  gravity: number;
}

export interface Recipe {
  /** CSS class driving the keyframe overlay. */
  readonly className: string;
  /** How long the effect runs; the synergy cues override the engine banner pacing. */
  readonly durationMs: number;
  /** Screen shake amplitude in pixels; 0 disables it. */
  readonly shake: number;
  readonly spawn: (width: number, height: number) => Particle[];
  readonly label: string;
}

const INK = ['#150f22', '#2a1f45', '#4c1d95', '#7c3aed'];
const GLASS = ['#f8fafc', '#e2e8f0', '#fde68a', '#fca5a5'];
const CURSED = ['#7f1d1d', '#b91c1c', '#f87171', '#fecaca'];
const EYES = ['#22d3ee', '#60a5fa', '#a5f3fc', '#3b82f6'];
const SPARK = ['#e2e8f0', '#f8fafc', '#c4b5fd', '#fde68a'];
const BLOOD = ['#450a0a', '#991b1b', '#ef4444', '#fecaca'];

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(items: readonly T[]): T {
  const value = items[Math.floor(Math.random() * items.length)];
  return value ?? (items[0] as T);
}

function dot(x: number, y: number, color: string, size: number, speed: number, lifeMs: number): Particle {
  const angle = randomBetween(0, Math.PI * 2);
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: lifeMs,
    maxLife: lifeMs,
    size,
    color,
    kind: 'dot',
    angle: 0,
    spin: 0,
    gravity: 0.0006,
  };
}

function shard(x: number, y: number, color: string, size: number, speed: number): Particle {
  const angle = randomBetween(0, Math.PI * 2);
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed - 0.05,
    life: randomBetween(600, 1100),
    maxLife: 1100,
    size,
    color,
    kind: 'shard',
    angle: randomBetween(0, Math.PI),
    spin: randomBetween(-0.006, 0.006),
    gravity: 0.0012,
  };
}

function ring(x: number, y: number, color: string, size: number, speed: number, lifeMs = 700): Particle {
  return {
    x,
    y,
    vx: speed,
    vy: 0,
    life: lifeMs,
    maxLife: lifeMs,
    size,
    color,
    kind: 'ring',
    angle: 0,
    spin: 0,
    gravity: 0,
  };
}

function streak(x: number, y: number, color: string, size: number, speed: number, angle: number): Particle {
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: randomBetween(350, 700),
    maxLife: 700,
    size,
    color,
    kind: 'streak',
    angle,
    spin: 0,
    gravity: 0.0004,
  };
}

/** Three diagonal claw trails of shadow ink, thrown across the screen. */
function clawRecipe(): Recipe {
  return {
    className: 'vfx-claw',
    durationMs: CUE_MS.CLAW ?? GAME_PACING.VFX_BANNER_DURATION_MS,
    shake: 14,
    label: 'DIVINE DOG · CLAW',
    spawn: (width, height) => {
      const particles: Particle[] = [];
      for (let trail = 0; trail < 3; trail++) {
        const startX = width * (0.05 + trail * 0.12);
        const startY = height * (0.06 + trail * 0.16);
        const angle = Math.atan2(height, width * 1.4);
        for (let i = 0; i < 26; i++) {
          const t = i / 26;
          particles.push(
            streak(
              startX + Math.cos(angle) * width * 1.2 * t,
              startY + Math.sin(angle) * height * 1.2 * t,
              pick(INK),
              randomBetween(3, 9),
              randomBetween(0.35, 0.9),
              angle + randomBetween(-0.35, 0.35),
            ),
          );
        }
      }
      for (let i = 0; i < 70; i++) {
        // Ink splash lives inside the 800ms beat, so the effect never has to cut it short.
        particles.push(dot(randomBetween(0, width), randomBetween(0, height), pick(INK), randomBetween(3, 14), randomBetween(0.05, 0.5), randomBetween(320, 780)));
      }
      return particles;
    },
  };
}

/** A 7:3 ratio cut: grid lines, a critical impact and shattering glass. */
function ratioRecipe(): Recipe {
  return {
    className: 'vfx-ratio',
    durationMs: CUE_MS.RATIO ?? GAME_PACING.VFX_BANNER_DURATION_MS,
    shake: 10,
    label: '7:3 RATIO · CRITICAL',
    spawn: (width, height) => {
      const particles: Particle[] = [];
      const y = height * 0.7;
      for (let i = 0; i < 48; i++) {
        particles.push(
          streak(
            width * 0.3,
            y,
            pick(SPARK),
            randomBetween(2, 6),
            randomBetween(0.4, 1.4),
            randomBetween(-0.25, 0.25) + (i % 2 === 0 ? 0 : Math.PI),
          ),
        );
      }
      for (let i = 0; i < 60; i++) {
        particles.push(shard(randomBetween(width * 0.2, width * 0.8), randomBetween(height * 0.35, height * 0.9), pick(GLASS), randomBetween(4, 14), randomBetween(0.1, 0.8)));
      }
      particles.push(ring(width * 0.3, y, '#fef3c7', 6, 1.4, 700));
      return particles;
    },
  };
}

/** Cleave: a blood-red diagonal katana slash that tears the whole screen. */
function cleaveRecipe(): Recipe {
  return {
    className: 'vfx-cleave',
    durationMs: GAME_PACING.VFX_BANNER_DURATION_MS,
    shake: 16,
    label: 'CLEAVE · 25% MAX HP',
    spawn: (width, height) => {
      const particles: Particle[] = [];
      const angle = Math.atan2(height, width);
      for (let trail = 0; trail < 3; trail++) {
        const startX = -width * 0.1 + trail * width * 0.18;
        const startY = -height * 0.05;
        for (let i = 0; i < 34; i++) {
          const t = i / 34;
          particles.push(
            streak(
              startX + Math.cos(angle) * width * 1.4 * t,
              startY + Math.sin(angle) * height * 1.4 * t,
              pick(BLOOD),
              randomBetween(3, 10),
              randomBetween(0.6, 1.6),
              angle + randomBetween(-0.12, 0.12),
            ),
          );
        }
      }
      for (let i = 0; i < 80; i++) {
        particles.push(
          dot(
            randomBetween(0, width),
            randomBetween(height * 0.1, height * 0.9),
            pick(BLOOD),
            randomBetween(2, 8),
            randomBetween(0.2, 1.1),
            randomBetween(400, 1_000),
          ),
        );
      }
      particles.push(ring(width * 0.5, height * 0.5, '#fecaca', 12, 2.4, 620));
      return particles;
    },
  };
}

/** Two cursed-energy shockwaves colliding into a clap. */
function clashRecipe(): Recipe {
  return {
    className: 'vfx-clash',
    durationMs: CUE_MS.CLASH ?? GAME_PACING.VFX_BANNER_DURATION_MS,
    shake: 18,
    label: 'BROTHERHOOD · CLAP',
    spawn: (width, height) => {
      const particles: Particle[] = [];
      const cx = width / 2;
      const cy = height / 2;
      // Two wavefronts rush inward first: a crimson wall and a jet-black one behind it.
      // A negative speed makes the ring contract, so it reaches the centre as it dies.
      const reach = Math.max(width, height) * 0.46;
      particles.push(ring(cx, cy, '#dc2626', reach, -reach / 520, 380));
      particles.push(ring(cx, cy, '#0f172a', reach * 0.82, -(reach * 0.82) / 520, 420));

      // Then the clap itself: crimson shock, jet-black body, then the white core.
      particles.push(ring(cx, cy, '#f87171', 40, 1.9, 620));
      particles.push(ring(cx, cy, '#1f2937', 20, 1.35, 700));
      particles.push(ring(cx, cy, '#fecaca', 8, 2.6, 480));
      for (let i = 0; i < 90; i++) particles.push(dot(cx, cy, pick(CURSED), randomBetween(4, 16), randomBetween(0.3, 1.6), randomBetween(320, 720)));
      for (let i = 0; i < 24; i++) particles.push(streak(cx, cy, pick(CURSED), randomBetween(3, 8), randomBetween(0.8, 2), randomBetween(0, Math.PI * 2)));
      return particles;
    },
  };
}

/** Six Eyes: a spatial ripple that reads the whole field. */
function sixEyesRecipe(): Recipe {
  return {
    className: 'vfx-six-eyes',
    // Matches the reveal window the cue announces.
    durationMs: GAME_PACING.SKILL_CARD_REVEAL_DURATION_MS,
    shake: 4,
    label: 'SIX EYES · FULL READ',
    spawn: (width, height) => {
      const particles: Particle[] = [];
      const cx = width / 2;
      const cy = height / 2;
      for (let i = 0; i < 4; i++) particles.push(ring(cx, cy, pick(EYES), 10 + i * 12, 0.9 + i * 0.35, 900 - i * 90));
      for (let i = 0; i < 70; i++) particles.push(dot(randomBetween(0, width), randomBetween(0, height), pick(EYES), randomBetween(2, 8), randomBetween(0.1, 0.7), randomBetween(600, 1300)));
      return particles;
    },
  };
}

function domainRecipe(cue: 'DOMAIN' | 'SIMPLE_DOMAIN'): Recipe {
  const simple = cue === 'SIMPLE_DOMAIN';
  return {
    className: simple ? 'vfx-simple-domain' : 'vfx-domain',
    durationMs: GAME_PACING.DOMAIN_ACTIVATION_CINEMATIC_MS,
    shake: simple ? 6 : 12,
    label: simple ? 'SIMPLE DOMAIN' : 'DOMAIN EXPANSION',
    spawn: (width, height) => {
      const particles: Particle[] = [];
      const cx = width / 2;
      const cy = height / 2;
      const colors = simple ? SPARK : ['#8b5cf6', '#c4b5fd', '#4c1d95', '#f472b6'];
      for (let i = 0; i < 3; i++) particles.push(ring(cx, cy, pick(colors), 30 + i * 26, 1.1 + i * 0.4, 1000 - i * 120));
      for (let i = 0; i < 70; i++) particles.push(dot(randomBetween(0, width), randomBetween(0, height), pick(colors), randomBetween(3, 12), randomBetween(0.15, 0.9), randomBetween(700, 1500)));
      return particles;
    },
  };
}

function strikeRecipe(): Recipe {
  return {
    className: 'vfx-strike',
    durationMs: GAME_PACING.VFX_BANNER_DURATION_MS,
    shake: 6,
    label: 'HIT',
    spawn: (width, height) => {
      const particles: Particle[] = [];
      for (let i = 0; i < 26; i++) {
        particles.push(streak(width * 0.62, height * 0.45, pick(SPARK), randomBetween(2, 6), randomBetween(0.5, 1.5), randomBetween(0, Math.PI * 2)));
      }
      return particles;
    },
  };
}

function recipeFor(cue: VfxCue): Recipe {
  switch (cue) {
    case 'CLAW':
      return clawRecipe();
    case 'RATIO':
      return ratioRecipe();
    case 'CLASH':
      return clashRecipe();
    case 'CLEAVE':
      return cleaveRecipe();
    case 'SIX_EYES':
      return sixEyesRecipe();
    case 'DOMAIN':
      return domainRecipe('DOMAIN');
    case 'SIMPLE_DOMAIN':
      return domainRecipe('SIMPLE_DOMAIN');
    default:
      return strikeRecipe();
  }
}

export interface CueBurst {
  readonly particles: readonly Particle[];
  readonly durationMs: number;
}

/**
 * Builds the real particle burst for one cue at a given canvas size. The full-screen layer
 * and the codex preview both call this, so a preview is the actual choreography (ink
 * claws, golden fracture, clap rings) rather than a generic impression of it.
 */
export function createCueBurst(cue: VfxCue, width: number, height: number): CueBurst {
  const recipe = recipeFor(cue);
  return { particles: capParticles(recipe.spawn(width, height)), durationMs: recipe.durationMs };
}

function capParticles(spawned: readonly Particle[]): Particle[] {
  if (spawned.length <= MAX_PARTICLES) return [...spawned];
  // Rings are a cue's signature — the clap, the ratio impact — so every one is kept and
  // only the supporting dots, shards and streaks are sampled down to fill the budget.
  const rings = spawned.filter((particle) => particle.kind === 'ring');
  const rest = spawned.filter((particle) => particle.kind !== 'ring');
  const budget = Math.max(0, MAX_PARTICLES - rings.length);
  if (budget === 0) return rings.slice(0, MAX_PARTICLES);
  const stride = rest.length / budget;
  const sampled = Array.from(
    { length: Math.min(budget, rest.length) },
    (_, index) => rest[Math.floor(index * stride)] as Particle,
  );
  return [...rings, ...sampled].slice(0, MAX_PARTICLES);
}

/**
 * Advances and paints one frame of a burst, returning the particles still alive. It is
 * pure canvas work with no scheduling: the caller owns the loop and its deadline.
 */
export function advanceParticles(
  context: CanvasRenderingContext2D,
  particles: readonly Particle[],
  dt: number,
): Particle[] {
  const alive: Particle[] = [];
  for (const particle of particles) {
    particle.life -= dt;
    if (particle.life <= 0) continue;
    particle.vy += particle.gravity * dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.angle += particle.spin * dt;
    const alpha = Math.max(0, Math.min(1, particle.life / particle.maxLife));
    context.globalAlpha = alpha;
    context.fillStyle = particle.color;
    context.strokeStyle = particle.color;

    if (particle.kind === 'ring') {
      const radius = particle.size + particle.vx * (1 - alpha) * 520;
      context.lineWidth = Math.max(1, 6 * alpha);
      context.beginPath();
      context.arc(particle.x, particle.y, radius, 0, Math.PI * 2);
      context.stroke();
    } else if (particle.kind === 'shard') {
      context.save();
      context.translate(particle.x, particle.y);
      context.rotate(particle.angle);
      context.fillRect(-particle.size / 2, -particle.size / 6, particle.size, particle.size / 3);
      context.restore();
    } else if (particle.kind === 'streak') {
      context.lineWidth = Math.max(1, particle.size * alpha);
      context.beginPath();
      context.moveTo(particle.x, particle.y);
      context.lineTo(particle.x - particle.vx * 26, particle.y - particle.vy * 26);
      context.stroke();
    } else {
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size * (0.4 + alpha), 0, Math.PI * 2);
      context.fill();
    }
    alive.push(particle);
  }
  context.globalAlpha = 1;
  return alive;
}

export interface VfxLayer {
  /** Plays one cue. Repeated calls restart the overlay rather than stacking it. */
  play(cue: VfxCue): void;
  /** Emergency stop: wipes the canvas and removes any running overlay. */
  clear(): void;
}

/** Live layers, so `clearAllVfx` can reach the frame handles without a call-site handle. */
const activeLayers = new Set<() => void>();

/**
 * Emergency reset for the effects surface: cancels every active loop, wipes the canvas and
 * drops any overlay still on screen. Called when a new match starts or a turn concludes so
 * no effect can bleed into the next state.
 */
export function clearAllVfx(): void {
  for (const clear of activeLayers) clear();
}

export interface VfxOptions {
  readonly layer: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** Elements that shake on heavy cues. */
  readonly shakeTargets: readonly HTMLElement[];
}

/**
 * Presentation-only effects: a keyframe overlay, a canvas particle burst and screen
 * shake. Every effect unmounts itself once its animation finishes, so nothing leaks.
 */
export function createVfxLayer(options: VfxOptions): VfxLayer {
  const { layer, canvas, shakeTargets } = options;
  const context = canvas.getContext('2d');
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let particles: Particle[] = [];
  let frame: number | null = null;
  let lastFrame = 0;
  let deadline = 0;

  const resize = (): void => {
    // A 3x phone screen would render nine times the pixels for no visible gain at this
    // size; the cap keeps a Retina burst as cheap as a 2x one.
    const ratio = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  resize();
  globalThis.addEventListener('resize', resize);

  /** Wipes the canvas and drops the frame handle, so an idle effect costs nothing. */
  const stop = (): void => {
    if (frame !== null) globalThis.cancelAnimationFrame(frame);
    frame = null;
    particles = [];
    deadline = 0;
    // The backing store is what actually holds pixels; CSS units would miss the DPR scale.
    context?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const clear = (): void => {
    stop();
    for (const overlay of layer.querySelectorAll('.vfx-overlay')) overlay.remove();
  };
  activeLayers.add(clear);

  const step = (now: number): void => {
    frame = null;
    if (!context) return;
    const dt = Math.min(48, now - lastFrame || 16);
    lastFrame = now;
    // Every frame starts from a clean canvas; trails are a controlled part of a particle's
    // look, never paint left behind by a previous effect.
    context.clearRect(0, 0, canvas.width, canvas.height);
    const expired = now >= deadline;

    particles = advanceParticles(context, particles, dt);

    // The effect owns a deadline: once it passes, or nothing is left to draw, the loop
    // clears the canvas and hands the frame back instead of spinning forever.
    if (expired || particles.length === 0) {
      stop();
      return;
    }
    frame = globalThis.requestAnimationFrame(step);
  };

  const shake = (amplitude: number): void => {
    for (const target of shakeTargets) {
      target.style.setProperty('--shake', `${amplitude}px`);
      target.classList.remove('shake');
      // Reflow so the animation restarts even when the same cue fires twice.
      void target.offsetWidth;
      target.classList.add('shake');
      globalThis.setTimeout(() => target.classList.remove('shake'), 520);
    }
  };

  const play = (cue: VfxCue): void => {
    const recipe = recipeFor(cue);
    const overlay = document.createElement('div');
    overlay.className = `vfx-overlay ${recipe.className}`;
    const caption = document.createElement('span');
    caption.className = 'vfx-label';
    caption.textContent = recipe.label;
    overlay.append(caption);
    layer.append(overlay);

    if (!reducedMotion) {
      // A fresh cue replaces the previous burst outright, so cues fired in quick
      // succession can never accumulate into a wall of dots.
      const effect = createCueBurst(cue, layer.clientWidth || 800, layer.clientHeight || 600);
      particles = [...effect.particles];
      // Canvas work is capped at 800ms even when the caption (Six Eyes) stays longer.
      deadline = performance.now() + Math.min(effect.durationMs, MAX_EFFECT_MS);
      if (frame === null) {
        lastFrame = 0;
        frame = globalThis.requestAnimationFrame(step);
      }
      if (recipe.shake > 0) shake(recipe.shake);
    }
    globalThis.setTimeout(() => overlay.remove(), recipe.durationMs);
  };

  return { play, clear };
}
