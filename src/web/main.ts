import { AiController, engineHost, startAiDriver } from '../ai/ai-controller.js';
import { AI_GRADE, AI_GRADE_ORDER, AI_GRADE_PROFILES, type AiGrade } from '../ai/difficulty.js';
import {
  BOARD_CLEAR_REWARD,
  BOARD_MODE,
  CARD_EFFECT_KIND,
  CARD_STATE,
  CARD_TYPE,
  CHARACTERS,
  CHARACTER_IDS,
  DOMAINS,
  GAME_CONSTANTS,
  GAME_PACING,
  HP_LIMITS,
  SHARED_BOARD_ID,
  SKILLS,
  STATUS_KIND,
  SYNERGIES,
  TRAPS,
  TURN_PHASE,
  ULTIMATES,
  ULTIMATE_TYPE,
  GameEngine,
  RANDOM_CHOICE,
  attemptOfPlayer,
  canPlayerAct,
  createCryptoRandom,
  isCharacterId,
  resolveMatchConfig,
  rollSetup,
  soundCuesForEvents,
  isTurnBasedMode,
  usesOwnBoards,
  type BoardId,
  type BoardMode,
  type CardEffectKind,
  type CardSubjectId,
  type CharacterId,
  type DamageCause,
  type EngineResult,
  type GameEvent,
  type MatchConfig,
  type MatchResult,
  type MatchSetup,
  type PlayerId,
  type SetupBoardClearReward,
  type SetupBoardLayout,
  type SetupCharacter,
  type SetupCount,
  type SetupGridSize,
  type SetupOpponent,
  type SetupStartingHp,
  type PublicAttemptView,
  type PublicBoardView,
  type PublicCardView,
  type PublicMatchView,
  type PublicPlayerView,
  type StatusKind,
  type BlessingId,
  type TurnQueueItem,
  type VfxCue,
} from '../engine/index.js';
import { OnlineGuest, OnlineHost, toGameConfigPayload, type GuestHooks, type HostHooks } from '../net/online.js';
import {
  createRoomCode,
  hostRoom,
  joinRoom,
  normalizeRoomCode,
  type PeerRoom,
  type PeerStatus,
} from '../net/peer.js';
import type { BoardStatePayload, GameConfigPayload } from '../net/network.js';
import { RematchTally } from './match-result-modal.js';
import { domainStatusOf, domainStatusTitle, renderDomainStatus } from './domain-status.js';
import { createCardButton, SUBJECT_GLYPH, TRANSFIGURED_FLESH_ART } from './card-face.js';
import { cardIconFor, renderCardIcon, TRAP_ICON } from './card-icons.js';
import { arrangeBoards } from './dual-boards.js';
import { SUBJECT_LABELS, createGuideBook } from './guidebook.js';
import { createSandboxToolbar, type SandboxToolbar } from './sandbox-toolbar.js';
import { mountSoundToggle } from './sound-toggle.js';
import { renderTurnQueue } from './turn-queue.js';
import { clearAllVfx, createVfxLayer, type VfxLayer } from './vfx.js';
import { createSentencingModal, type SentencingModal } from './deadly-sentencing-modal.js';
import { blessingTitle, createAwakeningModal, showAwakeningToast, type AwakeningModal } from './awakening-modal.js';
import { createHakariDomainModal, type HakariDomainModal, type PachinkoView } from './hakari-domain-modal.js';
import { createSealStampVfx } from './seal-stamp.js';
import { DuelTally, renderMatchFinisher } from './match-finisher.js';
import { createFloatingCombatText, type FloatingCombatText } from './floating-combat-text.js';
import {
  TRAP_BURST_MS,
  TRAP_IMPACT_LAG_MS,
  TRAP_IMPACT_MS,
  TRAP_PLANT_CLASS,
  TRAP_PLANT_CLASSES,
  TRAP_PLANT_MS,
  TRAP_POP_MS,
  flipBurstKind,
  flipWithTrapBurst,
  isDetonationConsequence,
  startTrapBurst,
  trapPopClass,
  trapPopSelector,
} from './trap-pop.js';
import { playDiceRoll, playExecutionerSlash, playTalismanSealStamp, sfx } from '../utils/sfx.js';
import { bgm } from '../utils/bgm.js';
import { OST_TRACK } from '../engine/bgm-tension.js';
import { applyAudioSettings, loadAudioSettings, saveAudioSettings } from '../utils/audio-settings.js';
import { createSettingsModal } from './settings-modal.js';

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const P1: PlayerId = 'p1';
const P2: PlayerId = 'p2';

const MODE = { PVE: 'PVE', PVP: 'PVP', ONLINE: 'ONLINE', SANDBOX: 'SANDBOX', RANDOM: 'RANDOM' } as const;
type ModeChoice = (typeof MODE)[keyof typeof MODE];
/** A match mode after resolution: `RANDOM` never survives into a running session. */
type Mode = Exclude<ModeChoice, 'RANDOM'>;

const NET_ROLE = { HOST: 'HOST', JOIN: 'JOIN' } as const;
type NetRole = (typeof NET_ROLE)[keyof typeof NET_ROLE];

type LogTone = 'good' | 'black' | 'domain' | 'info' | 'bad';

interface Session {
  /** Null on the guest: the host owns the authoritative engine. */
  readonly engine: GameEngine | null;
  readonly mode: Mode;
  /** Mutable: the training ground can switch between shared and dual grids mid-match. */
  boardMode: BoardMode;
  /** Grid size of this match, so a reshuffled grid can be laid out again. */
  readonly boardSize: number;
  /** Board elements keyed by boardId. Replaced when the training ground switches layout. */
  boardElements: ReadonlyMap<BoardId, HTMLElement>;
  readonly labels: ReadonlyMap<PlayerId, string>;
  /** Seats a human controls at this keyboard. */
  readonly humanSeats: ReadonlySet<PlayerId>;
  /** performance.now() at match start; engine time is measured from here. */
  readonly origin: number;
  readonly stopBot: (() => void) | null;
  readonly netRole: NetRole | null;
  readonly room: PeerRoom | null;
  readonly host: OnlineHost | null;
  readonly guest: OnlineGuest | null;
  /** Latest public snapshot pushed by the host; only the guest has one. */
  remote: BoardStatePayload | null;
  /** The resolved rules this match runs on, kept for a seamless online rematch. */
  readonly config: MatchConfig | null;
  /** The room code the connection was opened with, for rematch announcements. */
  readonly roomCode: string | null;
}

let session: Session | null = null;
let vfx: VfxLayer | null = null;
let sandboxToolbar: SandboxToolbar | null = null;
let netPingTimer: number | null = null;
/** Both seats' rematch votes, shown on the result overlay. */
const rematchVotes = new RematchTally();
/** The sorcerer the joining player has picked, mirrored locally before the host confirms. */
let selectedGuestCharacter: CharacterId | null = null;
/** What the host's locked P2 line shows: the guest's pick, or null while waiting. */
let hostGuestCharacter: CharacterId | null = null;
/** Players whose next critical hit is the damage half of a Black Flash that just landed. */
const blackFlashPending = new Set<PlayerId>();
/** True while a trap burst owns the grid: no card may be turned over until it ends. */
let boardLocked = false;
/** True while a trap burst is on screen: the board is not redrawn from under it. */
let renderHeld = false;
/** True while a room is being torn down, so teardown status cannot look like gameplay. */
let closingNet = false;
/** The newest online snapshot waiting for the next animation frame, if any. */
let pendingSnapshot: { readonly snapshot: BoardStatePayload; readonly events: readonly GameEvent[] } | null = null;
/** The frame a pending snapshot is parked on, so a burst of packets costs one render. */
let snapshotFrame: number | null = null;
/** Counts what each fighter did this match, for the finisher. */
const duel = new DuelTally();

const MODE_LABEL: Record<Mode, string> = {
  [MODE.PVE]: 'Player vs AI',
  [MODE.PVP]: 'Pass & Play',
  [MODE.ONLINE]: 'Online',
  [MODE.SANDBOX]: 'Training Grounds',
};

const BOARD_MODE_LABEL: Record<BoardMode, string> = {
  [BOARD_MODE.DUAL]: 'Dual boards · simultaneous',
  [BOARD_MODE.DUAL_TURN_BASED]: 'Dual boards · turn based',
  [BOARD_MODE.SHARED]: 'Shared board · turn based',
};

const CAUSE_LABEL: Record<DamageCause, string> = {
  MATCH: '',
  SYNERGY: 'synergy',
  SKILL: 'technique',
  ULTIMATE: 'domain',
  OVER_TIME: 'burn',
  SHOCKWAVE: 'delayed shockwave',
  RECOIL: 'resonance recoil',
  CARD_EFFECT: 'card trap',
};

const MODIFIER_GLYPH: Record<string, string> = {
  [CARD_EFFECT_KIND.NAILED]: '釘',
  [CARD_EFFECT_KIND.LAVA]: '蟲',
  [CARD_EFFECT_KIND.FLESH]: '躯',
  [CARD_EFFECT_KIND.LOCKED]: '封',
};

/** Card hazard rendered on the card itself: the modifier, or a face-up trap. */
type Hazard = 'TRAP' | 'NAILED' | 'LAVA' | 'FLESH' | 'LOCKED' | '';

/**
 * What to draw on a card. Modifiers are public information (they are announced when
 * planted), so they show on face-down cards too. A trap stays anonymous until it is
 * face-up: the grid is a memory game and hidden cards must not leak their identity.
 */
function hazardOf(card: PublicCardView): Hazard {
  if (card.locked) return 'LOCKED';
  const last = card.effectModifiers.at(-1);
  if (last) {
    if (last.kind === CARD_EFFECT_KIND.NAILED) return 'NAILED';
    if (last.kind === CARD_EFFECT_KIND.LAVA) return 'LAVA';
    if (last.kind === CARD_EFFECT_KIND.FLESH) return 'FLESH';
  }
  if (card.type === CARD_TYPE.TRAP) return 'TRAP';
  return card.corrupted ? 'FLESH' : '';
}

/** Why a click may be refused, in the player's words. */
const REJECT_LABEL: Partial<Record<string, string>> = {
  NOT_YOUR_TURN: 'Not your turn yet',
  WRONG_BOARD: "That card is on the other fighter's grid",
  CARD_UNAVAILABLE: 'That card is already face up',
  CARD_LOCKED: 'That card is sealed by a domain',
  CARD_NOT_FOUND: 'No such card',
  EVALUATING: 'Wait for this reveal to finish',
  FLIP_IN_PROGRESS: 'Finish your flip first',
  STUNNED: 'You are stunned',
  INSUFFICIENT_CE: 'Not enough cursed energy',
  DOMAIN_ALREADY_ACTIVE: 'Your domain is already open',
  GAME_OVER: 'The match is over',
  NOT_STARTED: 'The match has not started',
};

const STATUS_LABEL: Record<StatusKind, string> = {
  [STATUS_KIND.IMMORTAL]: 'unkillable',
  [STATUS_KIND.ABSOLUTE_SHIELD]: 'Infinity',
  [STATUS_KIND.SHIELD]: 'barrier',
  [STATUS_KIND.CRITICAL_STRIKE]: 'critical strike',
  [STATUS_KIND.FLASH_WINDOW]: 'Black Flash window',
  [STATUS_KIND.PIERCING_ATTACKS]: 'shield piercing',
  [STATUS_KIND.DAMAGE_OVER_TIME]: 'burn',
  [STATUS_KIND.DIVERGENT_MARK]: 'Divergent Fist mark',
  [STATUS_KIND.SHOCKWAVE]: 'shockwave armed',
  [STATUS_KIND.RESONANCE_RECOIL]: 'resonance recoil',
  [STATUS_KIND.EXTRA_FLIP]: 'extra flip',
  [STATUS_KIND.SKIP_TURNS]: 'turn skipped',
  [STATUS_KIND.SHORT_TIMER]: 'rushed clock',
  [STATUS_KIND.CE_LOCKED]: 'CE locked',
  [STATUS_KIND.MAX_HP_REDUCTION]: 'reduced max HP',
  [STATUS_KIND.DOMAIN_NULLIFIED]: 'domain neutralized',
  [STATUS_KIND.GAMBLE_TURN]: 'gamble',
  [STATUS_KIND.DAMAGE_BOOST]: 'damage boost',
  [STATUS_KIND.SOUL_STRIKE]: 'Soul Strike',
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function part<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  return part<T>(document, selector);
}

/**
 * Writes text only when it actually changed.
 *
 * The render loop paints every frame, but a value that did not move must not touch the DOM:
 * assigning the same string still replaces the text node, which marks the panel dirty, wakes
 * the layout and repaints a number nobody can see change. HP is the worst offender because
 * it is the value a player stares at while they are losing.
 */
function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

/** The same guard for a bar's width, in percent: an identical width is not a style change. */
function setBarWidth(element: HTMLElement, fraction: number): void {
  const percent = Math.max(0, Math.min(100, fraction * 100));
  const width = `${percent}%`;
  if (element.style.width !== width) element.style.width = width;
}

function panelEl(playerId: PlayerId): HTMLElement {
  return $(`.side[data-player="${playerId}"] .panel`);
}

