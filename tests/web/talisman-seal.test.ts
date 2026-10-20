// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TALISMAN_IMPACT_MS, TALISMAN_STAGGER_MS, stampTalismanSeals } from '../../src/web/talisman-seal.js';

function cards(count: number): HTMLElement[] {
  document.body.innerHTML = Array.from({ length: count }, () => '<button class="card sealed"></button>').join('');
  return Array.from(document.querySelectorAll<HTMLElement>('.card'));
}

const stamped = (target: HTMLElement | undefined): boolean =>
  target?.classList.contains('talisman-stamp-impact') ?? false;

describe('stampTalismanSeals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lands one stamp every 250ms, in order', () => {
    const targets = cards(3);
    const stamps: number[] = [];
    stampTalismanSeals(targets, { onStamp: (index) => stamps.push(index) });

    expect(stamps).toEqual([]);
    vi.advanceTimersByTime(0);
    expect(stamps).toEqual([0]);
    expect(stamped(targets[0])).toBe(true);
    expect(stamped(targets[1])).toBe(false);

    vi.advanceTimersByTime(TALISMAN_STAGGER_MS);
    expect(stamps).toEqual([0, 1]);
    expect(stamped(targets[1])).toBe(true);
    expect(stamped(targets[2])).toBe(false);

    vi.advanceTimersByTime(TALISMAN_STAGGER_MS);
    expect(stamps).toEqual([0, 1, 2]);
  });

  it('clears the class once the slam ends, so a later trial can play it again', () => {
    const targets = cards(1);
    stampTalismanSeals(targets);
    vi.advanceTimersByTime(0);
    expect(stamped(targets[0])).toBe(true);
    vi.advanceTimersByTime(TALISMAN_IMPACT_MS);
    expect(stamped(targets[0])).toBe(false);
  });

  it('waits out the quiet beat before the first stamp', () => {
    const targets = cards(1);
    stampTalismanSeals(targets, { delayMs: 160 });
    vi.advanceTimersByTime(159);
    expect(stamped(targets[0])).toBe(false);
    vi.advanceTimersByTime(1);
    expect(stamped(targets[0])).toBe(true);
  });

  it('cancels the rest and clears the class when the match is torn down', () => {
    const targets = cards(3);
    const stamps: number[] = [];
    const cancel = stampTalismanSeals(targets, { onStamp: (index) => stamps.push(index) });
    vi.advanceTimersByTime(0);
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(stamps).toEqual([0]);
    expect(targets.some(stamped)).toBe(false);
  });

  it('does nothing with no condemned cards', () => {
    const stamps: number[] = [];
    stampTalismanSeals([], { onStamp: (index) => stamps.push(index) });
    vi.advanceTimersByTime(5_000);
    expect(stamps).toEqual([]);
  });
});
