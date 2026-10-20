import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  GAME_CONSTANTS,
  SHARED_BOARD_ID,
  STATUS_KIND,
  GameEngine,
  createSeededRandom,
  type BoardMode,
  type CardSpec,
  type CharacterId,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type PublicMatchView,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';

/** Unique traps first, then standard pairs on (0,1), (2,3), ... once they run out. */
function layout(trapCount = 0, size = 16): CardSpec[] {
  const traps: CardSpec[] = Array.from({ length: trapCount }, (_, i) => ({
    pairId: `trap:sukuna_finger:${i}`,
    type: CARD_TYPE.TRAP,
    characterId: 'sukuna',
    trapId: 'sukuna_finger',
  }));
  const pairs: CardSpec[] = Array.from({ length: size - trapCount }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: CHARACTER_IDS[Math.floor(i / 2) % CHARACTER_IDS.length] as CardSpec['characterId'],
    trapId: null,
  }));
  return [...traps, ...pairs];
}

interface EngineOptions {
  readonly startingHp?: number;
  readonly p1?: CharacterId;
  readonly p2?: CharacterId;
  readonly trapCount?: number;
  readonly mode?: BoardMode;
}

function makeEngine(options: EngineOptions = {}): GameEngine {
  const config: MatchConfig = {
    matchId: 'balance-patch-test',
    boardMode: options.mode ?? BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: options.p1 ?? 'sukuna' },
      { id: P2, characterId: options.p2 ?? 'satoru_gojo' },
    ],
    boardSize: 16,
    trapCount: options.trapCount ?? 0,
    synergyPairCount: 0,
    ...(options.startingHp === undefined ? {} : { startingHp: options.startingHp }),
  };
  const engine = new GameEngine(config, createSeededRandom(23), layout(options.trapCount ?? 0));
  expectOk(engine.start(0));
  return engine;
}

function expectOk(result: EngineResult): readonly GameEvent[] {
  if (!result.ok) throw new Error(`Engine rejected command with ${result.code}`);
  return result.events;
}

function playerView(view: PublicMatchView, id: string) {
  const player = view.players.find((candidate) => candidate.id === id);
  if (!player) throw new Error(`missing player ${id}`);
  return player;
}

function cardId(position: number): string {
  return `${SHARED_BOARD_ID}:${position}`;
}

/** Flips `count` traps, banking their cursed energy without consuming the turn. */
function bankTraps(engine: GameEngine, playerId: string, count: number, now: number): number {
  let time = now;
  for (let i = 0; i < count; i++) {
    expectOk(engine.flipCard(playerId, cardId(i), time));
    time += 1;
  }
  return time;
}

function cardIdsOf(events: readonly GameEvent[], type: GameEvent['type']): string[] {
  const event = events.find((candidate) => candidate.type === type);
  return event && 'cardIds' in event ? [...event.cardIds] : [];
}

/** Two hidden, unsealed cards from different dealt pairs, for ending a turn on a mismatch. */
function mismatchingPositions(view: PublicMatchView): [number, number] {
  const groups = new Map<number, number>();
  for (const card of view.board) {
    if (card.state !== CARD_STATE.HIDDEN || card.locked) continue;
    const key = Math.floor(card.position / 2);
    if (!groups.has(key)) groups.set(key, card.position);
  }
  const [first, second] = [...groups.values()];
  if (first === undefined || second === undefined) throw new Error('need two unsealed pairs');
  return [first, second];
}

describe('Mahito: Self-Embodiment of Perfection', () => {
  it('cuts 25% of a 200 HP pool for good and clamps current HP', () => {
    const engine = makeEngine({ startingHp: 200, p1: 'mahito', trapCount: 4 });
    const now = bankTraps(engine, P1, 4, 0);
    const events = expectOk(engine.activateUltimate(P1, now));

    expect(events.find((event) => event.type === 'MAX_HP_CUT')).toMatchObject({
      playerId: P2,
      sourceId: P1,
      amount: 50,
      fraction: 0.25,
      maxHp: 150,
    });

    const p2 = playerView(engine.getPublicView(), P2);
    expect(p2.maxHp).toBe(150);
    expect(p2.hp).toBe(150);
    expect(p2.activeEffects.map((effect) => effect.kind)).toContain(STATUS_KIND.MAX_HP_REDUCTION);
  });
});

