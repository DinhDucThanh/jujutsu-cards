// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PachinkoSpinResult } from '../../src/web/hakari-domain-modal.js';
import { createHakariDomainModal, reelKind } from '../../src/web/hakari-domain-modal.js';

const P1 = 'p1' as const;
/** The third reel's lock time; the inspection window starts when it lands. */
const THIRD_REEL_LOCK_MS = 2_300;
/** The post-resolution freeze the modal enforces before it may close. */
const INSPECTION_MS = 2_000;

function resultOf(tier: PachinkoSpinResult['tier'], reels: readonly number[]): PachinkoSpinResult {
  return { playerId: P1, reels, tier, spinsLeft: 0, pity: 0 };
}

function setup() {
  const root = document.createElement('div');
  document.body.append(root);
  const spins: string[] = [];
  const modal = createHakariDomainModal({
    root,
    labelOf: () => 'Hakari',
    onSpin: (playerId) => spins.push(playerId),
  });
  const lever = (): HTMLButtonElement => {
    const button = root.querySelector<HTMLButtonElement>('button.hakari-lever');
    if (!button) throw new Error('no lever');
    return button;
  };
  const reels = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.hakari-reel')];
  const payoutRows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.hakari-payout')];
  return { root, modal, spins, lever, reels, payoutRows };
}

describe('Idle Death Gamble inspection window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('locks the machine as soon as a round resolves and holds the digits for 2.0s', () => {
    const { root, modal, spins, lever, reels, payoutRows } = setup();

    modal.showResult(resultOf('REGULAR', [3, 3, 3]), 0);
    modal.render(null, false, 0);

    // Locked from the moment the spin resolves: no owner input is accepted any more.
    expect(root.classList.contains('locked')).toBe(true);
    expect(root.dataset.phase).toBe('inspecting');
    expect(lever().disabled).toBe(true);
    lever().click();
    expect(spins).toEqual([]);

    // The three digits land and stay.
    vi.advanceTimersByTime(THIRD_REEL_LOCK_MS);
    modal.render(null, false, THIRD_REEL_LOCK_MS);
    expect(reels().map((reel) => reel.dataset.state)).toEqual(['landed', 'landed', 'landed']);
    expect(reels().map((reel) => reel.className)).toEqual([
      'hakari-reel reel-odd',
      'hakari-reel reel-odd',
      'hakari-reel reel-odd',
    ]);

    // The matching payout row stays lit, and the cabinet celebrates the win.
    expect(payoutRows()[0]?.classList.contains('payout-active-glow')).toBe(true);
    expect(root.querySelector('.hakari-cabinet')?.classList.contains('jackpot')).toBe(true);

    // Still frozen one millisecond before the window ends…
    modal.render(null, false, THIRD_REEL_LOCK_MS + INSPECTION_MS - 1);
    expect(root.classList.contains('show')).toBe(true);
    expect(root.classList.contains('locked')).toBe(true);
    expect(reels().map((reel) => reel.dataset.state)).toEqual(['landed', 'landed', 'landed']);

    // …and released exactly at 2.0s, with no board transition before it.
    modal.render(null, false, THIRD_REEL_LOCK_MS + INSPECTION_MS);
    expect(root.classList.contains('show')).toBe(false);
    expect(root.classList.contains('locked')).toBe(false);
  });

  it('keeps a bankrupt whiff on screen with its own payout row lit', () => {
    const { root, modal, reels, payoutRows } = setup();

    modal.showResult(resultOf('BANKRUPT', [1, 2, 5]), 0);
    modal.render(null, false, 0);
    vi.advanceTimersByTime(THIRD_REEL_LOCK_MS);
    modal.render(null, false, THIRD_REEL_LOCK_MS);

    expect(reels().map((reel) => reel.className)).toEqual([
      'hakari-reel reel-odd',
      'hakari-reel reel-even',
      'hakari-reel reel-odd',
    ]);
    // The whiff row explains the bankruptcy; a loss is never dressed up as a jackpot.
    expect(payoutRows()[3]?.classList.contains('payout-active-glow')).toBe(true);
    expect(payoutRows().slice(0, 3).every((row) => !row.classList.contains('payout-active-glow'))).toBe(true);
    expect(root.querySelector('.hakari-cabinet')?.classList.contains('jackpot')).toBe(false);

    expect(root.classList.contains('show')).toBe(true);
  });

  it('clears the freeze when a new spin starts or the machine is reset', () => {
    const machine = setup();

    machine.modal.showResult(resultOf('MISS', [1, 2, 4]), 0);
    machine.modal.render(null, false, 0);
    expect(machine.root.classList.contains('locked')).toBe(true);

    machine.modal.reset();
    expect(machine.root.classList.contains('show')).toBe(false);
    expect(machine.root.classList.contains('locked')).toBe(false);
  });
});

describe('side lever', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('cranks down, starts the reels and springs back after the pull animation', () => {
    const { root, modal, spins, lever } = setup();
    const mount = root.querySelector<HTMLElement>('.hakari-lever-mount');
    if (!mount) throw new Error('no side lever');
    modal.render({ playerId: P1, pachinko: { spinsLeft: 3, pity: 0, resetOnExpiry: false } }, true, 0);

    mount.click();

    expect(spins).toEqual([P1]);
    expect(mount.classList.contains('pulling')).toBe(true);
    expect(lever().disabled).toBe(true);
    expect(root.querySelector('.hakari-reel')?.getAttribute('data-state')).toBe('spinning');

    vi.advanceTimersByTime(500);
    expect(mount.classList.contains('pulling')).toBe(false);
  });
});

describe('reelKind', () => {
  it('names the symbol family the reel is painted in', () => {
    expect(reelKind(null)).toBe('blank');
    expect(reelKind(7)).toBe('seven');
    expect(reelKind(3)).toBe('odd');
    expect(reelKind(4)).toBe('even');
  });
});
