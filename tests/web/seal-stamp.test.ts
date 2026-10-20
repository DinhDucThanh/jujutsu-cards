// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSealStampVfx, type SealStampVfx } from '../../src/web/seal-stamp.js';
import { TALISMAN_IMPACT_MS, TALISMAN_STAGGER_MS } from '../../src/web/talisman-seal.js';

/** The delay the effect leaves between the grid being free and the first slam. */
const DELAY_MS = 160;

function grid(ids: readonly string[]): HTMLElement {
  const root = document.createElement('div');
  for (const id of ids) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card sealed';
    button.dataset.cardId = id;
    root.append(button);
  }
  document.body.append(root);
  return root;
}

const stamped = (id: string): boolean =>
  document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)?.classList.contains('talisman-stamp-impact') ?? false;

const cardCount = (): number =>
  Array.from(document.querySelectorAll('.card')).filter((card) =>
    card.classList.contains('talisman-stamp-impact'),
  ).length;

describe('createSealStampVfx', () => {
  let visible: boolean;
  let stamps: number;
  let vfx: SealStampVfx;

  function build(options: { delayMs?: number } = {}): SealStampVfx {
    return createSealStampVfx({
      roots: () => Array.from(document.querySelectorAll<HTMLElement>('.grid')),
      boardVisible: () => visible,
      onStamp: () => {
        stamps += 1;
      },
      ...options,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    visible = true;
    stamps = 0;
    vfx = build();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps the sealed cards one beat apart, in the order the engine named them', () => {
    const root = grid(['c1', 'c2', 'c3']);
    root.className = 'grid';
    vfx.queue(['c3', 'c1']);
    vfx.flush();

    vi.advanceTimersByTime(DELAY_MS - 1);
    expect(cardCount()).toBe(0);

    // The engine sealed c3 first, so c3 lands first even though c1 comes first in the DOM.
    vi.advanceTimersByTime(1);
    expect(stamped('c3')).toBe(true);
    expect(stamped('c1')).toBe(false);
    expect(stamps).toBe(1);

    vi.advanceTimersByTime(TALISMAN_STAGGER_MS);
    expect(stamped('c1')).toBe(true);
    expect(stamps).toBe(2);
  });

  it('holds the stamps while an overlay covers the grid, then lands them when it clears', () => {
    const root = grid(['c1']);
    root.className = 'grid';
    visible = false;
    vfx.queue(['c1']);
    vfx.flush();
    vi.advanceTimersByTime(2_000);
    expect(stamped('c1')).toBe(false);
    expect(stamps).toBe(0);

    visible = true;
    vfx.flush();
    vi.advanceTimersByTime(DELAY_MS);
    expect(stamped('c1')).toBe(true);
    expect(stamps).toBe(1);
  });

  it('ignores cards that are not on the grid', () => {
    const root = grid(['c1']);
    root.className = 'grid';
    vfx.queue(['gone', 'c1']);
    vfx.flush();
    vi.advanceTimersByTime(DELAY_MS);
    expect(stamps).toBe(1);
    expect(stamped('c1')).toBe(true);
  });

  it('lets a second batch wait for the running sequence instead of overlapping it', () => {
    const root = grid(['c1', 'c2', 'c3']);
    root.className = 'grid';
    vfx.queue(['c1', 'c2']);
    vfx.flush();
    vi.advanceTimersByTime(DELAY_MS + TALISMAN_STAGGER_MS);
    expect(stamps).toBe(2);

    // A late seal arrives while c1 and c2 are still on screen: it must not cut in.
    vfx.queue(['c3']);
    vfx.flush();
    vi.advanceTimersByTime(TALISMAN_STAGGER_MS);
    expect(stamped('c3')).toBe(false);

    // Once the last slam has finished the queue runs.
    vi.advanceTimersByTime(TALISMAN_IMPACT_MS);
    vfx.flush();
    vi.advanceTimersByTime(DELAY_MS);
    expect(stamped('c3')).toBe(true);
    expect(stamps).toBe(3);
  });

  it('cancels a running sequence and drops the queue on reset', () => {
    const root = grid(['c1', 'c2']);
    root.className = 'grid';
    vfx.queue(['c1', 'c2']);
    vfx.flush();
    vi.advanceTimersByTime(DELAY_MS);
    expect(stamped('c1')).toBe(true);

    vfx.reset();
    vi.advanceTimersByTime(5_000);
    expect(cardCount()).toBe(0);
    expect(stamps).toBe(1);

    // Anything it had queued is gone too: a fresh flush stamps nothing.
    vfx.flush();
    vi.advanceTimersByTime(1_000);
    expect(stamps).toBe(1);
  });

  it('deduplicates the same card reported twice', () => {
    const root = grid(['c1']);
    root.className = 'grid';
    vfx.queue(['c1']);
    vfx.queue(['c1']);
    vfx.flush();
    vi.advanceTimersByTime(DELAY_MS);
    expect(stamps).toBe(1);
  });
});
