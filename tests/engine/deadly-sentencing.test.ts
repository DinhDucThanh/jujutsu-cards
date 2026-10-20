import { describe, expect, it } from 'vitest';
import {
  BOARD_MODE,
  CARD_STATE,
  CARD_TYPE,
  CHARACTER_IDS,
  COURTROOM_PHASE,
  GAME_CONSTANTS,
  GAME_PACING,
  GameEngine,
  HP_LIMITS,
  STATUS_KIND,
  boardOfPlayer,
  createSeededRandom,
  type CardSpec,
  type CardSubjectId,
  type CharacterId,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type PublicMatchView,
} from '../../src/engine/index.js';

const P1 = 'p1';
const P2 = 'p2';

/** Standard cards: positions (2k, 2k+1) share a pair, and each pair shows a different fighter. */
function standardLayout(size: 16 | 36): CardSpec[] {
  return Array.from({ length: size }, (_, i) => ({
    pairId: `pair-${Math.floor(i / 2)}`,
    type: CARD_TYPE.STANDARD,
    characterId: CHARACTER_IDS[Math.floor(i / 2) % CHARACTER_IDS.length] as CardSpec['characterId'],
    trapId: null,
  }));
}

/**
 * Higuruma (P1) against `victim`. Sandbox mode gives CE on demand and an auto-picking dummy victim.
 * Without a sandbox the victim is a real player, and matched pairs chip its HP, so it starts at the maximum.
 */
