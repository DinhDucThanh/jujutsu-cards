import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  GAME_CONSTANTS,
  SHARED_BOARD_ID,
  STATUS_KIND,
  TurnEngine,
  createSeededRandom,
  type CardSpec,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type PublicMatchView,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';
const cardId = (index: number): string => `${SHARED_BOARD_ID}:${index}`;

/**
 * Sixteen standard cards: positions (0,1), (2,3), ... share a pairId. Every pair shows a
 * different fighter, as a real deal does: matching is by fighter, so a board of identical
 * characters would make every flip a match.
 */
function standardLayout(): CardSpec[] {
  return Array.from({ length: 16 }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: CHARACTER_IDS[Math.floor(i / 2) % CHARACTER_IDS.length] as CardSpec['characterId'],
    trapId: null,
  }));
}

/** One real lore synergy pair (Megumi + Divine Dog) inside an otherwise plain board. */
function synergyLayout(): CardSpec[] {
  const layout = standardLayout();
  layout[4] = { pairId: 'syn:divine_dog_pact', type: CARD_TYPE.SYNERGY, characterId: 'megumi_fushiguro', trapId: null };
  layout[5] = { pairId: 'syn:divine_dog_pact', type: CARD_TYPE.SYNERGY, characterId: 'divine_dog', trapId: null };
  return layout;
}

interface SandboxOptions {
  readonly layout?: CardSpec[];
  readonly sandbox?: boolean;
  readonly startingHp?: number;
}

function makeEngine(options: SandboxOptions = {}): TurnEngine {
  const config: MatchConfig = {
    matchId: 'sandbox-match',
    boardMode: BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: 'yuji_itadori' },
      { id: P2, characterId: 'sukuna' },
    ],
    boardSize: 16,
    trapCount: 0,
    synergyPairCount: 1,
    ...(options.sandbox === false ? {} : { sandbox: true }),
    ...(options.startingHp === undefined ? {} : { startingHp: options.startingHp }),
  };
  const engine = new TurnEngine(config, createSeededRandom(7), options.layout ?? standardLayout());
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

