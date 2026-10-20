/**
 * The trap detonation pop-up: which burst a hazard plays, and which reports belong to it.
 *
 * The animation itself lives in styles.css (`emberTriggerPop`, `cursedNailResonancePop`,
 * `sealTriggerBurst`, `fleshTriggerSurge`). This module owns the mapping from a planted
 * hazard to its class, the timing both the burst and its consequences run on, and the rule
 * that decides which engine reports must wait for the burst before they are announced.
 */
import {
  CARD_EFFECT_KIND,
  type CardEffectKind,
  type CardEffectModifier,
  type GameEvent,
  type PlayerId,
} from '../engine/index.js';

/**
 * The detonation burst each planted hazard plays when it goes off. A face-up cursed object
 * is not one of the four animated hazards, so it has no pop of its own: its card recoils.
 */
export const TRAP_POP_CLASS: Readonly<Record<CardEffectKind, string>> = {
  [CARD_EFFECT_KIND.LAVA]: 'trap-pop-ember',
  [CARD_EFFECT_KIND.NAILED]: 'trap-pop-nail',
  [CARD_EFFECT_KIND.FLESH]: 'trap-pop-flesh',
  [CARD_EFFECT_KIND.LOCKED]: 'trap-pop-seal',
};

/** Every pop class, for clearing whichever one a card was wearing before it fires again. */
export const TRAP_POP_CLASSES: readonly string[] = Object.values(TRAP_POP_CLASS);

/**
 * The planting animation each hazard plays when a skill drives it onto a card. Distinct
 * from the detonation burst above: planting slams the trap down onto the face, detonation
 * throws it back off.
 */
export const TRAP_PLANT_CLASS: Readonly<Record<CardEffectKind, string>> = {
  [CARD_EFFECT_KIND.LAVA]: 'trap-plant-ember',
  [CARD_EFFECT_KIND.NAILED]: 'trap-plant-nail',
  [CARD_EFFECT_KIND.FLESH]: 'trap-plant-flesh',
  [CARD_EFFECT_KIND.LOCKED]: 'trap-plant-seal',
};

/** Every planting class, for clearing whichever one a card was wearing. */
export const TRAP_PLANT_CLASSES: readonly string[] = Object.values(TRAP_PLANT_CLASS);

/** Longest planting animation in the stylesheet (0.5s), plus slack before classes come off. */
export const TRAP_PLANT_MS = 600;

/**
 * The art layer inside a card that wears each burst (see `hazardArt` in card-face.ts).
 *
 * The burst has to be played on the art itself: the engine consumes a planted modifier on
 * the flip that sets it off, so the card's `data-hazard` falls back to none on the next
 * frame and every `.hz-art` returns to `display: none`. Animating the wrapper around them
 * would leave the animation running with nothing left to see.
 */
export const TRAP_POP_SELECTOR: Readonly<Record<CardEffectKind, string>> = {
  [CARD_EFFECT_KIND.LAVA]: '.hz-lava',
  [CARD_EFFECT_KIND.NAILED]: '.hz-nail',
  [CARD_EFFECT_KIND.FLESH]: '.hz-soul',
  [CARD_EFFECT_KIND.LOCKED]: '.hz-seal',
};

/**
 * The hazards the engine sets off the moment their card is flipped.
 *
 * A planted ember or nail is a trap on the card: flipping that card sets it off. The
 * sealed talisman (LOCKED) is the odd one out — a locked card refuses to be flipped at
 * all, so it never detonates on a flip and has no burst to play there. The flesh is inert
 * for the engine (it corrupts a card rather than hurting anyone), but it still has a face
 * to show as the card turns over.
 */
export const DETONATING_HAZARDS: readonly CardEffectKind[] = [
  CARD_EFFECT_KIND.LAVA,
  CARD_EFFECT_KIND.NAILED,
];

/** True when a planted hazard goes off the moment its card is flipped. */
export function isDetonatingHazard(kind: CardEffectKind | null | undefined): boolean {
  return kind !== null && kind !== undefined && DETONATING_HAZARDS.includes(kind);
}

/**
 * The burst a flip plays, or null when the flip is quiet.
 *
 * The engine fires a planted modifier for everyone but the player who planted it, and
 * only for a modifier that does something. The view publishes every modifier on every
 * card, so the click handler can know what a flip is about to do before it does it: the
 * ember or the nail goes off, and a corrupted card surges as it turns over.
 */
export function flipBurstKind(
  modifiers: readonly CardEffectModifier[],
  actor: PlayerId,
): CardEffectKind | null {
  for (const modifier of modifiers) {
    // The engine never fires a trap for the player who planted it.
    if (modifier.sourceId === actor) continue;
    if (isDetonatingHazard(modifier.kind)) return modifier.kind;
  }
  if (modifiers.some((modifier) => modifier.kind === CARD_EFFECT_KIND.FLESH)) {
    return CARD_EFFECT_KIND.FLESH;
  }
  return null;
}

/**
 * How long the burst plays before the card that carries it may be updated.
 *
 * The engine resolves a flip in one call, so a trap is consumed on the very frame the
 * card is clicked and the board re-renders immediately. The burst therefore has to be
 * started before that resolution, and the card's own state has to wait for it: 750ms is
 * the length of the ember, nail and flesh bursts, so the trap is watched going off
 * before the card turns over and the damage lands.
 */
