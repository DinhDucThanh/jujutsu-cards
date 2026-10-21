import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GAME_PACING } from '../../src/engine/constants.js';

/**
 * The card's 3D flip is split across two elements: `.card` owns the perspective and the
 * hover lift, `.inner` owns the rotation. The stylesheet says it mirrors
 * GAME_PACING.CARD_FLIP_ANIMATION_MS but nothing enforced that, so these checks pin the
 * halves that would silently break the effect: a lost preserve-3d, a lift on the rotating
 * element (which would overwrite the rotateY and show a revealed card's back), or a pacing
 * drift between the CSS and the engine.
 */
const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleBody(selector: string): string {
  const pattern = new RegExp(`(?:^|\\n)${escapeForRegExp(selector)}\\s*\\{([^}]*)\\}`, 'm');
  const match = pattern.exec(css);
  if (!match) throw new Error(`styles.css has no rule for ${selector}`);
  return match[1] as string;
}

/** The whole body of a top-level `@media` block, comments included. */
function mediaBlock(header: string): string {
  const start = css.indexOf(`${header} {`);
  if (start < 0) throw new Error(`styles.css has no ${header} block`);
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  throw new Error(`${header} block is not closed`);
}

describe('card flip', () => {
  it('keeps the perspective on the slot and the rotation on the inner wrapper', () => {
    const card = ruleBody('.card');
    expect(card).toMatch(/perspective:\s*1000px/);
    expect(card).toMatch(/cursor:\s*pointer/);
    expect(card).toMatch(/-webkit-tap-highlight-color:\s*transparent/);

    const inner = ruleBody('.card .inner');
    expect(inner).toMatch(/transform-style:\s*preserve-3d/);
    expect(inner).toMatch(/will-change:\s*transform/);
    // A filter or opacity here would flatten the 3D context and hide the front face.
    expect(inner).not.toMatch(/(?:^|;)\s*(?:filter|opacity)\s*:/);
  });

  it('runs the flip for exactly the engine pacing, on the requested easing curve', () => {
    expect(ruleBody('.card .inner')).toContain(`transform ${GAME_PACING.CARD_FLIP_ANIMATION_MS / 1000}s cubic-bezier(0.4, 0, 0.2, 1)`);
  });

  it('turns both faces of the card the right way round', () => {
    expect(ruleBody('.card.revealed .inner')).toMatch(/transform:\s*rotateY\(180deg\)/);
    expect(ruleBody('.face')).toMatch(/backface-visibility:\s*hidden/);
    expect(ruleBody('.face')).toMatch(/-webkit-backface-visibility:\s*hidden/);
    expect(ruleBody('.face.front')).toMatch(/transform:\s*rotateY\(180deg\)/);
  });

  it('lifts only on hover-capable pointers, and never a matched or blocked card', () => {
    const hover = mediaBlock('@media (hover: hover) and (pointer: fine)');
    expect(hover).toContain('.card:hover .back');
    const lift = /\.card:hover:not\(\.matched\):not\(\.blocked\) \{([^}]*)\}/.exec(hover);
    expect(lift, 'the hover lift must live inside the pointer media query').not.toBeNull();
    expect(lift?.[1]).toMatch(/translate3d\(0, -2px, 0\)/);
    // The lift is on the slot, not on `.inner`: a transform there would replace the flip.
    expect(ruleBody('.card .inner')).not.toMatch(/translate3d|translateY/);
  });
});
