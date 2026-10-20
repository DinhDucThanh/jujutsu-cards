import { CHARACTERS } from './catalog.js';
import { statusValue } from './status.js';
import { STATUS_KIND, type CharacterId, type PlayerId, type PlayerState } from './types.js';

/**
 * The next turns, in the order they will actually be played.
 *
 * The projection mirrors `GameEngine.passTurn` exactly: turn ownership alternates, and
 * every turn a seat holds a `SKIP_TURNS` charge (Gojo's Unlimited Void) is consumed by
 * that skip — the seat does not advance, so the skipped player's opponent keeps the turn
 * and the queue shows it as an extra turn for them.
 *
 * It is deliberately a pure function of the live player states: nothing here mutates the
 * engine, so a HUD can re-project on every frame.
 */
export interface TurnQueueItem {
  readonly playerId: PlayerId;
  readonly characterId: CharacterId;
  readonly characterName: string;
  /** The seat the fighter plays from: 0 or 1. */
  readonly seat: 0 | 1;
  /** The seat that is playing right now. */
  readonly isCurrent: boolean;
  /** The turn comes straight after a skipped turn: the same fighter acts twice in a row. */
  readonly isExtraTurn: boolean;
  /** This turn is consumed by a turn-skip status (Unlimited Void). */
  readonly isSkipped: boolean;
  /** Charges left when the projection reached this entry, after its own skip. */
  readonly skipsRemaining: number;
}

/**
 * Projects `depth` upcoming turns from the live states, starting with the active seat.
 *
 * Returns an empty list when there is no turn order to project (simultaneous play).
 */
export function projectTurnQueue(
  players: readonly PlayerState[],
  activeSeat: 0 | 1,
  depth = 3,
): TurnQueueItem[] {
  const first = players[0];
  const second = players[1];
  if (!first || !second) return [];

  const queue: TurnQueueItem[] = [];
  // Skip charges are spent locally, exactly as `passTurn` spends the real ones.
  const skips = new Map<PlayerId, number>([
    [first.id, statusValue(first.activeEffects, STATUS_KIND.SKIP_TURNS)],
    [second.id, statusValue(second.activeEffects, STATUS_KIND.SKIP_TURNS)],
  ]);

  let seat: 0 | 1 = activeSeat;
  let previousWasSkipped = false;

  for (let step = 0; step < Math.max(1, depth); step++) {
    const player = seat === 0 ? first : second;
    const charge = skips.get(player.id) ?? 0;

    if (charge > 0) {
      // A skipped turn is still a turn boundary: the seat takes it, loses it to the
      // domain, and ownership flips back, exactly as `passTurn` does. The next entry is
      // therefore the other fighter again — which is why it reads as an extra turn.
      skips.set(player.id, charge - 1);
      queue.push(item(player, seat, { isCurrent: false, isExtraTurn: false, isSkipped: true, skipsRemaining: charge - 1 }));
      previousWasSkipped = true;
    } else {
      const isCurrent = step === 0;
      queue.push(
        item(player, seat, {
          isCurrent,
          isExtraTurn: previousWasSkipped,
          isSkipped: false,
          skipsRemaining: charge,
        }),
      );
      previousWasSkipped = false;
    }

    seat = seat === 0 ? 1 : 0;
  }

  return queue;
}

function item(
  player: PlayerState,
  seat: 0 | 1,
  flags: Pick<TurnQueueItem, 'isCurrent' | 'isExtraTurn' | 'isSkipped' | 'skipsRemaining'>,
): TurnQueueItem {
  return {
    playerId: player.id,
    characterId: player.characterId,
    characterName: CHARACTERS[player.characterId].name,
    seat,
    ...flags,
  };
}
