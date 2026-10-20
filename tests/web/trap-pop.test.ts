import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARD_EFFECT_KIND, type GameEvent, type PlayerId } from '../../src/engine/index.js';
import {
  TRAP_IMPACT_MS,
  TRAP_PLANT_CLASS,
  TRAP_PLANT_CLASSES,
  TRAP_POP_CLASS,
  TRAP_POP_CLASSES,
  TRAP_POP_MS,
  TRAP_POP_SELECTOR,
  isDetonationConsequence,
  trapPopClass,
  trapPopSelector,
} from '../../src/web/trap-pop.js';

// The burst itself is CSS: transparency and clipping cannot be seen from the DOM the app
// builds, so the rules that keep it on screen are pinned here against the real stylesheet.

describe('trap planting animation', () => {
  const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

  it('plants every hazard with a class that the stylesheet animates', () => {
    for (const kind of Object.values(CARD_EFFECT_KIND)) {
      const plant = TRAP_PLANT_CLASS[kind];
      expect(TRAP_PLANT_CLASSES).toContain(plant);
      expect(css).toMatch(new RegExp(`\\.card \\.hz-art\\.${plant}\\s*\\{[^}]*animation:`));
    }
  });
});
const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8')
  // Comments are stripped first: a rule's preamble would otherwise carry the prose above it.
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Bodies of every rule whose selector list contains `selector` verbatim. */
function rulesWith(selector: string): string[] {
  const out: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const selectors = (match[1] as string).split(',').map((part) => part.trim());
    if (selectors.includes(selector)) out.push(match[2] as string);
  }
  return out;
}

