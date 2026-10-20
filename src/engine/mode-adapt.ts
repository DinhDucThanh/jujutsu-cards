import { GAME_CONSTANTS } from './constants.js';
import { BOARD_MODE, STATUS_KIND, isTurnBasedMode, type BoardMode, type StatusSpec } from './types.js';

/**
 * One status after translation into the mode that is being played.
 *
 * A turn-based effect that has no meaning without turns is *converted* rather than
 * silently dropped: the victim loses the same amount of actionable time as a real-time
 * player would. Effects that are mode-agnostic pass through untouched.
 */
export interface AdaptedStatus {
  /** The status to store, or null when the effect was fully converted. */
  readonly spec: StatusSpec | null;
  /** Real-time lock-out the conversion produced, in engine milliseconds. */
  readonly stunMs: number;
  /** Set when the effect was converted, for the log line. */
  readonly note: string | null;
}

function passthrough(spec: StatusSpec): AdaptedStatus {
  return { spec, stunMs: 0, note: null };
}

/**
 * Translates an ability's status spec for the mode in play.
 *
 * Turn-based modes keep the spec as written. In simultaneous real-time play (DUAL)
 * turn-skipping and turn-timing effects have nothing to act on, so:
 *
 *  - `SKIP_TURNS n` becomes an `n * GAME_CONSTANTS.SKIP_TURN_MS` lock-out, i.e. exactly
 *    the amount of playing time a skipped turn would have cost the victim.
 *  - `SHORT_TIMER` is dropped, because it only shortens a turn budget that the
 *    real-time mode does not use (the lock-out above already covers Unlimited Void).
 *
 * Everything else (barriers, crits, burns, recoil, extra flips, domain nullification)
 * works the same in every mode and is returned unchanged.
 */
export function adaptStatusForMode(spec: StatusSpec, mode: BoardMode): AdaptedStatus {
  if (isTurnBasedMode(mode)) return passthrough(spec);
  if (mode !== BOARD_MODE.DUAL) return passthrough(spec);

  switch (spec.status) {
    case STATUS_KIND.SKIP_TURNS: {
      const stunMs = Math.max(0, spec.value) * GAME_CONSTANTS.SKIP_TURN_MS;
      return stunMs === 0
        ? { spec: null, stunMs: 0, note: null }
        : { spec: null, stunMs, note: `${stunMs / 1000}s lock-out (no turn order)` };
    }
    case STATUS_KIND.SHORT_TIMER:
      return { spec: null, stunMs: 0, note: 'no turn timer in simultaneous play' };
    default:
      return passthrough(spec);
  }
}

/** True when the mode ignores this status kind outright. */
export function isStatusModeIndependent(kind: StatusSpec['status'], mode: BoardMode): boolean {
  return adaptStatusForMode({ status: kind, value: 1, turns: null }, mode).spec !== null;
}
