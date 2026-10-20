import { describe, expect, it } from 'vitest';
import {
  BOARD_CLEAR_REWARD,
  BOARD_MODE,
  CHARACTER_IDS,
  GameEngine,
  RANDOM_CHOICE,
  SETUP_BOARD_LAYOUT_CHOICES,
  SETUP_HP_CHOICES,
  SETUP_SYNERGY_CHOICES,
  SETUP_TRAP_CHOICES,
  createSeededRandom,
  resolveMatchConfig,
  rollSetup,
  type MatchSetup,
} from '../../src/engine/index.js';

const PLAYER_IDS = ['p1', 'p2'] as const;

function allRandom(overrides: Partial<MatchSetup> = {}): MatchSetup {
  return {
    opponent: RANDOM_CHOICE,
    boardLayout: RANDOM_CHOICE,
    boardClearReward: RANDOM_CHOICE,
    gridSize: RANDOM_CHOICE,
    startingHp: RANDOM_CHOICE,
    p1Character: RANDOM_CHOICE,
    p2Character: RANDOM_CHOICE,
    cursedTraps: RANDOM_CHOICE,
    loreSynergies: RANDOM_CHOICE,
    ...overrides,
  };
}

describe('resolveMatchConfig', () => {
  it('rolls only the random seat: P1 stays Gojo while P2 becomes a valid sorcerer', () => {
    const setup = allRandom({
      opponent: 'PVP',
      boardLayout: BOARD_MODE.DUAL,
      boardClearReward: BOARD_CLEAR_REWARD.RANDOM_AUTO,
      gridSize: 16,
      startingHp: 200,
      p1Character: 'satoru_gojo',
      p2Character: RANDOM_CHOICE,
      cursedTraps: 2,
      loreSynergies: 1,
    });
    const { config, setup: resolved } = resolveMatchConfig(setup, createSeededRandom(7), {
      playerIds: PLAYER_IDS,
    });

    expect(resolved.p1Character).toBe('satoru_gojo');
    expect(config.players[0]?.characterId).toBe('satoru_gojo');
    expect(CHARACTER_IDS).toContain(config.players[1]?.characterId);
    // A random opponent is rolled to a different fighter when there is a choice.
    expect(config.players[1]?.characterId).not.toBe('satoru_gojo');
    // Every concrete field is untouched.
    expect(config.boardMode).toBe(BOARD_MODE.DUAL);
    expect(config.boardSize).toBe(16);
    expect(config.startingHp).toBe(200);
    expect(config.trapCount).toBe(2);
    expect(config.synergyPairCount).toBe(1);
    expect(config.boardClearReward).toBe(BOARD_CLEAR_REWARD.RANDOM_AUTO);
    expect(resolved.opponent).toBe('PVP');
  });

  it('rolls every random field into a value the engine accepts', () => {
    for (let seed = 0; seed < 40; seed++) {
      const rng = createSeededRandom(seed);
      const { config } = resolveMatchConfig(allRandom(), rng, { playerIds: PLAYER_IDS });

      expect(SETUP_BOARD_LAYOUT_CHOICES).toContain(config.boardMode);
      expect([16, 36]).toContain(config.boardSize);
      expect(SETUP_HP_CHOICES).toContain(config.startingHp);
      expect(SETUP_TRAP_CHOICES).toContain(config.trapCount);
      expect(SETUP_SYNERGY_CHOICES).toContain(config.synergyPairCount);
      expect([BOARD_CLEAR_REWARD.MANUAL_CHOICE, BOARD_CLEAR_REWARD.RANDOM_AUTO]).toContain(
        config.boardClearReward,
      );
      expect(CHARACTER_IDS).toContain(config.players[0]?.characterId);
      expect(CHARACTER_IDS).toContain(config.players[1]?.characterId);
      // Two random seats never land on the same sorcerer.
      expect(config.players[0]?.characterId).not.toBe(config.players[1]?.characterId);
      // No sentinel survives into the engine's config.
      expect(Object.values(config)).not.toContain(RANDOM_CHOICE);

      const engine = new GameEngine(config, createSeededRandom(seed + 1));
      expect(engine.start(0).ok, `seed ${seed}`).toBe(true);
      expect(engine.getPublicView().result).toBeNull();
    }
  });

  it('never rolls a random opponent into a room or the training ground', () => {
    for (let seed = 0; seed < 25; seed++) {
      const { setup } = resolveMatchConfig(allRandom(), createSeededRandom(seed), {
        playerIds: PLAYER_IDS,
      });
      expect(setup.opponent === 'PVE' || setup.opponent === 'PVP').toBe(true);
    }
  });

  it('marks a training ground as sandbox and honours the chosen board layout', () => {
    const dual = resolveMatchConfig(
      allRandom({ opponent: 'SANDBOX', boardLayout: BOARD_MODE.DUAL }),
      createSeededRandom(3),
      { playerIds: PLAYER_IDS },
    );
    expect(dual.config.sandbox).toBe(true);
    expect(dual.config.boardMode).toBe(BOARD_MODE.DUAL);
    expect(dual.config.players[1]?.id).toBe('p2');

    const shared = resolveMatchConfig(
      allRandom({ opponent: 'SANDBOX', boardLayout: BOARD_MODE.SHARED }),
      createSeededRandom(3),
      { playerIds: PLAYER_IDS },
    );
    expect(shared.config.boardMode).toBe(BOARD_MODE.SHARED);
  });

  it('uses a provided seat 2 build instead of rolling (AI grade, co-op guest)', () => {
    const { config } = resolveMatchConfig(
      allRandom({ opponent: 'PVE', p1Character: 'satoru_gojo', p2Character: RANDOM_CHOICE }),
      createSeededRandom(99),
      { playerIds: PLAYER_IDS, p2Character: 'sukuna', opponent: 'PVE' },
    );
    expect(config.players[0]?.characterId).toBe('satoru_gojo');
    expect(config.players[1]?.characterId).toBe('sukuna');
  });

  it('is reproducible from a seeded source', () => {
    const first = resolveMatchConfig(allRandom(), createSeededRandom(42), { playerIds: PLAYER_IDS });
    const second = resolveMatchConfig(allRandom(), createSeededRandom(42), { playerIds: PLAYER_IDS });
    expect(second.config).toEqual(first.config);
  });
});

