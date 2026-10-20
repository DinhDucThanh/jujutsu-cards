import type { TurnQueueItem } from '../engine/index.js';

/**
 * The bottom-right turn queue.
 *
 * The queue itself is projected by the engine (`getUpcomingTurnQueue`), which mirrors the
 * real `passTurn` loop: this module only paints it. Rows are keyed by seat position, not
 * by player, because the same fighter can legitimately appear twice in a row when a skip
 * hands the turn straight back.
 */
export interface TurnQueueOptions {
  /** The seat the local player controls, highlighted as "You". */
  readonly mySeat: 0 | 1;
  /** Seat labels ("You", "The AI", "Player 2"). */
  readonly seatLabel: (playerId: string) => string;
}

/** Renders the queue into `root`, hiding the whole widget when there is nothing to show. */
export function renderTurnQueue(root: HTMLElement, queue: readonly TurnQueueItem[], options: TurnQueueOptions): void {
  if (queue.length === 0) {
    if (root.hidden) return;
    root.hidden = true;
    root.replaceChildren();
    delete root.dataset.key;
    return;
  }

  // Same guard as the domain widget: the HUD redraws every frame, so the rows are only
  // rebuilt when the projected order changes.
  const key = queue
    .map((entry) => `${entry.playerId}:${entry.isCurrent ? 1 : 0}${entry.isSkipped ? 's' : ''}${entry.isExtraTurn ? 'e' : ''}`)
    .join(',');
  if (root.dataset.key === key && !root.hidden) return;
  root.dataset.key = key;

  const list = document.createElement('div');
  list.className = 'turn-queue-list';

  queue.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'turn-queue-row';
    row.dataset.player = entry.playerId;
    row.classList.toggle('now', entry.isCurrent);
    row.classList.toggle('skipped', entry.isSkipped);
    row.classList.toggle('extra', entry.isExtraTurn);
    row.classList.toggle('mine', entry.seat === options.mySeat);

    const index_ = document.createElement('span');
    index_.className = 'turn-queue-index';
    index_.textContent = `#${index + 1}`;

    const who = document.createElement('span');
    who.className = 'turn-queue-who';
    who.textContent = entry.characterName;

    const seat = document.createElement('span');
    seat.className = 'turn-queue-seat';
    seat.textContent = options.seatLabel(entry.playerId);

    const tag = document.createElement('span');
    tag.className = 'turn-queue-tag';
    if (entry.isCurrent) {
      tag.textContent = 'Now';
    } else if (entry.isSkipped) {
      tag.textContent = 'SKIPPED';
    } else if (entry.isExtraTurn) {
      tag.textContent = '+1 Turn';
    }

    const left = document.createElement('span');
    left.className = 'turn-queue-main';
    left.append(index_, who);

    row.append(left, seat);
    if (tag.textContent !== '') row.append(tag);
    row.title = entry.isSkipped
      ? `${entry.characterName} loses this turn to a domain (${entry.skipsRemaining} skip charge(s) left after it).`
      : entry.isCurrent
        ? `${entry.characterName} is on turn now.`
        : entry.isExtraTurn
          ? `${entry.characterName} acts again: the skipped turn came straight back to them.`
          : `${entry.characterName} takes the next turn.`;
    list.append(row);
  });

  root.replaceChildren(list);
  root.hidden = false;
}
