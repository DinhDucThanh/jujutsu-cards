/**
 * The split-screen finisher shown when a match ends. The engine keeps no per-fighter
 * statistics, so this tally is built from the same event stream the rest of the UI reads.
 */

import {
  CHARACTERS,
  DAMAGE_CAUSE,
  type CharacterId,
  type DamageCause,
  type GameEvent,
  type MatchResult,
  type PlayerId,
} from '../engine/index.js';
import { SUBJECT_GLYPH } from './card-face.js';

/** How the final blow landed, as the banner words it. */
export type FinishKind = 'BLACK_FLASH' | 'EXECUTIONER' | 'PIERCING' | 'KNOCKOUT';

export const FINISH_BADGE: Readonly<Record<FinishKind, string>> = {
  BLACK_FLASH: '⚡ BLACK FLASH EXECUTION',
  EXECUTIONER: '⚖️ DEATH PENALTY EXECUTED',
  PIERCING: '🗡️ BARRIER SHATTERED',
  KNOCKOUT: '💥 KNOCKOUT FINISH',
};

export interface DuelStats {
  readonly damageStandard: number;
  readonly damagePiercing: number;
  readonly blackFlashes: number;
  readonly barrierAbsorbed: number;
  readonly boardsCleared: number;
}

type MutableStats = { -readonly [K in keyof DuelStats]: number };

interface LastHit {
  readonly sourceId: PlayerId;
  readonly piercing: boolean;
  readonly cause: DamageCause;
  readonly blackFlash: boolean;
}

const SEATS: readonly PlayerId[] = ['p1', 'p2'];

function emptyStats(): MutableStats {
  return { damageStandard: 0, damagePiercing: 0, blackFlashes: 0, barrierAbsorbed: 0, boardsCleared: 0 };
}

/** Counts what each fighter did over one match. Feed it every event, in order. */
export class DuelTally {
  private cast = new Map<PlayerId, CharacterId>();
  private stats = new Map<PlayerId, MutableStats>();
  /** Players whose next damage is the one a Black Flash just armed. */
  private readonly flashArmed = new Set<PlayerId>();
  private readonly executioners = new Set<PlayerId>();
  private lastHit: LastHit | null = null;

  /** Starts a fresh duel between these fighters. */
  reset(cast: ReadonlyMap<PlayerId, CharacterId>): void {
    this.cast = new Map(cast);
    this.stats = new Map([...cast.keys()].map((id): [PlayerId, MutableStats] => [id, emptyStats()]));
    this.flashArmed.clear();
    this.executioners.clear();
    this.lastHit = null;
  }

  characterOf(id: PlayerId): CharacterId | undefined {
    return this.cast.get(id);
  }

  /**
   * Changes which fighter one seat is shown as, keeping its tally. Used by the training
   * dummy, which can switch fighters mid-match.
   */
  recast(id: PlayerId, characterId: CharacterId): void {
    this.cast.set(id, characterId);
  }

  statsOf(id: PlayerId): DuelStats {
    return { ...this.tallyOf(id) };
  }

  record(event: GameEvent): void {
    switch (event.type) {
      case 'BLACK_FLASH':
        this.tallyOf(event.playerId).blackFlashes += 1;
        this.flashArmed.add(event.playerId);
        return;
      case 'DAMAGE_DEALT': {
        const attacker = this.tallyOf(event.sourceId);
        if (event.piercing) attacker.damagePiercing += event.dealt;
        else attacker.damageStandard += event.dealt;
        this.tallyOf(event.targetId).barrierAbsorbed += event.absorbed;
        const blackFlash = this.flashArmed.delete(event.sourceId);
        this.lastHit = { sourceId: event.sourceId, piercing: event.piercing, cause: event.cause, blackFlash };
        return;
      }
      case 'AWAKENING_OPENED':
        this.tallyOf(event.playerId).boardsCleared += 1;
        return;
      case 'EXECUTIONER_GRANTED':
        this.executioners.add(event.playerId);
        return;
      case 'EXECUTIONER_EXPIRED':
        this.executioners.delete(event.playerId);
        return;
      default:
        return;
    }
  }

  /** The winner's final blow decides the banner. A loss by any other route reads as a knockout. */
  finishKind(winnerId: PlayerId | null): FinishKind {
    const hit = this.lastHit;
    if (winnerId === null || hit === null || hit.sourceId !== winnerId) return 'KNOCKOUT';
    if (hit.blackFlash) return 'BLACK_FLASH';
    if (hit.cause === DAMAGE_CAUSE.MATCH && this.executioners.has(winnerId)) return 'EXECUTIONER';
    if (hit.piercing) return 'PIERCING';
    return 'KNOCKOUT';
  }

  private tallyOf(id: PlayerId): MutableStats {
    let tally = this.stats.get(id);
    if (!tally) {
      tally = emptyStats();
      this.stats.set(id, tally);
    }
    return tally;
  }
}

function requireElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`match finisher is missing ${selector}`);
  return element;
}

function setText(root: ParentNode, selector: string, text: string): void {
  requireElement(root, selector).textContent = text;
}

/** Fills the finisher markup. Every value goes in as text, never as HTML. */
export function renderMatchFinisher(root: HTMLElement, result: MatchResult, tally: DuelTally): void {
  setText(root, '[data-finish-badge]', FINISH_BADGE[tally.finishKind(result.winnerId)]);

  for (const seat of SEATS) {
    const side = requireElement(root, `[data-side="${seat}"]`);
    const characterId = tally.characterOf(seat);
    const isDraw = result.winnerId === null;
    const isWinner = result.winnerId === seat;
    const verdict = isDraw ? 'DRAW' : isWinner ? 'VICTORY' : 'DEFEATED';
    const name = characterId ? CHARACTERS[characterId].name : 'Unknown fighter';

    side.classList.toggle('is-winner', isWinner);
    side.classList.toggle('is-loser', !isDraw && !isWinner);
    setText(side, '[data-finish-title]', `${name} · ${verdict}`);
    setText(side, '[data-finish-portrait]', characterId ? (SUBJECT_GLYPH[characterId] ?? '呪') : '?');
    setText(side, '[data-finish-stamp]', isDraw ? '分' : isWinner ? '祓' : '敗北');

    const stats = tally.statsOf(seat);
    for (const key of Object.keys(stats) as (keyof DuelStats)[]) {
      setText(side, `[data-stat="${key}"]`, String(stats[key]));
    }
  }
}