function humanize(code: string): string {
  const known = REJECT_LABEL[code];
  if (known) return known;
  const text = code.toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Type pill shown on the front face. */
function kindLabel(type: PublicCardView['type']): string {
  if (type === CARD_TYPE.TRAP) return '[CURSED OBJECT]';
  if (type === CARD_TYPE.SYNERGY) return '[SYNERGY]';
  if (type === CARD_TYPE.STANDARD) return '[PAIR]';
  return '';
}

/**
 * Compact pill wording. The footer tray is barely a card wide, so the pill prints a short
 * tag while the face carries the full wording as its label; the name above it never
 * truncates, which is where the room goes.
 */
function kindShortLabel(type: PublicCardView['type']): string {
  if (type === CARD_TYPE.TRAP) return '[CURSE]';
  if (type === CARD_TYPE.SYNERGY) return '[SYN]';
  if (type === CARD_TYPE.STANDARD) return '[PAIR]';
  return '';
}

/**
 * Name printed on the front face.
 *
 * Three kinds of card, three sources, all from the catalog so nothing can drift:
 *  - a trap prints its own short title ("Finger"), never the fighter it depicts
 *  - a fighter prints its character name
 *  - a summon or tool on a synergy card prints the codex wording ("Divine Dog")
 */
function cardTitle(card: PublicCardView): string {
  if (card.characterId === null) return '';
  if (card.type === CARD_TYPE.TRAP && card.trapId !== null) return TRAPS[card.trapId].cardTitle;
  return subjectLabel(card.characterId);
}

/** Character name, or the codex wording for a summon or tool. */
function subjectLabel(subjectId: string): string {
  if (isCharacterId(subjectId)) return CHARACTERS[subjectId].name;
  return SUBJECT_LABELS[subjectId as keyof typeof SUBJECT_LABELS] ?? subjectId.replace(/_/g, ' ');
}



const pendingTimers = new Set<number>();

function later(callback: () => void, delay: number): void {
  const id = window.setTimeout(() => {
    pendingTimers.delete(id);
    callback();
  }, delay);
  pendingTimers.add(id);
}

function elapsed(): number {
  return session ? performance.now() - session.origin : 0;
}

/**
 * The match as this client may see it: the guest renders the host's snapshot, everyone
 * else renders their own engine projection. One accessor keeps the two paths honest —
 * no renderer can accidentally read an engine the guest does not own.
 */
function currentView(): PublicMatchView | null {
  const current = session;
  if (!current) return null;
  return current.remote?.view ?? current.engine?.getPublicView() ?? null;
}

function currentQueue(): readonly TurnQueueItem[] {
  const current = session;
  if (!current) return [];
  return current.remote?.queue ?? current.engine?.getUpcomingTurnQueue(3) ?? [];
}

/** Engine time for this client: the guest's host-aligned clock, or the local origin. */
function clockNow(): number {
  return session?.guest?.clock() ?? elapsed();
}

function labelOf(id: PlayerId): string {
  return session?.labels.get(id) ?? id.toUpperCase();
}

function boardLabel(boardId: BoardId): string {
  return boardId === SHARED_BOARD_ID ? 'Shared grid' : `${labelOf(boardId)}'s grid`;
}

/** Flashes specific cards, for effects that plant or reveal something on the grid. */
function sparkCards(boardId: BoardId | null, cardIds: readonly string[]): void {
  const current = session;
  if (!current || cardIds.length === 0) return;
  const roots = boardId === null ? [...current.boardElements.values()] : [current.boardElements.get(boardId)];
  for (const root of roots) {
    if (!root) continue;
    for (const card of root.querySelectorAll<HTMLElement>('button.card')) {
      const id = card.dataset.cardId;
      if (id === undefined || !cardIds.includes(id)) continue;
      card.classList.remove('spark');
      void card.offsetWidth;
      card.classList.add('spark');
      later(() => card.classList.remove('spark'), 900);
    }
  }
}

/**
 * Hands the board back after a burst: the redraw that was held now runs, so the card
 * finally changes over.
 */
function releaseBurst(): void {
  if (!renderHeld && !boardLocked) return;
  boardLocked = false;
  renderHeld = false;
  renderFrame();
}

/** Cards a skill planted a trap on this frame, waiting for the grid to be drawn. */
const pendingTrapPlants = new Map<string, CardEffectKind>();

/**
 * Plays the planting animation on each card queued by `CARD_MODIFIED`: the card settles
 * under the blow and the trap is driven down onto its face. Runs after the boards render,
 * so the hazard art it animates is the one on screen.
 */
function flushTrapPlants(): void {
  if (pendingTrapPlants.size === 0) return;
  for (const [cardId, modifier] of pendingTrapPlants) {
    const card = cardEl(cardId);
    if (!card) continue;
    const art = card.querySelector<HTMLElement>(trapPopSelector(modifier));
    const plant = TRAP_PLANT_CLASS[modifier];
    card.classList.remove('trap-planting-card');
    for (const className of TRAP_PLANT_CLASSES) art?.classList.remove(className);
    void card.offsetWidth; // restart the impact and the plant with it
    card.classList.add('trap-planting-card');
    art?.classList.add(plant);
    later(() => {
      card.classList.remove('trap-planting-card');
      art?.classList.remove(plant);
    }, TRAP_PLANT_MS);
  }
  pendingTrapPlants.clear();
}

/** True while the card is wearing a burst: the click handler may have played it already. */
function isBurstPlaying(card: HTMLElement | null): boolean {
  return card !== null && card.classList.contains('trap-triggering-card');
}

/**
 * The trap the engine just set off: the card kicks and its art bursts off the face.
 *
 * A burst the click handler already played is left running — it is on screen right now,
 * and replaying it would throw the card back to the start of the animation. Only its
 * consequences are left to land.
 *
 * `onImpact` is the detonation's consequence — the damage number, the stun, the log line.
 * It runs `TRAP_IMPACT_MS` (800ms) later, so the burst plays out before the hit is
 * announced, and the temporary classes are cleared once it has landed.
 */
function trapPop(cardId: string, modifier: CardEffectKind | null, onImpact?: () => void): void {
  const card = cardEl(cardId);
  if (isBurstPlaying(card)) {
    // The burst is already on the card: its consequences land as the burst finishes.
    if (onImpact) later(onImpact, TRAP_IMPACT_LAG_MS);
    return;
  }
  if (!card) {
    // The card left the grid between the event and this frame: the hit still happens.
    if (onImpact) later(onImpact, TRAP_IMPACT_MS);
    return;
  }
  startTrapBurst(card, modifier, later);
  if (onImpact) later(onImpact, TRAP_IMPACT_MS);
}

/**
 * The burst a card would play when this seat turns it over, or null when the flip is
 * quiet.
 *
 * The engine fires a planted trap for everyone but the player who planted it, and the
 * view publishes every modifier on every card, so the click handler can know what a flip
 * is about to do before it does it.
 */
function flipBurstFor(cardId: string, actor: PlayerId): CardEffectKind | null {
  const view = currentView();
  if (!view) return null;
  for (const board of view.boards) {
    const card = board.cards.find((candidate) => candidate.id === cardId);
    if (!card) continue;
    // Only a card that can still be turned over can set a trap off.
    if (card.state !== CARD_STATE.HIDDEN || card.locked) return null;
    return flipBurstKind(card.effectModifiers, actor);
  }
  return null;
}

/**
 * A flip that sets a planted trap off: the burst plays first, and the card is only
 * turned over once the burst has finished.
 *
 * The engine resolves a flip in one call and the board is redrawn from its result, so the
 * flip itself has to wait. The trap is watched leaping off the card before the card
 * changes, and the grid is locked while it burns, so a second click cannot land on a card
 * that is already turning over.
 */
function flipWithBurst(
  current: Session,
  actor: PlayerId,
  cardId: string,
  boardId: BoardId,
  burst: CardEffectKind,
): void {
  const card = cardEl(cardId);
  if (!card) {
    // The card left the grid: there is nothing to burst, so the flip goes straight in.
    if (current.guest) current.guest.flip(cardId, boardId);
    else if (current.engine) command(current.engine.flipCard(actor, cardId, clockNow()));
    return;
  }
  // The turn clock stands still while the trap burns, so the player is never charged for
  // watching it go off.
  current.engine?.holdTurnClock(TRAP_BURST_MS);
  if (current.guest) {
    // The guest owns no engine: the host owns the truth. The flip goes out at once, so
    // the host is not charged for the guest's burst, and the report that comes back only
    // lands the consequences — the burst is already running here.
    current.guest.flip(cardId, boardId);
  }
  void flipWithTrapBurst({
    card,
    burst,
    lock: () => {
      boardLocked = true;
    },
    holdRender: () => {
      renderHeld = true;
    },
    release: () => {
      // A transfigured flesh card settles in place: the pop has already played, so the
      // reveal is drawn straight on the face instead of sweeping through a 3D turn.
      if (burst === CARD_EFFECT_KIND.FLESH) {
        card.classList.add('trap-settled');
        later(() => card.classList.remove('trap-settled'), 100);
      }
      releaseBurst();
    },
    schedule: later,
    applyFlip: () => {
      // The match may have been torn down while the trap was going off.
      if (session !== current) return;
      if (current.guest) return;
      if (current.engine) command(current.engine.flipCard(actor, cardId, clockNow()));
    },
  });
}

// ---------------------------------------------------------------------------
// Setup and lifecycle
// ---------------------------------------------------------------------------

function readCharacterChoice(select: HTMLSelectElement): SetupCharacter {
  if (select.value === RANDOM_CHOICE) return RANDOM_CHOICE;
  if (!isCharacterId(select.value)) throw new Error(`Invalid character: ${select.value}`);
  return select.value;
}

function readOpponent(): SetupOpponent {
  const value = $<HTMLSelectElement>('#mode').value;
  return Object.values(MODE).find((candidate) => candidate === value) ?? MODE.PVE;
}

function isSandbox(mode: Mode): boolean {
  return mode === MODE.SANDBOX;
}

function readBoardClearReward(): SetupBoardClearReward {
  const value = $<HTMLSelectElement>('#board-clear-reward').value;
  if (value === RANDOM_CHOICE) return RANDOM_CHOICE;
  const mode = Object.values(BOARD_CLEAR_REWARD).find((candidate) => candidate === value);
  if (!mode) throw new Error(`Unknown board clear reward: ${value}`);
  return mode;
}

function readBoardLayout(): SetupBoardLayout {
  const value = $<HTMLSelectElement>('#board-mode').value;
  if (value === RANDOM_CHOICE) return RANDOM_CHOICE;
  const mode = Object.values(BOARD_MODE).find((candidate) => candidate === value);
  if (!mode) throw new Error(`Unknown board layout: ${value}`);
  return mode;
}

function readGridSize(): SetupGridSize {
  const value = $<HTMLSelectElement>('#board-size').value;
  if (value === RANDOM_CHOICE) return RANDOM_CHOICE;
  return value === '36' ? 36 : 16;
}

/** A count preset, or the `RANDOM` sentinel; anything else is a programming error. */
function readCount(selector: string): SetupCount {
  const value = $<HTMLSelectElement>(selector).value;
  if (value === RANDOM_CHOICE) return RANDOM_CHOICE;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid setup count: ${value}`);
  return count;
}

/** Starting HP for both fighters: a preset, a roll, or the validated custom field. */
function readStartingHp(): SetupStartingHp {
  const choice = $<HTMLSelectElement>('#starting-hp').value;
  if (choice === RANDOM_CHOICE) return RANDOM_CHOICE;
  if (choice !== 'CUSTOM') {
    const preset = Number(choice);
    if (Number.isInteger(preset) && preset >= HP_LIMITS.MIN && preset <= HP_LIMITS.MAX) return preset;
    throw new Error(`Unknown HP preset: ${choice}`);
  }
  const custom = Number($<HTMLInputElement>('#custom-hp').value.trim());
  if (!Number.isInteger(custom) || custom < HP_LIMITS.MIN || custom > HP_LIMITS.MAX) {
    throw new Error(`Custom HP must be a whole number from ${HP_LIMITS.MIN} to ${HP_LIMITS.MAX}`);
  }
  return custom;
}

function readGrade(): AiGrade {
  const value = $<HTMLSelectElement>('#grade').value;
  const grade = AI_GRADE_ORDER.find((candidate) => candidate === value);
  if (!grade) throw new Error(`Invalid AI grade: ${value}`);
  return grade;
}

/** The whole form as the engine's setup language, sentinels included. */
function readSetup(): MatchSetup {
  return {
    opponent: readOpponent(),
    boardLayout: readBoardLayout(),
    boardClearReward: readBoardClearReward(),
    gridSize: readGridSize(),
    startingHp: readStartingHp(),
    p1Character: readCharacterChoice($<HTMLSelectElement>('#p1-character')),
    p2Character: readCharacterChoice($<HTMLSelectElement>('#p2-character')),
    cursedTraps: readCount('#traps'),
    loreSynergies: readCount('#synergies'),
  };
}

function syncSetupFields(): void {
  const opponent = readOpponent();
  const pve = opponent === MODE.PVE;
  const online = opponent === MODE.ONLINE;
  const joining = online && readNetRole() === NET_ROLE.JOIN;
  const hosting = online && readNetRole() === NET_ROLE.HOST;
  // The training dummy has no build to pick: only its grid and HP matter. A guest never
  // picks anything — the host's setup is the match it joins — and a co-op host cannot
  // pick for player 2 at all: the joining player owns that choice.
  $('#p2-field').hidden = pve || opponent === MODE.SANDBOX || joining || hosting;
  $('#p2-locked').hidden = !hosting;
  $('#p2-locked').textContent = hostGuestCharacter
    ? `P2 Choice: ${CHARACTERS[hostGuestCharacter].name}`
    : 'P2 Choice: Waiting for P2 selection...';
  $('#grade-field').hidden = !pve;
  $('#net-field').hidden = !online;
  $('#room-code-field').hidden = !joining;
  $('#start-hint').textContent = online
    ? joining
      ? 'The host creates the match; its board layout, grid size and fighters apply to both players. Pick your sorcerer once you join.'
      : 'You host with these settings. Share the five-character code with player 2, then launch once they pick a sorcerer.'
    : opponent === MODE.RANDOM
      ? 'The opponent will be rolled when the match starts: Player vs AI or Pass & Play.'
      : '';
  const customHp = $<HTMLSelectElement>('#starting-hp').value === 'CUSTOM';
  $('#custom-hp-field').hidden = !customHp;
  if (customHp) $<HTMLInputElement>('#custom-hp').value ||= String(HP_LIMITS.CUSTOM_DEFAULT);
}

/** Simultaneous boards default to the instant roll; turn-based play defaults to the picker. */
function syncBoardClearDefault(): void {
  const layout = readBoardLayout();
  if (layout === RANDOM_CHOICE) return;
  $<HTMLSelectElement>('#board-clear-reward').value =
    layout === BOARD_MODE.DUAL ? BOARD_CLEAR_REWARD.RANDOM_AUTO : BOARD_CLEAR_REWARD.MANUAL_CHOICE;
}

const RANDOM_OPTION_LABEL = '🎲 Random';

function populateSetup(): void {
  const p1Select = $<HTMLSelectElement>('#p1-character');
  const p2Select = $<HTMLSelectElement>('#p2-character');
  p1Select.add(new Option(RANDOM_OPTION_LABEL, RANDOM_CHOICE));
  p2Select.add(new Option(RANDOM_OPTION_LABEL, RANDOM_CHOICE));
  for (const id of CHARACTER_IDS) {
    const character = CHARACTERS[id];
    p1Select.add(new Option(character.name, id));
    p2Select.add(new Option(character.name, id));
  }
  p1Select.value = 'satoru_gojo';
  p2Select.value = 'yuji_itadori';

  const gradeSelect = $<HTMLSelectElement>('#grade');
  for (const grade of AI_GRADE_ORDER) gradeSelect.add(new Option(AI_GRADE_PROFILES[grade].label, grade));
  gradeSelect.value = AI_GRADE.ELITE;

  $<HTMLSelectElement>('#mode').addEventListener('change', syncSetupFields);
  $<HTMLSelectElement>('#net-role').addEventListener('change', syncSetupFields);
  $<HTMLSelectElement>('#starting-hp').addEventListener('change', syncSetupFields);
  $<HTMLSelectElement>('#board-mode').addEventListener('change', syncBoardClearDefault);
  syncSetupFields();
}

/** Writes a rolled setup back into the form so the player can see and tweak it. */
function applySetup(setup: MatchSetup): void {
  const select = (selector: string, value: string | number): void => {
    $<HTMLSelectElement>(selector).value = String(value);
  };
  select('#mode', setup.opponent);
  select('#board-mode', setup.boardLayout);
  select('#board-clear-reward', setup.boardClearReward);
  select('#board-size', setup.gridSize);
  select('#starting-hp', setup.startingHp);
  select('#p1-character', setup.p1Character);
  select('#p2-character', setup.p2Character);
  select('#traps', setup.cursedTraps);
  select('#synergies', setup.loreSynergies);
  syncSetupFields();
}

/**
 * The setup screen's one-click chaos roll: every rule, the grid, the HP pool and both
 * fighters land on a concrete random value, then the dice settle. In a co-op room the
 * opponent and player 2's locked pick are left alone: those belong to the room itself.
 */
function randomizeSetup(): void {
  const hosting = readOpponent() === MODE.ONLINE && readNetRole() === NET_ROLE.HOST;
  const rolled = rollSetup(readSetup(), createCryptoRandom(), {
    lockOpponent: true,
    lockP2Character: hosting,
  });
  applySetup(rolled);
  playDiceRoll();
  // A host already in a room keeps the guest's condition preview in step with the roll.
  if (session?.host && session.engine === null) syncOnlineLobbyPreview();
}


function labelsFor(mode: Mode, config: MatchConfig): Map<PlayerId, string> {
  const p1Name = CHARACTERS[config.players[0].characterId].name;
  const p2Name = CHARACTERS[config.players[1].characterId].name;
  if (isSandbox(mode)) {
    return new Map<PlayerId, string>([
      [P1, `You · ${p1Name}`],
      [P2, 'Training Dummy'],
    ]);
  }
  if (mode === MODE.PVE) {
    return new Map<PlayerId, string>([
      [P1, `You · ${p1Name}`],
      [P2, `AI · ${p2Name}`],
    ]);
  }
  return new Map<PlayerId, string>([
    [P1, `Player 1 · ${p1Name}`],
    [P2, `Player 2 · ${p2Name}`],
  ]);
}

/**
 * Shows the debug drawer for a training match and hides it in every other mode. The
 * controls are handed the live engine, so each button drives real match state.
 */
function mountSandboxToolbar(mode: Mode, engine: GameEngine, boardMode: BoardMode): void {
  sandboxToolbar?.destroy();
  sandboxToolbar = null;
  const root = $('#sandbox-toolbar');
  root.hidden = !isSandbox(mode);
  if (!isSandbox(mode)) {
    root.replaceChildren();
    return;
  }
  sandboxToolbar = createSandboxToolbar({
    root,
    engine,
    me: P1,
    dummy: P2,
    boardMode,
    now: elapsed,
    onResult: applySandboxResult,
    onBoardLayout: switchSandboxLayout,
    onDummyCharacter: assignDummyCharacter,
    onRefresh: renderFrame,
  });
}

function applySandboxResult(result: EngineResult): void {
  if (!result.ok) {
    toast(humanize(result.code));
    return;
  }
  handleEvents(result.events);
  renderFrame();
}

/**
 * Re-deals the training match onto the other layout and moves the grids to match. The engine
 * refuses while a sentencing or an Awakening Surge waits on a grid, so the arena only moves on success.
 */
function switchSandboxLayout(layout: 'shared' | 'dual'): void {
  const current = session;
  if (!current?.engine) return;
  const result = current.engine.debugSwitchBoardLayout(layout, elapsed());
  if (!result.ok) {
    toast(humanize(result.code));
    sandboxToolbar?.setBoardMode(current.boardMode);
    return;
  }
  const boardMode = layout === 'dual' ? BOARD_MODE.DUAL : BOARD_MODE.SHARED;
  if (boardMode !== current.boardMode) {
    const arena = $('#match');
    arena.dataset.boardMode = boardMode;
    arrangeBoards(arena, boardMode);
    current.boardMode = boardMode;
    current.boardElements = collectBoardElements(boardIdsFor(boardMode, [{ id: P1 }, { id: P2 }]));
    sandboxToolbar?.setBoardMode(boardMode);
  }
  // The re-deal events re-deal the new grids, so they must run after the elements are swapped.
  applySandboxResult(result);
}

/** Makes the training dummy fight as another fighter: its skills, ultimate and Domain change. */
function assignDummyCharacter(characterId: CharacterId): void {
  const engine = session?.engine;
  if (!engine) return;
  const result = engine.debugSetDummyCharacter(characterId, elapsed());
  if (result.ok) duel.recast(P2, characterId);
  applySandboxResult(result);
}

function stopSession(): void {
  sentencing.reset();
  hakari.reset();
  awakening.reset();
  sealStamps.reset();
  fct.reset();
  blackFlashPending.clear();
  // A burst that was still burning belongs to the match that is being torn down.
  boardLocked = false;
  renderHeld = false;
  bgm.stop();
  session?.stopBot?.();
  if (netPingTimer !== null) {
    window.clearInterval(netPingTimer);
    netPingTimer = null;
  }
  const room = session?.room ?? null;
  session = null;
  // Closing a room reports its own status; that must not look like a live match event.
  closingNet = true;
  room?.close();
  closingNet = false;
  setNetStatus('');
  hideHostRoom();
  setP2Choice(null);
  selectedGuestCharacter = null;
  $('#guest-picker').hidden = true;
  $('#match-conditions').hidden = true;
  resetRematchUi();
  for (const id of pendingTimers) window.clearTimeout(id);
  pendingTimers.clear();
  // A snapshot parked for the next frame belongs to the match that just ended.
  if (snapshotFrame !== null) window.cancelAnimationFrame(snapshotFrame);
  snapshotFrame = null;
  pendingSnapshot = null;
}

function boardIdsFor(boardMode: BoardMode, players: readonly { id: PlayerId }[]): BoardId[] {
  if (usesOwnBoards(boardMode)) return [players[0]?.id ?? P1, players[1]?.id ?? P2];
  return [SHARED_BOARD_ID];
}

/**
 * Shows the arena for a match and returns the grid elements it now owns.
 *
 * The grids are emptied but not laid out; each format lays out the cards it receives, and
 * the guest lays them out from its first snapshot rather than from a local deal.
 */
function mountArena(
  boardMode: BoardMode,
  boardIds: readonly BoardId[],
  players: readonly { readonly id: PlayerId; readonly characterId: CharacterId }[],
): ReadonlyMap<BoardId, HTMLElement> {
  const arena = $('#match');
  arena.dataset.boardMode = boardMode;
  arrangeBoards(arena, boardMode);
  arena.hidden = false;
  arena.classList.remove('finished');
  duel.reset(new Map(players.map((player) => [player.id, player.characterId])));
  $('#setup').hidden = true;
  $('#result').hidden = true;
  $('#new-match').hidden = false;
  $('#lobby').hidden = true;
  sentencing.reset();
  hakari.reset();
  awakening.reset();
  $('#sandbox-toolbar').hidden = true;
  $('#sandbox-toolbar').replaceChildren();
  $('#log').replaceChildren();
  $('#domain-overlay').className = 'domain-overlay';
  $('#reshuffle').className = 'reshuffle';
  $('#banner').className = 'banner';
  $('#toast').classList.remove('show');
  resetRematchUi();

  return collectBoardElements(boardIds);
}

/** Finds the grid element for each board in use, and empties the grids this layout leaves unused. */
function collectBoardElements(boardIds: readonly BoardId[]): Map<BoardId, HTMLElement> {
  const boardElements = new Map<BoardId, HTMLElement>();
  for (const boardId of boardIds) {
    boardElements.set(boardId, $(`#match .board[data-board="${boardId}"]`));
  }
  for (const element of document.querySelectorAll<HTMLElement>('#match .board')) {
    if (![...boardElements.values()].includes(element)) element.replaceChildren();
  }
  return boardElements;
}

