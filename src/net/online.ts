import { HP_LIMITS, boardClearRewardOf, isCharacterId } from '../engine/index.js';
import type {
  BlessingId,
  CardSubjectId,
  CharacterId,
  EngineResult,
  GameEvent,
  GameEngine,
  MatchConfig,
  PublicMatchView,
} from '../engine/index.js';
import {
  NETWORK_PROTOCOL_VERSION,
  asAnswerEscape,
  asBoardState,
  asCastSkill,
  asChooseBlessing,
  asCourtroomPick,
  asCourtroomProsecute,
  asDamageApplied,
  asDomainActivated,
  asFlipCard,
  asGameConfig,
  asJoinRequest,
  asMatchResult,
  asMatchStart,
  asP2SelectCharacter,
  asPingPong,
  asRoomReady,
  asVoteRematch,
  makePacket,
  type BoardStatePayload,
  type GameConfigPayload,
  type MatchStartPayload,
  type NetworkPacket,
  type RoomReadyPayload,
  type SeatIndex,
} from './network.js';

/** Seat 0 hosts and plays player 1; seat 1 is the guest and plays player 2. */
export const HOST_SEAT: SeatIndex = 0;
export const GUEST_SEAT: SeatIndex = 1;

/** How often an idle host repeats a snapshot so the guest's clock and HUD stay fresh. */
const SNAPSHOT_INTERVAL_MS = 250;

export interface OnlineStatus {
  readonly state: 'idle' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error';
  readonly detail: string;
}

export type SendPacket = (packet: NetworkPacket) => void;

export interface HostHooks {
  /** Handshake accepted: the caller starts the engine and calls `announce`. */
  onGuestJoined(guestName: string): void;
  /** The guest picked (or re-picked) player 2's sorcerer. */
  onGuestCharacter?: (characterId: CharacterId) => void;
  /** The guest voted for a rematch. */
  onRematchVote?: (vote: boolean) => void;
  /** A guest command produced engine events the local UI still has to show. */
  onEngineResult(result: EngineResult): void;
  onStatus(status: OnlineStatus): void;
}

export interface GuestHooks {
  onReady(ready: RoomReadyPayload): void;
  /** Host rules, sent as a lobby preview and again with every match start. */
  onConfig(config: GameConfigPayload): void;
  /** The host launched the opening match; `initialState` is its first snapshot. */
  onMatchStart?: (config: GameConfigPayload, initialState: BoardStatePayload) => void;
  /** The host launched a rematch over the same open connection. */
  onRematchStart?: (config: GameConfigPayload, initialState: BoardStatePayload) => void;
  /** Every snapshot, with the presentation events that preceded it. */
  onSnapshot(snapshot: BoardStatePayload, events: readonly GameEvent[]): void;
  onStatus(status: OnlineStatus): void;
}

/** The wire form of a match config. Shared by every packet that announces rules. */
export function toGameConfigPayload(config: MatchConfig, roomCode: string, hostName: string): GameConfigPayload {
  return {
    roomCode,
    boardMode: config.boardMode,
    boardSize: config.boardSize,
    startingHp: config.startingHp ?? HP_LIMITS.DEFAULT,
    trapCount: config.trapCount,
    synergyPairCount: config.synergyPairCount,
    boardClearReward: boardClearRewardOf(config),
    players: config.players.map((player) => ({ id: player.id, characterId: player.characterId })),
    hostName,
  };
}

/**
 * The host's authoritative half of an online match.
 *
 * It owns no rendering and no transport: packets arrive through `handlePacket`, commands
 * are applied to the real `GameEngine`, and the result is broadcast as public state. That
 * keeps the rules on one machine — the guest can never fabricate a match.
 */
export class OnlineHost {
  readonly engine: GameEngine;
  private readonly config: MatchConfig;
  private readonly guestId: string;
  private readonly send: SendPacket;
  private readonly now: () => number;
  private readonly hooks: HostHooks;
  private lastSnapshotClock = Number.NEGATIVE_INFINITY;
  private guestName = 'Player 2';
  private guestCharacter: CharacterId | null = null;
  private started = false;

  constructor(config: MatchConfig, engine: GameEngine, send: SendPacket, now: () => number, hooks: HostHooks) {
    this.config = config;
    this.engine = engine;
    this.guestId = config.players[1].id;
    this.send = send;
    this.now = now;
    this.hooks = hooks;
  }

  get guestPlayerId(): string {
    return this.guestId;
  }

  get connectedGuestName(): string {
    return this.guestName;
  }

  /** Player 2's current pick, or null until the guest chooses. */
  get guestCharacterId(): CharacterId | null {
    return this.guestCharacter;
  }

