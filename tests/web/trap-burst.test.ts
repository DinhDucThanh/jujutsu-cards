// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_EFFECT_KIND,
  type CardEffectKind,
  type CardEffectModifier,
  type PlayerId,
} from '../../src/engine/index.js';
import {
  TRAP_BURST_MS,
  TRAP_POP_MS,
  flipBurstKind,
  flipWithTrapBurst,
  startTrapBurst,
} from '../../src/web/trap-pop.js';

const P1: PlayerId = 'p1';
const P2: PlayerId = 'p2';

/** A planted modifier, as the view publishes it. */
function modifier(kind: CardEffectKind, sourceId: PlayerId = P2): CardEffectModifier {
  return { kind, sourceId, turnsRemaining: null };
}

/**
 * A card that carries every hazard art layer, the way `card-face.ts` builds one.
 *
 * The burst lands on the art itself, so the card has to own all four layers for the
 * tests to see which one was chosen.
 */
function cardWithHazardArt(): HTMLElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  for (const layer of ['hz-lava', 'hz-nail', 'hz-soul', 'hz-seal']) {
    const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    art.setAttribute('class', `hz-art ${layer}`);
    card.append(art);
  }
  document.body.append(card);
  return card;
}

/** The art layer that is wearing a burst, if any. */
function burstingArt(card: HTMLElement): Element | null {
  return card.querySelector('.hz-art.trap-pop-ember, .hz-art.trap-pop-nail, .hz-art.trap-pop-seal, .hz-art.trap-pop-flesh');
}