function makeMatch(victim: CharacterId, sandbox = true, boardSize: 16 | 36 = 16): GameEngine {
  const config: MatchConfig = {
    matchId: 'deadly-sentencing-test',
    boardMode: BOARD_MODE.SHARED,
    players: [
      { id: P1, characterId: 'higuruma' },
      { id: P2, characterId: victim },
    ],
    boardSize,
    trapCount: 0,
    synergyPairCount: 0,
    sandbox,
    ...(sandbox ? {} : { startingHp: HP_LIMITS.MAX }),
  };
  const engine = new GameEngine(config, createSeededRandom(5), standardLayout(boardSize));
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

/** Two face-down, unlocked cards from different pairs, so flipping them mismatches and ends the turn. */
function openMismatchedPair(engine: GameEngine): [number, number] {
  const board = boardOfPlayer(engine.getPublicView(), P1);
  const open = board
    .map((card, position) => ({ card, position }))
    .filter(({ card }) => card.state === CARD_STATE.HIDDEN && !card.locked)
    .map(({ position }) => position);
  const first = open[0];
  if (first === undefined) throw new Error('no open card');
  const second = open.find((position) => Math.floor(position / 2) !== Math.floor(first / 2));
  if (second === undefined) throw new Error('no mismatched card');
  return [first, second];
}

function cardIdAt(engine: GameEngine, position: number): string {
  const card = boardOfPlayer(engine.getPublicView(), P1)[position];
  if (!card) throw new Error(`no card at ${position}`);
  return card.id;
}

/** Flips two mismatching cards as `playerId`'s attempt, then waits out the reveal so the turn passes. */
function endTurnWithMismatch(engine: GameEngine, playerId: string, now: number): { now: number; events: GameEvent[] } {
  const [a, b] = openMismatchedPair(engine);
  expectOk(engine.flipCard(playerId, cardIdAt(engine, a), now));
  const events = [...expectOk(engine.flipCard(playerId, cardIdAt(engine, b), now + 1))];
  const resolved = now + 1 + GAME_CONSTANTS.MISMATCH_REVEAL_MS;
  events.push(...expectOk(engine.tick(resolved)));
  return { now: resolved, events };
}

/**
 * Plays out a whole trial: steps the clock until the Judgeman asks, then names slots 0..3 in turn.
 * The last verdict still holds for its inspection beat, so the clock runs one beat further.
 * Returns the events and the time the trial closed.
 */
function runTrial(engine: GameEngine, victimId: string, start: number): { now: number; events: GameEvent[] } {
  let now = start;
  const events: GameEvent[] = [];
  for (let round = 0; round < GAME_CONSTANTS.COURTROOM_SLOTS; round++) {
    for (let guard = 0; guard < 2000 && engine.getPublicView().sentencing?.phase !== COURTROOM_PHASE.PICK; guard++) {
      now += 100;
      events.push(...expectOk(engine.tick(now)));
    }
    events.push(...expectOk(engine.pickCourtroomSlot(victimId, round, now)));
  }
  now += GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS;
  events.push(...expectOk(engine.tick(now)));
  return { now, events: [...events] };
}

function guiltyCount(events: readonly GameEvent[]): number {
  return events.filter((event) => event.type === 'COURTROOM_VERDICT' && event.verdict === 'GUILTY').length;
}

describe('Deadly Sentencing pick timeout', () => {
  it('resolves an unanswered pick as a GUILTY guess once the 8s deadline passes', () => {
    // A real victim, not the sandbox dummy: the dummy would answer the pick itself after 1.2s.
    const engine = makeMatch('satoru_gojo', false);
    // Seven matched pairs give 105 CE, enough for the 100 CE domain. Each match keeps P1 on turn.
    let now = 0;
    for (let pair = 0; pair < 7; pair += 1) {
      expectOk(engine.flipCard(P1, cardIdAt(engine, 2 * pair), now));
      expectOk(engine.flipCard(P1, cardIdAt(engine, 2 * pair + 1), now + 1));
      now += 1_000;
      expectOk(engine.tick(now));
    }
    expectOk(engine.activateUltimate(P1, now));
    for (let guard = 0; guard < 2000 && engine.getPublicView().sentencing?.phase !== COURTROOM_PHASE.PICK; guard++) {
      now += 10;
      expectOk(engine.tick(now));
    }
    expect(engine.getPublicView().sentencing?.phase).toBe(COURTROOM_PHASE.PICK);
    // The pick opened at most one step before `now`, so its deadline falls in (now + 7_990, now + 8_000].

    // Nothing is judged while the victim still has time to answer.
    const early = expectOk(engine.tick(now + 7_980));
    expect(early.some((event) => event.type === 'COURTROOM_VERDICT')).toBe(false);
    expect(engine.getPublicView().sentencing?.phase).toBe(COURTROOM_PHASE.PICK);

    // Past the deadline the engine names a wrong slot for the victim: a GUILTY verdict, and the trial moves on.
    const late = expectOk(engine.tick(now + 8_000));
    const verdicts = late.filter((event) => event.type === 'COURTROOM_VERDICT');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ type: 'COURTROOM_VERDICT', playerId: P2, verdict: 'GUILTY', mistakes: 1 });
    expect(engine.getPublicView().sentencing?.phase).not.toBe(COURTROOM_PHASE.PICK);
  });
});

describe('Deadly Sentencing escape', () => {
  it('lets a Simple Domain victim with 100 CE escape the trial and neutralizes the domain', () => {
    const engine = makeMatch('yuji_itadori');
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    expectOk(engine.sandboxFillEnergy(P2, GAME_CONSTANTS.COURTROOM_ESCAPE_COST, 0));
    const victimCe = playerView(engine.getPublicView(), P2).cursedEnergy;

    const opened = expectOk(engine.activateUltimate(P1, 1));
    expect(opened.some((event) => event.type === 'SENTENCING_ESCAPE_OFFERED')).toBe(true);
    expect(engine.getPublicView().sentencing?.stage).toBe('ESCAPE');

    const escaped = expectOk(engine.answerEscape(P2, true, 2));
    expect(escaped.some((event) => event.type === 'SENTENCING_NEUTRALIZED')).toBe(true);
    const view = engine.getPublicView();
    expect(view.sentencing).toBeNull();
    expect(playerView(view, P1).activeDomain).toBeNull();
    expect(playerView(view, P2).cursedEnergy).toBe(victimCe - GAME_CONSTANTS.COURTROOM_ESCAPE_COST);
  });

  it('opens the trial when the victim cannot afford the 100 CE escape', () => {
    const engine = makeMatch('yuji_itadori');
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    expectOk(engine.sandboxFillEnergy(P2, GAME_CONSTANTS.COURTROOM_ESCAPE_COST - 1, 0));

    expectOk(engine.activateUltimate(P1, 1));
    expect(engine.getPublicView().sentencing?.stage).toBe('TRIAL');
    expectReject(engine.answerEscape(P2, true, 2), 'NO_ESCAPE_WINDOW');
  });
});

