import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The phone layout is a thermal budget, not a theme: the blurred surfaces, the wide card
 * blooms and the per-card compositing layers are the three costs that make a phone hot.
 * These checks pin the rules that carry those costs, so a future style edit cannot quietly
 * bring one back.
 */
const css = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
const MOBILE = '@media screen and (max-width: 900px)';

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

describe('mobile thermal budget', () => {
  const block = mediaBlock(MOBILE);

  it('drops every backdrop filter and replaces it with a flat fill', () => {
    expect(block).toContain('backdrop-filter: none');
    expect(block).toContain('-webkit-backdrop-filter: none');
    expect(block).toContain('rgba(12, 14, 24, 0.92)');
    // The blurred surfaces that cost the most: the arena frame, the card footer, the
    // courtroom, the codex and the lobby.
    for (const selector of ['.board-frame', '.face.front .foot', '.sentencing-panel', '.codex-panel', '.lobby']) {
      expect(block).toContain(selector);
    }
  });

  it('shrinks the card bloom from a 16px spread to 6px', () => {
    expect(css).toMatch(/:root\s*\{[^}]*--card-glow:\s*16px/);
    expect(block).toMatch(/--card-glow:\s*6px/);
    // Every character card reads the variable now, so one phone rule reaches all of them.
    expect(css).toContain('box-shadow: inset 0 0 var(--card-glow)');
    expect(css).not.toMatch(/inset 0 0 16px/);
  });

  it('keeps compositing layers only for the card being touched or flipped', () => {
    expect(block).toMatch(/\.card\s*\{[^}]*will-change:\s*auto/);
    expect(block).toMatch(/\.card \.inner\s*\{[^}]*will-change:\s*auto/);
    const active = /\.card:active,[\s\S]*?\{([^}]*)\}/.exec(block);
    expect(active).not.toBeNull();
    expect(active?.[1]).toMatch(/will-change:\s*transform/);
  });

  it('leaves the desktop card layer promotion alone', () => {
    const base = /(?:^|\n)\.card\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
    expect(base).toMatch(/transform:\s*translateZ\(0\)/);
    expect(base).toMatch(/will-change:\s*transform, opacity/);
    expect(base).toMatch(/contain:\s*layout style/);
  });
});