function startMatch(): void {
  // A fresh deal starts from a blank effects surface: no stale particles or overlay may
  // survive from the previous match.
  clearAllVfx();
  const opponent = readOpponent();
  if (opponent === MODE.ONLINE) {
    stopSession();
    if (readNetRole() === NET_ROLE.JOIN) startOnlineGuest();
    else startOnlineHost();
    return;
  }
  stopSession();

  let mode: Mode;
  let grade: AiGrade;
  let config: MatchConfig;
  let engine: GameEngine;
  try {
    grade = readGrade();
    const setup = readSetup();
    const resolved = resolveMatchConfig(setup, createCryptoRandom(), {
      matchId: `match-${Date.now()}`,
      playerIds: [P1, P2],
      ...(opponent === MODE.SANDBOX ? { sandbox: true } : {}),
    });
    const resolvedOpponent = resolved.setup.opponent;
    if (resolvedOpponent === 'RANDOM' || resolvedOpponent === 'ONLINE') {
      throw new Error('The opponent roll must settle on a local mode');
    }
    mode = resolvedOpponent;
    // The AI seat must run the grade's build: the controller casts that character's kit.
    config =
      mode === MODE.PVE
        ? resolveMatchConfig(
            { ...resolved.setup, p2Character: AI_GRADE_PROFILES[grade].characterId },
            createCryptoRandom(),
            { matchId: resolved.config.matchId, playerIds: [P1, P2], opponent: MODE.PVE },
          ).config
        : resolved.config;
    engine = new GameEngine(config, createCryptoRandom());
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
    return;
  }

  const boardMode = config.boardMode;
  // Local matches hear their own engine; the guest has no engine and plays the cues
  // carried by the host's events instead.
  engine.setSoundListener((cue) => sfx.play(cue));
  // This click is the gesture browsers require; the drone fades in under the first turn.
  bgm.ensureAudioContext();
  bgm.start(OST_TRACK.BATTLE_THEME);

  const origin = performance.now();
  const now = (): number => performance.now() - origin;
  const started = engine.start(0);
  if (!started.ok) {
    toast(humanize(started.code));
    return;
  }

  const humanSeats = new Set<PlayerId>(mode === MODE.PVP ? [P1, P2] : [P1]);
  const boardElements = mountArena(boardMode, boardIdsFor(boardMode, config.players), config.players);
  mountSandboxToolbar(mode, engine, boardMode);

  session = {
    engine,
    mode,
    boardMode,
    boardSize: config.boardSize,
    boardElements,
    labels: labelsFor(mode, config),
    humanSeats,
    origin,
    stopBot: null,
    netRole: null,
    room: null,
    host: null,
    guest: null,
    remote: null,
    config,
    roomCode: null,
  };

  // The bot's commands return events that only the driver sees, so forward them to the UI.
  const stopBot =
    mode === MODE.PVE && !isSandbox(mode)
      ? startAiDriver(AiController.forGrade(P2, grade, createCryptoRandom()), engineHost(engine, P2, now), {
          onResult: (result) => {
            handleEvents(result.events);
            renderFrame();
          },
        })
      : null;

  session = { ...session, stopBot };

  buildBoards(engine.getPublicView(), config.boardSize);
  handleEvents(started.events);
  renderFrame();
}

// ---------------------------------------------------------------------------
// Online play
// ---------------------------------------------------------------------------

function readNetRole(): NetRole {
  return $<HTMLSelectElement>('#net-role').value === NET_ROLE.JOIN ? NET_ROLE.JOIN : NET_ROLE.HOST;
}

/** Seat labels for an online match: the local seat is always "You". */
function onlineLabels(config: Pick<GameConfigPayload, 'players'>, role: NetRole): Map<PlayerId, string> {
  const first = config.players[0];
  const second = config.players[1];
  if (!first || !second) throw new Error('An online match needs two players');
  const firstName = CHARACTERS[first.characterId].name;
  const secondName = CHARACTERS[second.characterId].name;
  const host = role === NET_ROLE.HOST;
  return new Map<PlayerId, string>([
    [first.id, host ? `You · ${firstName}` : `Host · ${firstName}`],
    [second.id, host ? `Player 2 · ${secondName}` : `You · ${secondName}`],
  ]);
}

