/**
 * The Idle Death Gamble slot: Hakari's Domain Expansion opens a three-reel pachinko machine.
 *
 * The engine owns the reels, the re-spins, the pity and every payout. This module only draws
 * the machine from the public player state and sends a spin back for the seat that owns it.
 * The reels are CSS strips that spin on their own; the engine's result decides where they land.
 */
import { GAME_CONSTANTS, type PachinkoState, type PachinkoTier, type PlayerId } from '../engine/index.js';
import {
  playBankruptWhiff,
  playJackpotBellFanfare,
  playMechanicalLeverPull,
  playPachinkoReelSpin,
  playPachinkoReelStop,
} from '../utils/sfx.js';

/**
 * How long the finished spin stays up after the third reel locks, before the machine
 * closes or the lever comes back. Long enough to read the three digits and the payout row
 * that lit up for them: the verdict is the point of the spin, not a flicker on the way out.
 */
const RESOLUTION_INSPECTION_MS = 2_000;
/** When each reel locks, counted from the lever pull. The third reel holds the suspense longest. */
const REEL_LOCK_MS = [1_000, 1_600, 2_300] as const;
/** The third reel: the moment the round is resolved and the inspection window opens. */
const FINAL_REEL_LOCK_MS = REEL_LOCK_MS[REEL_LOCK_MS.length - 1] as number;
/**
 * If no result arrives this long after the lever is pulled (the engine refused the spin, or the
 * reply was lost), the reels settle back to what they showed before instead of spinning forever.
 */
const SPIN_ABORT_MS = 5_000;
/** How long the side lever stays down after a pull: the crank and the spring back. */
const PULL_ANIMATION_MS = 500;
/** Symbol cycles on each strip. The resting digit sits in the middle cycle, leaving room to spin. */
const STRIP_CYCLES = 4;
const RESTING_CYCLE = 2;

const TIER_TEXT: Record<PachinkoTier, string> = {
  MISS: 'No triple — spin again',
  REGULAR: 'REGULAR JACKPOT · 2 turns immortal, CE locked at max',
  GOLDEN: 'GOLDEN JACKPOT · 3 turns immortal, +50% damage',
  SUPREME: 'SUPREME 7-7-7 · 3 turns immortal, +50% damage, Domain reset',
  BANKRUPT: 'BANKRUPT · -30% max HP, pity grows',
};

/** The payout guide pinned beside the reels. */
const PAYOUTS: readonly { readonly title: string; readonly rolls: string; readonly effect: string; readonly accent: string }[] = [
  { title: '⚡ ODD FEVER TRIPLES ⚡', rolls: '1-1-1 / 3-3-3 / 5-5-5 · 確変', effect: '2 turns immortal + CE locked at max', accent: 'odd' },
  { title: '◆ EVEN REGULAR HIT ◆', rolls: '2-2-2 / 4-4-4 / 6-6-6 · 通常', effect: '3 turns immortal + 50% damage', accent: 'even' },
  { title: '✦ 7-7-7 SUPREME GOLDEN ✦', rolls: '7-7-7 · 大当たり', effect: '3 turns immortal + 50% damage + Domain reset', accent: 'seven' },
  { title: '⚠ TRIPLE WHIFF PENALTY ⚠', rolls: 'Whiff ×3 · ハズレ', effect: '-30% max HP + pity boost for the next Domain', accent: 'miss' },
];

/**
 * The payout row that lights up once a round resolves: the triple it landed, or the whiff
 * row that explains a bankruptcy. A single miss with re-spins left is no payout at all.
 */
const PAYOUT_ROW_FOR_TIER: Partial<Record<PachinkoTier, number>> = {
  REGULAR: 0,
  GOLDEN: 1,
  SUPREME: 2,
  BANKRUPT: 3,
};

