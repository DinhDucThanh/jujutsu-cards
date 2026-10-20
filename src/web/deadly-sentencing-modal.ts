/**
 * The Deadly Sentencing courtroom: the escape prompt, then the four-card trial.
 *
 * The engine owns every timer and every pick. This module only draws the public view and
 * sends the answers back. Cards are tracked by their starting slot, so a swap shows up as
 * one card sliding to its new slot instead of two cards teleporting.
 */
import {
  CHARACTERS,
  COURTROOM_PHASE,
  GAME_CONSTANTS,
  GAME_PACING,
  isCharacterId,
  type CardSubjectId,
  type PlayerId,
  type PublicSentencingView,
} from '../engine/index.js';
import { createCardButton, SUBJECT_GLYPH } from './card-face.js';
import { CARD_VISUALS, cardIconFor, renderCardIcon, type CardIconKey } from './card-icons.js';
import { SUBJECT_LABELS } from './guidebook.js';

const CARD_COUNT = GAME_CONSTANTS.COURTROOM_SLOTS;
/** Distance between neighbouring slots in px. Matches the 112px card with a 14px gap in CSS. */
const SLOT_STRIDE_PX = 126;
/** Ignores repeat clicks for a moment, so a double tap cannot send the same answer twice. */
const ANSWER_LOCK_MS = 500;

export type Verdict = 'NOT_GUILTY' | 'GUILTY';
type Swap = readonly [number, number];

/**
 * The courtroom's own copy for a verdict. A guilty pick names the evidence the victim
 * missed, because the point of the beat is seeing where the target actually went.
 */
export function verdictHeadline(verdict: Verdict, target: CardSubjectId | null): string {
  if (verdict === 'NOT_GUILTY') return 'NOT GUILTY — CHARGE DISMISSED';
  return `GUILTY — 1 CARD CONDEMNED${target === null ? '' : ` (Target was ${subjectName(target)})`}`;
}

export interface SentencingModalOptions {
  readonly root: HTMLElement;
  readonly labelOf: (id: PlayerId) => string;
  readonly onEscape: (escape: boolean) => void;
  /** Receives the slot the victim picked: the card's position at the moment of the click. */
  readonly onPick: (slot: number) => void;
  /** Receives the subject the prosecutor charges the victim with locating. */
  readonly onProsecute: (subject: CardSubjectId) => void;
}

export interface SentencingModal {
  /**
   * Draws the courtroom for this frame. `null` closes it once any verdict hold is over.
   * `victimIsHuman` and `casterIsHuman` say which answers this screen may send.
   */
  render(
    view: PublicSentencingView | null,
    victimIsHuman: boolean,
    now: number,
    casterIsHuman?: boolean,
  ): void;
  /** Flags the picked slot with its verdict. The flag clears itself after a short hold. */
  verdict(slot: number, verdict: Verdict): void;
  /** Hides the courtroom at once, for leaving a match. */
  reset(): void;
}

/** The card order after the first `steps` swaps. `order[position]` is the card standing there. */
export function slotOrderAfter(swaps: readonly Swap[], steps: number, count: number = CARD_COUNT): number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  for (const [a, b] of swaps.slice(0, Math.max(0, steps))) {
    const left = order[a];
    const right = order[b];
    if (left === undefined || right === undefined) continue;
    order[a] = right;
    order[b] = left;
  }
  return order;
}

/** How many swaps have begun by `now`. Swap i begins i × `swapMs` after the shuffle starts. */
export function swapsStarted(now: number, shuffleStartAt: number, swapCount: number, swapMs: number): number {
  if (swapCount <= 0 || now < shuffleStartAt) return 0;
  return Math.min(swapCount, Math.floor((now - shuffleStartAt) / swapMs) + 1);
}

/** The name a subject shows on its card and in the Judgeman's prompt. */
export function subjectName(id: CardSubjectId): string {
  return SUBJECT_LABELS[id] ?? (isCharacterId(id) ? CHARACTERS[id].name : id);
}

/**
 * The emblem a subject wears in the courtroom and its accent, both from the shared card visuals.
 * `mark` is the kanji fallback for a subject with no emblem.
 */