  /**
   * Publishes the host's rules before the match starts, so the guest can read the match
   * conditions and pick a sorcerer. Nothing is committed until `announce`.
   */
  syncLobby(payload: GameConfigPayload): void {
    this.send(makePacket('SYNC_GAME_CONFIG', HOST_SEAT, payload));
  }

  /** Publishes the opening match: rules plus the first public snapshot. */
  announce(roomCode: string, hostName: string, initialEvents: readonly GameEvent[] = []): void {
    this.started = true;
    const config = toGameConfigPayload(this.config, roomCode, hostName);
    this.send(makePacket('SYNC_GAME_CONFIG', HOST_SEAT, config));
    this.sendMatchStart('START_MATCH', config, initialEvents);
  }

  /**
   * Launches a rematch on the connection that is already open. The guest keeps its room,
   * its session and its AudioContext: only the board and the match config are replaced.
   */
  announceRematch(roomCode: string, hostName: string, initialEvents: readonly GameEvent[] = []): void {
    this.started = true;
    const config = toGameConfigPayload(this.config, roomCode, hostName);
    this.send(makePacket('SYNC_GAME_CONFIG', HOST_SEAT, config));
    this.sendMatchStart('START_REMATCH_MATCH', config, initialEvents);
  }

  private sendMatchStart(
    type: 'START_MATCH' | 'START_REMATCH_MATCH',
    config: GameConfigPayload,
    initialEvents: readonly GameEvent[],
  ): void {
    const payload: MatchStartPayload = { config, initialState: this.snapshot(initialEvents) };
    this.send(makePacket(type, HOST_SEAT, payload));
  }

  handlePacket(packet: NetworkPacket, from: SeatIndex): void {
    // Only the guest seat may command this match, and only once the handshake is done.
    if (from !== GUEST_SEAT || packet.senderIndex !== GUEST_SEAT) return;

    switch (packet.type) {
      case 'ROOM_JOIN_REQUEST': {
        const request = asJoinRequest(packet.payload);
        if (!request) return;
        if (request.protocol !== NETWORK_PROTOCOL_VERSION) {
          this.send(
            makePacket('ROOM_READY', HOST_SEAT, {
              protocol: NETWORK_PROTOCOL_VERSION,
              accepted: false,
              reason: `This room speaks protocol ${NETWORK_PROTOCOL_VERSION}, the guest sent ${request.protocol}.`,
              roomCode: '',
            } satisfies RoomReadyPayload),
          );
          return;
        }
        const name = request.guestName.trim();
        this.guestName = name === '' ? 'Player 2' : name.slice(0, 32);
        this.send(
          makePacket('ROOM_READY', HOST_SEAT, {
            protocol: NETWORK_PROTOCOL_VERSION,
            accepted: true,
            reason: null,
            roomCode: '',
          } satisfies RoomReadyPayload),
        );
        this.hooks.onStatus({ state: 'connected', detail: `${this.guestName} joined the room` });
        this.hooks.onGuestJoined(this.guestName);
        return;
      }
      case 'P2_SELECT_CHARACTER': {
        const pick = asP2SelectCharacter(packet.payload);
        if (!pick || !isCharacterId(pick.characterId)) return;
        this.guestCharacter = pick.characterId;
        this.hooks.onGuestCharacter?.(pick.characterId);
        return;
      }
      case 'VOTE_REMATCH': {
        const vote = asVoteRematch(packet.payload);
        if (!vote) return;
        this.hooks.onRematchVote?.(vote.vote);
        return;
      }
      case 'ACTION_FLIP_CARD': {
        const action = asFlipCard(packet.payload);
        if (!action) return;
        this.hooks.onEngineResult(this.engine.flipCard(this.guestId, action.cardId, this.now()));
        return;
      }
      case 'ACTION_CAST_SKILL': {
        const action = asCastSkill(packet.payload);
        if (!action) return;
        this.hooks.onEngineResult(
          action.ability === 'SKILL'
            ? this.engine.activateSkill(this.guestId, this.now())
            : this.engine.activateUltimate(this.guestId, this.now()),
        );
        return;
      }
      case 'ACTION_ANSWER_ESCAPE': {
        const action = asAnswerEscape(packet.payload);
        if (!action) return;
        this.hooks.onEngineResult(this.engine.answerEscape(this.guestId, action.escape, this.now()));
        return;
      }
      case 'ACTION_COURTROOM_PICK': {
        const action = asCourtroomPick(packet.payload);
        if (!action) return;
        this.hooks.onEngineResult(this.engine.pickCourtroomSlot(this.guestId, action.slot, this.now()));
        return;
      }
      case 'ACTION_COURTROOM_PROSECUTE': {
        const action = asCourtroomProsecute(packet.payload);
        if (!action) return;
        this.hooks.onEngineResult(this.engine.chooseProsecution(this.guestId, action.subject, this.now()));
        return;
      }
      case 'ACTION_CHOOSE_BLESSING': {
        const action = asChooseBlessing(packet.payload);
        if (!action) return;
        this.hooks.onEngineResult(this.engine.chooseBlessing(this.guestId, action.blessing, this.now()));
        return;
      }
      case 'PING_PONG': {
        const ping = asPingPong(packet.payload);
        if (!ping) return;
        this.send(makePacket('PING_PONG', HOST_SEAT, ping));
        return;
      }
      default:
        return;
    }
  }

