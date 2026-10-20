import type {
  BlessingId,
  BoardClearRewardMode,
  BoardId,
  BoardMode,
  CardId,
  CardSubjectId,
  CharacterId,
  DamageCause,
  DomainId,
  GameEvent,
  MatchResult,
  PlayerId,
  PublicMatchView,
  TurnQueueItem,
  UltimateId,
  UltimateType,
  VfxCue,
} from '../engine/index.js';

/**
 * Wire protocol between the host (seat 0, player 1) and the guest (seat 1, player 2).
 *
 * The host is authoritative: it owns the `GameEngine`, applies every action and streams
 * public state snapshots. The guest never simulates the match — it renders the snapshots
 * and asks for actions. Nothing private ever crosses the wire: `PublicMatchView` already
 * hides face-down cards, and a trap's identity only appears once it is face up.
 */

/**
 * Protocol revision. A host and a guest on different revisions refuse the handshake.
 * Revision 2 added the co-op lobby (character pick), the explicit match-start packets and
 * the rematch vote handshake.
 */
export const NETWORK_PROTOCOL_VERSION = 2;

/** Seat 0 is the host, seat 1 the guest. The engine seats are p1 and p2 in that order. */
export type SeatIndex = 0 | 1;

export type NetworkMessageType =
  | 'ROOM_JOIN_REQUEST'
  | 'ROOM_READY'
  | 'SYNC_GAME_CONFIG'
  | 'START_MATCH'
  | 'START_REMATCH_MATCH'
  | 'SYNC_BOARD_STATE'
  | 'VOTE_REMATCH'
  | 'P2_SELECT_CHARACTER'
  | 'ACTION_FLIP_CARD'
  | 'ACTION_CAST_SKILL'
  | 'ACTION_ANSWER_ESCAPE'
  | 'ACTION_COURTROOM_PICK'
  | 'ACTION_COURTROOM_PROSECUTE'
  | 'ACTION_CHOOSE_BLESSING'
  | 'EVENT_MATCH_RESULT'
  | 'EVENT_DAMAGE_APPLIED'
  | 'EVENT_DOMAIN_ACTIVATED'
  | 'PING_PONG';

export interface NetworkPacket<T = unknown> {
  readonly type: NetworkMessageType;
  /** 0: Host, 1: Guest. */
  readonly senderIndex: SeatIndex;
  readonly payload: T;
  /** Sender clock in milliseconds (`Date.now()`), used for latency and staleness only. */
  readonly timestamp: number;
}

export interface JoinRequestPayload {
  readonly protocol: number;
  /** Display name the guest picked, shown on the host's side. */
  readonly guestName: string;
}

export interface RoomReadyPayload {
  readonly protocol: number;
  readonly accepted: boolean;
  /** Why a handshake was refused, in the host's words. */
  readonly reason: string | null;
  readonly roomCode: string;
}

export interface PlayerSetupPayload {
  readonly id: PlayerId;
  readonly characterId: CharacterId;
}

/** The match the host created; the guest adopts it instead of its own setup choices. */
export interface GameConfigPayload {
  readonly roomCode: string;
  readonly boardMode: BoardMode;
  readonly boardSize: 16 | 36;
  readonly startingHp: number;
  readonly trapCount: number;
  readonly synergyPairCount: number;
  readonly boardClearReward: BoardClearRewardMode;
  readonly players: readonly PlayerSetupPayload[];
  readonly hostName: string;
}

/**
 * The host's launch packet for a fresh match. `initialState` is the first public snapshot:
 * the guest adopts it instead of simulating anything, so both screens open the same board.
 */
export interface MatchStartPayload {
  readonly config: GameConfigPayload;
  readonly initialState: BoardStatePayload;
}

/** The joining player's sorcerer. Sent as soon as they click a character card. */
export interface P2SelectCharacterPayload {
  readonly characterId: CharacterId;
}

/** One seat's rematch vote. The host launches once both seats have voted. */
export interface VoteRematchPayload {
  readonly vote: boolean;
}

export interface BoardStatePayload {
  readonly view: PublicMatchView;
  readonly queue: readonly TurnQueueItem[];
  /** Events the host has not sent yet, minus the three that travel as EVENT_* packets. */
  readonly events: readonly GameEvent[];
  /** The host's engine clock when the snapshot was taken, so the guest can align timers. */
  readonly sentAt: number;
}

export interface FlipCardPayload {
  readonly cardId: CardId;
  readonly boardId: BoardId;
}

export type CastableKind = 'SKILL' | 'ULTIMATE';

export interface CastSkillPayload {
  readonly ability: CastableKind;
}

export interface AnswerEscapePayload {
  readonly escape: boolean;
}

export interface CourtroomPickPayload {
  readonly slot: number;
}

export interface ChooseBlessingPayload {
  readonly blessing: BlessingId;
}

export interface CourtroomProsecutePayload {
  readonly subject: CardSubjectId;
}

export interface MatchResultPayload {
  readonly result: MatchResult;
}