/** The tiers that are a win, and so light the cabinet. A bankruptcy lights its row only. */
const WINNING_TIERS: ReadonlySet<PachinkoTier> = new Set<PachinkoTier>(['REGULAR', 'GOLDEN', 'SUPREME']);

/** The slot state the modal draws: whose machine it is and what it currently holds. */
export interface PachinkoView {
  readonly playerId: PlayerId;
  readonly pachinko: PachinkoState;
}

/** One resolved spin, as the engine reports it. */
export interface PachinkoSpinResult {
  readonly playerId: PlayerId;
  readonly reels: readonly number[];
  readonly tier: PachinkoTier;
  readonly spinsLeft: number;
  readonly pity: number;
}

export interface HakariDomainModalOptions {
  readonly root: HTMLElement;
  readonly labelOf: (id: PlayerId) => string;
  /** Sends a spin for the seat that owns the machine. */
  readonly onSpin: (playerId: PlayerId) => void;
}

export interface HakariDomainModal {
  /**
   * Draws the machine for this frame. `view` is null when no Domain is spinning.
   * `spinIsHuman` says whether this screen may pull the lever.
   */
  render(view: PachinkoView | null, spinIsHuman: boolean, now: number): void;
  /** Lands the reels on a resolved spin and keeps the machine open briefly. */
  showResult(result: PachinkoSpinResult, now: number): void;
  /** Hides the machine at once, for leaving a match. */
  reset(): void;
}

/** One reel: its window (the glass frame, which carries the state) and the strip inside it. */
interface Reel {
  readonly frame: HTMLElement;
  readonly strip: HTMLElement;
}

type ReelState = 'idle' | 'spinning' | 'landed';

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** The style family of a reel symbol: odd, even, the lucky seven, or none before a spin. */
export function reelKind(symbol: number | null): 'odd' | 'even' | 'seven' | 'blank' {
  if (symbol === null) return 'blank';
  if (symbol === GAME_CONSTANTS.PACHINKO_REELS) return 'seven';
  return symbol % 2 === 1 ? 'odd' : 'even';
}

/** Percentage of the next-Domain jackpot bonus, from the pity fraction (0..1). */
export function pityPercent(pity: number): number {
  return Math.round(Math.min(1, Math.max(0, pity)) * 100);
}

/**
 * The strip offset that rests a symbol in the window. The strip repeats 1..PACHINKO_REELS, so
 * the symbol sits in cell `cycle * PACHINKO_REELS + (symbol - 1)`.
 */
function restingOffset(symbol: number): string {
  const cell = RESTING_CYCLE * GAME_CONSTANTS.PACHINKO_REELS + (symbol - 1);
  return `calc(var(--reel-cell) * -${cell})`;
}

function buildReel(): Reel {
  const frame = make('div', 'hakari-reel reel-blank');
  frame.dataset.state = 'idle';
  const strip = make('div', 'hakari-reel-strip');
  for (let cell = 0; cell < GAME_CONSTANTS.PACHINKO_REELS * STRIP_CYCLES; cell++) {
    strip.append(make('div', 'hakari-cell', String((cell % GAME_CONSTANTS.PACHINKO_REELS) + 1)));
  }
  strip.style.setProperty('--y', restingOffset(1));
  frame.append(strip, make('span', 'hakari-reel-idle', '—'));
  return { frame, strip };
}

function bulbRow(): HTMLElement {
  const row = make('span', 'hakari-bulbs');
  for (let index = 0; index < 5; index++) {
    const bulb = make('i', 'hakari-bulb');
    bulb.style.animationDelay = `${index * 0.2}s`;
    row.append(bulb);
  }
  return row;
}