export const TRAP_BURST_MS = 750;

/**
 * How long a detonation holds before its consequences are announced. Long enough for the
 * player to watch the trap leap off the card: the seal is the slowest burst at 0.8s, so the
 * damage, drain and stun land as it comes down instead of on top of it.
 */
export const TRAP_IMPACT_MS = 800;

/** The longest trap pop in the stylesheet (0.8s), plus slack before its classes come off. */
export const TRAP_POP_MS = 900;

/**
 * The gap between the engine resolving a flip and the consequences of a burst that was
 * already played landing.
 *
 * A burst the click handler played has run its course by the time the engine reports the
 * trap, so its damage number and log line follow at once instead of waiting for a second
 * burst that will never come.
 */
export const TRAP_IMPACT_LAG_MS = 60;

/** The burst class for a planted hazard. */
export function trapPopClass(modifier: CardEffectKind): string {
  return TRAP_POP_CLASS[modifier];
}

/** The art layer that burst belongs on. */
export function trapPopSelector(modifier: CardEffectKind): string {
  return TRAP_POP_SELECTOR[modifier];
}

/**
 * Starts the burst on a card that is about to detonate: the card kicks and its own art
 * bursts off the face.
 *
 * The burst class goes on the trap's art SVG, never on the `.hazard` wrapper: the engine
 * consumes the modifier on the flip that sets it off, so `data-hazard` clears on the next
 * frame and the art would go back to `display: none` while the wrapper kept animating an
 * empty box. The class carries `display: block !important` for exactly that reason.
 *
 * Every class comes off and the card is reflowed first, so a trap that fires twice in a
 * turn replays its burst instead of inheriting a finished animation. `modifier` is null
 * for a face-up cursed object, which recoils without a pop of its own.
 *
 * `schedule` owns the cleanup timer: the session keeps its own list of timers, so a
 * match that is torn down does not leave a burst running.
 */
export function startTrapBurst(
  card: HTMLElement,
  modifier: CardEffectKind | null,
  schedule: (callback: () => void, delay: number) => void,
): void {
  const pop = modifier === null ? null : trapPopClass(modifier);
  const art = modifier === null ? null : card.querySelector<HTMLElement>(trapPopSelector(modifier));
  card.classList.remove('trap-triggering-card');
  for (const layer of card.querySelectorAll<HTMLElement>('.hz-art')) {
    for (const className of TRAP_POP_CLASSES) layer.classList.remove(className);
  }
  void card.offsetWidth; // restart the recoil, and the pop with it
  card.classList.add('trap-triggering-card');
  if (art && pop) art.classList.add(pop);
  schedule(() => {
    card.classList.remove('trap-triggering-card');
    if (art && pop) art.classList.remove(pop);
  }, TRAP_POP_MS);
}

/** What a flip that sets a trap off needs to do around its burst. */
export interface TrapBurstFlip {
  /** The card that carries the trap. */
  readonly card: HTMLElement;
  /** The planted hazard it carries. */
  readonly burst: CardEffectKind;
  /** Locks the grid, so a second click cannot land on a card that is turning over. */
  readonly lock: () => void;
  /** Holds the redraw, so the card cannot change from under the burst. */
  readonly holdRender: () => void;
  /** Hands the grid and the redraw back once the burst is over. */
  readonly release: () => void;
  /** Schedules the cleanup of the burst's classes and the release of the grid. */
  readonly schedule: (callback: () => void, delay: number) => void;
  /** Applies the flip, once the burst has played out. */
  readonly applyFlip: () => void;
}

/**
 * A flip that sets a planted trap off: the burst plays first, and the card is only
 * turned over once the burst has finished.
 *
 * The engine resolves a flip in one call and the board is redrawn from its result, so
 * the flip itself has to wait. The trap is watched leaping off the card before the card
 * changes, and the grid is locked while it burns, so a second click cannot land on a
 * card that is already turning over.
 */
export async function flipWithTrapBurst(flip: TrapBurstFlip): Promise<void> {
  startTrapBurst(flip.card, flip.burst, flip.schedule);
  flip.lock();
  flip.holdRender();
  // The grid is handed back when the burst is over, whether the flip was accepted or not.
  flip.schedule(flip.release, TRAP_POP_MS);
  await new Promise((resolve) => setTimeout(resolve, TRAP_BURST_MS));
  flip.applyFlip();
}

/**
 * The reports a detonating card produces: its damage, its cursed-energy drain and its stun.
 *
 * The engine emits these just before the `CARD_EFFECT_TRIGGERED` that explains them, so the
 * numbers would otherwise land while the trap is still leaping off the card. Only the seats
 * that are detonating in this batch are matched, so an unrelated burn or siphon keeps its
 * immediate feedback.
 */
export function isDetonationConsequence(event: GameEvent, detonating: ReadonlySet<PlayerId>): boolean {
  if (detonating.size === 0) return false;
  switch (event.type) {
    case 'DAMAGE_DEALT':
      return event.cause === 'CARD_EFFECT' && detonating.has(event.targetId);
    case 'CE_CHANGED':
      return event.cause === 'CARD_EFFECT' && detonating.has(event.playerId);
    case 'STUNNED':
      return detonating.has(event.playerId);
    default:
      return false;
  }
}