export interface DamageAppliedPayload {
  readonly sourceId: PlayerId;
  readonly targetId: PlayerId;
  readonly dealt: number;
  readonly absorbed: number;
  readonly critical: boolean;
  readonly piercing: boolean;
  readonly cause: DamageCause;
}

/** Mirrors the engine's ULTIMATE_ACTIVATED event, so the guest can replay its cue. */
export interface DomainActivatedPayload {
  readonly playerId: PlayerId;
  readonly characterId: CharacterId;
  readonly ultimateId: UltimateId;
  readonly name: string;
  readonly cost: number;
  readonly ultimateType: UltimateType;
  readonly domainId: DomainId | null;
  readonly turnsRemaining: number | null;
  readonly vfx: VfxCue;
}

export interface PingPongPayload {
  /** Echoed unchanged, so the sender can match a reply to its request. */
  readonly nonce: number;
}

const MESSAGE_TYPES: readonly NetworkMessageType[] = [
  'ROOM_JOIN_REQUEST',
  'ROOM_READY',
  'SYNC_GAME_CONFIG',
  'START_MATCH',
  'START_REMATCH_MATCH',
  'SYNC_BOARD_STATE',
  'VOTE_REMATCH',
  'P2_SELECT_CHARACTER',
  'ACTION_FLIP_CARD',
  'ACTION_CAST_SKILL',
  'ACTION_ANSWER_ESCAPE',
  'ACTION_COURTROOM_PICK',
  'ACTION_COURTROOM_PROSECUTE',
  'ACTION_CHOOSE_BLESSING',
  'EVENT_MATCH_RESULT',
  'EVENT_DAMAGE_APPLIED',
  'EVENT_DOMAIN_ACTIVATED',
  'PING_PONG',
];

export function isNetworkMessageType(value: unknown): value is NetworkMessageType {
  return typeof value === 'string' && (MESSAGE_TYPES as readonly string[]).includes(value);
}

export function makePacket<T>(
  type: NetworkMessageType,
  senderIndex: SeatIndex,
  payload: T,
  timestamp = Date.now(),
): NetworkPacket<T> {
  return { type, senderIndex, payload, timestamp };
}

/** Serializes a packet for the data channel. */
export function encodePacket(packet: NetworkPacket): string {
  return JSON.stringify(packet);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses and structurally validates a packet off the wire.
 *
 * Anything malformed returns null instead of throwing: a peer is untrusted input, and a
 * bad frame must not take the match loop down. Payload shapes are checked by the
 * handlers that consume them.
 */
export function decodePacket(raw: unknown): NetworkPacket | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4_000_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { type, senderIndex, payload, timestamp } = parsed;
  if (!isNetworkMessageType(type)) return null;
  if (senderIndex !== 0 && senderIndex !== 1) return null;
  if (!isRecord(payload)) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  return { type, senderIndex, payload, timestamp };
}

// ---------------------------------------------------------------------------
// Payload guards
// ---------------------------------------------------------------------------

export function asJoinRequest(payload: unknown): JoinRequestPayload | null {
  if (!isRecord(payload)) return null;
  const { protocol, guestName } = payload;
  if (typeof protocol !== 'number' || !Number.isInteger(protocol)) return null;
  if (typeof guestName !== 'string' || guestName.length > 32) return null;
  return { protocol, guestName };
}

export function asRoomReady(payload: unknown): RoomReadyPayload | null {
  if (!isRecord(payload)) return null;
  const { protocol, accepted, reason, roomCode } = payload;
  if (typeof protocol !== 'number' || typeof accepted !== 'boolean') return null;
  if (reason !== null && typeof reason !== 'string') return null;
  if (typeof roomCode !== 'string') return null;
  return { protocol, accepted, reason, roomCode };
}

export function asGameConfig(payload: unknown): GameConfigPayload | null {
  if (!isRecord(payload)) return null;
  const {
    roomCode,
    boardMode,
    boardSize,
    startingHp,
    trapCount,
    synergyPairCount,
    boardClearReward,
    players,
    hostName,
  } = payload;
  if (typeof roomCode !== 'string') return null;
  if (boardMode !== 'DUAL' && boardMode !== 'DUAL_TURN_BASED' && boardMode !== 'SHARED') return null;
  if (boardSize !== 16 && boardSize !== 36) return null;
  if (typeof startingHp !== 'number' || typeof trapCount !== 'number' || typeof synergyPairCount !== 'number') return null;
  if (boardClearReward !== 'MANUAL_CHOICE' && boardClearReward !== 'RANDOM_AUTO') return null;
  if (!Array.isArray(players) || players.length !== 2) return null;
  for (const player of players) {
    if (!isRecord(player) || typeof player.id !== 'string' || typeof player.characterId !== 'string') return null;
  }
  if (typeof hostName !== 'string') return null;
  return {
    roomCode,
    boardMode,
    boardSize,
    startingHp,
    trapCount,
    synergyPairCount,
    boardClearReward,
    players: players as PlayerSetupPayload[],
    hostName,
  };
}

