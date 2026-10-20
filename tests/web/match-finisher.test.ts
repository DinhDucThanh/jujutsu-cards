import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAMAGE_CAUSE, type GameEvent } from '../../src/engine/index.js';
import { DuelTally } from '../../src/web/match-finisher.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

const CAST = new Map<'p1' | 'p2', 'yuji_itadori' | 'mahito'>([
  ['p1', 'yuji_itadori'],
  ['p2', 'mahito'],
]);

function hit(
  sourceId: 'p1' | 'p2',
  overrides: { dealt?: number; absorbed?: number; piercing?: boolean; cause?: string } = {},
): GameEvent {
  return {
    type: 'DAMAGE_DEALT',
    sourceId,
    targetId: sourceId === 'p1' ? 'p2' : 'p1',
    dealt: overrides.dealt ?? 10,
    absorbed: overrides.absorbed ?? 0,
    critical: false,
    piercing: overrides.piercing ?? false,
    cause: overrides.cause ?? DAMAGE_CAUSE.MATCH,
  } as unknown as GameEvent;
}

function freshTally(): DuelTally {
  const tally = new DuelTally();
  tally.reset(CAST);
  return tally;
}

describe('DuelTally', () => {
  it('starts both fighters at zero and reports their characters', () => {
    const tally = freshTally();
    expect(tally.characterOf('p1')).toBe('yuji_itadori');
    expect(tally.characterOf('p2')).toBe('mahito');
    expect(tally.statsOf('p1')).toEqual({
      damageStandard: 0,
      damagePiercing: 0,
      blackFlashes: 0,
      barrierAbsorbed: 0,
      boardsCleared: 0,
    });
  });

  it('splits damage into standard and piercing and credits absorbed barrier to the target', () => {
    const tally = freshTally();
    tally.record(hit('p1', { dealt: 7, absorbed: 0 }));
    tally.record(hit('p1', { dealt: 5, piercing: true }));
    tally.record(hit('p2', { dealt: 3, absorbed: 4 }));
    expect(tally.statsOf('p1')).toMatchObject({ damageStandard: 7, damagePiercing: 5, barrierAbsorbed: 4 });
    expect(tally.statsOf('p2')).toMatchObject({ damageStandard: 3, barrierAbsorbed: 0 });
  });

  it('counts black flashes and boards cleared per fighter', () => {
    const tally = freshTally();
    tally.record({ type: 'BLACK_FLASH', playerId: 'p2', streak: 1 });
    tally.record({ type: 'AWAKENING_OPENED', playerId: 'p1', boardId: 'a', decideBy: 0 } as GameEvent);
    expect(tally.statsOf('p2').blackFlashes).toBe(1);
    expect(tally.statsOf('p1').boardsCleared).toBe(1);
  });

  it('returns a copy of the stats, so callers cannot mutate the tally', () => {
    const tally = freshTally();
    const snapshot = tally.statsOf('p1') as { damageStandard: number };
    snapshot.damageStandard = 99;
    expect(tally.statsOf('p1').damageStandard).toBe(0);
  });

  it('is cleared by reset', () => {
    const tally = freshTally();
    tally.record(hit('p1', { dealt: 9 }));
    tally.reset(CAST);
    expect(tally.statsOf('p1').damageStandard).toBe(0);
  });

  it('swaps the fighter a seat is shown as and keeps its tally', () => {
    const tally = freshTally();
    tally.record(hit('p2', { dealt: 12 }));
    tally.recast('p2', 'sukuna');
    expect(tally.characterOf('p2')).toBe('sukuna');
    expect(tally.statsOf('p2').damageStandard).toBe(12);
  });

  describe('finishKind', () => {
    it('reads a plain knockout when there is no winner or no hit', () => {
      const tally = freshTally();
      expect(tally.finishKind(null)).toBe('KNOCKOUT');
      expect(tally.finishKind('p1')).toBe('KNOCKOUT');
    });

    it('reads a Black Flash when the winner landed the armed hit', () => {
      const tally = freshTally();
      tally.record({ type: 'BLACK_FLASH', playerId: 'p1', streak: 1 });
      tally.record(hit('p1'));
      expect(tally.finishKind('p1')).toBe('BLACK_FLASH');
    });

    it('reads an executioner finish only for a match hit by a fighter holding the sword', () => {
      const tally = freshTally();
      tally.record({ type: 'EXECUTIONER_GRANTED', playerId: 'p1', damage: 5, turns: 2 });
      tally.record(hit('p1'));
      expect(tally.finishKind('p1')).toBe('EXECUTIONER');
    });

    it('reads a piercing finish when the final hit went straight through', () => {
      const tally = freshTally();
      tally.record(hit('p1', { piercing: true }));
      expect(tally.finishKind('p1')).toBe('PIERCING');
    });

    it('reads a knockout when the loser landed the last hit', () => {
      const tally = freshTally();
      tally.record({ type: 'BLACK_FLASH', playerId: 'p2', streak: 1 });
      tally.record(hit('p2'));
      expect(tally.finishKind('p1')).toBe('KNOCKOUT');
    });

    it('forgets the sword once it has expired', () => {
      const tally = freshTally();
      tally.record({ type: 'EXECUTIONER_GRANTED', playerId: 'p1', damage: 5, turns: 1 });
      tally.record({ type: 'EXECUTIONER_EXPIRED', playerId: 'p1' });
      tally.record(hit('p1'));
      expect(tally.finishKind('p1')).toBe('KNOCKOUT');
    });
  });
});

describe('match finisher markup', () => {
  it('has a side column for each seat, with every slot the renderer fills', () => {
    expect(html).toMatch(/data-side="p1"/);
    expect(html).toMatch(/data-side="p2"/);
    expect(html).toMatch(/data-finish-badge/);
    for (const slot of ['data-finish-title', 'data-finish-portrait', 'data-finish-stamp']) {
      expect(html.split(slot).length - 1, slot).toBeGreaterThanOrEqual(2);
    }
    for (const stat of ['damageStandard', 'damagePiercing', 'blackFlashes', 'barrierAbsorbed', 'boardsCleared']) {
      expect(html.split(`data-stat="${stat}"`).length - 1, stat).toBe(2);
    }
  });
});