function showLobby(code: string, status: string): void {
  const lobby = $('#lobby');
  lobby.hidden = false;
  $('#setup').hidden = true;
  $('#match').hidden = true;
  $('#result').hidden = true;
  $('#lobby-code').hidden = false;
  $('#lobby-code-value').textContent = code;
  $('#lobby-code').dataset.code = code;
  $('#lobby-hint').textContent =
    'Player 2 opens this app, picks Online / LAN → Join a room, and enters this code. Both machines need a network connection for the introduction; play itself is peer to peer.';
  setLobbyStatus(status);
}

function hideLobby(): void {
  $('#lobby').hidden = true;
}

function setLobbyStatus(text: string, error = false): void {
  const status = $('#lobby-status');
  $('#lobby-status-text').textContent = text;
  status.classList.toggle('error', error);
}

function setNetStatus(text: string): void {
  const status = $('#net-status');
  status.textContent = text;
  status.hidden = text === '';
}

// ---------------------------------------------------------------------------
// Co-op lobby helpers
// ---------------------------------------------------------------------------

/** Resumes both audio contexts from a real click; a suspended one cannot play BGM. */
function ensureCoopAudio(): void {
  sfx.unlock();
  bgm.ensureAudioContext();
}

function setHostStatus(text: string, error = false): void {
  const status = $('#host-status');
  status.textContent = text;
  status.classList.toggle('error', error);
}

/**
 * The setup form's Start Match button is also the Join button in online mode. A dial that is
 * under way disables it, and every dead end re-arms it so a correctable code is never a
 * dead screen.
 */
function setJoinBusy(busy: boolean): void {
  $<HTMLButtonElement>('#setup-form button[type="submit"]').disabled = busy;
}

function showHostRoom(code: string): void {
  $('#host-room').hidden = false;
  $('#host-code').hidden = false;
  $('#host-code-value').textContent = code;
  $('#host-code').dataset.code = code;
  $<HTMLButtonElement>('#launch-match').disabled = hostGuestCharacter === null;
  setHostStatus('Contacting the matchmaking service…');
}

function hideHostRoom(): void {
  $('#host-room').hidden = true;
}

function setP2Choice(characterId: CharacterId | null): void {
  hostGuestCharacter = characterId;
  $('#p2-locked').textContent = characterId
    ? `P2 Choice: ${CHARACTERS[characterId].name}`
    : 'P2 Choice: Waiting for P2 selection...';
  $<HTMLButtonElement>('#launch-match').disabled = characterId === null;
}

/** The host's current rules with a concrete seat 2, used for the lobby preview. */
function onlinePreviewConfig(): MatchConfig {
  return resolveMatchConfig(readSetup(), createCryptoRandom(), {
    matchId: 'online-lobby',
    playerIds: [P1, P2],
    opponent: MODE.ONLINE,
    p2Character: hostGuestCharacter ?? 'yuji_itadori',
  }).config;
}

/** Re-sends the host's rules after a setup change while waiting in the lobby. */
function syncOnlineLobbyPreview(): void {
  const current = session;
  if (!current?.host || current.engine !== null) return;
  // Changing the room's role or mode closes it: those belong to the lobby, not the rules.
  if (readOpponent() !== MODE.ONLINE || readNetRole() !== NET_ROLE.HOST) {
    showSetup();
    return;
  }
  current.host.syncLobby(toGameConfigPayload(onlinePreviewConfig(), current.roomCode ?? '', 'Player 1'));
}

/**
 * Hosts a room. The setup form stays on screen as the host's rules panel while the room
 * waits: player 2's dropdown is replaced by a locked status line, and the launch button
 * only arms once the guest has picked a sorcerer. The engine is created at launch, so the
 * rules the guest sees are exactly the ones the match starts with.
 *
 * Nothing here counts down. A host leaving the screen open is doing what the screen asks of
 * them, so the room stays registered on the signaling server until a guest arrives or the
 * player presses Cancel: only the guest's join has a deadline, because only a join can be
 * aimed at a code that does not exist.
 */
function startOnlineHost(): void {
  const code = createRoomCode();
  const clock = { origin: performance.now() };
  const now = (): number => performance.now() - clock.origin;
  setP2Choice(null);
  hideLobby();

  let host: OnlineHost;
  let guestName = 'Player 2';

  const room = hostRoom(code, {
    // Always route to the live host: a rematch replaces the instance but not the room.
    onPacket: (packet, from) => session?.host?.handlePacket(packet, from),
    onStatus: (status) => {
      if (closingNet) return;
      switch (status.state) {
        case 'signaling':
          // The transport's own wording, so a retry attempt is visible instead of a
          // frozen "Contacting…" line that looks identical to a hang.
          setHostStatus(status.detail);
          return;
        case 'waiting':
          // A dropped guest's pick must not arm the launch button for the next one.
          if (session?.engine === null) setP2Choice(null);
          // Waiting is the room's normal state, never an error: a failed dial-in is
          // reported here as a note on a room that is still open, because the host has
          // nothing to retry and the code on screen is still valid.
          setHostStatus(status.detail);
          return;
        case 'connecting':
          setHostStatus('Connecting players…');
          return;
        case 'connected':
          ensureCoopAudio();
          setHostStatus(`${guestName} connected. Waiting for their sorcerer…`);
          return;
        case 'error':
          setHostStatus(status.detail, true);
          return;
        default:
          setHostStatus(status.detail);
          return;
      }
    },
  });

  function hostHooks(): HostHooks {
    return {
      onGuestJoined: (name) => {
        guestName = name;
        // A fresh guest has not picked yet, even if the previous one had.
        setP2Choice(null);
        ensureCoopAudio();
        setHostStatus(`${guestName} connected. Waiting for their sorcerer…`);
        host.syncLobby(toGameConfigPayload(onlinePreviewConfig(), code, 'Player 1'));
      },
      onGuestCharacter: (characterId) => {
        setP2Choice(characterId);
        setHostStatus(`${CHARACTERS[characterId].name} is ready. Launch Match when you are.`);
        sfx.play('CARD_MATCH');
        host.syncLobby(toGameConfigPayload(onlinePreviewConfig(), code, 'Player 1'));
      },
      onRematchVote: (vote) => {
        if (vote) noteRematchVote(P2);
      },
      onEngineResult: (result) => command(result),
      onStatus: (status) => {
        if (!closingNet) setHostStatus(status.detail, status.state === 'error');
      },
    };
  }

  const preview = onlinePreviewConfig();
  const previewEngine = new GameEngine(preview, createCryptoRandom());
  host = new OnlineHost(preview, previewEngine, (packet) => room.send(packet), now, hostHooks());

  session = {
    engine: null,
    mode: MODE.ONLINE,
    boardMode: preview.boardMode,
    boardSize: preview.boardSize,
    boardElements: new Map(),
    labels: new Map<PlayerId, string>([
      [P1, 'You'],
      [P2, 'Player 2'],
    ]),
    humanSeats: new Set([P1]),
    origin: clock.origin,
    stopBot: null,
    netRole: NET_ROLE.HOST,
    room,
    host,
    guest: null,
    remote: null,
    config: preview,
    roomCode: code,
  };

  showHostRoom(code);
  setNetStatus('Online · hosting');
  ensureCoopAudio();

  function launch(): void {
    const current = session;
    if (!current || current.engine !== null) return;
    if (hostGuestCharacter === null) {
      toast('Wait for player 2 to pick a sorcerer');
      return;
    }
    let config: MatchConfig;
    let engine: GameEngine;
    try {
      config = resolveMatchConfig(readSetup(), createCryptoRandom(), {
        matchId: `match-${Date.now()}`,
        playerIds: [P1, P2],
        opponent: MODE.ONLINE,
        p2Character: hostGuestCharacter,
      }).config;
      engine = new GameEngine(config, createCryptoRandom());
      engine.setSoundListener((cue) => sfx.play(cue));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      return;
    }

    clock.origin = performance.now();
    const boardElements = mountArena(
      config.boardMode,
      boardIdsFor(config.boardMode, config.players),
      config.players,
    );
    hideHostRoom();
    session = {
      ...current,
      engine,
      boardMode: config.boardMode,
      boardSize: config.boardSize,
      boardElements,
      labels: onlineLabels({ players: config.players }, NET_ROLE.HOST),
      origin: clock.origin,
      config,
    };

    const started = engine.start(now());
    if (!started.ok) {
      toast(humanize(started.code));
      return;
    }
    host = new OnlineHost(config, engine, (packet) => room.send(packet), now, hostHooks());
    session = { ...session, host };
    setNetStatus('Online · host');
    // This is a real click, so the host's own music can start immediately.
    bgm.ensureAudioContext();
    bgm.start(OST_TRACK.BATTLE_THEME);
    host.announce(code, 'Player 1', started.events);
    handleEvents(started.events);
    renderFrame();
  }

  $<HTMLButtonElement>('#launch-match').onclick = launch;
  $<HTMLButtonElement>('#cancel-room').onclick = () => showSetup();
  $<HTMLButtonElement>('#host-copy').onclick = () => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => setHostStatus('Room code copied.'))
      .catch(() => toast(`Room code: ${code}`));
  };
}

/** The guest's character grid and the host's read-only rules card. */
function renderGuestPicker(): void {
  const grid = $('#guest-picker-grid');
  grid.replaceChildren(
    ...CHARACTER_IDS.map((id) => {
      const character = CHARACTERS[id];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'guest-pick';
      button.dataset.characterId = id;
      button.setAttribute('aria-pressed', selectedGuestCharacter === id ? 'true' : 'false');
      if (selectedGuestCharacter === id) button.classList.add('selected');

      const glyph = document.createElement('span');
      glyph.className = 'guest-pick-glyph';
      glyph.textContent = SUBJECT_GLYPH[id] ?? '呪';
      const name = document.createElement('span');
      name.className = 'guest-pick-name';
      name.textContent = character.name;
      const title = document.createElement('span');
      title.className = 'guest-pick-title';
      title.textContent = character.title;
      button.append(glyph, name, title);
      button.addEventListener('click', () => chooseGuestCharacter(id));
      return button;
    }),
  );
  $('#guest-picker').hidden = false;
}

