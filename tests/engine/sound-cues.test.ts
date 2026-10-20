import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_TYPE,
  CHARACTER_IDS,
  SHARED_BOARD_ID,
  SOUND_CUE,
  TurnEngine,
  createSeededRandom,
  soundCueFor,
  soundCuesForEvents,
  type CardSpec,
  type CharacterId,
  type GameEvent,
  type MatchConfig,
  type SoundCue,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';

function pairCharacter(pair: number): CharacterId {
  return CHARACTER_IDS[pair % CHARACTER_IDS.length] as CharacterId;
}

/** Sixteen cards in eight pairs: positions (0,1), (2,3), ... match. */
function standardLayout(): CardSpec[] {
  return Array.from({ length: 16 }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: pairCharacter(Math.floor(i / 2)),
    trapId: null,
  }));
}

function trapLayout(): CardSpec[] {
  const traps: CardSpec[] = [
    { pairId: 'trap:sukuna_finger:0', type: CARD_TYPE.TRAP, characterId: 'sukuna', trapId: 'sukuna_finger' },
    { pairId: 'trap:sukuna_finger:1', type: CARD_TYPE.TRAP, characterId: 'sukuna', trapId: 'sukuna_finger' },
  ];
  const pairs: CardSpec[] = Array.from({ length: 14 }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: pairCharacter(Math.floor(i / 2)),
    trapId: null,
  }));
  return [...traps, ...pairs];
}

function makeEngine(layout: CardSpec[] = standardLayout(), trapCount = 0): TurnEngine {
  const config: MatchConfig = {
    matchId: 'sfx-test',
    boardMode: BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: 'satoru_gojo' },
      { id: P2, characterId: 'sukuna' },
    ],
    boardSize: 16,
    trapCount,
    synergyPairCount: 0,
  };
  const engine = new TurnEngine(config, createSeededRandom(7), layout);
  const started = engine.start(0);
  if (!started.ok) throw new Error(`start failed: ${started.code}`);
  return engine;
}

const cardId = (index: number): string => `${SHARED_BOARD_ID}:${index}`;

function record(engine: TurnEngine): SoundCue[] {
  const cues: SoundCue[] = [];
  engine.setSoundListener((cue) => cues.push(cue));
  return cues;
}

