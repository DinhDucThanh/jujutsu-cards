import { describe, expect, it } from 'vitest';
import { RematchTally } from '../../src/web/match-result-modal.js';

describe('RematchTally', () => {
  it('starts empty and words the result button only after a vote', () => {
    const tally = new RematchTally();
    expect(tally.count).toBe(0);
    expect(tally.ready).toBe(false);
    expect(tally.statusText('p1')).toBe('');
    expect(tally.votes).toEqual({ p1: false, p2: false });
  });

  it('shows the waiting line to the seat that has voted', () => {
    const tally = new RematchTally();
    expect(tally.vote('p1')).toBe(1);
    expect(tally.has('p1')).toBe(true);
    expect(tally.statusText('p1')).toBe('Waiting for opponent... (1/2)');
    // The seat that has not voted sees no waiting line of its own.
    expect(tally.statusText('p2')).toBe('');
  });

  it('is ready only when both seats have voted', () => {
    const tally = new RematchTally();
    tally.vote('p1');
    expect(tally.ready).toBe(false);
    expect(tally.vote('p2')).toBe(2);
    expect(tally.ready).toBe(true);
    expect(tally.statusText('p2')).toBe('Rematch ready — starting…');
  });

  it('ignores duplicate votes and bad seat ids', () => {
    const tally = new RematchTally();
    tally.vote('p1');
    expect(tally.vote('p1')).toBe(1);
    expect(tally.vote('spectator')).toBe(1);
    expect(tally.has('spectator')).toBe(false);
  });

  it('resets both votes for a fresh result screen', () => {
    const tally = new RematchTally();
    tally.vote('p1');
    tally.vote('p2');
    tally.reset();
    expect(tally.count).toBe(0);
    expect(tally.ready).toBe(false);
    expect(tally.statusText('p1')).toBe('');
  });
});
