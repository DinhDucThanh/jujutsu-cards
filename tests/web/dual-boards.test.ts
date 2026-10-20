// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { BOARD_MODE } from '../../src/engine/index.js';
import { arrangeBoards } from '../../src/web/dual-boards.js';

/**
 * Pass & Play dual boards once rendered a blank centre row: the HUDs, turn queue and
 * clock were live, but neither grid existed. The cause was in `arrangeBoards`, which
 * removed the `.dual-boards` container while the two player grids were still inside it,
 * so a dual match started after a shared one had no grids left to place.
 *
 * These tests run against the real `index.html` markup, so the slot structure the
 * renderer depends on is the one shipped.
 */
// Not `new URL(...)`: the jsdom environment replaces the global URL with its own.
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../index.html'), 'utf8');

function arena(): HTMLElement {
  const { document } = new JSDOM(html).window;
  const match = document.querySelector<HTMLElement>('#match');
  if (!match) throw new Error('index.html has no #match arena');
  return match;
}

function ownSlots(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.grid-slot:not(.shared-slot)')];
}

function boardOf(slot: HTMLElement): string | undefined {
  return slot.querySelector<HTMLElement>('.board')?.dataset.board;
}

function place(root: ParentNode, where: string): string[] {
  return ownSlots(root)
    .filter((slot) => slot.parentElement?.className === where)
    .map((slot) => boardOf(slot) ?? '?');
}

describe('board arrangement', () => {
  it('moves both grids into the centre row for a dual match', () => {
    const match = arena();
    arrangeBoards(match, BOARD_MODE.DUAL);

    expect(place(match, 'dual-boards')).toEqual(['p1', 'p2']);
    const dual = match.querySelector<HTMLElement>('.dual-boards');
    expect(dual?.parentElement?.className).toBe('center');
    // The shared grid stays where it is and is hidden by the mode stylesheet instead.
    expect(match.querySelector('.center > .shared-slot')).not.toBeNull();
    expect(match.querySelectorAll('.grid-slot')).toHaveLength(3);
  });

  it('returns both grids to their pillars for a shared match', () => {
    const match = arena();
    arrangeBoards(match, BOARD_MODE.DUAL);
    arrangeBoards(match, BOARD_MODE.SHARED);

    expect(match.querySelector('.dual-boards')).toBeNull();
    const p1 = match.querySelector<HTMLElement>('.side[data-player="p1"] .grid-slot');
    const p2 = match.querySelector<HTMLElement>('.side[data-player="p2"] .grid-slot');
    expect(boardOf(p1 as HTMLElement)).toBe('p1');
    expect(boardOf(p2 as HTMLElement)).toBe('p2');
    // The grids are permanent: leaving dual must not delete them from the document.
    expect(match.querySelectorAll('.grid-slot')).toHaveLength(3);
    expect(match.querySelectorAll('.board[data-board="p1"], .board[data-board="p2"]')).toHaveLength(2);
  });

  it('re-renders both grids in a dual match started after a shared one', () => {
    const match = arena();
    arrangeBoards(match, BOARD_MODE.SHARED);
    arrangeBoards(match, BOARD_MODE.DUAL_TURN_BASED);

    expect(place(match, 'dual-boards')).toEqual(['p1', 'p2']);
    for (const id of ['p1', 'p2']) {
      const board = match.querySelector<HTMLElement>(`.board[data-board="${id}"]`);
      expect(board?.isConnected).toBe(true);
      expect(board?.closest('.dual-boards')).not.toBeNull();
    }
  });

  it('keeps both grids through every format switch, without duplicating them', () => {
    const match = arena();
    const order = [
      BOARD_MODE.DUAL,
      BOARD_MODE.SHARED,
      BOARD_MODE.DUAL_TURN_BASED,
      BOARD_MODE.SHARED,
      BOARD_MODE.DUAL,
    ];
    for (const mode of order) {
      arrangeBoards(match, mode);
      arrangeBoards(match, mode); // a rematch re-arranges the same format
      expect(ownSlots(match).map(boardOf)).toEqual(['p1', 'p2']);
      expect(match.querySelectorAll('.grid-slot')).toHaveLength(3);
    }
    expect(place(match, 'dual-boards')).toEqual(['p1', 'p2']);
  });
});