export function asBoardState(payload: unknown): BoardStatePayload | null {
  if (!isRecord(payload)) return null;
  const { view, queue, events, sentAt } = payload;
  if (!isRecord(view) || !Array.isArray(view.boards) || !Array.isArray(view.players)) return null;
  if (!Array.isArray(queue) || !Array.isArray(events)) return null;
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return null;
  if (typeof view.result !== 'object' && view.result !== null) return null;
  return {
    view: view as unknown as PublicMatchView,
    queue: queue as TurnQueueItem[],
    events: events as GameEvent[],
    sentAt,
  };
}

export function asMatchStart(payload: unknown): MatchStartPayload | null {
  if (!isRecord(payload)) return null;
  const config = asGameConfig(payload.config);
  const initialState = asBoardState(payload.initialState);
  if (!config || !initialState) return null;
  return { config, initialState };
}

export function asP2SelectCharacter(payload: unknown): P2SelectCharacterPayload | null {
  if (!isRecord(payload)) return null;
  const { characterId } = payload;
  if (typeof characterId !== 'string' || characterId.length === 0 || characterId.length > 64) return null;
  return { characterId: characterId as CharacterId };
}

export function asVoteRematch(payload: unknown): VoteRematchPayload | null {
  if (!isRecord(payload)) return null;
  const { vote } = payload;
  if (typeof vote !== 'boolean') return null;
  return { vote };
}

export function asFlipCard(payload: unknown): FlipCardPayload | null {
  if (!isRecord(payload)) return null;
  const { cardId, boardId } = payload;
  if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > 64) return null;
  if (typeof boardId !== 'string' || boardId.length === 0) return null;
  return { cardId, boardId };
}

export function asCastSkill(payload: unknown): CastSkillPayload | null {
  if (!isRecord(payload)) return null;
  const { ability } = payload;
  if (ability !== 'SKILL' && ability !== 'ULTIMATE') return null;
  return { ability };
}

export function asAnswerEscape(payload: unknown): AnswerEscapePayload | null {
  if (!isRecord(payload)) return null;
  const { escape } = payload;
  if (typeof escape !== 'boolean') return null;
  return { escape };
}

export function asCourtroomPick(payload: unknown): CourtroomPickPayload | null {
  if (!isRecord(payload)) return null;
  const { slot } = payload;
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot > 3) return null;
  return { slot };
}

export function asCourtroomProsecute(payload: unknown): CourtroomProsecutePayload | null {
  if (!isRecord(payload)) return null;
  const { subject } = payload;
  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 64) return null;
  return { subject: subject as CardSubjectId };
}

export function asChooseBlessing(payload: unknown): ChooseBlessingPayload | null {
  if (!isRecord(payload)) return null;
  const { blessing } = payload;
  if (typeof blessing !== 'string' || blessing.length === 0 || blessing.length > 64) return null;
  // The engine checks the id against the three offered blessings and refuses anything else.
  return { blessing: blessing as BlessingId };
}

export function asMatchResult(payload: unknown): MatchResultPayload | null {
  if (!isRecord(payload) || !isRecord(payload.result)) return null;
  const result = payload.result;
  if (typeof result.winnerId !== 'string' && result.winnerId !== null) return null;
  if (typeof result.reason !== 'string' || typeof result.endedAt !== 'number') return null;
  return { result: result as unknown as MatchResult };
}

export function asDamageApplied(payload: unknown): DamageAppliedPayload | null {
  if (!isRecord(payload)) return null;
  const { sourceId, targetId, dealt, absorbed, critical, piercing, cause } = payload;
  if (typeof sourceId !== 'string' || typeof targetId !== 'string') return null;
  if (typeof dealt !== 'number' || typeof absorbed !== 'number' || typeof critical !== 'boolean') return null;
  if (typeof piercing !== 'boolean') return null;
  if (typeof cause !== 'string') return null;
  return { sourceId, targetId, dealt, absorbed, critical, piercing, cause: cause as DamageCause };
}

export function asDomainActivated(payload: unknown): DomainActivatedPayload | null {
  if (!isRecord(payload)) return null;
  const { playerId, characterId, ultimateId, name, cost, ultimateType, domainId, turnsRemaining, vfx } = payload;
  if (typeof playerId !== 'string' || typeof characterId !== 'string') return null;
  if (typeof ultimateId !== 'string' || typeof name !== 'string' || typeof cost !== 'number') return null;
  if (ultimateType !== 'DOMAIN' && ultimateType !== 'SIMPLE_DOMAIN_MAXIMUM') return null;
  if (domainId !== null && typeof domainId !== 'string') return null;
  if (turnsRemaining !== null && typeof turnsRemaining !== 'number') return null;
  if (typeof vfx !== 'string') return null;
  return {
    playerId,
    characterId: characterId as CharacterId,
    ultimateId: ultimateId as UltimateId,
    name,
    cost,
    ultimateType,
    domainId: domainId as DomainId | null,
    turnsRemaining,
    vfx: vfx as VfxCue,
  };
}

export function asPingPong(payload: unknown): PingPongPayload | null {
  if (!isRecord(payload)) return null;
  const { nonce } = payload;
  if (typeof nonce !== 'number' || !Number.isFinite(nonce)) return null;
  return { nonce };
}