describe('soundCueFor', () => {
  const cases: ReadonlyArray<readonly [GameEvent, SoundCue | null]> = [
    [{ type: 'CARD_REVEALED', playerId: P1, cardId: 'c1' }, SOUND_CUE.CARD_FLIP],
    [{ type: 'PAIR_MATCHED', playerId: P1, pairId: 'p', cardIds: ['a', 'b'], cardType: CARD_TYPE.STANDARD }, SOUND_CUE.CARD_MATCH],
    [{ type: 'PAIR_MISMATCHED', playerId: P1, cardIds: ['a', 'b'] }, SOUND_CUE.MISMATCH],
    [{ type: 'BLACK_FLASH', playerId: P1, streak: 3 }, SOUND_CUE.BLACK_FLASH],
    [
      {
        type: 'DAMAGE_DEALT',
        sourceId: P1,
        targetId: P2,
        dealt: 12,
        absorbed: 0,
        critical: false,
        piercing: false,
        cause: 'MATCH',
      },
      null,
    ],
    [
      {
        type: 'DAMAGE_DEALT',
        sourceId: P1,
        targetId: P2,
        dealt: 0,
        absorbed: 30,
        critical: false,
        piercing: false,
        cause: 'MATCH',
      },
      SOUND_CUE.BARRIER_HIT,
    ],
    [{ type: 'TRAP_TRIGGERED', playerId: P1, cardId: 'c1', trapId: 'sukuna_finger', cursedEnergyGain: 16 }, SOUND_CUE.TRAP_DETONATE],
    [{ type: 'TURN_STARTED', playerId: P1, turnNumber: 2 }, null],
    [{ type: 'MATCH_STARTED', at: 0, boardMode: BOARD_MODE.SHARED }, null],
    [
      {
        type: 'SKILL_ACTIVATED',
        playerId: P1,
        characterId: 'satoru_gojo',
        skillId: 'infinity',
        name: 'Infinity',
        cost: 50,
        vfx: 'SKILL',
      },
      SOUND_CUE.SKILL_CAST,
    ],
    [
      {
        type: 'SKILL_ACTIVATED',
        playerId: P1,
        characterId: 'sukuna',
        skillId: 'cleave',
        name: 'Cleave',
        cost: 50,
        vfx: 'CLEAVE',
      },
      SOUND_CUE.CLEAVE,
    ],
    [{ type: 'SEAL_ABSORBED', playerId: P1, boardId: SHARED_BOARD_ID, cardId: 'c1', ceGain: 20 }, SOUND_CUE.SEAL_ABSORBED],
    [
      {
        type: 'ULTIMATE_ACTIVATED',
        playerId: P1,
        characterId: 'satoru_gojo',
        ultimateId: 'unlimited_void',
        name: 'Unlimited Void',
        cost: 100,
        ultimateType: 'DOMAIN',
        domainId: 'unlimited_void',
        turnsRemaining: 3,
        vfx: 'DOMAIN',
      },
      SOUND_CUE.DOMAIN_EXPANSION,
    ],
    [
      {
        type: 'ULTIMATE_ACTIVATED',
        playerId: P1,
        characterId: 'sukuna',
        ultimateId: 'malevolent_shrine',
        name: 'Malevolent Shrine',
        cost: 100,
        ultimateType: 'SIMPLE_DOMAIN_MAXIMUM',
        domainId: null,
        turnsRemaining: null,
        vfx: 'SIMPLE_DOMAIN',
      },
      SOUND_CUE.SKILL_CAST,
    ],
    [
      {
        type: 'CARD_EFFECT_TRIGGERED',
        playerId: P1,
        cardId: 'c1',
        modifier: 'LAVA',
        damage: 9,
        stunMs: 0,
        ceDrain: 0,
      },
      SOUND_CUE.EMBER_INSECT,
    ],
    [
      {
        type: 'CARD_EFFECT_TRIGGERED',
        playerId: P1,
        cardId: 'c1',
        modifier: 'NAILED',
        damage: 0,
        stunMs: 900,
        ceDrain: 0,
      },
      SOUND_CUE.CURSED_NAIL,
    ],
    [{ type: 'COURTROOM_OPENED', casterId: P1, victimId: P2, rounds: 4 }, SOUND_CUE.GAVEL_STRIKE],
    [{ type: 'COURTROOM_VERDICT', playerId: P2, slot: 0, verdict: 'GUILTY', mistakes: 1 }, SOUND_CUE.GAVEL_STRIKE],
    [{ type: 'COURTROOM_VERDICT', playerId: P2, slot: 0, verdict: 'NOT_GUILTY', mistakes: 0 }, SOUND_CUE.JUDGEMAN_BELL],
    [{ type: 'EXECUTIONER_GRANTED', playerId: P1, damage: 25, turns: 3 }, SOUND_CUE.EXECUTIONER_SLASH],
    [{ type: 'SYNERGY_TRIGGERED', playerId: P1, synergyId: 'brotherhood_barrage', cue: 'CLASH' }, SOUND_CUE.BROTHERHOOD_SYNC],
    [{ type: 'SYNERGY_TRIGGERED', playerId: P1, synergyId: 'some_other_synergy', cue: 'CLASH' }, null],
  ];

  it.each(cases)('maps %o', (event, expected) => {
    expect(soundCueFor(event)).toBe(expected);
  });

  it('caps repeated cues in one batch, keeping the order of first appearance', () => {
    const events: GameEvent[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'CARD_REVEALED',
      playerId: P1,
      cardId: `c${i}`,
    }));
    events.push({ type: 'PAIR_MISMATCHED', playerId: P1, cardIds: ['c0', 'c1'] });
    expect(soundCuesForEvents(events)).toEqual([SOUND_CUE.CARD_FLIP, SOUND_CUE.CARD_FLIP, SOUND_CUE.MISMATCH]);
  });
});

describe('GameEngine sound listener', () => {
  it('reports a flip for every revealed card', () => {
    const engine = makeEngine();
    const cues = record(engine);
    const result = engine.flipCard(P1, cardId(0), 100);
    expect(result.ok).toBe(true);
    expect(cues).toEqual([SOUND_CUE.CARD_FLIP]);
  });

  it('reports the chime and no extra hit sound when a pair lands', () => {
    const engine = makeEngine();
    const cues = record(engine);
    engine.flipCard(P1, cardId(0), 100);
    engine.flipCard(P1, cardId(1), 200);
    expect(cues).toEqual([SOUND_CUE.CARD_FLIP, SOUND_CUE.CARD_FLIP, SOUND_CUE.CARD_MATCH]);
  });

  it('reports the mismatch thud when the pair fails', () => {
    const engine = makeEngine();
    const cues = record(engine);
    engine.flipCard(P1, cardId(0), 100);
    engine.flipCard(P1, cardId(2), 200);
    expect(cues).toEqual([SOUND_CUE.CARD_FLIP, SOUND_CUE.CARD_FLIP, SOUND_CUE.MISMATCH]);
  });

  it('reports the detonation when a trap is flipped', () => {
    const engine = makeEngine(trapLayout(), 2);
    const cues = record(engine);
    engine.flipCard(P1, cardId(0), 100);
    expect(cues).toEqual([SOUND_CUE.TRAP_DETONATE]);
  });

  it('stops reporting once the listener is cleared', () => {
    const engine = makeEngine();
    const cues = record(engine);
    engine.setSoundListener(null);
    engine.flipCard(P1, cardId(0), 100);
    expect(cues).toEqual([]);
  });
});
