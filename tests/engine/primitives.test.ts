import { describe, expect, it } from 'vitest';
import {
  CARD_TYPE,
  GAME_CONSTANTS,
  STATUS_KIND,
  applyDamage,
  calculateMatchEffects,
  createBoardTemplate,
  createSeededRandom,
  fisherYatesShuffle,
  heal,
  instantiateBoard,
  grantShield,
  isBlackFlash,
  matchKeyOf,
  maxHpOf,
  randomInt,
  shieldCapOf,
  verifyPair,
  type Card,
  type PlayerState,
  type StatusEffect,
} from '../../src/engine/index.js';

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 'p',
    characterId: 'satoru_gojo',
    maxHp: 100,
    hp: 100,
    shield: 0,
    cursedEnergy: 0,
    activeEffects: [],
    comboStreak: 0,
    pairsMatched: 0,
    activeDomain: null,
    activeSimpleDomain: null,
    stunUntil: 0,
    executioner: null,
    pachinko: { spinsLeft: 0, pity: 0, resetOnExpiry: false },
    guaranteedBlackFlash: false,
    ...overrides,
  };
}

function effect(kind: StatusEffect['kind'], value: number, turnsRemaining: number | null = null): StatusEffect {
  return { kind, sourceId: 'test', turnsRemaining, value };
}

