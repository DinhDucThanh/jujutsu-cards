// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COURTROOM_PHASE,
  GAME_PACING,
  type CardSubjectId,
  type PublicSentencingView,
} from '../../src/engine/index.js';
import {
  createSentencingModal,
  slotOrderAfter,
  subjectName,
  swapsStarted,
  type SentencingModal,
} from '../../src/web/deadly-sentencing-modal.js';

const CASTER = 'P1';
const VICTIM = 'P2';
const SUBJECTS = ['divine_dog', 'ratio_blade', 'six_eyes', 'divine_dog'] as CardSubjectId[];

function trialView(overrides: Partial<PublicSentencingView>): PublicSentencingView {
  return {
    stage: 'TRIAL',
    casterId: CASTER,
    victimId: VICTIM,
    round: 1,
    totalRounds: 2,
    phase: COURTROOM_PHASE.PICK,
    phaseEndsAt: null,
    slots: null,
    swaps: [],
    target: 'six_eyes',
    pickedSlot: null,
    mistakes: 0,
    candidates: null,
    ...overrides,
  };
}

function escapeView(): PublicSentencingView {
  return trialView({ stage: 'ESCAPE', round: 0, phase: null, target: null, totalRounds: 2 });
}

describe('slotOrderAfter', () => {
  it('moves cards by slot position, one swap at a time', () => {
    expect(slotOrderAfter([], 0)).toEqual([0, 1, 2, 3]);
    expect(slotOrderAfter([[0, 2]], 1)).toEqual([2, 1, 0, 3]);
    // Two swaps that touch the same slot: the second sees the first's result.
    expect(slotOrderAfter([[0, 1], [1, 2]], 2)).toEqual([1, 2, 0, 3]);
  });

  it('applies only the swaps that have begun', () => {
    const swaps: Array<readonly [number, number]> = [
      [0, 1],
      [2, 3],
    ];
    expect(slotOrderAfter(swaps, 1)).toEqual([1, 0, 2, 3]);
    expect(slotOrderAfter(swaps, 99)).toEqual([1, 0, 3, 2]);
  });

  it('ignores out-of-range slots instead of corrupting the order', () => {
    expect(slotOrderAfter([[0, 9]], 1)).toEqual([0, 1, 2, 3]);
  });
});

describe('swapsStarted', () => {
  it('counts a swap as begun at its start time, every swapMs', () => {
    expect(swapsStarted(999, 1000, 3, 400)).toBe(0);
    expect(swapsStarted(1000, 1000, 3, 400)).toBe(1);
    expect(swapsStarted(1399, 1000, 3, 400)).toBe(1);
    expect(swapsStarted(1400, 1000, 3, 400)).toBe(2);
    expect(swapsStarted(9999, 1000, 3, 400)).toBe(3);
  });

  it('handles a shuffle with no swaps', () => {
    expect(swapsStarted(5000, 1000, 0, 400)).toBe(0);
  });
});

describe('subjectName', () => {
  it('uses the guidebook label for a subject, and the character name otherwise', () => {
    expect(subjectName('divine_dog')).toBe('Divine Dog');
    expect(subjectName('ratio_blade')).toBe('7:3 Ratio Blade');
  });
});

