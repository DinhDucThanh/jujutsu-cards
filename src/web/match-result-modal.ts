import type { PlayerId } from '../engine/index.js';

/**
 * Rematch coordination for the result overlay.
 *
 * Both seats vote over the still-open peer connection. The host launches only when the
 * tally is full, so neither client can restart a duel while the other is still reading
 * the scoreboard. The state is deliberately tiny and DOM-free: the result overlay reads
 * it to word its button, and the network layer owns the packets that fill it.
 */

export interface RematchVotes {
  readonly p1: boolean;
  readonly p2: boolean;
}

const SEATS: readonly PlayerId[] = ['p1', 'p2'];

function isSeat(id: string): id is 'p1' | 'p2' {
  return id === 'p1' || id === 'p2';
}

export class RematchTally {
  private state: { p1: boolean; p2: boolean } = { p1: false, p2: false };

  /** Clears both votes for a fresh result screen. */
  reset(): void {
    this.state = { p1: false, p2: false };
  }

  get votes(): RematchVotes {
    return { ...this.state };
  }

  get count(): number {
    return SEATS.filter((seat) => this.state[seat as 'p1' | 'p2']).length;
  }

  get ready(): boolean {
    return this.state.p1 && this.state.p2;
  }

  has(seat: PlayerId): boolean {
    return isSeat(seat) ? this.state[seat] : false;
  }

  /** Records one seat's vote and returns the number of seats now ready. */
  vote(seat: PlayerId): number {
    if (isSeat(seat)) this.state[seat] = true;
    return this.count;
  }

  /** The line under the rematch button: empty until this seat has voted. */
  statusText(seat: PlayerId): string {
    if (!this.has(seat)) return '';
    if (this.ready) return 'Rematch ready — starting…';
    return `Waiting for opponent... (${this.count}/2)`;
  }
}