function subjectStyle(id: CardSubjectId): { readonly icon: CardIconKey | null; readonly mark: string; readonly accent: string } {
  return {
    icon: cardIconFor(id, false),
    mark: SUBJECT_GLYPH[id] ?? subjectName(id).charAt(0),
    accent: CARD_VISUALS[id].accent,
  };
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

function identityOrder(): number[] {
  return Array.from({ length: CARD_COUNT }, (_, index) => index);
}

function canPick(view: PublicSentencingView, victimIsHuman: boolean, pickedRound: number): boolean {
  return (
    view.stage === 'TRIAL' &&
    view.phase === COURTROOM_PHASE.PICK &&
    victimIsHuman &&
    pickedRound !== view.round
  );
}

function canProsecute(view: PublicSentencingView, casterIsHuman: boolean): boolean {
  return (
    view.stage === 'TRIAL' &&
    view.phase === COURTROOM_PHASE.PROSECUTE &&
    casterIsHuman &&
    (view.candidates?.length ?? 0) > 0
  );
}

function trialPrompt(
  view: PublicSentencingView,
  casterName: string,
  casterIsHuman: boolean,
  victimIsHuman: boolean,
  remainingMs: number,
): string {
  switch (view.phase) {
    case COURTROOM_PHASE.REVEAL:
      return `MEMORIZE THE EVIDENCE (${(remainingMs / 1000).toFixed(1)}s)`;
    case COURTROOM_PHASE.SHUFFLE:
      return 'Judgeman: Watch the evidence shuffle. Do not lose track.';
    case COURTROOM_PHASE.PROSECUTE:
      return casterIsHuman ? 'Judgeman: Choose the charge.' : `Judgeman: ${casterName} is naming the charge.`;
    case COURTROOM_PHASE.PICK:
      if (!victimIsHuman) return "Judgeman: Awaiting defendant's plea / card selection...";
      return view.target === null ? 'Judgeman: Make your selection.' : `Judgeman: Locate ${subjectName(view.target)}!`;
    default:
      return '';
  }
}

export function createSentencingModal(options: SentencingModalOptions): SentencingModal {
  const { root, labelOf } = options;
  const swapMs = GAME_PACING.COURTROOM_SWAP_DURATION_MS;

  root.classList.add('sentencing');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Deadly Sentencing');
  root.replaceChildren();

  const panel = make('div', 'sentencing-panel');
  const head = make('div', 'sentencing-head');
  const titleGroup = make('div', 'sentencing-title-group');
  titleGroup.append(
    make('span', 'sentencing-title', '⚖️ DEADLY SENTENCING'),
    make('span', 'sentencing-subtitle', '· 斷罪裁判'),
  );
  const tracker = make('span', 'sentencing-tracker');
  tracker.setAttribute('aria-hidden', 'true');
  const dots: HTMLElement[] = [];
  for (let index = 0; index < GAME_CONSTANTS.COURTROOM_ROUNDS; index++) {
    const dot = make('span', 'sentencing-dot', '○');
    dots.push(dot);
    tracker.append(dot);
  }
  const roundLabel = make('span', 'sentencing-round');
  const roundGroup = make('div', 'sentencing-round-group');
  roundGroup.append(tracker, roundLabel);
  const strikeMarks = make('span', 'sentencing-strikes');
  head.append(titleGroup, roundGroup, strikeMarks);

  const judgeman = make('p', 'sentencing-judgeman');
  judgeman.setAttribute('aria-live', 'polite');
  const timer = make('div', 'sentencing-timer');
  const timerFill = make('span', 'sentencing-timer-fill');
  timer.append(timerFill);

  // The left-docked prosecutor panel: four name badges, shown only to a human prosecutor.
  const side = make('aside', 'sentencing-side');
  const prosecute = make('div', 'sentencing-prosecute');
  const prosecuteTitle = make('p', 'sentencing-prosecute-title', '⚖️ PROSECUTION CHARGE');
  const prosecutePrompt = make('p', 'sentencing-prosecute-prompt', 'Select the required evidence for the accused:');
  const badges = make('div', 'sentencing-badges');
  prosecute.append(prosecuteTitle, prosecutePrompt, badges);
  // Takes the prosecutor's place when nobody is prosecuting, so the side column keeps its shape.
  const caseNote = make('div', 'sentencing-case');
  side.append(prosecute, caseNote);
  let badgeKey = '';
  let badgeButtons: HTMLButtonElement[] = [];

  const verdictLine = make('div', 'sentencing-verdict');
  // A slim bar under the proclamation that drains over the inspection beat.
  const inspect = make('div', 'sentencing-inspect');
  const inspectFill = make('span', 'sentencing-inspect-fill');
  inspect.append(inspectFill);

  const track = make('div', 'sentencing-track');
  track.style.setProperty('--swap-ms', `${swapMs}ms`);
  const cards: HTMLButtonElement[] = [];
  for (let index = 0; index < CARD_COUNT; index++) {
    // The battle grid's own card DOM, so a courtroom card carries the same talisman art.
    const card = createCardButton();
    card.classList.add('sentencing-card');
    card.disabled = true;
    const sigil = card.querySelector('.sigil');
    if (sigil) sigil.textContent = '秤';
    // The seal sits outside the flip so it reads the same whichever face is up.
    card.append(make('span', 'seal', '封'));
    card.addEventListener('click', () => pickCard(index));
    track.append(card);
    cards.push(card);
  }

  const escapeRow = make('div', 'sentencing-escape');
  const payButton = make('button', 'sentencing-btn spend', `Spend ${GAME_CONSTANTS.COURTROOM_ESCAPE_COST} CE to escape`);
  const faceButton = make('button', 'sentencing-btn', 'Face the trial');
  payButton.type = 'button';
  faceButton.type = 'button';
  payButton.addEventListener('click', () => answerEscape(true));
  faceButton.addEventListener('click', () => answerEscape(false));
  escapeRow.append(payButton, faceButton);

  const trialStage = make('div', 'sentencing-stage');
  trialStage.append(judgeman, timer, verdictLine, inspect, track, escapeRow);
  const body = make('div', 'sentencing-body');
  body.append(side, trialStage);
  panel.append(head, body);
  root.append(panel);

  let visible = false;
  let current: PublicSentencingView | null = null;
  let victimIsHuman = false;
  let casterIsHuman = false;
  let stage: 'ESCAPE' | 'TRIAL' | null = null;
  let round = 0;
  let subjects: (CardSubjectId | null)[] = Array.from({ length: CARD_COUNT }, () => null);
  let order = identityOrder();
  let positions: number[] = Array.from({ length: CARD_COUNT }, () => -1);
  let moving = new Set<number>();
  let pickedRound = 0;
  let locked = false;
  let lockTimer: number | null = null;
  /**
   * The verdict on screen: the card the victim picked, how it was judged, and the card that
   * really held the target (null on an acquittal). Both are face-up while it is set.
   */
  let inspection: { card: number; verdict: Verdict; target: number | null } | null = null;
  /** What the proclamation currently says, so the DOM is only rebuilt when the verdict changes. */
  let verdictShown = '';

  let prosecutorShown = false;

  /** A hidden element keeps its space, so nothing around it moves when a phase changes. */
  function setShown(element: HTMLElement, shown: boolean): void {
    element.style.visibility = shown ? '' : 'hidden';
  }

  /** The prosecutor's panel springs in as it opens; the case note yields to it. */
  function showProsecutor(shown: boolean): void {
    prosecute.hidden = !shown;
    caseNote.hidden = shown;
    if (shown && !prosecutorShown) {
      prosecute.classList.remove('prosecutor-panel-enter');
      void prosecute.offsetWidth;
      prosecute.classList.add('prosecutor-panel-enter');
    }
    prosecutorShown = shown;
  }

  /** The prosecutor's panel is a prompt on the prosecutor's screen and a waiting banner everywhere else. */
  function setProsecutorCopy(waiting: boolean, casterName: string): void {
    prosecute.classList.toggle('waiting', waiting);
    prosecuteTitle.textContent = waiting ? '⚖️ COURT IN SESSION' : '⚖️ PROSECUTION CHARGE';
    prosecutePrompt.textContent = waiting
      ? `Prosecutor ${casterName} is reviewing the charges...`
      : 'Select the required evidence for the accused:';
  }

  function setCaseNote(view: PublicSentencingView): void {
    const text = `CASE FILE\nAccused: ${labelOf(view.victimId)}\nSentenced by: ${labelOf(view.casterId)}`;
    if (caseNote.textContent !== text) caseNote.textContent = text;
  }

  function syncControls(): void {
    const escapeOpen = current?.stage === 'ESCAPE' && victimIsHuman;
    // Below the cards in a top-aligned stage, so hiding it moves nothing above it.
    escapeRow.hidden = !escapeOpen;
    payButton.disabled = locked;
    faceButton.disabled = locked;

    // Every client sees the charge phase; only the prosecutor's own screen can choose.
    const charging = current !== null && current.stage === 'TRIAL' && current.phase === COURTROOM_PHASE.PROSECUTE;
    const choosable = current !== null && canProsecute(current, casterIsHuman);
    showProsecutor(charging);
    for (const badge of badgeButtons) badge.disabled = locked || !choosable;

    const pickable = current !== null && canPick(current, victimIsHuman, pickedRound) && !locked;
    track.classList.toggle('pickable', pickable);
    for (const card of cards) card.disabled = !pickable;
  }

  /** Blocks further answers briefly. The engine still decides, so a rejected answer just toasts. */
  function lockBriefly(): void {
    locked = true;
    syncControls();
    if (lockTimer !== null) window.clearTimeout(lockTimer);
    lockTimer = window.setTimeout(() => {
      lockTimer = null;
      locked = false;
      syncControls();
    }, ANSWER_LOCK_MS);
  }

  function pickCard(card: number): void {
    const view = current;
    if (!view || locked || !canPick(view, victimIsHuman, pickedRound)) return;
    const slot = order.indexOf(card);
    if (slot < 0) return;
    pickedRound = view.round;
    lockBriefly();
    options.onPick(slot);
  }

  function answerEscape(escape: boolean): void {
    if (!current || locked || current.stage !== 'ESCAPE' || !victimIsHuman) return;
    lockBriefly();
    options.onEscape(escape);
  }

  function prosecuteWith(subject: CardSubjectId): void {
    const view = current;
    if (!view || locked || !canProsecute(view, casterIsHuman)) return;
    lockBriefly();
    options.onProsecute(subject);
  }

  /** Rebuilds the badges only when the candidates change, so a click is never lost to a redraw. */
  function buildBadges(candidates: readonly CardSubjectId[]): void {
    const key = candidates.join('|');
    if (key === badgeKey) return;
    badgeKey = key;
    badges.replaceChildren();
    badgeButtons = [];
    for (const id of candidates) {
      const badge = make('button', 'sentencing-badge');
      badge.type = 'button';
      const style = subjectStyle(id);
      badge.style.setProperty('--accent', style.accent);
      const mark = make('span', 'badge-mark', style.icon === null ? style.mark : '');
      if (style.icon !== null) mark.innerHTML = renderCardIcon(style.icon);
      badge.append(mark, make('span', 'badge-name', subjectName(id)));
      badge.addEventListener('click', () => prosecuteWith(id));
      badges.append(badge);
      badgeButtons.push(badge);
    }
  }

  /** Moves every card to its slot. A snap skips the transition, used when a new round deals. */
  function placeCards(snap: boolean): void {
    if (snap) track.classList.add('snap');
    cards.forEach((card, index) => {
      const position = order.indexOf(index);
      if (positions[index] === position) return;
      positions[index] = position;
      card.style.transform = `translateX(${position * SLOT_STRIDE_PX}px)`;
    });
    if (snap) {
      track.getBoundingClientRect();
      track.classList.remove('snap');
    }
  }

  /** Face-up cards, the swapping pair and verdict colours follow the phase and the latest verdict. */
  function paintCards(): void {
    const phase = current?.phase ?? null;
    const revealAll = phase === COURTROOM_PHASE.REVEAL;
    const inspecting = phase === COURTROOM_PHASE.INSPECT;
    const picked = inspection?.card ?? -1;
    const target = inspection?.target ?? -1;
    cards.forEach((card, index) => {
      // The reveal turns every card up; the inspection turns up only the two that matter.
      card.classList.toggle('up', revealAll || (inspecting && (index === picked || index === target)));
      card.classList.toggle('moving', moving.has(index));
      card.classList.toggle('ng', inspection?.verdict === 'NOT_GUILTY' && index === picked);
      card.classList.toggle('guilty', inspection?.verdict === 'GUILTY' && index === picked);
      // The true slot wears a golden bracket, so it reads in a glance next to the red pick.
      card.classList.toggle('target', inspecting && index === target);
      const subject = subjects[index] ?? null;
      const key = subject ?? '';
      // `data-char` is what the stylesheet keys each fighter's colours on, as on the battle grid.
      if (card.dataset.subject === key) return;
      card.dataset.subject = key;
      card.dataset.char = key;
      const name = subject ? subjectName(subject) : '';
      const style = subject ? subjectStyle(subject) : null;
      const glyph = subject ? (SUBJECT_GLYPH[subject] ?? name.charAt(0)) : '';
      const art = card.querySelector('.art');
      const label = card.querySelector('.name');
      if (art) {
        // A fighter wears its SVG emblem; a subject without one keeps the kanji.
        const icon = style?.icon ?? null;
        art.classList.toggle('emblem', icon !== null);
        if (icon !== null) art.innerHTML = renderCardIcon(icon);
        else art.textContent = glyph;
      }
      if (label) label.textContent = name;
    });
  }

  function startRound(view: PublicSentencingView): void {
    stage = 'TRIAL';
    round = view.round;
    inspection = null;
    subjects = Array.from({ length: CARD_COUNT }, () => null);
    order = identityOrder();
    moving = new Set();
    placeCards(true);
  }

  function drawEscape(view: PublicSentencingView): void {
    roundLabel.textContent = 'Sentence pending';
    strikeMarks.textContent = '';
    setShown(track, false);
    setShown(timer, false);
    const victim = labelOf(view.victimId);
    const tail = victimIsHuman ? `Pay ${GAME_CONSTANTS.COURTROOM_ESCAPE_COST} CE to escape, or face the trial.` : `${victim} decides.`;
    judgeman.textContent = `Judgeman: ${labelOf(view.casterId)} has sentenced ${victim}. ${tail}`;
  }

  function drawTrial(view: PublicSentencingView, now: number): void {
    setShown(track, true);
    roundLabel.textContent = `Round ${view.round}/${view.totalRounds}`;
    dots.forEach((dot, index) => {
      const passed = index < view.round;
      dot.textContent = passed ? '●' : '○';
      dot.classList.toggle('lit', passed);
    });
    strikeMarks.textContent = view.mistakes > 0 ? '✗'.repeat(view.mistakes) : '';
    strikeMarks.setAttribute('aria-label', `${view.mistakes} strikes`);

    // The shuffle slides one card per swap; the card pair mid-swap is lifted above the rest.
    let steps = view.swaps.length;
    let liveSwap: Swap | undefined;
    if (view.phase === COURTROOM_PHASE.SHUFFLE && view.phaseEndsAt !== null) {
      const shuffleStart = view.phaseEndsAt - view.swaps.length * swapMs;
      steps = swapsStarted(now, shuffleStart, view.swaps.length, swapMs);
      if (steps > 0 && now < shuffleStart + steps * swapMs) liveSwap = view.swaps[steps - 1];
    }
    order = slotOrderAfter(view.swaps, steps);
    // The view names a subject per slot; the courtroom draws them per card, so translate
    // through the current order. Hidden phases publish no slots and keep the last deal.
    if (view.slots) {
      const byCard: (CardSubjectId | null)[] = Array.from({ length: CARD_COUNT }, () => null);
      view.slots.forEach((subject, slot) => {
        const card = order[slot];
        if (card !== undefined) byCard[card] = subject;
      });
      subjects = byCard;
    }
    // The pair mid-swap: the cards now standing in the two slots that are swapping.
    moving = new Set();
    if (liveSwap !== undefined) {
      for (const slot of liveSwap) {
        const card = order[slot];
        if (card !== undefined) moving.add(card);
      }
    }
    let remainingMs = 0;
    if (view.phase === COURTROOM_PHASE.REVEAL && view.phaseEndsAt !== null) {
      remainingMs = Math.max(0, view.phaseEndsAt - now);
    }
    placeCards(false);

    const revealing = view.phase === COURTROOM_PHASE.REVEAL;
    setShown(timer, revealing);
    if (revealing) {
      const fraction = Math.min(1, remainingMs / GAME_PACING.COURTROOM_REVEAL_DURATION_MS);
      timerFill.style.transform = `scaleX(${fraction})`;
    }

    const caster = labelOf(view.casterId);
    const charging = view.stage === 'TRIAL' && view.phase === COURTROOM_PHASE.PROSECUTE;
    if (charging) buildBadges(view.candidates ?? []);
    setProsecutorCopy(charging && !casterIsHuman, caster);

    // The verdict inspection: both sides of the answer stay face-up while the bar drains.
    const inspecting = view.phase === COURTROOM_PHASE.INSPECT && view.pickedSlot !== null && view.slots !== null;
    if (inspecting) {
      const pickedSlot = view.pickedSlot as number;
      const pickedSubject = view.slots?.[pickedSlot] ?? null;
      const correct = pickedSubject !== null && pickedSubject === view.target;
      const targetSlot = view.target === null ? -1 : (view.slots?.indexOf(view.target) ?? -1);
      inspection = {
        card: order[pickedSlot] ?? -1,
        verdict: correct ? 'NOT_GUILTY' : 'GUILTY',
        target: correct || targetSlot < 0 ? null : (order[targetSlot] ?? null),
      };
      setVerdictLine(inspection.verdict, view.target);
      const remaining = view.phaseEndsAt === null ? 0 : Math.max(0, view.phaseEndsAt - now);
      const fraction = Math.min(1, remaining / GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS);
      inspectFill.style.transform = `scaleX(${fraction})`;
      judgeman.textContent = 'Judgeman: The verdict stands. Study the evidence.';
    } else if (view.phase !== COURTROOM_PHASE.INSPECT) {
      inspection = null;
      clearVerdictLine();
    }
    setShown(inspect, inspecting);
    if (!inspecting) judgeman.textContent = trialPrompt(view, caster, casterIsHuman, victimIsHuman, remainingMs);
  }

  /**
   * Writes the proclamation. A guilty verdict keeps its "(Target was …)" in one unbroken
   * span, so a narrow courtroom wraps before it instead of splitting the name in half.
   */
  function setVerdictLine(verdict: Verdict, target: CardSubjectId | null): void {
    const key = `${verdict}|${target ?? ''}`;
    if (key === verdictShown) return;
    verdictShown = key;
    verdictLine.textContent = '';
    verdictLine.className = `sentencing-verdict show ${verdict === 'NOT_GUILTY' ? 'ng' : 'guilty'}`;
    const headline = verdictHeadline(verdict, target);
    const split = verdict === 'GUILTY' ? headline.indexOf(' (') : -1;
    const head = document.createElement('span');
    head.className = 'verdict-head';
    // The space belongs to the first part, so the DOM text still reads as one sentence.
    head.textContent = split < 0 ? headline : `${headline.slice(0, split)} `;
    if (split < 0) {
      verdictLine.append(head);
      return;
    }
    const named = document.createElement('span');
    named.className = 'verdict-target';
    named.textContent = headline.slice(split + 1);
    verdictLine.append(head, named);
  }

  function clearVerdictLine(): void {
    if (verdictShown === '') return;
    verdictShown = '';
    verdictLine.className = 'sentencing-verdict';
    verdictLine.textContent = '';
  }

  function hide(): void {
    visible = false;
    prosecutorShown = false;
    stage = null;
    round = 0;
    subjects = Array.from({ length: CARD_COUNT }, () => null);
    order = identityOrder();
    positions = Array.from({ length: CARD_COUNT }, () => -1);
    moving = new Set();
    pickedRound = 0;
    locked = false;
    if (lockTimer !== null) window.clearTimeout(lockTimer);
    lockTimer = null;
    inspection = null;
    verdictShown = '';
    verdictLine.className = 'sentencing-verdict';
    verdictLine.textContent = '';
    inspectFill.style.transform = 'scaleX(0)';
    setShown(inspect, false);
    root.classList.remove('show');
  }

  return {
    render(view, isHuman, now, casterHuman = false) {
      victimIsHuman = isHuman;
      casterIsHuman = casterHuman;
      if (!view) {
        current = null;
        // The engine held the verdict for its inspection beat already; closing is immediate.
        if (visible) hide();
        syncControls();
        return;
      }
      current = view;
      setCaseNote(view);
      if (!visible) {
        visible = true;
        root.classList.add('show');
      }
      if (view.stage === 'ESCAPE') {
        stage = 'ESCAPE';
        round = 0;
        drawEscape(view);
      } else {
        if (stage !== 'TRIAL' || view.round !== round) startRound(view);
        drawTrial(view, now);
      }
      paintCards();
      syncControls();
    },

    reset() {
      current = null;
      hide();
    },

    verdict(slot, kind) {
      // The inspection view owns the colours, the target and the copy; this only lets a caller
      // mark the card the instant the verdict arrives, before the next frame paints it.
      const card = order[slot];
      if (card === undefined) return;
      inspection = { card, verdict: kind, target: null };
      paintCards();
    },
  };
}
