import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The layering of the effects layer is not observable from the engine, so it is pinned
 * here against the real stylesheet and markup. The bug this guards against: the codex
 * can play a cue from its own "Preview VFX" buttons, and while the effects layer sat
 * below the modal (z-index 46 against 60) every preview animated behind the scrim.
 */
// The finisher has its own stylesheet, so the rules of both are checked together.
const css = ['../../src/web/styles.css', '../../src/web/match-finisher.css']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Declarations of one top-level rule of the stylesheet. */
function ruleBody(selector: string): string {
  const pattern = new RegExp(`(?:^|\\n)${escapeForRegExp(selector)}\\s*\\{([^}]*)\\}`, 'm');
  const match = pattern.exec(css);
  if (!match) throw new Error(`styles.css has no rule for ${selector}`);
  return match[1] as string;
}

function zIndexOf(selector: string): number {
  const match = /z-index:\s*(-?\d+)/.exec(ruleBody(selector));
  if (!match) throw new Error(`${selector} declares no z-index`);
  return Number(match[1]);
}

/** Surfaces that can sit over the board while an effect is on screen. */
const OVERLAYS = [
  '.codex',
  '.result',
  '.toast',
  '.sandbox-toolbar',
  '.domain-overlay',
  '.flash',
  '.reshuffle',
  '.sentencing',
];

describe('effects layer stacking', () => {
  it('paints the VFX layer and its canvas above every modal and overlay', () => {
    const layer = zIndexOf('.vfx-layer');
    const canvas = zIndexOf('.vfx-canvas');
    expect(layer).toBeGreaterThan(0);
    // The canvas draws the particles for the caption's cue, so it never falls behind it.
    expect(canvas).toBeGreaterThanOrEqual(layer);
    for (const overlay of OVERLAYS) {
      expect(layer, `${overlay} must stay under the VFX layer`).toBeGreaterThan(zIndexOf(overlay));
      expect(canvas, `${overlay} must stay under the VFX canvas`).toBeGreaterThan(zIndexOf(overlay));
    }
  });

  it('keeps the codex itself above the board and below the effects', () => {
    // The board is unpositioned content, so the codex only has to clear 0 to sit over it.
    expect(zIndexOf('.codex')).toBeGreaterThan(0);
    expect(zIndexOf('.codex')).toBeLessThan(zIndexOf('.vfx-layer'));
  });

  it('leaves both effect surfaces click-through, so a cue never blocks a modal control', () => {
    for (const selector of ['.vfx-layer', '.vfx-canvas']) {
      expect(ruleBody(selector)).toMatch(/pointer-events:\s*none/);
      expect(ruleBody(selector)).toMatch(/position:\s*fixed/);
    }
  });

  it('mounts the effects and the codex as sibling children of the body', () => {
    // Equal indentation is how the markup expresses "both are direct children of body",
    // which is what keeps their z-indexes comparable: a nested effects layer would be
    // trapped in a stacking context and could not paint over the modal at all.
    expect(html).toMatch(/^ {4}<div id="vfx" class="vfx-layer"/m);
    expect(html).toMatch(/^ {4}<canvas id="vfx-canvas" class="vfx-canvas"/m);
    expect(html).toMatch(/^ {4}<div id="codex-modal" class="codex"/m);
  });
});
