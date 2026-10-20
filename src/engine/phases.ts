import { GAME_CONSTANTS } from './constants.js';
import { TURN_PHASE, type TurnPhase } from './types.js';

/**
 * Escalating turn budget, in engine milliseconds.
 *
 *  - turns 1-10: 25s, both players are still reading the board
 *  - turns 11-20: 20s, the match has found its rhythm
 *  - turn 21+: 15s, late-game pressure so resolution is forced
 */
export function calculateTurnDuration(turnNumber: number): number {
  if (turnNumber >= GAME_CONSTANTS.TURN_TIME_LATE_FROM_TURN) return GAME_CONSTANTS.TURN_TIME_LATE_MS;
  if (turnNumber >= GAME_CONSTANTS.TURN_TIME_MID_FROM_TURN) return GAME_CONSTANTS.TURN_TIME_MID_MS;
  return GAME_CONSTANTS.TURN_TIME_EARLY_MS;
}

const P = TURN_PHASE;

/** Legal turn transitions. MATCH_OVER is terminal; IN_PROGRESS covers concurrent DUAL play. */
const TRANSITIONS: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  MATCH_START: [P.WAITING_FOR_P1, P.IN_PROGRESS],
  IN_PROGRESS: [P.MATCH_OVER],
  WAITING_FOR_P1: [P.P1_FLIPPED_FIRST, P.WAITING_FOR_P2, P.MATCH_OVER],
  P1_FLIPPED_FIRST: [P.P1_FLIPPED_SECOND, P.WAITING_FOR_P2, P.MATCH_OVER],
  P1_FLIPPED_SECOND: [P.EVALUATING, P.MATCH_OVER],
  WAITING_FOR_P2: [P.P2_FLIPPED_FIRST, P.WAITING_FOR_P1, P.MATCH_OVER],
  P2_FLIPPED_FIRST: [P.P2_FLIPPED_SECOND, P.WAITING_FOR_P1, P.MATCH_OVER],
  P2_FLIPPED_SECOND: [P.EVALUATING, P.MATCH_OVER],
  EVALUATING: [P.WAITING_FOR_P1, P.WAITING_FOR_P2, P.MATCH_OVER],
  MATCH_OVER: [],
};

export function canTransition(from: TurnPhase, to: TurnPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws on an illegal transition: that indicates an engine bug, not bad client input. */
export function assertTransition(from: TurnPhase, to: TurnPhase): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal turn transition ${from} -> ${to}`);
  }
}