/** Collects the timers a burst schedules, so they can be run on demand. */
function timerBox(): {
  schedule: (callback: () => void, delay: number) => void;
  run: (delay: number) => void;
  delayOf: (callback: () => void) => number | undefined;
} {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  return {
    schedule: (callback, delay) => {
      timers.push({ callback, delay });
    },
    run: (delay) => {
      for (const timer of timers.filter((entry) => entry.delay === delay)) timer.callback();
    },
    delayOf: (callback) => timers.find((entry) => entry.callback === callback)?.delay,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('flipBurstKind', () => {
  it('names the burst a planted trap will play', () => {
    expect(flipBurstKind([modifier(CARD_EFFECT_KIND.LAVA)], P1)).toBe(CARD_EFFECT_KIND.LAVA);
    expect(flipBurstKind([modifier(CARD_EFFECT_KIND.NAILED)], P1)).toBe(CARD_EFFECT_KIND.NAILED);
  });

  it('leaves the player who planted the trap alone', () => {
    // The engine never fires a trap for the seat that planted it, so the burst must not
    // be played on that seat's own flip.
    expect(flipBurstKind([modifier(CARD_EFFECT_KIND.LAVA, P1)], P1)).toBeNull();
  });

  it('leaves a sealed card quiet, because it cannot be flipped at all', () => {
    expect(flipBurstKind([modifier(CARD_EFFECT_KIND.LOCKED)], P1)).toBeNull();
  });

  it('surges the flesh on a corrupted card, whoever planted it', () => {
    // The flesh is inert for the engine, but it still has a face to show as the card
    // turns over.
    expect(flipBurstKind([modifier(CARD_EFFECT_KIND.FLESH)], P1)).toBe(CARD_EFFECT_KIND.FLESH);
    expect(flipBurstKind([modifier(CARD_EFFECT_KIND.FLESH, P1)], P1)).toBe(CARD_EFFECT_KIND.FLESH);
  });

  it('is quiet on a card that carries no modifier', () => {
    expect(flipBurstKind([], P1)).toBeNull();
  });
});

describe('startTrapBurst', () => {
  it('kicks the card and bursts the art that carries the trap', () => {
    const card = cardWithHazardArt();
    const timers = timerBox();
    startTrapBurst(card, CARD_EFFECT_KIND.LAVA, timers.schedule);
    expect(card.classList.contains('trap-triggering-card')).toBe(true);
    expect(burstingArt(card)).toBe(card.querySelector('.hz-lava'));
  });

  it('takes the classes off once the burst is over', () => {
    const card = cardWithHazardArt();
    const timers = timerBox();
    startTrapBurst(card, CARD_EFFECT_KIND.NAILED, timers.schedule);
    timers.run(TRAP_POP_MS);
    expect(card.classList.contains('trap-triggering-card')).toBe(false);
    expect(burstingArt(card)).toBeNull();
  });

  it('replays a burst that fires twice in a turn', () => {
    // The classes come off and the card is reflowed first, so the second burst starts
    // from the beginning instead of inheriting a finished animation.
    const card = cardWithHazardArt();
    const timers = timerBox();
    startTrapBurst(card, CARD_EFFECT_KIND.LAVA, timers.schedule);
    timers.run(TRAP_POP_MS);
    startTrapBurst(card, CARD_EFFECT_KIND.LAVA, timers.schedule);
    expect(card.classList.contains('trap-triggering-card')).toBe(true);
    expect(card.querySelectorAll('.hz-lava.trap-pop-ember')).toHaveLength(1);
  });

  it('lets a cursed object recoil without a pop of its own', () => {
    const card = cardWithHazardArt();
    const timers = timerBox();
    startTrapBurst(card, null, timers.schedule);
    expect(card.classList.contains('trap-triggering-card')).toBe(true);
    expect(burstingArt(card)).toBeNull();
  });
});

describe('flipWithTrapBurst', () => {
  it('plays the burst before the card is turned over', async () => {
    vi.useFakeTimers();
    const card = cardWithHazardArt();
    const timers = timerBox();
    const order: string[] = [];
    const flipped = flipWithTrapBurst({
      card,
      burst: CARD_EFFECT_KIND.LAVA,
      lock: () => order.push('lock'),
      holdRender: () => order.push('hold'),
      release: () => order.push('release'),
      schedule: timers.schedule,
      applyFlip: () => order.push('flip'),
    });
    // The burst is on screen and the grid is locked before anything else happens.
    expect(card.classList.contains('trap-triggering-card')).toBe(true);
    expect(order).toEqual(['lock', 'hold']);
    expect(order).not.toContain('flip');
    await vi.advanceTimersByTimeAsync(TRAP_BURST_MS);
    await flipped;
    // Only now does the engine learn about the flip.
    expect(order).toEqual(['lock', 'hold', 'flip']);
  });

  it('holds the flip for the whole burst', async () => {
    vi.useFakeTimers();
    const card = cardWithHazardArt();
    const timers = timerBox();
    let flipped = false;
    const done = flipWithTrapBurst({
      card,
      burst: CARD_EFFECT_KIND.NAILED,
      lock: () => {},
      holdRender: () => {},
      release: () => {},
      schedule: timers.schedule,
      applyFlip: () => {
        flipped = true;
      },
    });
    await vi.advanceTimersByTimeAsync(TRAP_BURST_MS - 1);
    expect(flipped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(flipped).toBe(true);
  });

  it('hands the grid back once the burst is over', async () => {
    vi.useFakeTimers();
    const card = cardWithHazardArt();
    const timers = timerBox();
    let released = false;
    const release = (): void => {
      released = true;
    };
    const done = flipWithTrapBurst({
      card,
      burst: CARD_EFFECT_KIND.LAVA,
      lock: () => {},
      holdRender: () => {},
      release,
      schedule: timers.schedule,
      applyFlip: () => {},
    });
    // The release waits for the whole pop, so the grid comes back after the trap has
    // finished going off rather than under it.
    expect(timers.delayOf(release)).toBe(TRAP_POP_MS);
    expect(TRAP_POP_MS).toBeGreaterThan(TRAP_BURST_MS);
    await vi.advanceTimersByTimeAsync(TRAP_BURST_MS);
    await done;
    timers.run(TRAP_POP_MS);
    expect(released).toBe(true);
    expect(card.classList.contains('trap-triggering-card')).toBe(false);
  });
});