describe('sandbox match', () => {
  it('runs a turn order with no clock and an immortal training dummy', () => {
    const engine = makeEngine();
    const view = engine.getPublicView();

    expect(view.turnOwner).toBe(P1);
    expect(view.turnDeadline).toBeNull();
    expect(view.turnTimeMs).toBeNull();

    const dummy = playerView(view, P2);
    expect(dummy.maxHp).toBe(GAME_CONSTANTS.SANDBOX_DUMMY_HP);
    expect(dummy.hp).toBe(GAME_CONSTANTS.SANDBOX_DUMMY_HP);
    expect(dummy.activeEffects.map((effect) => effect.kind)).toContain(STATUS_KIND.IMMORTAL);
  });

  it('keeps the turn after a miss and never times the player out', () => {
    const engine = makeEngine();
    expectOk(engine.flipCard(P1, cardId(0), 10));
    expectOk(engine.flipCard(P1, cardId(2), 20));
    expectOk(engine.tick(20 + GAME_CONSTANTS.MISMATCH_REVEAL_MS));

    const after = engine.getPublicView();
    expect(after.turnOwner).toBe(P1);
    expect(after.turnNumber).toBe(1);
    expect(after.phase).toBe('WAITING_FOR_P1');
    expect(after.board[0]?.state).toBe(CARD_STATE.HIDDEN);

    // Hours of real time cannot end the turn of a training ground.
    const late = expectOk(engine.tick(60 * 60 * 1000));
    expect(late.some((event) => event.type === 'TURN_TIMED_OUT')).toBe(false);
    expect(engine.getPublicView().turnOwner).toBe(P1);
  });

  it('refuses the debug controls outside a sandbox match', () => {
    const engine = makeEngine({ sandbox: false });
    const result = engine.sandboxFillEnergy(P1, 50, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_SANDBOX');
  });

  it('fills cursed energy, clamped to the pool', () => {
    const engine = makeEngine();
    expectOk(engine.sandboxFillEnergy(P1, 50, 10));
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(50);

    expectOk(engine.sandboxFillEnergy(P1, 100, 20));
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBe(GAME_CONSTANTS.MAX_CURSED_ENERGY);
  });

  it('arms Black Flash so the next match lands 2.5x damage and raises a 20 point barrier', () => {
    const engine = makeEngine({ startingHp: 100 });
    expectOk(engine.sandboxArmBlackFlash(P1, 10));

    expectOk(engine.flipCard(P1, cardId(0), 20));
    const events = expectOk(engine.flipCard(P1, cardId(1), 30));

    expect(events.some((event) => event.type === 'BLACK_FLASH')).toBe(true);
    expect(events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({ dealt: 25, critical: true });
    expect(events.find((event) => event.type === 'STATUS_APPLIED' && event.status === STATUS_KIND.SHIELD)).toMatchObject({
      value: GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN,
    });

    const player = playerView(engine.getPublicView(), P1);
    // The +10 HP half of the Kokusen is asserted on `calculateMatchEffects` in
    // primitives.test.ts; here the barrier pool it adds is the new pipeline guarantee.
    expect(player.shield).toBe(GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN);
    expect(player.cursedEnergy).toBe(GAME_CONSTANTS.MATCH_CE_GAIN + GAME_CONSTANTS.BLACK_FLASH_CE_GAIN);
  });

  it('grants the dummy a barrier that soaks a match before its HP', () => {
    const engine = makeEngine();
    expectOk(engine.sandboxGrantBarrier(P2, 50, 10));
    expect(playerView(engine.getPublicView(), P2).shield).toBe(50);

    const before = playerView(engine.getPublicView(), P2).hp;
    expectOk(engine.flipCard(P1, cardId(0), 20));
    expectOk(engine.flipCard(P1, cardId(1), 30));

    const dummy = playerView(engine.getPublicView(), P2);
    expect(dummy.hp).toBe(before);
    expect(dummy.shield).toBe(50 - GAME_CONSTANTS.BASE_MATCH_DAMAGE);
    expect(dummy.shield).toBeGreaterThan(0);
  });

  it('spawns a synergy pair face-up and resolves it through the real pipeline', () => {
    const engine = makeEngine();
    const events = expectOk(engine.sandboxSpawnSynergy(P1, 'divine_dog_pact', 10));

    expect(events.some((event) => event.type === 'SYNERGY_TRIGGERED')).toBe(true);
    expect(events.filter((event) => event.type === 'CARD_REVEALED').length).toBe(2);
    expect(events.some((event) => event.type === 'DEBUG_ACTION')).toBe(true);

    const board = engine.getPublicView().board;
    const pair = board.filter((card) => card.pairId === 'syn:divine_dog_pact');
    expect(pair.length).toBe(2);
    expect(pair.every((card) => card.state === CARD_STATE.MATCHED)).toBe(true);
    // Divine Dog Pact is a 1.5x synergy match (15) plus its own 10 damage.
    expect(playerView(engine.getPublicView(), P2).hp).toBe(
      GAME_CONSTANTS.SANDBOX_DUMMY_HP - 15 - 10,
    );
  });

  it('spawns a pair the board does not hold by rebuilding two cards in place', () => {
    const engine = makeEngine({ layout: standardLayout() });
    expect(engine.getPublicView().board.every((card) => card.type !== CARD_TYPE.SYNERGY)).toBe(true);

    const events = expectOk(engine.sandboxSpawnSynergy(P1, 'seven_three_blade', 10));
    expect(events.some((event) => event.type === 'SYNERGY_TRIGGERED')).toBe(true);

    const pair = engine.getPublicView().board.filter((card) => card.pairId === 'syn:seven_three_blade');
    expect(pair.map((card) => card.characterId).sort()).toEqual(['kento_nanami', 'ratio_blade']);
  });

  it('re-deals every grid and clears stuns, statuses and domains', () => {
    const engine = makeEngine({ layout: synergyLayout() });
    expectOk(engine.flipCard(P1, cardId(0), 10));
    expectOk(engine.sandboxArmBlackFlash(P1, 20));
    expect(playerView(engine.getPublicView(), P1).activeEffects.length).toBeGreaterThan(0);

    const reshuffled = expectOk(engine.sandboxReshuffle(30));
    expect(reshuffled.some((event) => event.type === 'BOARD_RESPAWNED')).toBe(true);
    const board = engine.getPublicView().board;
    expect(board.length).toBe(16);
    expect(board.every((card) => card.state === CARD_STATE.HIDDEN)).toBe(true);

    expectOk(engine.sandboxClearStatuses(40));
    const view = engine.getPublicView();
    // The dummy keeps its immortality: the wipe clears buffs, not the mode's guarantee.
    expect(playerView(view, P1).activeEffects).toEqual([]);
    expect(playerView(view, P2).activeEffects).toEqual([
      { kind: STATUS_KIND.IMMORTAL, sourceId: P2, turnsRemaining: null, value: 1 },
    ]);
    expect(view.players.every((player) => player.activeDomain === null)).toBe(true);
    // An armed Simple Domain window is wiped with the rest: no counter survives the reset.
    expect(view.players.every((player) => player.activeSimpleDomain === null)).toBe(true);

    // A wiped dummy is still impossible to knock out.
    expectOk(engine.sandboxArmBlackFlash(P1, 50));
    expectOk(engine.sandboxSpawnSynergy(P1, 'seven_three_blade', 60));
    expect(playerView(engine.getPublicView(), P2).hp).toBeGreaterThan(0);
  });

  it('switches to dual boards with one fresh grid per fighter, then back to shared', () => {
    const engine = makeEngine();
    const dual = expectOk(engine.debugSwitchBoardLayout('dual', 10));
    expect(dual.some((event) => event.type === 'BOARD_RESPAWNED')).toBe(true);
    const dualView = engine.getPublicView();
    expect(dualView.boardMode).toBe(BOARD_MODE.DUAL);
    expect(dualView.boards.map((board) => board.boardId).sort()).toEqual([P1, P2]);
    expect(dualView.boards.every((board) => board.cards.length > 0)).toBe(true);

    expectOk(engine.debugSwitchBoardLayout('shared', 20));
    const sharedView = engine.getPublicView();
    expect(sharedView.boardMode).toBe(BOARD_MODE.SHARED);
    expect(sharedView.boards.map((board) => board.boardId)).toEqual([SHARED_BOARD_ID]);
  });

  it('makes the dummy fight as the chosen fighter and closes any Domain it had open', () => {
    const engine = makeEngine();
    expectOk(engine.debugSetDummyCharacter('mahito', 10));
    const view = engine.getPublicView();
    expect(playerView(view, P2).characterId).toBe('mahito');
    expect(playerView(view, P2).activeDomain).toBeNull();
    expect(playerView(view, P2).activeSimpleDomain).toBeNull();
  });

  it('refuses to swap the dummy fighter to an unknown character', () => {
    const engine = makeEngine();
    const result = engine.debugSetDummyCharacter('not_a_fighter' as never, 10);
    expect(result.ok).toBe(false);
    expect(playerView(engine.getPublicView(), P2).characterId).toBe('sukuna');
  });
});
