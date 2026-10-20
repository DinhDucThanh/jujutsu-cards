import { usesOwnBoards, type BoardMode } from '../engine/index.js';

/**
 * The two player-owned grids, wherever they currently live: inside their status
 * pillar, or inside the centre-row `.dual-boards` container after a dual match.
 */
const OWN_SLOT = '.grid-slot:not(.shared-slot)';

/**
 * Places the grids for the format being played.
 *
 * SHARED: one board in the middle column, where it gets the full height and width.
 * The dual formats have two grids, so they move side by side into that same centre row
 * instead of being squeezed into the 20rem status pillars, which then hold panel + log.
 *
 * The slots are the permanent grids for both seats, so this function only ever *moves*
 * them. Dropping a container that still holds them would delete both grids from the
 * document, and the next dual match would render an empty centre row with the HUD,
 * panels and turn queue all still running — the blank-board failure this guards.
 */
export function arrangeBoards(root: ParentNode, boardMode: BoardMode): void {
  const center = root.querySelector<HTMLElement>('.center');
  const sharedSlot = center?.querySelector<HTMLElement>('.shared-slot');
  if (!center || !sharedSlot) throw new Error('Missing match centre');

  // Collected from the whole arena, not just the pillars: a previous dual match moved
  // them into `.dual-boards`, which lives under `.center`.
  const ownSlots = [...root.querySelectorAll<HTMLElement>(OWN_SLOT)];
  const dual = center.querySelector<HTMLElement>('.dual-boards');

  if (usesOwnBoards(boardMode)) {
    const container = dual ?? createDualContainer(center, sharedSlot);
    for (const slot of ownSlots) {
      if (slot.parentElement !== container) container.append(slot);
    }
    return;
  }

  for (const slot of ownSlots) {
    const playerId = slot.querySelector<HTMLElement>('.board')?.dataset.board;
    if (!playerId) continue;
    const side = root.querySelector<HTMLElement>(`.side[data-player="${playerId}"]`);
    if (!side || slot.parentElement === side) continue;
    side.append(slot);
  }
  dual?.remove();
}

function createDualContainer(center: HTMLElement, sharedSlot: HTMLElement): HTMLElement {
  const dual = center.ownerDocument.createElement('div');
  dual.className = 'dual-boards';
  sharedSlot.after(dual);
  return dual;
}
