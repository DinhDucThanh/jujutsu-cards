import type { CardEffectKind } from './types.js';
import type { GameEvent } from './events.js';

/**
 * Presentation hooks for the engine's own events.
 *
 * The engine stays free of the browser: it never touches an AudioContext, it just names
 * the cue each moment deserves. `src/utils/sfx.ts` turns these names into synthesized
 * sound, and the UI decides whether anything plays at all. Because the mapping lives next
 * to the rules, a new damage path or evaluation branch cannot ship silently: whatever event
 * it emits is classified here.
 */
export const SOUND_CUE = {
  CARD_FLIP: 'CARD_FLIP',
  CARD_MATCH: 'CARD_MATCH',
  MISMATCH: 'MISMATCH',
  BLACK_FLASH: 'BLACK_FLASH',
  BROTHERHOOD_SYNC: 'BROTHERHOOD_SYNC',
  BARRIER_HIT: 'BARRIER_HIT',
  SKILL_CAST: 'SKILL_CAST',
  /** Sukuna's Cleave: a heavy katana bite rather than a generic cursed-energy cast. */
  CLEAVE: 'CLEAVE',
  DOMAIN_EXPANSION: 'DOMAIN_EXPANSION',
  TRAP_DETONATE: 'TRAP_DETONATE',
  COURTROOM_ENTER: 'COURTROOM_ENTER',
  GAVEL_STRIKE: 'GAVEL_STRIKE',
  JUDGEMAN_BELL: 'JUDGEMAN_BELL',
  EXECUTIONER_SLASH: 'EXECUTIONER_SLASH',
  AWAKENING_SURGE: 'AWAKENING_SURGE',
  BLESSING_CHOSEN: 'BLESSING_CHOSEN',
  TALISMAN_SEAL: 'TALISMAN_SEAL',
  /** Jogo incinerating a seal: a roaring flame burst with a low-end sweep. */
  SEAL_ABSORBED: 'SEAL_ABSORBED',
  /** Setup screen: a handful of dice tumbling across felt, then the roll settling. */
  DICE_ROLL: 'DICE_ROLL',
  /** A slot reel locking onto its symbol: one dry mechanical click. Presentation only. */
  REEL_STOP: 'REEL_STOP',
  /** A board card under the pointer: a quiet paper tick, never a full flip. Presentation only. */
  CARD_HOVER: 'CARD_HOVER',
  /** Ember insect: a fast buzz that melts into a magma burst. Trap cues stay under two seconds. */
  EMBER_INSECT: 'EMBER_INSECT',
  /** Cursed nail: an iron impact with an inharmonic ring. */
  CURSED_NAIL: 'CURSED_NAIL',
  /** Sealed talisman: parchment rustle over a sub-bass cursed pulse. */
  SEALED_TALISMAN: 'SEALED_TALISMAN',
  /** Transfigured flesh: a frequency-modulated, moist distortion. */
  TRANSFIGURED_FLESH: 'TRANSFIGURED_FLESH',
  /** Yuji's Divergent Fist: a blunt punch, then the delayed cursed boom. */
  DIVERGENT_FIST: 'DIVERGENT_FIST',
  /** Hakari's Idle Death Gamble opening: dice rattle and a tense metallic tick. */
  GAMBLE_START: 'GAMBLE_START',
  /** Pachinko lever pulled: a heavy arcade clack, down then release. */
  PACHINKO_LEVER: 'PACHINKO_LEVER',
  /** Side lever pulled: a crisp two-tick metal ratchet as the arm cranks down. */
  MECHANICAL_LEVER_PULL: 'MECHANICAL_LEVER_PULL',
  /** Pachinko reels spinning: rapid mechanical ratchet clicks. */
  PACHINKO_REEL_SPIN: 'PACHINKO_REEL_SPIN',
  /** Pachinko reel locking: a solid THUNK with a metallic spring. */
  PACHINKO_REEL_STOP: 'PACHINKO_REEL_STOP',
  /** Regular (odd triple) jackpot: cascading bells and coin shimmer. */
  JACKPOT_REGULAR: 'JACKPOT_REGULAR',
  /** Golden or 7-7-7 jackpot: chord fanfare, siren pulse and a coin fountain. */
  JACKPOT_GOLDEN: 'JACKPOT_GOLDEN',
  /** Bankrupt Domain: glass crunch over a hollow descending buzzer. */
  BANKRUPT_WHIFF: 'BANKRUPT_WHIFF',
} as const;