  /**
   * Sends the public state after a command. Events are streamed once: the three that have
   * their own packet type travel that way, everything else rides on the snapshot.
   */
  publish(events: readonly GameEvent[]): void {
    if (!this.started) return;
    // Quiet frames only refresh the snapshot on the timer: streaming state at 60 Hz for
    // an unchanged board would burn bandwidth and battery for nothing.
    if (events.length === 0) {
      this.refresh();
      return;
    }
    this.broadcast(events);
  }

  /** Keeps the guest's timer and HUD in step between commands. */
  refresh(): void {
    if (!this.started) return;
    if (this.now() - this.lastSnapshotClock < SNAPSHOT_INTERVAL_MS) return;
    this.broadcast([]);
  }

  notifyDisconnected(detail: string): void {
    this.started = false;
    this.hooks.onStatus({ state: 'disconnected', detail });
  }

  private broadcast(events: readonly GameEvent[]): void {
    const remaining: GameEvent[] = [];
    for (const event of events) {
      switch (event.type) {
        case 'DAMAGE_DEALT':
          this.send(
            makePacket('EVENT_DAMAGE_APPLIED', HOST_SEAT, {
              sourceId: event.sourceId,
              targetId: event.targetId,
              dealt: event.dealt,
              absorbed: event.absorbed,
              critical: event.critical,
              piercing: event.piercing,
              cause: event.cause,
            }),
          );
          break;
        case 'ULTIMATE_ACTIVATED':
          this.send(
            makePacket('EVENT_DOMAIN_ACTIVATED', HOST_SEAT, {
              playerId: event.playerId,
              characterId: event.characterId,
              ultimateId: event.ultimateId,
              name: event.name,
              cost: event.cost,
              ultimateType: event.ultimateType,
              domainId: event.domainId,
              turnsRemaining: event.turnsRemaining,
              vfx: event.vfx,
            }),
          );
          break;
        case 'MATCH_ENDED':
          this.send(makePacket('EVENT_MATCH_RESULT', HOST_SEAT, { result: event.result }));
          break;
        default:
          remaining.push(event);
          break;
      }
    }

    this.send(makePacket('SYNC_BOARD_STATE', HOST_SEAT, this.snapshot(remaining)));
  }

  /** The public state as the guest receives it, with `events` riding along. */
  private snapshot(events: readonly GameEvent[]): BoardStatePayload {
    const sentAt = this.now();
    this.lastSnapshotClock = sentAt;
    return {
      view: this.engine.getPublicView(),
      queue: this.engine.getUpcomingTurnQueue(3),
      events,
      sentAt,
    };
  }
}

/**
 * The guest's view of an online match.
 *
 * It renders published state and nothing else: no engine, no local simulation, so the two
 * screens cannot drift apart. Its clock is the host's clock plus a measured offset, which
 * keeps turn timers and stun countdowns in step despite the network delay.
 */
export class OnlineGuest {
  private readonly send: SendPacket;
  private readonly localNow: () => number;
  private readonly hooks: GuestHooks;
  private pendingEvents: GameEvent[] = [];
  private skew = 0;
  private view: PublicMatchView | null = null;
  private config: GameConfigPayload | null = null;
  private waitingPing: { nonce: number; sentAt: number } | null = null;
  private smoothedRtt = 0;

  constructor(send: SendPacket, localNow: () => number, hooks: GuestHooks) {
    this.send = send;
    this.localNow = localNow;
    this.hooks = hooks;
  }

  /** Latest published match, or null before the first snapshot. */
  get publicView(): PublicMatchView | null {
    return this.view;
  }

  /** The host's setup, adopted once the handshake completes. */
  get gameConfig(): GameConfigPayload | null {
    return this.config;
  }

  /** Host-aligned engine clock in milliseconds. */
  clock(): number {
    return this.localNow() + this.skew;
  }

  get latencyMs(): number {
    return Math.round(this.smoothedRtt);
  }

  requestJoin(guestName: string): void {
    this.send(makePacket('ROOM_JOIN_REQUEST', GUEST_SEAT, { protocol: NETWORK_PROTOCOL_VERSION, guestName }));
  }

