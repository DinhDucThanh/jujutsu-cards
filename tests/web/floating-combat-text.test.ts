// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOATING_TEXT_LIFETIME_MS,
  createFloatingCombatText,
  type FloatingCombatText,
} from '../../src/web/floating-combat-text.js';

/** jsdom lays nothing out, so every anchored element needs its box declared. */
function boxed(rect: { left: number; top: number; width: number; height: number }): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  element.getBoundingClientRect = () => ({ ...rect, right: 0, bottom: 0, x: rect.left, y: rect.top }) as DOMRect;
  return element;
}

describe('createFloatingCombatText', () => {
  let layer: HTMLElement;
  let fct: FloatingCombatText;

  const badges = (): HTMLElement[] => Array.from(layer.querySelectorAll<HTMLElement>('.fct'));

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="fct"></div>';
    layer = document.getElementById('fct') as HTMLElement;
    fct = createFloatingCombatText({ layer });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pops a badge over the anchor, with the kind’s own class', () => {
    const panel = boxed({ left: 100, top: 200, width: 300, height: 400 });
    fct.showOver(panel, '-15', 'DAMAGE');

    const [badge] = badges();
    expect(badge?.className).toContain('fct-damage');
    expect(badge?.className).toContain('fct-bounce');
    expect(badge?.textContent).toBe('-15');
    expect(badge?.style.left).toBe('250px');
    // Near the top of the panel rather than its middle, and never below 96px into it, so a
    // tall panel does not float the number away from the fighter it belongs to.
    expect(badge?.style.top).toBe('296px');
  });

  it('names the kind in the class for each badge type', () => {
    const panel = boxed({ left: 0, top: 0, width: 200, height: 200 });
    for (const [text, kind] of [
      ['-25 PIERCE!', 'PIERCE'],
      ['⚡ 50 BLACK FLASH! ⚡', 'BLACK_FLASH'],
      ['🛡️ BLOCKED', 'BLOCK'],
      ['🛡️ -20 BARRIER', 'BARRIER'],
      ['+10 HP', 'HEAL'],
    ] as const) {
      fct.showOver(panel, text, kind);
    }
    expect(badges().map((badge) => badge.className.split(' ')[1])).toEqual([
      'fct-pierce',
      'fct-black-flash',
      'fct-block',
      'fct-barrier',
      'fct-heal',
    ]);
  });

  it('stacks two badges on the same anchor instead of covering one with the other', () => {
    const panel = boxed({ left: 0, top: 0, width: 200, height: 200 });
    fct.showOver(panel, '🛡️ -20 BARRIER', 'BARRIER');
    fct.showOver(panel, '-15', 'DAMAGE');
    expect(badges()[0]?.style.top).toBe('70px');
    expect(badges()[1]?.style.top).toBe('96px');
  });

  it('retires a badge after its lifetime', () => {
    fct.showAt(10, 20, '-15', 'DAMAGE');
    expect(badges()).toHaveLength(1);
    vi.advanceTimersByTime(FLOATING_TEXT_LIFETIME_MS - 1);
    expect(badges()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(badges()).toHaveLength(0);
  });

  it('ignores an anchor with no box, so a hidden panel never spawns a stray number', () => {
    const hidden = boxed({ left: 0, top: 0, width: 0, height: 0 });
    fct.showOver(hidden, '-15', 'DAMAGE');
    fct.showOver(null, '-15', 'DAMAGE');
    fct.showOver(document.createElement('div'), '-15', 'DAMAGE');
    expect(badges()).toHaveLength(0);
  });

  it('retires the oldest badges once a flurry fills the layer', () => {
    for (let index = 0; index < 30; index += 1) fct.showAt(index, index, `-${index}`, 'DAMAGE');
    expect(badges().length).toBeLessThanOrEqual(24);
    // The newest arrival is always kept.
    expect(badges().at(-1)?.textContent).toBe('-29');
  });

  it('clears the layer and its timers on reset', () => {
    const panel = boxed({ left: 0, top: 0, width: 100, height: 100 });
    fct.showOver(panel, '-15', 'DAMAGE');
    fct.reset();
    expect(badges()).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(badges()).toHaveLength(0);
    // The clearing ran no pending timer twice, so the layer still works afterwards.
    fct.showOver(panel, '+10 HP', 'HEAL');
    expect(badges()).toHaveLength(1);
  });
});