describe('Sukuna: Cleave', () => {
  it.each([
    [100, 25],
    [200, 50],
    [300, 75],
  ])('deals 25%% of a %i HP pool: %i damage', (startingHp, expected) => {
    const engine = makeEngine({ startingHp, p1: 'sukuna', trapCount: 2 });
    const now = bankTraps(engine, P1, 2, 0);
    const events = expectOk(engine.activateSkill(P1, now));

    expect(events.find((event) => event.type === 'SKILL_ACTIVATED')).toMatchObject({
      skillId: 'cleave',
      vfx: 'CLEAVE',
    });
    expect(events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({
      sourceId: P1,
      targetId: P2,
      dealt: expected,
      cause: 'SKILL',
    });
    const p2 = playerView(engine.getPublicView(), P2);
    expect(p2.hp).toBe(startingHp - expected);
    expect(p2.maxHp).toBe(startingHp);
  });
});

describe('Jogo: shared-board Seal Absorption', () => {
  it('consumes a seal for +20 CE and leaves the card face-down and flippable', () => {
    const engine = makeEngine({ startingHp: 200, p1: 'jogo', trapCount: 4 });
    const now = bankTraps(engine, P1, 4, 0);
    const ultimate = expectOk(engine.activateUltimate(P1, now));
    const sealed = cardIdsOf(ultimate, 'CARD_MODIFIED');
    expect(sealed).toHaveLength(2);

    const card = sealed[0] as string;
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(0);
    const absorbed = expectOk(engine.flipCard(P1, card, now + 1));
    expect(absorbed.find((event) => event.type === 'SEAL_ABSORBED')).toMatchObject({
      playerId: P1,
      boardId: SHARED_BOARD_ID,
      cardId: card,
      ceGain: GAME_CONSTANTS.SEAL_ABSORPTION_CE,
    });
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.SEAL_ABSORPTION_CE);

    const view = engine.getPublicView();
    const unsealed = view.board.find((candidate) => candidate.id === card);
    expect(unsealed).toMatchObject({ state: CARD_STATE.HIDDEN, locked: false });
    // The absorption is a utility touch, not a flip attempt: the turn stays with Jogo.
    expect(view.turnOwner).toBe(P1);

    const next = view.board.find(
      (candidate) => candidate.id !== card && candidate.state === CARD_STATE.HIDDEN && !candidate.locked,
    );
    expect(next).toBeDefined();
    expectOk(engine.flipCard(P1, next?.id ?? '', now + 2));
  });

  it('does not let another fighter absorb the same seal', () => {
    const engine = makeEngine({ startingHp: 200, p1: 'jogo', p2: 'sukuna', trapCount: 4 });
    const now = bankTraps(engine, P1, 4, 0);
    const ultimate = expectOk(engine.activateUltimate(P1, now));
    const sealed = cardIdsOf(ultimate, 'CARD_MODIFIED');
    expect(sealed).toHaveLength(2);

    // End Jogo's turn on a mismatch so Sukuna gets the click.
    const [first, second] = mismatchingPositions(engine.getPublicView());
    expectOk(engine.flipCard(P1, cardId(first), now + 1));
    expectOk(engine.flipCard(P1, cardId(second), now + 2));
    const resolved = now + 2 + GAME_CONSTANTS.MISMATCH_REVEAL_MS;
    expectOk(engine.tick(resolved));
    expect(engine.getPublicView().turnOwner).toBe(P2);

    const before = playerView(engine.getPublicView(), P2).cursedEnergy;
    const rejected = engine.flipCard(P2, sealed[0] as string, resolved + 1);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('CARD_LOCKED');
    expect(playerView(engine.getPublicView(), P2).cursedEnergy).toBe(before);
    expect(engine.getPublicView().board.find((card) => card.id === sealed[0])?.locked).toBe(true);
  });
});