export type SoundCue = (typeof SOUND_CUE)[keyof typeof SOUND_CUE];

/** Receives cues in the order the engine produced their events. */
export type SoundListener = (cue: SoundCue) => void;

/**
 * The cue an event maps to, or null when it is bookkeeping the player should not hear.
 *
 * A pair landing plays the reward chime and its damage share does not add a second hit
 * sound: only damage that actually chewed through a barrier rings the crystal. Trap
 * cards, planted nails and ember insects all detonate with the same snap.
 */
export function soundCueFor(event: GameEvent): SoundCue | null {
  switch (event.type) {
    case 'CARD_REVEALED':
      return SOUND_CUE.CARD_FLIP;
    case 'PAIR_MATCHED':
      return SOUND_CUE.CARD_MATCH;
    case 'PAIR_MISMATCHED':
      return SOUND_CUE.MISMATCH;
    case 'BLACK_FLASH':
      return SOUND_CUE.BLACK_FLASH;
    case 'SYNERGY_TRIGGERED':
      // Brotherhood Sync claps before its thunder; other lore pairs keep their own cues.
      return event.synergyId === 'brotherhood_barrage' ? SOUND_CUE.BROTHERHOOD_SYNC : null;
    case 'TRAP_TRIGGERED':
      return SOUND_CUE.TRAP_DETONATE;
    case 'CARD_EFFECT_TRIGGERED':
      return cardEffectCue(event.modifier);
    case 'SKILL_ACTIVATED':
      if (event.skillId === 'cleave') return SOUND_CUE.CLEAVE;
      if (event.skillId === 'divergent_fist') return SOUND_CUE.DIVERGENT_FIST;
      return SOUND_CUE.SKILL_CAST;
    case 'SIMPLE_DOMAIN_OPENED':
      return SOUND_CUE.SKILL_CAST;
    case 'SEAL_ABSORBED':
      return SOUND_CUE.SEAL_ABSORBED;
    case 'ULTIMATE_ACTIVATED':
      return event.domainId === null ? SOUND_CUE.SKILL_CAST : SOUND_CUE.DOMAIN_EXPANSION;
    case 'DAMAGE_DEALT':
      return event.absorbed > 0 ? SOUND_CUE.BARRIER_HIT : null;
    case 'COURTROOM_OPENED':
      // Opening the domain is the judge's first gavel strike.
      return SOUND_CUE.GAVEL_STRIKE;
    case 'COURTROOM_VERDICT':
      // An acquittal rings the Judgeman's bell; a guilty verdict is the gavel coming down.
      return event.verdict === 'NOT_GUILTY' ? SOUND_CUE.JUDGEMAN_BELL : SOUND_CUE.GAVEL_STRIKE;
    case 'EXECUTIONER_GRANTED':
      return SOUND_CUE.EXECUTIONER_SLASH;
    case 'AWAKENING_OPENED':
      return SOUND_CUE.AWAKENING_SURGE;
    case 'AWAKENING_CHOSEN':
      return SOUND_CUE.BLESSING_CHOSEN;
    default:
      return null;
  }
}

/** Each planted card modifier has its own sound; the modifier names match `CARD_EFFECT_KIND`. */
function cardEffectCue(modifier: CardEffectKind): SoundCue {
  switch (modifier) {
    case 'NAILED':
      return SOUND_CUE.CURSED_NAIL;
    case 'LAVA':
      return SOUND_CUE.EMBER_INSECT;
    case 'FLESH':
      return SOUND_CUE.TRANSFIGURED_FLESH;
    case 'LOCKED':
      return SOUND_CUE.SEALED_TALISMAN;
  }
}

/**
 * Cap on how often one cue may fire for a single engine result. One command can reveal
 * half the grid (scouting techniques), and ten overlapping whooshes is noise, not feedback.
 */
export const MAX_CUE_REPEATS_PER_BATCH = 2;

/** Cues for a whole engine result, in order, with the per-batch repeat cap applied. */
export function soundCuesForEvents(events: readonly GameEvent[]): SoundCue[] {
  const cues: SoundCue[] = [];
  const counts = new Map<SoundCue, number>();
  for (const event of events) {
    const cue = soundCueFor(event);
    if (cue === null) continue;
    const count = counts.get(cue) ?? 0;
    if (count >= MAX_CUE_REPEATS_PER_BATCH) continue;
    counts.set(cue, count + 1);
    cues.push(cue);
  }
  return cues;
}