describe('Deadly Sentencing verdict inspection', () => {
  /** Steps the clock until the Judgeman asks for a pick, and returns that moment. */
  function waitForPick(engine: GameEngine, from: number): number {
    let now = from;
    for (let guard = 0; guard < 4000 && engine.getPublicView().sentencing?.phase !== COURTROOM_PHASE.PICK; guard++) {
      now += 100;
      expectOk(engine.tick(now));
    }
    expect(engine.getPublicView().sentencing?.phase).toBe(COURTROOM_PHASE.PICK);
    return now;
  }

  function openTrial(): { engine: GameEngine; now: number } {
    const engine = makeMatch('satoru_gojo');
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    expectOk(engine.activateUltimate(P1, 1));
    return { engine, now: waitForPick(engine, 1) };
  }

  it('lets only the caster name the charge and only the victim pick a slot', () => {
    const engine = makeMatch('satoru_gojo');
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    expectOk(engine.activateUltimate(P1, 1));
    let now = 1;
    for (let guard = 0; guard < 4000 && engine.getPublicView().sentencing?.phase !== COURTROOM_PHASE.PROSECUTE; guard++) {
      now += 100;
      expectOk(engine.tick(now));
    }
    const trial = engine.getPublicView().sentencing;
    expect(trial?.phase).toBe(COURTROOM_PHASE.PROSECUTE);
    const subject = trial?.candidates?.[0] as CardSubjectId;

    // The victim is P2 here; it must not be able to name the charge.
    expectReject(engine.chooseProsecution(P2, subject, now), 'NOT_YOUR_TURN');
    // The caster may name it, but the caster cannot pick a slot during the prosecution.
    expectReject(engine.pickCourtroomSlot(P1, 0, now), 'NOT_YOUR_TURN');
    expectOk(engine.chooseProsecution(P1, subject, now));
  });

  it('holds the answer on screen with the picked slot published before the next round deals', () => {
    const { engine, now } = openTrial();
    const picked = expectOk(engine.pickCourtroomSlot(P2, 0, now));
    expect(picked.filter((event) => event.type === 'COURTROOM_VERDICT')).toHaveLength(1);

    const view = engine.getPublicView();
    expect(view.sentencing?.phase).toBe(COURTROOM_PHASE.INSPECT);
    expect(view.sentencing?.round).toBe(1);
    expect(view.sentencing?.pickedSlot).toBe(0);
    // Both the pick and the true target are readable during the beat.
    expect(view.sentencing?.slots).toHaveLength(GAME_CONSTANTS.COURTROOM_SLOTS);
    expect(view.sentencing?.target).not.toBeNull();
    expect(view.sentencing?.phaseEndsAt).toBe(now + GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS);

    // The board holds still for the whole beat...
    expectOk(engine.tick(now + GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS - 1));
    expect(engine.getPublicView().sentencing?.phase).toBe(COURTROOM_PHASE.INSPECT);

    // ...and the next round is dealt exactly on it.
    const next = expectOk(engine.tick(now + GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS));
    expect(next.some((event) => event.type === 'COURTROOM_ROUND_STARTED' && event.round === 2)).toBe(true);
    const after = engine.getPublicView();
    expect(after.sentencing?.phase).toBe(COURTROOM_PHASE.REVEAL);
    expect(after.sentencing?.round).toBe(2);
    expect(after.sentencing?.pickedSlot).toBeNull();
  });

  it('holds the fourth verdict for its beat before the courtroom closes', () => {
    const { engine, now: firstPick } = openTrial();
    let now = firstPick;
    for (let round = 1; round < GAME_CONSTANTS.COURTROOM_ROUNDS; round++) {
      expectOk(engine.pickCourtroomSlot(P2, 0, now));
      now = waitForPick(engine, now);
    }
    expectOk(engine.pickCourtroomSlot(P2, 0, now));
    expect(engine.getPublicView().sentencing?.phase).toBe(COURTROOM_PHASE.INSPECT);
    expect(engine.getPublicView().sentencing?.round).toBe(GAME_CONSTANTS.COURTROOM_ROUNDS);

    expectOk(engine.tick(now + GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS - 1));
    expect(engine.getPublicView().sentencing).not.toBeNull();

    const closed = expectOk(engine.tick(now + GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS));
    expect(closed.some((event) => event.type === 'COURTROOM_CLOSED')).toBe(true);
    expect(engine.getPublicView().sentencing).toBeNull();
  });
});