describe('rollSetup', () => {
  it('turns every field concrete for the modal, so the player can see the roll', () => {
    const rolled = rollSetup(allRandom(), createSeededRandom(11));
    for (const value of Object.values(rolled)) {
      expect(value).not.toBe(RANDOM_CHOICE);
    }
    expect(SETUP_HP_CHOICES).toContain(rolled.startingHp);
    expect(SETUP_TRAP_CHOICES).toContain(rolled.cursedTraps);
    expect(SETUP_SYNERGY_CHOICES).toContain(rolled.loreSynergies);
    expect(rolled.p1Character).not.toBe(rolled.p2Character);
  });

  it('locks an online room and player 2 for a co-op host', () => {
    const rolled = rollSetup(
      allRandom({ opponent: 'ONLINE', p2Character: RANDOM_CHOICE }),
      createSeededRandom(5),
      { lockOpponent: true, lockP2Character: true },
    );
    expect(rolled.opponent).toBe('ONLINE');
    expect(rolled.p2Character).toBe(RANDOM_CHOICE);
  });

  it('can switch a local setup to the other opponent mode', () => {
    const opponents = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const rolled = rollSetup(
        allRandom({ opponent: 'PVE' }),
        createSeededRandom(seed),
        { lockOpponent: true },
      );
      opponents.add(rolled.opponent);
    }
    expect([...opponents].sort()).toEqual(['PVE', 'PVP']);
  });
});