describe('random sources', () => {
  it('seeded generator is deterministic per seed', () => {
    const a = createSeededRandom(7);
    const b = createSeededRandom(7);
    const c = createSeededRandom(8);
    const seqA = Array.from({ length: 10 }, () => a.nextUint32());
    const seqB = Array.from({ length: 10 }, () => b.nextUint32());
    const seqC = Array.from({ length: 10 }, () => c.nextUint32());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('randomInt stays in range and rejects invalid bounds', () => {
    const rng = createSeededRandom(1);
    for (let i = 0; i < 1000; i++) {
      const v = randomInt(rng, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(randomInt(createSeededRandom(2), 1)).toBe(0);
    expect(() => randomInt(rng, 0)).toThrow(RangeError);
    expect(() => randomInt(rng, 1.5)).toThrow(RangeError);
  });

  it('Fisher-Yates returns a permutation without mutating its input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = fisherYatesShuffle(input, createSeededRandom(99));
    expect([...out].sort((x, y) => x - y)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('Fisher-Yates is close to uniform over all permutations of 3 items', () => {
    const rng = createSeededRandom(12345);
    const counts = new Map<string, number>();
    const trials = 60000;
    for (let i = 0; i < trials; i++) {
      const key = fisherYatesShuffle(['a', 'b', 'c'], rng).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    const expected = trials / 6;
    for (const count of counts.values()) {
      expect(Math.abs(count - expected)).toBeLessThan(expected * 0.05);
    }
  });
});

describe('board templates', () => {
  it('deals every non-trap pair exactly twice and traps exactly once', () => {
    const template = createBoardTemplate({ size: 36, trapCount: 2, synergyPairCount: 2 }, createSeededRandom(5));
    expect(template).toHaveLength(36);

    const counts = new Map<string, number>();
    for (const spec of template) counts.set(spec.pairId, (counts.get(spec.pairId) ?? 0) + 1);
    for (const spec of template) {
      const expected = spec.type === CARD_TYPE.TRAP ? 1 : 2;
      expect(counts.get(spec.pairId)).toBe(expected);
    }
    expect(template.filter((s) => s.type === CARD_TYPE.TRAP)).toHaveLength(2);
    expect(template.filter((s) => s.type === CARD_TYPE.SYNERGY)).toHaveLength(4);
  });

  it('rejects layouts with an odd number of playable cards or invalid options', () => {
    const rng = createSeededRandom(1);
    expect(() => createBoardTemplate({ size: 16, trapCount: 1, synergyPairCount: 0 }, rng)).toThrow(RangeError);
    expect(() => createBoardTemplate({ size: 10 as 16, trapCount: 0, synergyPairCount: 0 }, rng)).toThrow(RangeError);
    expect(() => createBoardTemplate({ size: 16, trapCount: 0, synergyPairCount: 9 }, rng)).toThrow(RangeError);
  });

  it('instantiates hidden cards with unique ids', () => {
    const template = createBoardTemplate({ size: 16, trapCount: 0, synergyPairCount: 0 }, createSeededRandom(3));
    const cards = instantiateBoard(template, 'SHARED');
    expect(new Set(cards.map((c) => c.id)).size).toBe(16);
    expect(cards.every((c) => c.state === 'HIDDEN' && c.revealedBy === null)).toBe(true);
  });
});

describe('matcher', () => {
  const card = (
    id: string,
    pairId: string,
    characterId: Card['characterId'] = 'mahito',
    state: Card['state'] = 'REVEALED',
    type: Card['type'] = CARD_TYPE.STANDARD,
  ): Card => ({
    id,
    pairId,
    characterId,
    type,
    trapId: null,
    state,
    revealedBy: 'p1',
    effectModifiers: [],
  });

  it('accepts two distinct revealed cards sharing a pairId', () => {
    expect(verifyPair(card('a', 'x'), card('b', 'x'))).toEqual({
      isMatch: true,
      pairId: 'x',
      cardType: CARD_TYPE.STANDARD,
    });
  });

  it('rejects same card, hidden card and different fighters', () => {
    expect(verifyPair(card('a', 'x'), card('a', 'x'))).toEqual({ isMatch: false, reason: 'SAME_CARD' });
    expect(verifyPair(card('a', 'x'), card('b', 'x', 'mahito', 'HIDDEN'))).toEqual({
      isMatch: false,
      reason: 'NOT_REVEALED',
    });
    expect(verifyPair(card('a', 'x', 'mahito'), card('b', 'y', 'sukuna'))).toEqual({
      isMatch: false,
      reason: 'PAIR_MISMATCH',
    });
  });

  it('matches two standard cards showing the same fighter, whatever pair dealt them', () => {
    // The 6x6 bug: a 36 card grid needs 18 pairs out of a 10 fighter roster, so the deal
    // repeats characters. Two Nobara cards from different pair instances are a match.
    const dealt = verifyPair(card('a', 'std:nobara_kugisaki:0', 'nobara_kugisaki'), card('b', 'std:nobara_kugisaki:1', 'nobara_kugisaki'));
    expect(dealt.isMatch).toBe(true);
    expect(matchKeyOf({ type: CARD_TYPE.STANDARD, pairId: 'std:nobara_kugisaki:1', characterId: 'nobara_kugisaki' })).toBe(
      'std:nobara_kugisaki',
    );
  });

  it('never matches a synergy card with the standard pair of the same fighter', () => {
    // Six Eyes deals a synergy Satoru Gojo next to the plain Gojo pair: the synergy card
    // may only complete its own pact, even with an identical face.
    const cross = verifyPair(
      card('a', 'syn:six_eyes_vision', 'satoru_gojo', 'REVEALED', CARD_TYPE.SYNERGY),
      card('b', 'std:satoru_gojo:0', 'satoru_gojo'),
    );
    expect(cross).toEqual({ isMatch: false, reason: 'PAIR_MISMATCH' });

    const pact = verifyPair(
      card('a', 'syn:six_eyes_vision', 'satoru_gojo', 'REVEALED', CARD_TYPE.SYNERGY),
      card('b', 'syn:six_eyes_vision', 'six_eyes', 'REVEALED', CARD_TYPE.SYNERGY),
    );
    expect(pact.isMatch).toBe(true);
  });

  it('keeps every trap on its own key, so two traps never pair', () => {
    // Two copies of the same trap are still two separate cards: each is dealt alone and
    // resolves on the flip that reveals it, never as a pair.
    const first: Card = { ...card('a', 'trap:sukuna_finger:0', 'sukuna', 'REVEALED', CARD_TYPE.TRAP), trapId: 'sukuna_finger' };
    const second: Card = { ...card('b', 'trap:sukuna_finger:1', 'sukuna', 'REVEALED', CARD_TYPE.TRAP), trapId: 'sukuna_finger' };
    expect(verifyPair(first, second)).toEqual({ isMatch: false, reason: 'PAIR_MISMATCH' });
  });
});

describe('combat math', () => {
  it('Black Flash triggers on the second match of a turn streak', () => {
    expect(isBlackFlash(0)).toBe(false);
    expect(isBlackFlash(1)).toBe(true);
    expect(isBlackFlash(2)).toBe(true);
  });

  it('computes synergy and Black Flash effects', () => {
    const synergy = calculateMatchEffects({
      cardType: CARD_TYPE.SYNERGY,
      blackFlash: false,
      attackerStatuses: [],
      domainActive: false,
    });
    expect(synergy.damage).toBe(Math.round(GAME_CONSTANTS.BASE_MATCH_DAMAGE * GAME_CONSTANTS.SYNERGY_DAMAGE_MULTIPLIER));
    expect(synergy.critical).toBe(false);

    const flash = calculateMatchEffects({
      cardType: CARD_TYPE.STANDARD,
      blackFlash: true,
      attackerStatuses: [],
      domainActive: false,
    });
    expect(flash.damage).toBe(Math.round(GAME_CONSTANTS.BASE_MATCH_DAMAGE * GAME_CONSTANTS.BLACK_FLASH_CRIT_MULTIPLIER));
    expect(flash.healing).toBe(GAME_CONSTANTS.BLACK_FLASH_HEAL);
    expect(flash.healing).toBe(10);
    expect(flash.shieldGain).toBe(GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN);
    expect(flash.shieldGain).toBe(20);
    expect(flash.ceGain).toBe(GAME_CONSTANTS.MATCH_CE_GAIN + GAME_CONSTANTS.BLACK_FLASH_CE_GAIN);
    expect(flash.critical).toBe(true);
    // An ordinary match grants no barrier of its own.
    expect(synergy.shieldGain).toBe(0);
  });

  it('a critical strike status and domain boost multiply', () => {
    const effects = calculateMatchEffects({
      cardType: CARD_TYPE.STANDARD,
      blackFlash: false,
      attackerStatuses: [effect(STATUS_KIND.CRITICAL_STRIKE, GAME_CONSTANTS.CRITICAL_STRIKE_MULTIPLIER)],
      domainActive: true,
    });
    const expected = Math.round(
      GAME_CONSTANTS.BASE_MATCH_DAMAGE * GAME_CONSTANTS.CRITICAL_STRIKE_MULTIPLIER * GAME_CONSTANTS.DOMAIN_BOOST,
    );
    expect(effects.damage).toBe(expected);
    expect(effects.critical).toBe(true);
  });

  it('black flash takes precedence over a critical strike (no stacking)', () => {
    const effects = calculateMatchEffects({
      cardType: CARD_TYPE.STANDARD,
      blackFlash: true,
      attackerStatuses: [effect(STATUS_KIND.CRITICAL_STRIKE, GAME_CONSTANTS.CRITICAL_STRIKE_MULTIPLIER)],
      domainActive: false,
    });
    expect(effects.damage).toBe(Math.round(GAME_CONSTANTS.BASE_MATCH_DAMAGE * GAME_CONSTANTS.BLACK_FLASH_CRIT_MULTIPLIER));
  });

  it('reports piercing attacks so matches can bypass shields', () => {
    const effects = calculateMatchEffects({
      cardType: CARD_TYPE.STANDARD,
      blackFlash: false,
      attackerStatuses: [effect(STATUS_KIND.PIERCING_ATTACKS, 1)],
      domainActive: false,
    });
    expect(effects.piercing).toBe(true);
    expect(effects.damage).toBe(GAME_CONSTANTS.BASE_MATCH_DAMAGE);
  });

  it('barrier points absorb damage before HP', () => {
    const target = makePlayer({ shield: 5 });
    const result = applyDamage(target, 10);
    // The split is published under both spellings: the short one the events carry and
    // the explicit one callers read by name.
    expect(result).toEqual({ dealt: 5, absorbed: 5, damageToHp: 5, damageToShield: 5 });
    expect(target.hp).toBe(95);
    expect(target.shield).toBe(0);
  });

  it('barrier grants stack up to half of max HP and never past it', () => {
    const target = makePlayer({ hp: 100 });
    expect(grantShield(target, 20)).toBe(20);
    expect(grantShield(target, 20)).toBe(20);
    // Ceiling is 50 for a 100 max HP pool.
    expect(grantShield(target, 40)).toBe(10);
    expect(target.shield).toBe(50);
    expect(shieldCapOf(target)).toBe(50);
  });

  it('a lowered maximum HP lowers the barrier ceiling', () => {
    const target = makePlayer({ shield: 50, activeEffects: [effect(STATUS_KIND.MAX_HP_REDUCTION, 60)] });
    expect(maxHpOf(target)).toBe(40);
    expect(shieldCapOf(target)).toBe(20);
  });

  it('immortal targets keep at least 1 HP', () => {
    const target = makePlayer({ hp: 3, activeEffects: [effect(STATUS_KIND.IMMORTAL, 1)] });
    applyDamage(target, 50);
    expect(target.hp).toBe(1);
  });

  it('an absolute shield negates all incoming damage', () => {
    const target = makePlayer({ activeEffects: [effect(STATUS_KIND.ABSOLUTE_SHIELD, 1)] });
    expect(applyDamage(target, 40)).toEqual({ dealt: 0, absorbed: 40, damageToHp: 0, damageToShield: 40 });
    expect(target.hp).toBe(100);
  });

  it('piercing damage ignores the barrier entirely', () => {
    const target = makePlayer({ shield: 30 });
    expect(applyDamage(target, 12, { piercing: true })).toEqual({
      dealt: 12,
      absorbed: 0,
      damageToHp: 12,
      damageToShield: 0,
    });
    expect(target.hp).toBe(88);
    expect(target.shield).toBe(30);
  });

  it('maximum HP reductions cap healing and the HP total', () => {
    const target = makePlayer({ hp: 40, activeEffects: [effect(STATUS_KIND.MAX_HP_REDUCTION, 25)] });
    expect(maxHpOf(target)).toBe(75);
    expect(heal(target, 60, maxHpOf(target))).toBe(35);
    expect(target.hp).toBe(75);
  });
});