describe('Deadly Sentencing trial seals', () => {
  it('seals one hidden card of the victim per wrong guess and grants the sword only when a guess was wrong', () => {
    const engine = makeMatch('satoru_gojo');
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    expectOk(engine.activateUltimate(P1, 1));

    const { events } = runTrial(engine, P2, 1);
    const guilty = guiltyCount(events);
    const closed = events.find((event) => event.type === 'COURTROOM_CLOSED');
    expect(closed).toBeDefined();
    expect(engine.getPublicView().sentencing).toBeNull();

    const locked = boardOfPlayer(engine.getPublicView(), P2).filter((card) => card.locked).length;
    expect(locked).toBe(guilty);

    const executioner = playerView(engine.getPublicView(), P1).executioner;
    if (guilty > 0) {
      expect(executioner?.damage).toBe(GAME_CONSTANTS.EXECUTIONER_BASE_DAMAGE + GAME_CONSTANTS.EXECUTIONER_DAMAGE_PER_MISTAKE * guilty);
    } else {
      expect(executioner).toBeNull();
    }
  });
});

describe("Executioner's Sword", () => {
  it('scales true damage 25/35/45/55 with the mistakes and ignores the barrier', () => {
    const scaled = [1, 2, 3, 4].map(
      (mistakes) => GAME_CONSTANTS.EXECUTIONER_BASE_DAMAGE + GAME_CONSTANTS.EXECUTIONER_DAMAGE_PER_MISTAKE * mistakes,
    );
    expect(scaled).toEqual([25, 35, 45, 55]);

    const engine = makeMatch('satoru_gojo');
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    expectOk(engine.activateUltimate(P1, 1));
    const { now, events } = runTrial(engine, P2, 1);
    const guilty = guiltyCount(events);
    if (guilty === 0) throw new Error('trial produced no mistakes; the sword is not granted');

    let time = now + 1;
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.SKILL_CE_COST, time));
    expectOk(engine.sandboxGrantBarrier(P2, 50, time));
    const before = playerView(engine.getPublicView(), P2);
    const expected = playerView(engine.getPublicView(), P1).executioner?.damage;
    expect(expected).toBe(scaled[guilty - 1]);

    time += 1;
    expectOk(engine.activateSkill(P1, time));
    const after = playerView(engine.getPublicView(), P2);
    expect(before.hp - after.hp).toBe(expected);
    expect(after.shield).toBe(before.shield);
  });

  it("wipes the caster's CE when the sword's three turns run out", () => {
    const engine = makeMatch('satoru_gojo');
    expectOk(engine.sandboxFillEnergy(P1, GAME_CONSTANTS.DOMAIN_CE_COST, 0));
    expectOk(engine.activateUltimate(P1, 1));
    const { now, events } = runTrial(engine, P2, 1);
    expect(guiltyCount(events)).toBeGreaterThan(0);

    let time = now + 1;
    expectOk(engine.sandboxFillEnergy(P1, 60, time));
    expect(playerView(engine.getPublicView(), P1).cursedEnergy).toBeGreaterThan(0);

    // The grant turn is skipped by the grace flag; the sword then covers three more of P1's turns.
    let casterTurnsEnded = 0;
    let expired = false;
    for (let guard = 0; guard < 12 && !expired; guard++) {
      const owner = engine.getPublicView().turnOwner;
      if (owner === null) throw new Error('no turn owner');
      const turn = endTurnWithMismatch(engine, owner, time);
      time = turn.now;
      if (owner === P1) {
        casterTurnsEnded += 1;
        expired = turn.events.some((event) => event.type === 'EXECUTIONER_EXPIRED');
      }
    }
    expect(expired).toBe(true);
    expect(casterTurnsEnded).toBe(4);
    const caster = playerView(engine.getPublicView(), P1);
    expect(caster.executioner).toBeNull();
    expect(caster.cursedEnergy).toBe(0);
  });
});