  handlePacket(packet: NetworkPacket, from: SeatIndex): void {
    if (from !== HOST_SEAT || packet.senderIndex !== HOST_SEAT) return;

    switch (packet.type) {
      case 'ROOM_READY': {
        const ready = asRoomReady(packet.payload);
        if (!ready) return;
        if (!ready.accepted) {
          this.hooks.onStatus({ state: 'error', detail: ready.reason ?? 'The host refused the connection.' });
          return;
        }
        this.hooks.onReady(ready);
        return;
      }
      case 'SYNC_GAME_CONFIG': {
        const config = asGameConfig(packet.payload);
        if (!config) return;
        this.config = config;
        this.hooks.onConfig(config);
        return;
      }
      case 'START_MATCH':
      case 'START_REMATCH_MATCH': {
        const start = asMatchStart(packet.payload);
        if (!start) return;
        this.config = start.config;
        this.view = start.initialState.view;
        this.skew = start.initialState.sentAt - this.localNow();
        this.pendingEvents = [];
        // The UI mounts the arena first, then the snapshot's events are replayed into it.
        if (packet.type === 'START_REMATCH_MATCH') {
          this.hooks.onRematchStart?.(start.config, start.initialState);
        } else {
          this.hooks.onMatchStart?.(start.config, start.initialState);
        }
        this.hooks.onSnapshot(start.initialState, start.initialState.events);
        return;
      }
      case 'SYNC_BOARD_STATE': {
        const snapshot = asBoardState(packet.payload);
        if (!snapshot) return;
        this.view = snapshot.view;
        this.skew = snapshot.sentAt - this.localNow();
        const events = [...this.pendingEvents, ...snapshot.events];
        this.pendingEvents = [];
        this.hooks.onSnapshot(snapshot, events);
        return;
      }
      case 'EVENT_DAMAGE_APPLIED': {
        const damage = asDamageApplied(packet.payload);
        if (!damage) return;
        this.pendingEvents.push({
          type: 'DAMAGE_DEALT',
          sourceId: damage.sourceId,
          targetId: damage.targetId,
          dealt: damage.dealt,
          absorbed: damage.absorbed,
          critical: damage.critical,
          piercing: damage.piercing,
          cause: damage.cause,
        });
        return;
      }
      case 'EVENT_DOMAIN_ACTIVATED': {
        const domain = asDomainActivated(packet.payload);
        if (!domain) return;
        this.pendingEvents.push({ type: 'ULTIMATE_ACTIVATED', ...domain });
        return;
      }
      case 'EVENT_MATCH_RESULT': {
        const result = asMatchResult(packet.payload);
        if (!result) return;
        this.pendingEvents.push({ type: 'MATCH_ENDED', result: result.result });
        return;
      }
      case 'PING_PONG': {
        const pong = asPingPong(packet.payload);
        if (!pong || !this.waitingPing || pong.nonce !== this.waitingPing.nonce) return;
        const rtt = Date.now() - this.waitingPing.sentAt;
        this.waitingPing = null;
        this.smoothedRtt = this.smoothedRtt === 0 ? rtt : this.smoothedRtt * 0.7 + rtt * 0.3;
        return;
      }
      default:
        return;
    }
  }

  /** Picks player 2's sorcerer; the host reflects it in the lobby immediately. */
  selectCharacter(characterId: CharacterId): void {
    this.send(makePacket('P2_SELECT_CHARACTER', GUEST_SEAT, { characterId }));
  }

  /** Votes for a rematch. The host launches once both seats have voted. */
  voteRematch(): void {
    this.send(makePacket('VOTE_REMATCH', GUEST_SEAT, { vote: true }));
  }

  flip(cardId: string, boardId: string): void {
    this.send(makePacket('ACTION_FLIP_CARD', GUEST_SEAT, { cardId, boardId }));
  }

  cast(ability: 'SKILL' | 'ULTIMATE'): void {
    this.send(makePacket('ACTION_CAST_SKILL', GUEST_SEAT, { ability }));
  }

  answerEscape(escape: boolean): void {
    this.send(makePacket('ACTION_ANSWER_ESCAPE', GUEST_SEAT, { escape }));
  }

  pickCourtroomSlot(slot: number): void {
    this.send(makePacket('ACTION_COURTROOM_PICK', GUEST_SEAT, { slot }));
  }

  prosecuteCourtroom(subject: CardSubjectId): void {
    this.send(makePacket('ACTION_COURTROOM_PROSECUTE', GUEST_SEAT, { subject }));
  }

  chooseBlessing(blessing: BlessingId): void {
    this.send(makePacket('ACTION_CHOOSE_BLESSING', GUEST_SEAT, { blessing }));
  }

  ping(): void {
    const sentAt = Date.now();
    this.waitingPing = { nonce: sentAt, sentAt };
    this.send(makePacket('PING_PONG', GUEST_SEAT, { nonce: sentAt }));
  }
}