function chooseGuestCharacter(id: CharacterId): void {
  const current = session;
  if (!current?.guest) return;
  ensureCoopAudio();
  selectedGuestCharacter = id;
  current.guest.selectCharacter(id);
  for (const button of document.querySelectorAll<HTMLElement>('#guest-picker-grid .guest-pick')) {
    const active = button.dataset.characterId === id;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  $('#guest-pick-status').textContent = `${CHARACTERS[id].name} selected — waiting for the host to launch…`;
  setLobbyStatus(`${CHARACTERS[id].name} locked in. Waiting for the host to launch…`);
  sfx.play('CARD_MATCH');
}

function renderMatchConditions(config: GameConfigPayload): void {
  const first = config.players[0];
  const rows: Array<readonly [string, string]> = [
    ['Board layout', BOARD_MODE_LABEL[config.boardMode]],
    ['Grid size', config.boardSize === 36 ? '6 × 6 · 36 cards' : '4 × 4 · 16 cards'],
    ['Starting HP', `${config.startingHp} HP`],
    ['Cursed traps', String(config.trapCount)],
    ['Lore synergies', String(config.synergyPairCount)],
    [
      'Board clear',
      config.boardClearReward === BOARD_CLEAR_REWARD.MANUAL_CHOICE ? 'Manual blessing choice' : 'Instant random',
    ],
    ['Host', first ? `${config.hostName} · ${CHARACTERS[first.characterId].name}` : config.hostName],
    ['Your sorcerer', selectedGuestCharacter ? CHARACTERS[selectedGuestCharacter].name : 'Pick below'],
  ];
  const list = $('#match-conditions-list');
  list.replaceChildren(
    ...rows.map(([label, value]) => {
      const term = document.createElement('dt');
      term.textContent = label;
      const detail = document.createElement('dd');
      detail.textContent = value;
      const row = document.createElement('div');
      row.append(term, detail);
      return row;
    }),
  );
  $('#match-conditions').hidden = false;
}

/**
 * Joins a room by code. The guest keeps no engine: it adopts the host's rules, picks a
 * sorcerer, then renders the snapshots the host publishes. The rules card and the picker
 * appear before the match starts, so the guest knows the conditions they are joining.
 */
/**
 * Parks an online snapshot until the next animation frame.
 *
 * A packet arrives whenever the network hands it over, which has nothing to do with when
 * the screen is about to draw. Applying the board update straight from the socket lands
 * mid-frame — a layout and paint between two frames the compositor was already committed
 * to. Waiting for `requestAnimationFrame` puts the update in the frame it belongs to, and
 * a burst of packets coalesces into one render instead of one per packet.
 */
function queueSnapshot(snapshot: BoardStatePayload, events: readonly GameEvent[]): void {
  // The newest snapshot is the truth; its events still all have to be played and logged.
  const merged = pendingSnapshot ? [...pendingSnapshot.events, ...events] : events;
  pendingSnapshot = { snapshot, events: merged };
  if (snapshotFrame !== null) return;
  snapshotFrame = window.requestAnimationFrame(() => {
    snapshotFrame = null;
    const pending = pendingSnapshot;
    pendingSnapshot = null;
    if (!pending || !session) return;
    session.remote = pending.snapshot;
    // The guest owns no engine, so the host's published events are the only source of
    // sound on this side of the match.
    for (const cue of soundCuesForEvents(pending.events)) sfx.play(cue);
    handleEvents(pending.events);
    renderFrame();
  });
}

function startOnlineGuest(): void {
  const code = normalizeRoomCode($<HTMLInputElement>('#room-code-input').value);
  if (!code) {
    toast('Enter the five-character room code');
    return;
  }
  ensureCoopAudio();
  selectedGuestCharacter = null;
  $('#guest-picker').hidden = true;
  $('#match-conditions').hidden = true;

  const origin = performance.now();
  const now = (): number => performance.now() - origin;
  let guest: OnlineGuest;
  let joinSent = false;

  const room = joinRoom(code, {
    onPacket: (packet, from) => guest.handlePacket(packet, from),
    onStatus: (status) => {
      if (closingNet) return;
      if (status.state === 'connected' && !joinSent) {
        joinSent = true;
        // The handshake is a join request plus a ping: the request gets the host's rules
        // moving, the ping measures the round trip the turn clock is aligned against.
        guest.requestJoin('Player 2');
        guest.ping();
        setJoinBusy(false);
        setLobbyStatus('Connected. Waiting for the host’s match conditions…');
        return;
      }
      if (status.state === 'error') {
        // A dead room must not trap the screen: report it, hand the setup form back and
        // let the player correct the code instead of waiting on a lobby forever.
        setJoinBusy(false);
        setLobbyStatus(status.detail, true);
        toast(status.detail);
        later(() => {
          if (session?.netRole === NET_ROLE.JOIN && session.engine === null) showSetup();
        }, GAME_PACING.TOAST_MS + 600);
        return;
      }
      if (status.state === 'signaling' || status.state === 'connecting') {
        setLobbyStatus(status.detail);
        return;
      }
      if (status.state === 'disconnected' && session) setNetStatus('Online · disconnected');
    },
  });

  guest = new OnlineGuest((packet) => room.send(packet), now, {
    onReady: () => setLobbyStatus('Connected. Waiting for the host’s match conditions…'),
    onConfig: (config) => {
      renderMatchConditions(config);
      renderGuestPicker();
      setLobbyStatus(
        selectedGuestCharacter
          ? `${CHARACTERS[selectedGuestCharacter].name} locked in. Waiting for the host to launch…`
          : 'Pick your sorcerer. The host launches once you are ready.',
      );
    },
    onMatchStart: (config, snapshot) => enterGuestArena(config, snapshot),
    onRematchStart: (config, snapshot) => enterGuestArena(config, snapshot),
    // Board updates wait for the frame that will draw them.
    onSnapshot: (snapshot, events) => {
      if (!session) return;
      queueSnapshot(snapshot, events);
    },
    onStatus: (status) => {
      if (!closingNet) setLobbyStatus(status.detail, status.state === 'error');
    },
  });

  session = {
    engine: null,
    mode: MODE.ONLINE,
    boardMode: BOARD_MODE.DUAL,
    boardSize: 16,
    boardElements: new Map(),
    labels: new Map<PlayerId, string>([
      [P1, 'Host'],
      [P2, 'You'],
    ]),
    humanSeats: new Set([P2]),
    origin,
    stopBot: null,
    netRole: NET_ROLE.JOIN,
    room,
    host: null,
    guest,
    remote: null,
    config: null,
    roomCode: code,
  };

  setJoinBusy(true);
  showLobby(code, 'Finding room…');

  function enterGuestArena(config: GameConfigPayload, snapshot: BoardStatePayload): void {
    const current = session;
    if (!current) return;
    const boardElements = mountArena(
      config.boardMode,
      boardIdsFor(config.boardMode, config.players),
      config.players,
    );
    session = {
      ...current,
      engine: null,
      mode: MODE.ONLINE,
      boardMode: config.boardMode,
      boardSize: config.boardSize,
      boardElements,
      labels: onlineLabels(config, NET_ROLE.JOIN),
      humanSeats: new Set([P2]),
      config: null,
      remote: snapshot,
    };
    hideLobby();
    setNetStatus('Online · guest');
    // The character click or the join click already unlocked audio; this makes the
    // remotely-triggered start explicit rather than relying on that earlier gesture.
    bgm.ensureAudioContext();
    bgm.start(OST_TRACK.BATTLE_THEME);
    if (netPingTimer === null) {
      guest.ping();
      netPingTimer = window.setInterval(() => guest.ping(), 3000);
    }
    renderFrame();
  }
}

// ---------------------------------------------------------------------------
// Rematch handshake
// ---------------------------------------------------------------------------

function resetRematchUi(): void {
  rematchVotes.reset();
  const button = $<HTMLButtonElement>('#rematch');
  button.disabled = false;
  button.textContent = '⚔️ Rematch / Tái Đấu';
  $('#rematch-status').textContent = '';
}

function updateRematchUi(seat: PlayerId): void {
  const button = $<HTMLButtonElement>('#rematch');
  button.disabled = true;
  button.textContent = '⏳ Rematch requested';
  $('#rematch-status').textContent = rematchVotes.statusText(seat);
}

/** The overlay's rematch button: local matches restart at once, co-op votes first. */
function requestRematch(): void {
  const current = session;
  if (!current) return;
  if (current.netRole === null || current.room === null) {
    startMatch();
    return;
  }
  const seat: PlayerId = current.netRole === NET_ROLE.HOST ? P1 : P2;
  if (rematchVotes.has(seat)) return;
  rematchVotes.vote(seat);
  updateRematchUi(seat);
  if (current.netRole === NET_ROLE.JOIN) {
    current.guest?.voteRematch();
    return;
  }
  if (rematchVotes.ready) startOnlineRematch();
}

/** Host side: the guest's vote arrived over the connection that is already open. */
function noteRematchVote(seat: PlayerId): void {
  const current = session;
  if (!current || current.netRole !== NET_ROLE.HOST || rematchVotes.has(seat)) return;
  rematchVotes.vote(seat);
  updateRematchUi(P1);
  if (rematchVotes.ready) startOnlineRematch();
}

/**
 * Host side of the rematch: a fresh engine over the same room and data channel. The host
 * announces the new config and first snapshot, and both screens leave the result overlay
 * without a room code, a reconnect or a new peer handshake.
 */
function startOnlineRematch(): void {
  const current = session;
  if (!current || current.netRole !== NET_ROLE.HOST || !current.engine || !current.config || !current.room) {
    return;
  }
  const config: MatchConfig = { ...current.config, matchId: `match-${Date.now()}` };
  let engine: GameEngine;
  try {
    engine = new GameEngine(config, createCryptoRandom());
    engine.setSoundListener((cue) => sfx.play(cue));
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
    return;
  }
  const room = current.room;
  const code = current.roomCode ?? '';
  const origin = performance.now();
  const now = (): number => performance.now() - origin;
  const host = new OnlineHost(config, engine, (packet) => room.send(packet), now, {
    onGuestJoined: () => {},
    onEngineResult: (result) => command(result),
    onRematchVote: (vote) => {
      if (vote) noteRematchVote(P2);
    },
    onStatus: (status) => {
      if (!closingNet) setNetStatus(`Online · ${status.state}`);
    },
  });

  const boardElements = mountArena(config.boardMode, boardIdsFor(config.boardMode, config.players), config.players);
  session = {
    ...current,
    engine,
    boardMode: config.boardMode,
    boardSize: config.boardSize,
    boardElements,
    labels: onlineLabels({ players: config.players }, NET_ROLE.HOST),
    origin,
    config,
    host,
    remote: null,
  };

  const started = engine.start(now());
  if (!started.ok) {
    toast(humanize(started.code));
    return;
  }
  bgm.ensureAudioContext();
  bgm.start(OST_TRACK.BATTLE_THEME);
  host.announceRematch(code, 'Player 1', started.events);
  handleEvents(started.events);
  renderFrame();
}

/** Turns a CSS grid into an empty grid of `count` fresh card buttons. */
function layoutBoard(element: HTMLElement, count: number, boardSize: number): void {
  const cols = boardSize === 36 ? 6 : 4;
  const rows = Math.round(boardSize / cols);
  element.replaceChildren(...Array.from({ length: count }, () => createCardButton()));
  // The frame owns the geometry (it is what scales to the slot); the grid inherits it.
  const frame = element.closest<HTMLElement>('.board-frame') ?? element;
  frame.style.setProperty('--cols', String(cols));
  frame.style.setProperty('--ratio', String((cols * 3) / (rows * 4)));
}

function buildBoards(view: PublicMatchView, boardSize: number): void {
  const current = session;
  if (!current) return;
  for (const [boardId, element] of current.boardElements) {
    const board = view.boards.find((candidate) => candidate.boardId === boardId);
    if (!board) continue;
    layoutBoard(element, board.cards.length, boardSize);
  }
}

/** Re-lays out one grid after it was reshuffled, with a short deal-in flash. */
/** Lays out a grid the first time it is seen, or when its card count changed. */
function ensureBoards(view: PublicMatchView, boardSize: number): void {
  const current = session;
  if (!current) return;
  for (const [boardId, element] of current.boardElements) {
    const board = view.boards.find((candidate) => candidate.boardId === boardId);
    if (board && element.children.length !== board.cards.length) {
      layoutBoard(element, board.cards.length, boardSize);
    }
  }
}

function dealBoard(boardId: BoardId): void {
  const current = session;
  if (!current) return;
  const element = current.boardElements.get(boardId);
  const board = currentView()?.boards.find((candidate) => candidate.boardId === boardId);
  if (!element || !board) return;
  layoutBoard(element, board.cards.length, current.boardSize);
  element.classList.remove('dealt');
  void element.offsetWidth; // restart the CSS animation
  element.classList.add('dealt');
  later(() => element.classList.remove('dealt'), GAME_PACING.BOARD_DEAL_MS);
}

/**
 * Restarts the menu theme once the audio context exists. Before the first gesture there is
 * no context, so this does nothing and the boot listener starts it instead.
 */
function playMenuTheme(): void {
  if (bgm.contextState === null) return;
  bgm.ensureAudioContext();
  bgm.start();
}

function showSetup(): void {
  stopSession();
  hideLobby();
  // Leaving a lobby must always hand the Join button back, whatever path brought us here.
  setJoinBusy(false);
  sandboxToolbar = null;
  $('#sandbox-toolbar').hidden = true;
  $('#setup').hidden = false;
  playMenuTheme();
  $('#match').hidden = true;
  $('#result').hidden = true;
  $('#new-match').hidden = true;
  $('#mode-label').textContent = '';
  $('#turn-label').textContent = '';
  for (const board of document.querySelectorAll<HTMLElement>('#match .board')) board.replaceChildren();
}

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------

function cardSignature(card: PublicCardView): string {
  const modifiers = card.effectModifiers.map((modifier) => modifier.kind).join('+');
  return [card.state, card.characterId ?? '', card.type ?? '', card.revealedBy ?? '', modifiers, card.corrupted].join('|');
}

function updateCard(button: HTMLButtonElement, card: PublicCardView, interactive: boolean): void {
  button.dataset.cardId = card.id;
  const signature = cardSignature(card);
  if (button.dataset.sig !== signature) {
    button.dataset.sig = signature;
    const faceUp = card.state === CARD_STATE.REVEALED || card.state === CARD_STATE.MATCHED;
    button.classList.toggle('revealed', faceUp);
    button.classList.toggle('matched', card.state === CARD_STATE.MATCHED);
    button.classList.toggle('trap', card.type === CARD_TYPE.TRAP);
    button.classList.toggle('synergy', card.type === CARD_TYPE.SYNERGY);
    button.classList.toggle('corrupted', card.corrupted);
    button.dataset.by = card.revealedBy ?? '';
    button.dataset.hazard = hazardOf(card);

    const name = part(button, '.name');
    const kind = part(button, '.kind');
    const art = part(button, '.art');
    // Face-down cards publish no identity at all, so neither does the DOM they produce.
    button.dataset.char = card.corrupted ? '' : card.characterId ?? '';
    if (card.corrupted) {
      name.textContent = '躯';
      kind.textContent = 'Transfigured';
      kind.setAttribute('aria-label', 'Transfigured');
      // The corrupted face is a living flesh mass, drawn as an emblem so it fills the art area.
      art.classList.add('emblem');
      art.innerHTML = TRANSFIGURED_FLESH_ART;
    } else {
      name.textContent = cardTitle(card);
      kind.textContent = kindShortLabel(card.type);
      // The pill is short on paint but not in meaning: assistive tech and hovers get the
      // full type, and the full name is on the card itself, never abbreviated.
      kind.setAttribute('aria-label', kindLabel(card.type));
      // A fighter or synergy half wears its SVG emblem. A talisman keeps its kanji mark, as does
      // a subject with no emblem, so a face-up card always shows art.
      const emblem = card.type === CARD_TYPE.TRAP
        ? (card.trapId === null ? null : TRAP_ICON[card.trapId])
        : card.characterId !== null
          ? cardIconFor(card.characterId, card.type === CARD_TYPE.SYNERGY)
          : null;
      art.classList.toggle('emblem', emblem !== null);
      if (emblem !== null) {
        art.innerHTML = renderCardIcon(emblem);
      } else {
        art.textContent = card.characterId === null ? '' : SUBJECT_GLYPH[card.characterId] ?? '呪';
      }
    }
    const modifier = card.effectModifiers.at(-1);
    part(button, '.badge').textContent = modifier ? (MODIFIER_GLYPH[modifier.kind] ?? '') : '';
  }

  // Cards stay clickable even when the action is refused: the engine answers with the
  // reason and the toast shows it, which is how a sealed card, the other fighter's grid
  // and a click out of turn explain themselves. `.blocked` only styles that state.
  const flippable = interactive && card.state === CARD_STATE.HIDDEN && !card.locked;
  button.classList.toggle('blocked', !flippable);
  button.classList.toggle('sealed', card.locked);
  button.setAttribute('aria-disabled', flippable ? 'false' : 'true');
}

function renderBoard(board: PublicBoardView, actor: PlayerId | null, view: PublicMatchView, now: number): void {
  const element = session?.boardElements.get(board.boardId);
  if (!element) return;
  const interactive = actor !== null && isHumanActor(view, actor, now);
  // In the sequential dual format only the on-turn player's grid is live.
  const owner = board.ownerId ?? view.turnOwner;
  element.classList.toggle(
    'live',
    view.result === null && (!isTurnBasedMode(view.boardMode) || (owner !== null && view.turnOwner === owner)),
  );
  board.cards.forEach((card, index) => {
    const button = element.children[index];
    if (button instanceof HTMLButtonElement) updateCard(button, card, interactive);
  });
}

/** True when a human at this keyboard owns `actorId` and may act right now. */
function isHumanActor(view: PublicMatchView, actorId: PlayerId, now: number): boolean {
  const current = session;
  if (!current) return false;
  return current.humanSeats.has(actorId) && canPlayerAct(view, actorId, now);
}

// ---------------------------------------------------------------------------
// Panels, turn indicator and rendering
// ---------------------------------------------------------------------------

/** How many cards the active attempt still wants. */
function picksLeft(attempt: { currentSelection: readonly string[]; flipLimit: number } | undefined): number {
  if (!attempt) return 1;
  return Math.max(0, attempt.flipLimit - attempt.currentSelection.length);
}

/** One line describing the selection, shared by the panel and the turn indicator. */
function selectionHint(attempt: PublicAttemptView | undefined): string {
  if (!attempt) return 'Pick a card';
  if (attempt.isEvaluating) return 'Resolving the flip…';
  if (attempt.currentSelection.length === 0) return 'Pick a card';
  const left = picksLeft(attempt);
  if (left <= 0) return 'Resolving the flip…';
  return left === 1 ? 'Pick one more card' : `Pick ${left} more cards`;
}

function attemptLabel(view: PublicMatchView, playerId: PlayerId, now: number, isHuman: boolean): string {
  const attempt = attemptOfPlayer(view, playerId);
  if (!attempt) return '';
  if (attempt.stunnedUntil > now) return `Stunned ${((attempt.stunnedUntil - now) / 1000).toFixed(1)}s`;
  if (attempt.phase === 'EVALUATING') return 'Evaluating…';
  if (attempt.currentSelection.length > 0) return selectionHint(attempt);
  if (view.result !== null) return '';
  if (isHuman && canPlayerAct(view, playerId, now)) return 'Your move';
  if (isTurnBasedMode(view.boardMode) && view.turnOwner !== playerId) return 'Waiting';
  return isHuman ? '' : 'Thinking…';
}

function renderPanel(player: PublicPlayerView, view: PublicMatchView, now: number): void {
  const current = session;
  if (!current) return;
  const panel = panelEl(player.id);
  const character = CHARACTERS[player.characterId];
  const isHuman = current.humanSeats.has(player.id);
  const actable = canPlayerAct(view, player.id, now);
  const attempt = attemptOfPlayer(view, player.id);
  const busy = (attempt?.currentSelection.length ?? 0) > 0;

  const dummy = current.mode === MODE.SANDBOX && player.id === P2;
  setText(part(panel, '.char-name'), dummy ? 'Cursed Training Dummy' : character.name);
  setText(part(panel, '.label'), current.labels.get(player.id) ?? player.id.toUpperCase());
  // HP is painted only when it moved: the panel is redrawn every frame, and rewriting an
  // unchanged number sixty times a second is churn the player can never see.
  setBarWidth(part(panel, '.hp-fill'), player.hp / player.maxHp);
  setText(part(panel, '.hp-text'), `HP: ${player.hp} / ${player.maxHp}`);
  // The barrier row carries barrier numbers only: the HP row sits directly above it, so
  // repeating HP there was noise. It keeps a dimmed track at 0 rather than vanishing, so
  // "no barrier" and "barrier spent" stay distinguishable at a glance.
  const shieldCap = Math.floor(player.maxHp * GAME_CONSTANTS.SHIELD_FRACTION_OF_MAX_HP);
  const shieldWrap = part(panel, '.shield-wrap');
  shieldWrap.classList.toggle('off', player.shield <= 0);
  shieldWrap.title = `Barrier soaks damage before HP · ceiling ${shieldCap}`;
  setBarWidth(part(panel, '.shield-fill'), player.shield / Math.max(1, shieldCap));
  setText(part(panel, '.shield-text'), `Barrier: ${player.shield} / ${shieldCap}`);
  setBarWidth(part(panel, '.ce-fill'), player.cursedEnergy / GAME_CONSTANTS.MAX_CURSED_ENERGY);
  setText(part(panel, '.ce-text'), `${Math.floor(player.cursedEnergy)} / ${GAME_CONSTANTS.MAX_CURSED_ENERGY} CE`);
  part(panel, '.ce-wrap').classList.toggle('ready', player.cursedEnergy >= GAME_CONSTANTS.SKILL_CE_COST);

  const combo = part(panel, '.combo');
  setText(combo, `Combo ×${player.comboStreak}`);
  combo.classList.toggle('hot', player.comboStreak >= 1);
  setText(part(panel, '.pairs'), `${player.pairsMatched} pairs`);
  panel.classList.toggle('dead', player.hp <= 0);
  panel.classList.toggle(
    'active',
    view.result === null && (isTurnBasedMode(view.boardMode) ? view.turnOwner === player.id : true),
  );
  panel.classList.toggle('human', isHuman);

  const statusParts: string[] = [];
  if (player.activeDomain) {
    const domain = DOMAINS[player.activeDomain.domainId];
    const nullified = player.activeEffects.some((effect) => effect.kind === STATUS_KIND.DOMAIN_NULLIFIED);
    statusParts.push(`Domain: ${domain.name} (${player.activeDomain.turnsRemaining})${nullified ? ' ✕ neutralized' : ''}`);
  }
  for (const effect of player.activeEffects) {
    if (effect.kind === STATUS_KIND.DOMAIN_NULLIFIED) continue;
    const label = STATUS_LABEL[effect.kind];
    statusParts.push(effect.turnsRemaining === null ? label : `${label} ×${effect.turnsRemaining}`);
  }
  const attemptText = attemptLabel(view, player.id, now, isHuman);
  if (attemptText) statusParts.push(attemptText);
  setText(part(panel, '.status'), statusParts.join(' · '));

  // The domain widget carries the state the status line can only hint at, including an
  // armed counter window that has not cancelled anything yet.
  const domainStatus = domainStatusOf(player);
  const domainSlot = part(panel, '.domain-status-slot');
  renderDomainStatus(domainSlot, domainStatus, dummy ? 'The dummy' : character.name);
  domainSlot.title = domainStatusTitle(domainStatus);

  // Executioner's Sword takes over the skill slot while a Deadly Sentencing sentence lasts.
  const sword = player.executioner;
  const skillDef = SKILLS[sword ? 'executioners_sword' : character.skillId];
  renderAbility(panel, '.skill-btn', {
    name: skillDef.name,
    description: skillDef.description,
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    badge: 'Skill',
    sword: sword ? { turnsRemaining: sword.turnsRemaining, damage: sword.damage } : null,
    enabled: isHuman && actable && !busy && player.cursedEnergy >= GAME_CONSTANTS.SKILL_CE_COST,
  });

  const ultimate = ULTIMATES[character.ultimateId];
  renderAbility(panel, '.ultimate-btn', {
    name: ultimate.name,
    description: ultimate.description,
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    badge: ultimate.type === ULTIMATE_TYPE.DOMAIN ? 'Domain' : 'Simple Domain',
    enabled:
      isHuman &&
      actable &&
      !busy &&
      player.cursedEnergy >= GAME_CONSTANTS.DOMAIN_CE_COST &&
      !(ultimate.type === ULTIMATE_TYPE.DOMAIN && player.activeDomain !== null),
  });
}

function renderAbility(
  panel: HTMLElement,
  selector: string,
  options: {
    name: string;
    description: string;
    cost: number;
    badge: string;
    enabled: boolean;
    /** Set while Executioner's Sword replaces the skill: its turns left and true damage. */
    sword?: { readonly turnsRemaining: number; readonly damage: number } | null;
  },
): void {
  const button = part<HTMLButtonElement>(panel, selector);
  const sword = options.sword ?? null;
  part(button, '.ability-name').textContent = sword
    ? `🗡️ ${options.name} (${sword.turnsRemaining}T)`
    : `${options.badge}: ${options.name}`;
  part(button, '.ability-cost').textContent = sword
    ? `${options.cost} CE · ${sword.damage} True DMG · Piercing`
    : `${options.cost} CE`;
  button.title = options.description;
  button.disabled = !options.enabled;
  button.classList.toggle('ready', options.enabled);
  button.classList.toggle('sword', sword !== null);
}

function renderTurn(view: PublicMatchView, now: number): void {
  const current = session;
  if (!current) return;
  const banner = $('#turn-banner');
  const timerFill = $('#turn-timer-fill');
  let text: string;
  let tone: string;
  let fraction = 0;
  let timeText = '—';

  if (view.result !== null) {
    text = 'Match over';
    tone = 'over';
  } else if (view.boardMode === BOARD_MODE.DUAL) {
    text = 'Simultaneous play';
    tone = 'duo';
    const states = view.players
      .map((player) => `${CHARACTERS[player.characterId].name}: ${attemptLabel(view, player.id, now, current.humanSeats.has(player.id)) || 'ready'}`)
      .join('   ');
    $('#turn-detail').textContent = states;
    timeText = 'both boards live';
  } else {
    const frozen = view.phase === TURN_PHASE.EVALUATING;
    const owner = view.turnOwner;
    if (frozen) {
      text = 'Evaluating flip…';
      tone = 'eval';
    } else if (owner !== null && current.humanSeats.has(owner)) {
      text = current.mode === MODE.PVE || current.mode === MODE.SANDBOX ? 'Your move' : `${labelOf(owner)} to move`;
      tone = 'you';
    } else {
      text =
        owner === null
          ? 'Waiting'
          : current.mode === MODE.PVE
            ? `${labelOf(owner)} is thinking…`
            : `${labelOf(owner)}'s turn`;
      tone = 'bot';
    }
    const remaining = Math.max(0, (view.turnDeadline ?? now) - now);
    const budget = view.turnTimeMs;
    fraction = frozen || budget === null ? 0 : Math.min(1, remaining / budget);
    timeText = frozen ? '—' : budget === null ? 'no clock' : `${Math.ceil(remaining / 1000)} s`;
    // The detail line comes from the same place as the banner, so "Evaluating flip…"
    // can never sit next to "pick a second card".
    const active = owner === null ? undefined : attemptOfPlayer(view, owner);
    setText(
      $('#turn-detail'),
      frozen
        ? `Turn ${view.turnNumber} · ${selectionHint(active)}`
        : `Turn ${view.turnNumber} · ${selectionHint(active).toLowerCase()}`,
    );
  }

  setText(banner, text);
  const bannerClass = `turn-banner ${tone}`;
  if (banner.className !== bannerClass) banner.className = bannerClass;
  setBarWidth(timerFill, fraction);
  timerFill.classList.toggle('low', view.boardMode !== BOARD_MODE.DUAL && fraction > 0 && fraction <= 1 / 3);
  timerFill.classList.toggle('idle', view.boardMode === BOARD_MODE.DUAL || view.result !== null);
  setText($('#turn-time'), timeText);
  setText($('#turn-label'), view.result === null ? `Cycle ${view.cycles}` : 'Final');

  // Minimal round info under the board: where the match is, and the clock it is on.
  setText($('#round-cycle'), view.result === null ? `Cycle ${view.cycles} · Turn ${view.turnNumber}` : 'Match over');
  setText(
    $('#round-pace'),
    view.boardMode === BOARD_MODE.DUAL
      ? 'both boards live'
      : view.turnTimeMs === null
        ? 'training ground · no clock'
        : `${Math.round(view.turnTimeMs / 1000)}s turn clock`,
  );
  setText($('#mode-label'), `${MODE_LABEL[current.mode]} · ${BOARD_MODE_LABEL[view.boardMode]}`);
}

function renderFrame(): void {
  // A trap on screen owns the board: the card under it must not be redrawn from under
  // the burst, or the animation is thrown away half way through.
  if (renderHeld) return;
  const current = session;
  if (!current) return;
  const view = currentView();
  if (!view) return;
  const now = clockNow();

  // The guest learns the grid from the host, so its cards are laid out on first sight.
  ensureBoards(view, current.boardSize);

  for (const board of view.boards) {
    const actor = board.ownerId ?? view.turnOwner;
    renderBoard(board, actor, view, now);
  }
  // The grids are current, so any seal the engine reported this frame can land on them.
  sealStamps.flush();
  flushTrapPlants();
  for (const player of view.players) renderPanel(player, view, now);
  renderTurn(view, now);
  const trial = view.sentencing;
  sentencing.render(
    trial,
    trial !== null && current.humanSeats.has(trial.victimId),
    now,
    trial !== null && current.humanSeats.has(trial.casterId),
  );
  // The Idle Death Gamble machine belongs to whoever has re-spins open. Only the owning
  // human seat, on a local screen, may pull the lever.
  const slotOwner = view.players.find((player) => player.pachinko.spinsLeft > 0) ?? null;
  // Music answers a condition, not an event: a domain expiring calms it down just as
  // surely as casting one wound it up, so the tier is re-read from the view every frame.
  // The Sorcery Codex is a menu, so it takes the menu theme over an ordinary battle; a
  // jackpot, domain or modal still outranks it, as the tier rule expects.
  bgm.updateScene(view, { menu: codex.isOpen(), modal: slotOwner !== null ? 'SLOT' : null });
  hakari.render(
    slotOwner ? { playerId: slotOwner.id, pachinko: slotOwner.pachinko } : null,
    slotOwner !== null && current.humanSeats.has(slotOwner.id) && !current.guest,
    now,
  );
  const blessing = view.awakening;
  awakening.render(blessing, blessing !== null && current.humanSeats.has(blessing.playerId), now);

  // The queue is projected by the engine from live state: skips and the extra turn a
  // skipped turn hands back are already baked into the order it returns.
  const mySeat: 0 | 1 = current.humanSeats.has(P1) ? 0 : 1;
  renderTurnQueue($('#turn-queue'), currentQueue(), {
    mySeat,
    seatLabel: (playerId) => current.labels.get(playerId as PlayerId) ?? '',
  });
}

// ---------------------------------------------------------------------------
// Events: log lines and visual cues
// ---------------------------------------------------------------------------

function log(text: string, tone: LogTone = 'info'): void {
  const list = $<HTMLOListElement>('#log');
  const item = document.createElement('li');
  item.className = tone;
  item.textContent = text;
  list.append(item);
  while (list.children.length > 90) list.firstElementChild?.remove();
  list.scrollTop = list.scrollHeight;
}

function showBanner(text: string, tone: 'black' | 'domain' | ''): void {
  const banner = $('#banner');
  banner.textContent = text;
  banner.className = tone ? `banner show ${tone}` : 'banner show';
  later(() => banner.classList.remove('show'), GAME_PACING.VFX_BANNER_DURATION_MS);
}

function showOverlay(title: string, subtitle: string): void {
  const overlay = $('#domain-overlay');
  part(overlay, '.title').textContent = title;
  part(overlay, '.sub').textContent = subtitle;
  overlay.className = 'domain-overlay show';
  later(() => overlay.classList.remove('show'), GAME_PACING.DOMAIN_ACTIVATION_CINEMATIC_MS);
}

/** Endless-board banner: a cleared grid is announced while it is re-dealt. */
function showReshuffle(ownerId: PlayerId | null): void {
  const overlay = $('#reshuffle');
  part(overlay, '.sub').textContent =
    ownerId === null ? 'Reshuffling the shared grid…' : `Reshuffling ${labelOf(ownerId)}'s grid…`;
  overlay.classList.remove('show');
  void overlay.offsetWidth; // restart the CSS animation
  overlay.classList.add('show');
  later(() => overlay.classList.remove('show'), GAME_PACING.BOARD_RESPAWN_ANIMATION_MS);
}

function showBlackFlash(streak: number): void {
  const flash = $('#flash');
  flash.classList.remove('play');
  void flash.offsetWidth; // restart the CSS animation
  flash.classList.add('play');
  showBanner(`BLACK FLASH ×${streak}`, 'black');
}

/** The card button for a card id, on whichever grid it is standing. */
function cardEl(cardId: string): HTMLElement | null {
  const current = session;
  if (!current) return null;
  for (const root of current.boardElements.values()) {
    for (const button of root.querySelectorAll<HTMLElement>('button.card')) {
      if (button.dataset.cardId === cardId) return button;
    }
  }
  return null;
}

/** The public view of one player, as the panels are drawn from it. */
function playerOf(playerId: PlayerId): PublicPlayerView | null {
  return currentView()?.players.find((player) => player.id === playerId) ?? null;
}

/**
 * One damage event as the player reads it: what landed, and on what.
 *
 * The engine's own flags decide the badge, never the number. A piercing hit that ignores a
 * barrier and a hit that emptied one can both deal ten damage, and they mean very
 * different things to the fighter on the receiving end.
 */
function showDamage(
  sourceId: PlayerId,
  targetId: PlayerId,
  dealt: number,
  absorbed: number,
  piercing: boolean,
  critical: boolean,
  cleave: boolean,
): void {
  const panel = panelEl(targetId);
  if (absorbed > 0) fct.showOver(panel, `🛡️ -${absorbed} BARRIER`, 'BARRIER');
  if (cleave) {
    // Cleave is 25% of the target's current HP, so the number shown is the full bite it
    // dealt before any barrier soaked it.
    fct.showOver(panel, `🗡️ CLEAVE: ${dealt + absorbed} DMG (25% CURRENT HP)`, 'DAMAGE');
    return;
  }
  if (dealt <= 0) {
    // Nothing got through: say so once, rather than showing a zero.
    if (absorbed > 0) fct.showOver(panel, '🛡️ BLOCKED', 'BLOCK');
    return;
  }
  // A Kokusen announces itself one event earlier; this is the damage it just did.
  if (critical && blackFlashPending.delete(sourceId)) {
    fct.showOver(panel, `⚡ ${dealt} BLACK FLASH! ⚡`, 'BLACK_FLASH');
    return;
  }
  if (piercing) {
    // The Executioner's Sword is the one technique whose true damage is its whole identity.
    const sword = playerOf(sourceId)?.executioner ?? null;
    const label = sword !== null && sword.damage === dealt ? 'DEATH PENALTY' : 'PIERCE';
    fct.showOver(panel, `-${dealt} ${label}!`, 'PIERCE');
    return;
  }
  fct.showOver(panel, `-${dealt}`, 'DAMAGE');
}

function playCue(cue: VfxCue): void {
  vfx?.play(cue);
}


function showResult(result: MatchResult): void {
  const overlay = $('#result');
  renderMatchFinisher(overlay, result, duel);
  overlay.hidden = false;
  // The arena freezes to ink wash behind the verdict.
  $('#match').classList.add('finished');
  // One shot per match: dropping and re-adding the class restarts both ink strokes.
  overlay.classList.remove('finish');
  void overlay.offsetWidth;
  overlay.classList.add('finish');
  playExecutionerSlash();
  // The verdict gets the screen to itself; the loop has nothing left to score.
  bgm.stop();
}

function handleEvents(events: readonly GameEvent[]): void {
  // A planted card's consequences are held back to land with its detonation instead of on
  // top of it. The trigger event itself stays in this batch, because that is what starts
  // the pop; the damage, drain and stun replay through this same handler once it has
  // played, so every line, float and tally entry is still produced exactly once.
  const detonating = new Set<PlayerId>();
  for (const event of events) {
    if (event.type !== 'CARD_EFFECT_TRIGGERED') continue;
    // A burst the click handler already played is running right now: its consequences
    // land with it instead of waiting for a second burst that will never come.
    if (isBurstPlaying(cardEl(event.cardId))) continue;
    detonating.add(event.playerId);
  }
  let immediate = events;
  if (detonating.size > 0) {
    const held = events.filter((event) => isDetonationConsequence(event, detonating));
    if (held.length > 0) {
      immediate = events.filter((event) => !isDetonationConsequence(event, detonating));
      later(() => handleEvents(held), TRAP_IMPACT_MS);
    }
  }

  for (const event of immediate) {
    duel.record(event);
    switch (event.type) {
      case 'PAIR_MATCHED':
        log(`${labelOf(event.playerId)} matched a ${event.cardType.toLowerCase()} pair`, 'good');
        break;
      case 'PAIR_MISMATCHED':
        log(`${labelOf(event.playerId)} missed; both cards hidden again`);
        break;
      case 'BLACK_FLASH':
        showBlackFlash(event.streak);
        // The damage event that follows carries the number; this only says whose it is.
        blackFlashPending.add(event.playerId);
        log(`${labelOf(event.playerId)} landed a Black Flash (×${event.streak})`, 'black');
        break;
      case 'SYNERGY_TRIGGERED': {
        const synergy = SYNERGIES[event.synergyId as keyof typeof SYNERGIES];
        playCue(event.cue);
        log(`${labelOf(event.playerId)} sync: ${synergy?.name ?? event.synergyId} — ${synergy?.description ?? ''}`, 'domain');
        break;
      }
      case 'DAMAGE_DEALT': {
        const source = playerOf(event.sourceId);
        const cleave =
          event.cause === 'SKILL' &&
          source !== null &&
          CHARACTERS[source.characterId].skillId === 'cleave';
        showDamage(
          event.sourceId,
          event.targetId,
          event.dealt,
          event.absorbed,
          event.piercing,
          event.critical,
          cleave,
        );
        const detail = [event.critical ? 'critical' : '', event.absorbed > 0 ? `${event.absorbed} blocked` : ''].filter(
          Boolean,
        );
        const cause = CAUSE_LABEL[event.cause];
        const suffix = [...detail, cause].filter(Boolean).join(', ');
        log(
          `${labelOf(event.sourceId)} dealt ${event.dealt} damage to ${labelOf(event.targetId)}${
            suffix ? ` (${suffix})` : ''
          }`,
          'good',
        );
        break;
      }
      case 'HEALED':
        fct.showOver(panelEl(event.playerId), `+${event.amount} HP`, 'HEAL');
        log(`${labelOf(event.playerId)} healed ${event.amount} HP`, 'good');
        break;
      case 'MAX_HP_CUT': {
        const panel = panelEl(event.playerId);
        panel.classList.remove('soul-cut');
        void panel.offsetWidth; // restart the pulse when the domain lands twice
        panel.classList.add('soul-cut');
        later(() => panel.classList.remove('soul-cut'), 900);
        fct.showOver(panel, `-${Math.round(event.fraction * 100)}% MAX HP (SOUL DISFIGURED)`, 'DAMAGE');
        log(
          `${labelOf(event.playerId)}'s soul is disfigured: maximum HP is now ${event.maxHp} (-${event.amount})`,
          'bad',
        );
        break;
      }
      case 'SEAL_ABSORBED': {
        const card = cardEl(event.cardId);
        sparkCards(event.boardId, [event.cardId]);
        if (card) {
          card.classList.remove('ember-absorb');
          void card.offsetWidth;
          card.classList.add('ember-absorb');
          later(() => card.classList.remove('ember-absorb'), 900);
        }
        fct.showOver(card, `+${event.ceGain} CE · SEAL CONSUMED 🔥`, 'HEAL');
        log(`${labelOf(event.playerId)} consumed a seal for +${event.ceGain} CE`, 'good');
        break;
      }
      case 'CE_CHANGED':
        if (event.cause === 'SIPHON' || event.cause === 'DRAIN' || event.cause === 'CARD_EFFECT') {
          log(
            `${labelOf(event.playerId)} ${event.delta >= 0 ? 'gained' : 'lost'} ${Math.abs(event.delta)} CE (${
              event.cause === 'SIPHON' ? 'siphon' : event.cause === 'DRAIN' ? 'drain' : 'trap'
            })`,
          );
        }
        break;
      case 'CARDS_REVEALED':
        sparkCards(event.boardId, event.cardIds);
        log(`${labelOf(event.sourceId)} revealed ${event.cardIds.length} card(s) for ${event.revealMs / 1000}s`);
        break;
      case 'CARD_MODIFIED':
        // Every sealing ability ends the same way: the talisman lands on each locked card.
        if (event.modifier === CARD_EFFECT_KIND.LOCKED) sealStamps.queue(event.cardIds);
        for (const cardId of event.cardIds) pendingTrapPlants.set(cardId, event.modifier);
        sparkCards(event.boardId, event.cardIds);
        log(
          `${labelOf(event.sourceId)} planted ${MODIFIER_GLYPH[event.modifier] ?? event.modifier} on ${
            event.cardIds.length
          } card(s)`,
          'bad',
        );
        break;
      case 'CARD_EFFECT_TRIGGERED': {
        const rules = [
          event.damage > 0 ? `${event.damage} damage` : '',
          event.stunMs > 0 ? `${event.stunMs / 1000}s stun` : '',
          event.ceDrain > 0 ? `${event.ceDrain} CE drained` : '',
        ].filter(Boolean);
        playCue('STRIKE');
        sparkCards(null, [event.cardId]);
        // The hazard that just went off detonates — ember burst, nail slam, seal burst or
        // flesh surge on top of the card's own recoil — and its consequences are announced
        // on impact, so the burst is never stolen by the damage number under it.
        trapPop(event.cardId, event.modifier, () => {
          // Hazard damage pops off the card itself, which is where the player just clicked.
          if (event.damage > 0) fct.showOver(cardEl(event.cardId), `-${event.damage}`, 'DAMAGE');
          log(
            `${labelOf(event.playerId)} triggered a ${event.modifier.toLowerCase()} card (${rules.join(', ')})`,
            'bad',
          );
        });
        break;
      }
      case 'CARDS_SWAPPED':
        sparkCards(event.boardId, event.cardIds);
        log(`${boardLabel(event.boardId)} reshuffled by Boogie Woogie`);
        break;
      case 'CARDS_AUTO_MATCHED':
        sparkCards(event.boardId, event.cardIds);
        log(`${labelOf(event.playerId)}'s technique resolved a pair`, 'domain');
        break;
      case 'STUNNED':
        log(`${labelOf(event.playerId)} is stunned until ${(event.until / 1000).toFixed(1)}s`, 'bad');
        break;
      case 'STATUS_APPLIED':
        if (event.status === STATUS_KIND.SHIELD) {
          fct.showOver(panelEl(event.playerId), `+${event.value} BARRIER`, 'HEAL');
          log(`${labelOf(event.playerId)} raised a ${event.value} barrier`, 'good');
          break;
        }
        log(
          `${labelOf(event.playerId)}: ${STATUS_LABEL[event.status]}${
            event.turnsRemaining === null ? '' : ` (${event.turnsRemaining} turns)`
          }`,
          'domain',
        );
        break;
      case 'STATUS_ADAPTED':
        log(`${labelOf(event.playerId)}: ${STATUS_LABEL[event.status]} — ${event.note}`, 'bad');
        break;
      case 'TRAP_TRIGGERED':
        // A cursed object has no burst of its own: the card recoils, and the cursed energy
        // it hands over is announced as the recoil settles.
        trapPop(event.cardId, null, () => {
          log(`${labelOf(event.playerId)} flipped ${TRAPS[event.trapId].name} (+${event.cursedEnergyGain} CE)`);
        });
        break;
      case 'SKILL_ACTIVATED':
        playCue(event.vfx);
        log(`${labelOf(event.playerId)} used ${event.name} (${event.cost} CE)`, 'domain');
        break;
      case 'ULTIMATE_ACTIVATED': {
        playCue(event.vfx);
        if (event.domainId !== null) {
          showOverlay(event.name, event.ultimateType === ULTIMATE_TYPE.DOMAIN ? 'DOMAIN EXPANSION' : 'SIMPLE DOMAIN');
          showBanner(event.name.toUpperCase(), 'domain');
        }
        log(
          `${labelOf(event.playerId)} activated ${event.name} [${
            event.ultimateType === ULTIMATE_TYPE.DOMAIN ? 'Domain' : 'Simple Domain / Maximum'
          }]`,
          'domain',
        );
        break;
      }
      case 'SENTENCING_ESCAPE_OFFERED':
        log(`Judgeman: ${labelOf(event.casterId)} sentences ${labelOf(event.victimId)} to a Deadly Sentencing`, 'domain');
        break;
      case 'SENTENCING_NEUTRALIZED':
        log(`${labelOf(event.victimId)} paid the cursed energy and escaped the sentencing`, 'good');
        break;
      case 'COURTROOM_OPENED':
        log(`Judgeman: ${labelOf(event.victimId)} faces a ${event.rounds}-round trial`, 'domain');
        break;
      case 'COURTROOM_VERDICT':
        sentencing.verdict(event.slot, event.verdict);
        log(
          event.verdict === 'NOT_GUILTY' ? 'Judgeman: Not guilty' : `Judgeman: Guilty (strike ${event.mistakes})`,
          event.verdict === 'NOT_GUILTY' ? 'good' : 'bad',
        );
        break;
      case 'COURTROOM_CLOSED':
        // Its seals are already queued; they land as soon as the courtroom releases the grid.
        log(`${labelOf(event.victimId)} leaves the trial with ${event.mistakes} strike(s)`, 'domain');
        break;
      case 'EXECUTIONER_GRANTED':
        log(`${labelOf(event.playerId)} wields the Executioner's Sword (${event.damage} damage)`, 'bad');
        break;
      case 'AWAKENING_OPENED':
        log(`${labelOf(event.playerId)} cleared the board: Awakening Surge! Choosing a blessing…`, 'domain');
        break;
      case 'AWAKENING_CHOSEN':
        if (event.rolled) {
          // Instant roll: no pause, so the result lands as a banner under the clearer's HUD.
          log(`${labelOf(event.playerId)} rolled ${blessingTitle(event.blessing)}`, 'domain');
          showAwakeningToast(part(panelEl(event.playerId), '.awakening-toast-slot'), event.blessing);
          break;
        }
        log(
          event.automatic
            ? `Time ran out: ${labelOf(event.playerId)} is granted ${blessingTitle(event.blessing)}`
            : `${labelOf(event.playerId)} chose ${blessingTitle(event.blessing)}`,
          'domain',
        );
        break;
      case 'EXECUTIONER_EXPIRED':
        log(`${labelOf(event.playerId)}'s Executioner's Sword fades`);
        break;
      case 'DOMAIN_NULLIFIED':
        log(`${labelOf(event.playerId)}'s domain was neutralized for ${event.turnsRemaining} turns`, 'bad');
        break;
      case 'SIMPLE_DOMAIN_OPENED':
        log(`${labelOf(event.playerId)} raises ${ULTIMATES[event.ultimateId].name} for ${event.turnsRemaining} turns`, 'domain');
        break;
      case 'SIMPLE_DOMAIN_CLOSED':
        log(`${ULTIMATES[event.ultimateId].name} closes`, 'info');
        break;
      case 'DOMAIN_EXPIRED':
        log(`${labelOf(event.playerId)}'s domain collapsed`);
        break;
      case 'BOARD_CLEARED':
        showReshuffle(event.ownerId);
        log(`${boardLabel(event.boardId)} cleared — reshuffling`, 'domain');
        break;
      case 'BOARD_RESPAWNED':
        dealBoard(event.boardId);
        log(`${boardLabel(event.boardId)} re-dealt: ${event.cardCount} fresh cards`);
        break;
      case 'PACHINKO_OPENED':
        log(`${labelOf(event.playerId)} opens the Idle Death Gamble · ${event.spins} re-spins`, 'domain');
        break;
      case 'PACHINKO_SPUN':
        hakari.showResult(event, clockNow());
        log(`${labelOf(event.playerId)} spins ${event.reels.join('-')}: ${event.tier}`, 'domain');
        if (event.tier !== 'MISS') showBanner(event.tier === 'BANKRUPT' ? 'BANKRUPT!' : `${event.tier} JACKPOT!`, 'domain');
        break;
      case 'GAMBLE_RESOLVED':
        fct.showOver(panelEl(event.playerId), event.won ? '🎰 GAMBLE WON! x2 DMG & 40 CE REFUND' : '💥 GAMBLE LOST: -15% MAX HP', 'DAMAGE');
        log(event.won ? `${labelOf(event.playerId)} wins the gamble: double damage & CE refund` : `${labelOf(event.playerId)} loses the gamble: -${event.amount} HP`, event.won ? 'good' : 'bad');
        break;
      case 'TURN_ENDED':
        // The turn is over, so its effects are over too; nothing may paint into the next.
        clearAllVfx();
        break;
      case 'TURN_SKIPPED':
        log(`${labelOf(event.playerId)} loses the turn to Unlimited Void`, 'bad');
        showBanner(`${labelOf(event.playerId).toUpperCase()}'S TURN SKIPPED!`, 'domain');
        break;
      case 'TURN_TIMED_OUT':
        log(`${labelOf(event.playerId)} ran out of time`);
        break;
      case 'DEBUG_ACTION':
        log(`⚙ ${event.detail}`, 'good');
        break;
      case 'MATCH_ENDED':
        showResult(event.result);
        log('Match ended');
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Input and loop
// ---------------------------------------------------------------------------

function toast(message: string): void {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  later(() => element.classList.remove('show'), GAME_PACING.TOAST_MS);
}

/** The victim's escape choice: the host applies it directly, a guest sends it to the host. */
function answerSentencing(escape: boolean): void {
  const current = session;
  const trial = currentView()?.sentencing;
  if (!current || !trial) return;
  if (current.guest) {
    current.guest.answerEscape(escape);
    return;
  }
  if (current.engine) command(current.engine.answerEscape(trial.victimId, escape, clockNow()));
}

/** The victim's pick of a face-down slot: the host applies it directly, a guest sends it to the host. */
function pickSentencingSlot(slot: number): void {
  const current = session;
  const trial = currentView()?.sentencing;
  if (!current || !trial) return;
  if (current.guest) {
    current.guest.pickCourtroomSlot(slot);
    return;
  }
  if (current.engine) command(current.engine.pickCourtroomSlot(trial.victimId, slot, clockNow()));
}

/** The prosecutor's charge: the host applies it directly, a guest sends it to the host. */
function prosecuteSentencing(subject: CardSubjectId): void {
  const current = session;
  const trial = currentView()?.sentencing;
  if (!current || !trial) return;
  if (current.guest) {
    current.guest.prosecuteCourtroom(subject);
    return;
  }
  if (current.engine) command(current.engine.chooseProsecution(trial.casterId, subject, clockNow()));
}

/** The clearer's blessing: the host applies it directly, a guest sends it to the host. */
function chooseAwakening(blessing: BlessingId): void {
  const current = session;
  const pending = currentView()?.awakening;
  if (!current || !pending) return;
  if (current.guest) {
    current.guest.chooseBlessing(blessing);
    return;
  }
  if (current.engine) command(current.engine.chooseBlessing(pending.playerId, blessing, clockNow()));
}

function command(result: EngineResult): void {
  handleEvents(result.events);
  // Every refused action says why: a sealed card, the wrong grid, an open evaluation.
  if (!result.ok) toast(humanize(result.code));
  // Host and guest actions alike are mirrored to the guest; the host owns the truth.
  session?.host?.publish(result.events);
  renderFrame();
}

function loop(): void {
  const current = session;
  if (current?.engine) {
    const result = current.engine.tick(clockNow());
    handleEvents(result.events);
    current.host?.publish(result.events);
    renderFrame();
  } else if (current?.guest) {
    // The guest renders snapshots the host pushed; nothing ticks locally.
    renderFrame();
  }
  window.requestAnimationFrame(loop);
}

function bindEvents(): void {
  // A setup-form failure is logged rather than allowed to stop the remaining handlers from binding.
  try {
    populateSetup();
  } catch (error) {
    console.error('Setup modal failed to initialise:', error);
  }

  $('#setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    startMatch();
  });
  $('#new-match').addEventListener('click', showSetup);
  $('#rematch').addEventListener('click', requestRematch);
  $('#back-setup').addEventListener('click', showSetup);
  $('#randomize-all').addEventListener('click', randomizeSetup);
  // A host waiting in a room re-sends the rules whenever the form changes.
  $('#setup-form').addEventListener('change', () => syncOnlineLobbyPreview());

  $('#lobby-cancel').addEventListener('click', () => showSetup());
  $('#copy-code').addEventListener('click', () => {
    const code = $('#lobby-code').dataset.code ?? '';
    const label = $('#copy-code-label');
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        label.textContent = '✓ Copied!';
        window.setTimeout(() => {
          label.textContent = 'Copy';
        }, 2000);
      })
      .catch(() => toast(`Room code: ${code}`));
  });

  for (const board of document.querySelectorAll<HTMLElement>('#match .board')) {
    board.addEventListener('click', (event) => {
      const current = session;
      if (!current || !(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('button.card');
      const cardId = button?.dataset.cardId;
      if (!button || !cardId) return;
      // A burst owns the grid until it ends: a second click would land on a card that is
      // already turning over.
      if (boardLocked) return;

      const view = currentView();
      if (!view) return;
      const boardId = board.dataset.board ?? SHARED_BOARD_ID;
      const actor = boardId === SHARED_BOARD_ID ? view.turnOwner : boardId;
      if (actor === null) return;
      // A human never plays another seat for them; the host engine answers the rest.
      if (!current.humanSeats.has(actor)) {
        toast(current.guest ? 'That grid belongs to the host' : `${labelOf(actor)} is handled by the AI`);
        return;
      }
      // A planted trap goes off the moment the card turns over. The burst is played
      // before the flip, so the card is never redrawn from underneath it.
      const burst = flipBurstFor(cardId, actor);
      if (burst !== null) {
        void flipWithBurst(current, actor, cardId, boardId, burst);
        return;
      }
      if (current.guest) {
        current.guest.flip(cardId, boardId);
        return;
      }
      if (current.engine) command(current.engine.flipCard(actor, cardId, clockNow()));
    });
  }

  for (const side of document.querySelectorAll<HTMLElement>('#match .side')) {
    const playerId = side.dataset.player ?? '';
    part<HTMLButtonElement>(side, '.skill-btn').addEventListener('click', () => {
      const current = session;
      if (!current) return;
      if (current.guest) {
        if (playerId === P2) current.guest.cast('SKILL');
        return;
      }
      if (current.engine) command(current.engine.activateSkill(playerId, clockNow()));
    });
    part<HTMLButtonElement>(side, '.ultimate-btn').addEventListener('click', () => {
      const current = session;
      if (!current) return;
      if (current.guest) {
        if (playerId === P2) current.guest.cast('ULTIMATE');
        return;
      }
      if (current.engine) command(current.engine.activateUltimate(playerId, clockNow()));
    });
  }
}

const vfxLayer = $('#vfx');
const vfxCanvas = $<HTMLCanvasElement>('#vfx-canvas');
vfx = createVfxLayer({ layer: vfxLayer, canvas: vfxCanvas, shakeTargets: [$('#match')] });

const fct: FloatingCombatText = createFloatingCombatText({ layer: $('#fct') });

const sentencing: SentencingModal = createSentencingModal({
  root: $('#sentencing'),
  labelOf,
  onEscape: answerSentencing,
  onPick: pickSentencingSlot,
  onProsecute: prosecuteSentencing,
});

const hakari: HakariDomainModal = createHakariDomainModal({
  root: $('#hakari'),
  labelOf,
  onSpin: (playerId) => {
    const current = session;
    if (!current?.engine) return;
    command(current.engine.spinPachinko(playerId, clockNow()));
  },
});

const awakening: AwakeningModal = createAwakeningModal({
  root: $('#awakening'),
  labelOf,
  onChoose: chooseAwakening,
});

/** One seal-stamp effect for every ability that locks a card, driven by the render loop. */
const sealStamps = createSealStampVfx({
  roots: () => (session ? [...session.boardElements.values()] : []),
  // A covered grid would hide the slam, so a courtroom's talismans wait for it to close.
  boardVisible: () => document.querySelector('.sentencing.show, .awakening.show') === null,
  onStamp: playTalismanSealStamp,
});

// One switch for everything the game plays: the effects and the music share the mute, so M
// is never half-silent.
// The saved mixer applies before anything plays, so the stored levels and mutes hold from the first sound.
applyAudioSettings(loadAudioSettings(), { sfx, bgm });

// Pre-bake every cue into a buffer while the app is still settling, so the first flip of a
// match is a buffer replay rather than an oscillator graph built on the main thread. Idle
// scheduled, and with a timeout, so launch work can never hold up the first paint.
if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(() => sfx.prewarm(), { timeout: 2_000 });
} else {
  window.setTimeout(() => sfx.prewarm(), 600);
}

mountSoundToggle($<HTMLButtonElement>('#sound-toggle'), {
  get muted(): boolean {
    return sfx.muted;
  },
  toggle(): boolean {
    const next = sfx.toggle();
    bgm.setMuted(next);
    // Keep the saved master mute in step, so the settings modal and the header button agree.
    const saved = loadAudioSettings();
    saveAudioSettings({ ...saved, master: { ...saved.master, muted: next } });
    if (!next) {
      sfx.unlock();
      bgm.unlock();
    }
    return next;
  },
  unlock(): void {
    sfx.unlock();
    bgm.unlock();
  },
});

// The codex owns its own trigger, its tabs and its keyboard handling. Its synergy previews
// render inside each pair's own clipped canvas, never on the full-screen effects layer.
const codex = createGuideBook({
  root: $('#codex-modal'),
  trigger: $('#codex'),
});
// The setup dialog's Rules & Modes button opens the codex straight onto its rules tab.
$('#open-rules').addEventListener('click', () => codex.openTab('rules'));

createSettingsModal({
  root: $('#settings-modal'),
  trigger: $<HTMLButtonElement>('#settings-open'),
});

bindEvents();
showSetup();
// iOS Safari mutes the audio bus until the first touch; this unlocks it on that touch.
sfx.armGestureUnlock();
// Browsers keep audio silent until a gesture, so the menu theme starts on the first press.
document.addEventListener(
  'pointerdown',
  () => {
    bgm.ensureAudioContext();
    bgm.start();
  },
  { once: true },
);
window.requestAnimationFrame(loop);