describe('createSentencingModal', () => {
  let root: HTMLElement;
  let onEscape: ReturnType<typeof vi.fn<(escape: boolean) => void>>;
  let onPick: ReturnType<typeof vi.fn<(slot: number) => void>>;
  let onProsecute: ReturnType<typeof vi.fn<(subject: CardSubjectId) => void>>;
  let modal: SentencingModal;

  const labelOf = (id: string) => (id === VICTIM ? 'Victim' : 'Caster');
  const cards = (): HTMLButtonElement[] => Array.from(root.querySelectorAll<HTMLButtonElement>('.sentencing-card'));
  const button = (text: string): HTMLButtonElement => {
    const found = Array.from(root.querySelectorAll<HTMLButtonElement>('.sentencing-btn')).find((b) =>
      b.textContent?.includes(text),
    );
    if (!found) throw new Error(`no button "${text}"`);
    return found;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="sentencing" class="sentencing"></div>';
    root = document.getElementById('sentencing') as HTMLElement;
    onEscape = vi.fn<(escape: boolean) => void>();
    onPick = vi.fn<(slot: number) => void>();
    onProsecute = vi.fn<(subject: CardSubjectId) => void>();
    modal = createSentencingModal({ root, labelOf, onEscape, onPick, onProsecute });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the courtroom and closes it again', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.REVEAL, slots: SUBJECTS, target: null }), false, 0);
    expect(root.classList.contains('show')).toBe(true);
    modal.render(null, false, 0);
    expect(root.classList.contains('show')).toBe(false);
  });

  it('shows the four subjects face-up during the reveal', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.REVEAL, slots: SUBJECTS, target: null }), false, 0);
    expect(cards()).toHaveLength(4);
    expect(cards().every((card) => card.classList.contains('up'))).toBe(true);
    expect(cards().map((card) => card.querySelector('.name')?.textContent)).toEqual([
      'Divine Dog',
      '7:3 Ratio Blade',
      'Six Eyes',
      'Divine Dog',
    ]);
  });

  it('turns the cards face-down once the shuffle starts', () => {
    modal.render(
      trialView({ phase: COURTROOM_PHASE.SHUFFLE, swaps: [[0, 1]], phaseEndsAt: 1400 }),
      false,
      1000,
    );
    expect(cards().some((card) => card.classList.contains('up'))).toBe(false);
  });

  it('slides the card that was at a swapped slot to its new position when its swap begins', () => {
    // One swap; the shuffle starts at 1000 because it ends one swap-duration later.
    const shuffle = trialView({
      phase: COURTROOM_PHASE.SHUFFLE,
      swaps: [[0, 2]],
      phaseEndsAt: 1000 + GAME_PACING.COURTROOM_SWAP_DURATION_MS,
    });
    modal.render(shuffle, false, 999);
    expect(cards()[0]?.style.transform).toBe('translateX(0px)');
    modal.render(shuffle, false, 1000);
    // Card 0 has slid to slot 2, two strides (126px each) to the right.
    expect(cards()[0]?.style.transform).toBe('translateX(252px)');
    expect(cards()[2]?.style.transform).toBe('translateX(0px)');
  });

  it('lets a human victim pick a card by its current position', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK, swaps: [[0, 2]] }), true, 2000);
    cards()[0]?.click();
    // Card 0 now sits in slot 2.
    expect(onPick).toHaveBeenCalledWith(2);
  });

  it('keeps the face-down cards inert for the caster and for an AI victim', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK }), false, 2000);
    cards()[1]?.click();
    expect(onPick).not.toHaveBeenCalled();
    expect(cards().every((card) => card.disabled)).toBe(true);
  });

  it('allows one pick per round, then waits for the next round', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK, round: 1 }), true, 2000);
    cards()[0]?.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK, round: 1 }), true, 2600);
    cards()[1]?.click();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('shows the Judgeman prompt naming the target', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK, target: 'six_eyes' }), true, 2000);
    expect(root.querySelector('.sentencing-judgeman')?.textContent).toBe('Judgeman: Locate Six Eyes!');
  });

  it('counts down the evidence preview and dims the bar as it runs out', () => {
    modal.render(
      trialView({ phase: COURTROOM_PHASE.REVEAL, slots: SUBJECTS, target: null, phaseEndsAt: 4000 }),
      false,
      0,
    );
    expect(root.querySelector('.sentencing-judgeman')?.textContent).toBe('MEMORIZE THE EVIDENCE (4.0s)');
    expect(root.querySelector<HTMLElement>('.sentencing-timer-fill')?.style.transform).toBe('scaleX(1)');
    modal.render(
      trialView({ phase: COURTROOM_PHASE.REVEAL, slots: SUBJECTS, target: null, phaseEndsAt: 4000 }),
      false,
      2000,
    );
    expect(root.querySelector('.sentencing-judgeman')?.textContent).toBe('MEMORIZE THE EVIDENCE (2.0s)');
  });

  it('tracks the round with one dot per round', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK, round: 2, totalRounds: 4 }), true, 2000);
    const dots = Array.from(root.querySelectorAll<HTMLElement>('.sentencing-dot'));
    expect(dots.map((dot) => dot.textContent)).toEqual(['●', '●', '○', '○']);
    expect(root.querySelector('.sentencing-round')?.textContent).toBe('Round 2/4');
  });

  it('lifts the pair of cards mid-swap and no others', () => {
    const shuffle = trialView({ phase: COURTROOM_PHASE.SHUFFLE, swaps: [[0, 2]], phaseEndsAt: 1400 });
    modal.render(shuffle, false, 1100);
    expect(cards().filter((card) => card.classList.contains('moving')).map((card) => cards().indexOf(card))).toEqual([
      0, 2,
    ]);
    modal.render(shuffle, false, 1500);
    expect(cards().some((card) => card.classList.contains('moving'))).toBe(false);
  });

  it('has the human prosecutor pick the charge from four badges', () => {
    const candidates = ['divine_dog', 'ratio_blade', 'six_eyes', 'sukuna'] as CardSubjectId[];
    modal.render(
      trialView({ phase: COURTROOM_PHASE.PROSECUTE, candidates, target: null }),
      true,
      2000,
      true,
    );
    const prompt = root.querySelector<HTMLElement>('.sentencing-prosecute');
    expect(prompt?.hidden).toBe(false);
    const badges = Array.from(root.querySelectorAll<HTMLButtonElement>('.sentencing-badge'));
    expect(badges.map((badge) => badge.querySelector('.badge-name')?.textContent)).toEqual([
      'Divine Dog',
      '7:3 Ratio Blade',
      'Six Eyes',
      'Ryomen Sukuna',
    ]);
    badges[2]?.click();
    expect(onProsecute).toHaveBeenCalledWith('six_eyes');
  });

  it('shows a remote prosecutor\'s charge panel to the victim as a disabled waiting banner', () => {
    modal.render(
      trialView({ phase: COURTROOM_PHASE.PROSECUTE, candidates: ['divine_dog', 'ratio_blade'] as CardSubjectId[] }),
      true,
      2000,
      false,
    );
    const panel = root.querySelector<HTMLElement>('.sentencing-prosecute');
    expect(panel?.hidden).toBe(false);
    expect(panel?.classList.contains('waiting')).toBe(true);
    expect(root.querySelector('.sentencing-prosecute-title')?.textContent).toBe('\u2696\ufe0f COURT IN SESSION');
    const badges = Array.from(root.querySelectorAll<HTMLButtonElement>('.sentencing-badge'));
    expect(badges.every((badge) => badge.disabled)).toBe(true);
    badges[0]?.click();
    expect(root.querySelector('.sentencing-judgeman')?.textContent).toBe('Judgeman: Caster is naming the charge.');
    expect(onProsecute).not.toHaveBeenCalled();
  });

  it('tells a non-victim the defendant is still choosing while the cards are locked', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK, target: null }), false, 2000, true);
    expect(root.querySelector('.sentencing-judgeman')?.textContent).toBe("Judgeman: Awaiting defendant's plea / card selection...");
    expect(cards().every((card) => card.disabled)).toBe(true);
  });

  it('offers the escape choice to a human victim only', () => {
    modal.render(escapeView(), true, 0);
    expect(root.querySelector<HTMLElement>('.sentencing-escape')?.hidden).toBe(false);
    button('Spend').click();
    expect(onEscape).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(600);
    modal.render(escapeView(), false, 0);
    expect(root.querySelector<HTMLElement>('.sentencing-escape')?.hidden).toBe(true);
  });

  it('turns a not-guilty pick green, drains the inspection bar, then clears for the next round', () => {
    modal.render(
      trialView({ phase: COURTROOM_PHASE.INSPECT, slots: SUBJECTS, target: 'six_eyes', pickedSlot: 2, phaseEndsAt: 2_000 }),
      false,
      500,
    );
    expect(cards()[2]?.classList.contains('ng')).toBe(true);
    expect(cards()[2]?.classList.contains('up')).toBe(true);
    // The evidence was found where it was asked for: nothing else needs turning up.
    expect(cards().some((card) => card.classList.contains('target'))).toBe(false);
    expect(root.querySelector('.sentencing-verdict')?.textContent).toBe('NOT GUILTY — CHARGE DISMISSED');
    expect(root.querySelector<HTMLElement>('.sentencing-inspect-fill')?.style.transform).toBe('scaleX(0.75)');
    expect(root.querySelector<HTMLElement>('.sentencing-inspect')?.style.visibility).toBe('');

    // The next round's reveal ends the inspection: the bar goes and the proclamation clears.
    modal.render(
      trialView({ phase: COURTROOM_PHASE.REVEAL, slots: SUBJECTS, target: null, phaseEndsAt: 6_000 }),
      false,
      2_000,
    );
    expect(root.querySelector<HTMLElement>('.sentencing-inspect')?.style.visibility).toBe('hidden');
    expect(root.querySelector('.sentencing-verdict')?.textContent).toBe('');
    expect(cards()[2]?.classList.contains('ng')).toBe(false);
  });

  it('reveals the true target in gold beside a wrong pick and names it', () => {
    modal.render(
      trialView({ phase: COURTROOM_PHASE.INSPECT, slots: SUBJECTS, target: 'six_eyes', pickedSlot: 0, phaseEndsAt: 2_000, mistakes: 1 }),
      false,
      0,
    );
    expect(cards()[0]?.classList.contains('guilty')).toBe(true);
    expect(cards()[0]?.classList.contains('up')).toBe(true);
    // Six Eyes sat in slot 2; the inspection turns it up under a golden bracket.
    expect(cards()[2]?.classList.contains('target')).toBe(true);
    expect(cards()[2]?.classList.contains('up')).toBe(true);
    // The two cards nobody asked about stay face-down.
    expect(cards()[1]?.classList.contains('up')).toBe(false);
    expect(cards()[3]?.classList.contains('up')).toBe(false);
    expect(root.querySelector('.sentencing-verdict')?.textContent).toBe(
      'GUILTY — 1 CARD CONDEMNED (Target was Six Eyes)',
    );
  });

  it('maps the inspection through the shuffle, so it marks the slots the victim actually saw', () => {
    // One swap: the card from slot 0 now stands in slot 2, and slot 2's card in slot 0.
    modal.render(
      trialView({
        phase: COURTROOM_PHASE.INSPECT,
        slots: SUBJECTS,
        swaps: [[0, 2]],
        target: 'six_eyes',
        pickedSlot: 0,
        phaseEndsAt: 2_000,
      }),
      false,
      0,
    );
    // Slot 0 holds the card that started in slot 2, so that is the wrongly picked card.
    expect(cards()[2]?.classList.contains('guilty')).toBe(true);
    // Six Eyes now stands in slot 0, so that card carries the golden bracket.
    expect(cards()[0]?.classList.contains('target')).toBe(true);
  });

  it('keeps the verdict the engine sent until the inspection frame arrives', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK }), false, 2_000);
    modal.verdict(1, 'GUILTY');
    expect(cards()[1]?.classList.contains('guilty')).toBe(true);
  });

  it('hides at once on reset, even with a verdict on screen', () => {
    modal.render(trialView({ phase: COURTROOM_PHASE.PICK }), true, 2000);
    modal.verdict(0, 'GUILTY');
    modal.reset();
    expect(root.classList.contains('show')).toBe(false);
    // The pending hold must not reopen or repaint anything.
    vi.advanceTimersByTime(2000);
    expect(root.classList.contains('show')).toBe(false);
  });
});