describe('Confiscated Cursed Tool (shared board)', () => {
  /**
   * Plays a full trial against P2 on a 36-card board, so the victim's turns come around and the grid
   * keeps unsealed cards. Returns the engine and the clock; P1 still holds the turn.
   * With `victimMatches`, P2 first matches a pair (15 CE), so it can pay the 10 CE backlash.
   */
  function plantSeals(victimMatches: boolean): { engine: GameEngine; now: number } {
    const engine = makeMatch('satoru_gojo', false, 36);
    let now = 1;
    if (victimMatches) {
      // P1's opening mismatch hands the turn to P2, which matches pair 0 and then mismatches to return it.
      now = handTurnToVictim(engine, now);
      expectOk(engine.flipCard(P2, cardIdAt(engine, 0), now));
      expectOk(engine.flipCard(P2, cardIdAt(engine, 1), now + 1));
      now += 1_000;
      expectOk(engine.tick(now));
      expect(playerView(engine.getPublicView(), P2).cursedEnergy).toBe(GAME_CONSTANTS.MATCH_CE_GAIN);
      now = endTurnWithMismatch(engine, P2, now).now + 1;
      expect(engine.getPublicView().turnOwner).toBe(P1);
    }
    // Seven matches by Higuruma pay for the 100 CE domain. Each match keeps P1 on turn.
    const firstPair = victimMatches ? 1 : 0;
    for (let pair = firstPair; pair < firstPair + 7; pair += 1) {
      expectOk(engine.flipCard(P1, cardIdAt(engine, 2 * pair), now));
      expectOk(engine.flipCard(P1, cardIdAt(engine, 2 * pair + 1), now + 1));
      now += 1_000;
      expectOk(engine.tick(now));
    }
    expectOk(engine.activateUltimate(P1, now));
    const trial = runTrial(engine, P2, now);
    if (guiltyCount(trial.events) === 0) throw new Error('trial produced no mistakes; nothing is sealed');
    return { engine, now: trial.now };
  }

  /** P1 spends its turn on a mismatch, which hands the turn to the victim. Returns the clock. */
  function handTurnToVictim(engine: GameEngine, now: number): number {
    const turn = endTurnWithMismatch(engine, P1, now);
    expect(engine.getPublicView().turnOwner).toBe(P2);
    return turn.now + 1;
  }

  /** Positions of the victim's sealed cards on the shared grid. */
  function sealedPositions(engine: GameEngine): number[] {
    return boardOfPlayer(engine.getPublicView(), P2)
      .map((card, position) => ({ card, position }))
      .filter(({ card }) => card.locked)
      .map(({ position }) => position);
  }

  it('charges the victim 10 CE and ends their turn when they touch a sealed card', () => {
    const { engine, now } = plantSeals(true);
    const sealed = sealedPositions(engine);
    expect(sealed.length).toBeGreaterThan(0);

    let time = handTurnToVictim(engine, now);
    const before = playerView(engine.getPublicView(), P2).cursedEnergy;
    expect(before).toBeGreaterThanOrEqual(GAME_CONSTANTS.CONFISCATED_BACKLASH_CE);

    time += 1;
    const touched = expectOk(engine.flipCard(P2, cardIdAt(engine, sealed[0] ?? 0), time));
    const tool = touched.find((event) => event.type === 'CONFISCATED_TOOL');
    expect(tool).toMatchObject({ type: 'CONFISCATED_TOOL', playerId: P2, outcome: 'BACKLASH' });

    const view = engine.getPublicView();
    expect(playerView(view, P2).cursedEnergy).toBe(before - GAME_CONSTANTS.CONFISCATED_BACKLASH_CE);
    expect(view.turnOwner).toBe(P1);
    // The victim's touch does not lift the seal.
    expect(sealedPositions(engine)).toEqual(sealed);
  });

  it('deals recoil damage instead when the victim has no CE to lose', () => {
    const { engine, now } = plantSeals(false);
    const sealed = sealedPositions(engine);
    expect(sealed.length).toBeGreaterThan(0);

    let time = handTurnToVictim(engine, now);
    // Matches are the only way to earn CE, and the victim has made none.
    expect(playerView(engine.getPublicView(), P2).cursedEnergy).toBe(0);
    const hpBefore = playerView(engine.getPublicView(), P2).hp;

    time += 1;
    const touched = expectOk(engine.flipCard(P2, cardIdAt(engine, sealed[0] ?? 0), time));
    const recoil = touched.find((event) => event.type === 'DAMAGE_DEALT' && event.cause === 'RECOIL');
    expect(recoil).toBeDefined();
    expect(playerView(engine.getPublicView(), P2).hp).toBe(hpBefore - GAME_CONSTANTS.CONFISCATED_BACKLASH_DAMAGE);
    expect(engine.getPublicView().turnOwner).toBe(P1);
  });

  it('lets Higuruma reclaim the tool for barrier and a free flip without spending his turn', () => {
    const { engine, now } = plantSeals(false);
    const sealed = sealedPositions(engine);
    expect(sealed.length).toBeGreaterThan(0);
    const turnOwner = engine.getPublicView().turnOwner;
    expect(turnOwner).toBe(P1);
    const shieldBefore = playerView(engine.getPublicView(), P1).shield;

    const time = now + 1;
    const reclaimed = expectOk(engine.flipCard(P1, cardIdAt(engine, sealed[0] ?? 0), time));
    const tool = reclaimed.find((event) => event.type === 'CONFISCATED_TOOL');
    expect(tool).toMatchObject({ type: 'CONFISCATED_TOOL', playerId: P1, outcome: 'RECLAIMED' });
    expect(reclaimed.some((event) => event.type === 'STATUS_APPLIED' && event.status === STATUS_KIND.EXTRA_FLIP)).toBe(true);

    const view = engine.getPublicView();
    expect(playerView(view, P1).shield).toBe(shieldBefore + GAME_CONSTANTS.CONFISCATED_RECLAIM_BARRIER);
    expect(view.turnOwner).toBe(turnOwner);
    // The reclaimed card is back to a normal, unlocked hidden card.
    const card = boardOfPlayer(view, P2)[sealed[0] ?? 0];
    expect(card?.locked).toBe(false);
    expect(card?.state).toBe(CARD_STATE.HIDDEN);
    expect(sealedPositions(engine)).toHaveLength(sealed.length - 1);
  });
});

function expectReject(result: EngineResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}