/** Body of a keyframes at-rule, by name. */
function keyframesBody(name: string): string {
  const start = css.indexOf(`@keyframes ${name}`);
  if (start < 0) throw new Error(`styles.css has no @keyframes ${name}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`@keyframes ${name} is unbalanced`);
}

const P1: PlayerId = 'p1';
const P2: PlayerId = 'p2';
const detonating = new Set<PlayerId>([P1]);

function damage(cause: 'CARD_EFFECT' | 'MATCH', targetId: PlayerId): GameEvent {
  return {
    type: 'DAMAGE_DEALT',
    sourceId: P1,
    targetId,
    dealt: 15,
    absorbed: 0,
    critical: false,
    piercing: false,
    cause,
  };
}

function energy(cause: 'CARD_EFFECT' | 'SIPHON', playerId: PlayerId): GameEvent {
  return { type: 'CE_CHANGED', playerId, delta: -10, cause };
}

function stun(playerId: PlayerId): GameEvent {
  return { type: 'STUNNED', playerId, until: 500 };
}

describe('trap detonation bursts', () => {
  it('gives each planted hazard its own pop class', () => {
    expect(trapPopClass(CARD_EFFECT_KIND.LAVA)).toBe('trap-pop-ember');
    expect(trapPopClass(CARD_EFFECT_KIND.NAILED)).toBe('trap-pop-nail');
    expect(trapPopClass(CARD_EFFECT_KIND.LOCKED)).toBe('trap-pop-seal');
    expect(trapPopClass(CARD_EFFECT_KIND.FLESH)).toBe('trap-pop-flesh');
  });

  it('keeps every hazard mapped, and every burst distinct', () => {
    const kinds = Object.keys(TRAP_POP_CLASS);
    expect(kinds).toHaveLength(4);
    expect(TRAP_POP_CLASSES).toHaveLength(4);
    expect(new Set(TRAP_POP_CLASSES).size).toBe(4);
    for (const className of TRAP_POP_CLASSES) expect(className).toMatch(/^trap-pop-/);
  });

  it('plays each burst on the trap art layer that carries it', () => {
    // The burst has to land on the art itself: the wrapper around it is left empty once
    // `data-hazard` clears, so a class there animates nothing.
    expect(trapPopSelector(CARD_EFFECT_KIND.LAVA)).toBe('.hz-lava');
    expect(trapPopSelector(CARD_EFFECT_KIND.NAILED)).toBe('.hz-nail');
    expect(trapPopSelector(CARD_EFFECT_KIND.LOCKED)).toBe('.hz-seal');
    expect(trapPopSelector(CARD_EFFECT_KIND.FLESH)).toBe('.hz-soul');
    expect(Object.keys(TRAP_POP_SELECTOR)).toHaveLength(4);
    expect(new Set(Object.values(TRAP_POP_SELECTOR)).size).toBe(4);
  });

  it('holds consequences for the full 800ms burst and clears the classes after it', () => {
    // The brief asks for an explicit 800ms pause before the hit is applied.
    expect(TRAP_IMPACT_MS).toBe(800);
    // Cleanup may never run before the impact, or the art would vanish ahead of its hit.
    expect(TRAP_POP_MS).toBeGreaterThan(TRAP_IMPACT_MS);
    expect(TRAP_POP_MS).toBeGreaterThanOrEqual(800);
  });
});

describe('trap detonation stylesheet', () => {
  const BURSTS = ['emberTriggerPop', 'cursedNailResonancePop', 'sealTriggerBurst', 'fleshTriggerSurge'];

  it('pins every burst opaque from its first frame', () => {
    // The trap art is normally painted by its entry animation, which starts at opacity 0.
    // The pop replaces that animation, so a burst with no opacity of its own inherits the
    // transparent frame and plays out invisible — the bug this guard exists for.
    for (const name of BURSTS) {
      const body = keyframesBody(name);
      const firstFrame = /0%\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
      expect(firstFrame, `${name} must not start transparent`).toMatch(/opacity:\s*1(?![\d.])/);
    }
  });

  it('keeps the ember solid until it disperses', () => {
    const ember = keyframesBody('emberTriggerPop');
    // Every frame before the last holds full opacity: the burst's timing function is an
    // accelerating curve, so a fade spread over the whole run empties in the first 100ms.
    const frames = [...ember.matchAll(/(\d+)%\s*\{([^}]*)\}/g)];
    for (const [, offset, body] of frames) {
      if (offset === '100') continue;
      expect(body as string, `ember frame ${offset}% must stay opaque`).toMatch(/opacity:\s*1(?!\d)/);
    }
  });

  it('lifts paint containment for the burst, so it is not cropped at the card border', () => {
    // `.hz-art` is paint-contained so an idle trap never repaints its neighbours; that same
    // containment crops a 1.65x burst to the art box, which is the visible symptom.
    for (const className of TRAP_POP_CLASSES) {
      const body = rulesWith(`.card .hz-art.${className}`).join('\n');
      expect(body).toMatch(/contain:\s*layout style/);
      expect(body).not.toMatch(/paint/);
      expect(body).toMatch(/overflow:\s*visible/);
    }
  });

  it('lets the triggering card and its grid cell spill, and lifts the card above the grid', () => {
    const card = rulesWith('.card.trap-triggering-card').join('\n');
    expect(card).toMatch(/overflow:\s*visible\s*!important/);
    expect(card).toMatch(/z-index:\s*100\s*!important/);
    expect(rulesWith('.grid-slot:has(.trap-triggering-card)').join('\n')).toMatch(/overflow:\s*visible/);
  });

  it('forces the burst layer visible and above every neighbour', () => {
    for (const className of TRAP_POP_CLASSES) {
      const body = rulesWith(`.${className}`).join('\n');
      expect(body).toMatch(/display:\s*block\s*!important/);
      expect(body).toMatch(/z-index:\s*120\s*!important/);
      expect(body).toMatch(/pointer-events:\s*none/);
    }
  });
});

describe('isDetonationConsequence', () => {
  it('holds the damage, drain and stun a detonating card just dealt', () => {
    expect(isDetonationConsequence(damage('CARD_EFFECT', P1), detonating)).toBe(true);
    expect(isDetonationConsequence(energy('CARD_EFFECT', P1), detonating)).toBe(true);
    expect(isDetonationConsequence(stun(P1), detonating)).toBe(true);
  });

  it('leaves every other report on its own beat', () => {
    // Another seat's numbers, a match hit, a siphon and a plain flip are not held.
    expect(isDetonationConsequence(damage('CARD_EFFECT', P2), detonating)).toBe(false);
    expect(isDetonationConsequence(damage('MATCH', P1), detonating)).toBe(false);
    expect(isDetonationConsequence(energy('SIPHON', P1), detonating)).toBe(false);
    expect(isDetonationConsequence(stun(P2), detonating)).toBe(false);
    expect(isDetonationConsequence({ type: 'PAIR_MISMATCHED', playerId: P1, cardIds: [] }, detonating)).toBe(false);
  });

  it('holds nothing in a batch where no card detonates', () => {
    const none = new Set<PlayerId>();
    expect(isDetonationConsequence(damage('CARD_EFFECT', P1), none)).toBe(false);
    expect(isDetonationConsequence(energy('CARD_EFFECT', P1), none)).toBe(false);
    expect(isDetonationConsequence(stun(P1), none)).toBe(false);
  });
});