export function createHakariDomainModal(options: HakariDomainModalOptions): HakariDomainModal {
  const { root, labelOf, onSpin } = options;

  root.classList.add('hakari');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Idle Death Gamble');
  root.replaceChildren();

  const panel = make('div', 'hakari-panel');

  const head = make('div', 'hakari-head');
  const title = make('span', 'hakari-title', '🎰 IDLE DEATH GAMBLE · 坐殺博徒');
  const badges = make('div', 'hakari-badges');
  const spinsBadge = make('span', 'hakari-spins');
  const pityBadge = make('span', 'hakari-pity');
  const pityBar = make('span', 'hakari-pity-fill');
  pityBadge.append(pityBar);
  badges.append(spinsBadge, pityBadge);
  head.append(title, badges);

  const body = make('div', 'hakari-body');

  const stage = make('div', 'hakari-stage');
  const owner = make('p', 'hakari-owner');

  const cabinet = make('div', 'hakari-cabinet');
  const marquee = make('div', 'hakari-marquee');
  marquee.append(bulbRow(), make('span', 'hakari-marquee-text', '✦ 7 7 7 IDLE DEATH GAMBLE ✦'), bulbRow());
  const reelRow = make('div', 'hakari-reels');
  const reels: Reel[] = REEL_LOCK_MS.map(buildReel);
  reelRow.append(...reels.map((reel) => reel.frame), make('span', 'hakari-payline'));
  cabinet.append(marquee, reelRow);

  // The physical lever sits on the right flank of the cabinet. It drives the same pull as the button.
  const leverMount = make('div', 'hakari-lever-mount');
  leverMount.setAttribute('role', 'button');
  leverMount.setAttribute('aria-label', 'Pull lever to spin');
  leverMount.tabIndex = 0;
  leverMount.title = 'Pull to Spin!';
  const leverArm = make('div', 'lever-arm');
  leverArm.append(make('div', 'lever-rod'), make('div', 'lever-knob'));
  leverMount.append(make('div', 'lever-base'), leverArm);
  const machine = make('div', 'hakari-machine');
  machine.append(cabinet, leverMount);

  const outcome = make('p', 'hakari-outcome');
  outcome.setAttribute('aria-live', 'polite');
  const lever = make('button', 'hakari-lever', '🎰 PULL LEVER / SPIN');
  lever.type = 'button';
  const waiting = make('p', 'hakari-waiting', '');
  stage.append(owner, machine, outcome, lever, waiting);

  const guide = make('aside', 'hakari-guide');
  const guideHead = make('div', 'hakari-marquee-head');
  guideHead.append(bulbRow(), make('span', 'hakari-guide-title', '⚡ PAYOUT MARQUEE · 配当一覧 ⚡'), bulbRow());
  guide.append(guideHead);
  const payoutRows: HTMLElement[] = [];
  for (const row of PAYOUTS) {
    const line = make('div', `hakari-payout accent-${row.accent}`);
    line.append(
      make('span', 'hakari-payout-title', row.title),
      make('span', 'hakari-payout-rolls', row.rolls),
      make('span', 'hakari-payout-effect', row.effect),
    );
    guide.append(line);
    payoutRows.push(line);
  }

  body.append(stage, guide);
  panel.append(head, body);
  root.append(panel);

  let held: (PachinkoSpinResult & { readonly until: number }) | null = null;
  let spinIsHumanNow = false;
  let shownFresh = false;
  let ownerNow: PlayerId | null = null;
  let spinsNow = 0;
  let pityNow = 0;
  /** True from the lever pull (or a remote result) until the third reel locks. */
  let spinning = false;
  /** True while a resolved round is held for inspection: the lever and the panel are inert. */
  let inspecting = false;
  /** Engine clock at which the inspection window ends, or null when it is not running. */
  let inspectionUntil: number | null = null;
  let spinStartedAt = 0;
  let landedCount = 0;
  /** The symbol each reel currently shows, null while blank. */
  let shown: (number | null)[] = REEL_LOCK_MS.map(() => null);
  let timers: number[] = [];
  let pullTimer = 0;

  /** Cancels the scheduled reel locks and the abort timer, but leaves the lever's crank alone. */
  function clearScheduled(): void {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function clearTimers(): void {
    clearScheduled();
    window.clearTimeout(pullTimer);
    leverMount.classList.remove('pulling');
  }

  function setReel(reel: Reel, state: ReelState, symbol: number | null): void {
    reel.frame.dataset.state = state;
    reel.frame.className = `hakari-reel reel-${reelKind(symbol)}`;
    if (symbol !== null) reel.strip.style.setProperty('--y', restingOffset(symbol));
  }

  function setInspecting(active: boolean): void {
    inspecting = active;
    root.classList.toggle('locked', active);
    root.dataset.phase = active ? 'inspecting' : spinning ? 'spinning' : 'ready';
    // A locked machine takes no click at all: the panel stops hit-testing for the window,
    // so neither the lever nor anything behind it can rush the payout off the screen.
    panel.setAttribute('aria-busy', active ? 'true' : 'false');
  }

  function updateLever(): void {
    const canPull = spinIsHumanNow && spinsNow > 0 && !spinning && !inspecting;
    lever.disabled = !canPull;
    lever.classList.toggle('pickable', canPull);
    leverMount.classList.toggle('pickable', canPull);
    leverMount.setAttribute('aria-disabled', String(!canPull));
    lever.textContent = spinning ? `SPINNING... [${landedCount} / ${REEL_LOCK_MS.length}]` : '🎰 PULL LEVER / SPIN';
  }

  function startSpin(): void {
    if (spinning) return;
    clearTimers();
    spinning = true;
    if (inspecting) setInspecting(false);
    spinStartedAt = performance.now();
    playPachinkoReelSpin();
    landedCount = 0;
    cabinet.classList.remove('jackpot');
    for (const row of payoutRows) row.classList.remove('payout-active-glow');
    for (const reel of reels) setReel(reel, 'spinning', null);
    updateLever();
  }

  function landReel(index: number, result: PachinkoSpinResult): void {
    const reel = reels[index];
    if (!reel) return;
    const symbol = result.reels[index] ?? null;
    shown[index] = symbol;
    setReel(reel, 'landed', symbol);
    playPachinkoReelStop();
    landedCount = index + 1;
    if (landedCount === REEL_LOCK_MS.length) finishSpin(result);
    else updateLever();
  }

  /**
   * The round is over: the digits stay where they landed and the payout row that matched
   * them stays lit. Nothing else on the machine moves again until the window closes.
   */
  function finishSpin(result: PachinkoSpinResult): void {
    spinning = false;
    outcome.textContent = TIER_TEXT[result.tier];
    outcome.dataset.tier = result.tier;
    const row = PAYOUT_ROW_FOR_TIER[result.tier];
    if (row !== undefined) payoutRows[row]?.classList.add('payout-active-glow');
    if (WINNING_TIERS.has(result.tier)) cabinet.classList.add('jackpot');
    // Golden and 7-7-7 ring the long bell fanfare; a regular odd triple rings the short cascade.
    if (WINNING_TIERS.has(result.tier)) {
      playJackpotBellFanfare(result.tier === 'GOLDEN' || result.tier === 'SUPREME');
    } else if (result.tier === 'BANKRUPT') {
      playBankruptWhiff();
    }
    updateLever();
  }

  /** Settles the reels back to what they showed before a spin that never resolved. */
  function abortSpin(): void {
    clearTimers();
    spinning = false;
    inspectionUntil = null;
    setInspecting(false);
    reels.forEach((reel, index) => {
      const symbol = shown[index] ?? null;
      setReel(reel, symbol === null ? 'idle' : 'landed', symbol);
    });
    updateLever();
  }

  function showFreshMachine(): void {
    clearTimers();
    spinning = false;
    inspectionUntil = null;
    setInspecting(false);
    shown = REEL_LOCK_MS.map(() => null);
    for (const reel of reels) setReel(reel, 'idle', null);
    outcome.textContent = '';
    cabinet.classList.remove('jackpot');
    for (const row of payoutRows) row.classList.remove('payout-active-glow');
  }

  /** The side lever cranks down and springs back, for as long as the pull animation lasts. */
  function animatePull(): void {
    leverMount.classList.add('pulling');
    window.clearTimeout(pullTimer);
    pullTimer = window.setTimeout(() => leverMount.classList.remove('pulling'), PULL_ANIMATION_MS);
  }

  function pullLever(): void {
    // The three refusals are absolute: no owner, no pulls left, or a round still being read.
    if (!ownerNow || !spinIsHumanNow || spinsNow <= 0 || spinning || inspecting) return;
    playMechanicalLeverPull();
    startSpin();
    animatePull();
    timers.push(window.setTimeout(abortSpin, SPIN_ABORT_MS));
    onSpin(ownerNow);
  }

  lever.addEventListener('click', pullLever);
  leverMount.addEventListener('click', pullLever);
  leverMount.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    pullLever();
  });

  return {
    render(view, spinIsHuman, now) {
      const holding = held !== null && now < held.until;
      if (!holding) held = null;
      if (view === null && !holding) {
        root.classList.remove('show');
        // The window is over with the machine closed: never leave a stale lock behind.
        if (inspecting) {
          inspectionUntil = null;
          setInspecting(false);
        }
        ownerNow = null;
        return;
      }

      const playerId = view?.playerId ?? held!.playerId;
      const spinsLeft = view ? view.pachinko.spinsLeft : 0;
      const pity = view ? view.pachinko.pity : held!.pity;
      const label = labelOf(playerId);
      ownerNow = playerId;
      spinsNow = spinsLeft;
      pityNow = pity;
      spinIsHumanNow = view !== null && spinIsHuman;

      // The inspection window is measured on the engine clock and ends in a render frame,
      // so the machine can never stay locked past it.
      if (inspecting && inspectionUntil !== null && now >= inspectionUntil) {
        inspectionUntil = null;
        setInspecting(false);
        updateLever();
      }

      root.classList.add('show');
      owner.textContent = `${label}'s domain`;
      spinsBadge.textContent = `Re-spins Left: ${spinsLeft} / ${GAME_CONSTANTS.PACHINKO_SPINS}`;
      pityBar.style.width = `${pityPercent(pityNow)}%`;
      pityBadge.title = `Pity +${pityPercent(pityNow)}% jackpot chance on the next Domain`;

      // A fresh Domain opens with full re-spins and a blank machine.
      if (view !== null && spinsLeft === GAME_CONSTANTS.PACHINKO_SPINS && !shownFresh) showFreshMachine();
      shownFresh = view !== null && spinsLeft === GAME_CONSTANTS.PACHINKO_SPINS;

      updateLever();
      const remote = view !== null && !spinIsHuman && spinsLeft > 0;
      waiting.textContent = remote ? `${label} is spinning the Pachinko reels...` : '';
    },
    showResult(result, now) {
      // A local pull has already started the reels; a remote result starts them here.
      startSpin();
      clearScheduled();
      const elapsed = performance.now() - spinStartedAt;
      // The digits are what the player came for. Once the third one locks, the machine is
      // frozen for a strict 2.0s so the roll and its payout can both be read.
      const untilSettled = Math.max(0, FINAL_REEL_LOCK_MS - elapsed);
      inspectionUntil = now + untilSettled + RESOLUTION_INSPECTION_MS;
      held = { ...result, until: inspectionUntil };
      setInspecting(true);
      updateLever();
      REEL_LOCK_MS.forEach((lockAt, index) => {
        timers.push(window.setTimeout(() => landReel(index, result), Math.max(0, lockAt - elapsed)));
      });
    },
    reset() {
      held = null;
      ownerNow = null;
      spinIsHumanNow = false;
      inspectionUntil = null;
      showFreshMachine();
      updateLever();
      root.classList.remove('show');
    },
  };
}
