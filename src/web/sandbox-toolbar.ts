import {
  CHARACTERS,
  CHARACTER_IDS,
  GAME_CONSTANTS,
  SYNERGIES,
  SYNERGY_IDS,
  usesOwnBoards,
  type BoardMode,
  type CharacterId,
  type EngineResult,
  type GameEngine,
  type PlayerId,
  type SynergyId,
} from '../engine/index.js';

/**
 * The training-ground debug dock.
 *
 * Every control drives the live `GameEngine` through its sandbox debug API, so the dock
 * tests the real pipeline. The engine refuses each command outside a sandbox match. Commands
 * that change the layout or the dummy's fighter are delegated to the caller, because they
 * also relayout the grids and refresh the duel panel.
 */
export interface SandboxToolbarOptions {
  /** The dock container from index.html. */
  readonly root: HTMLElement;
  readonly engine: GameEngine;
  /** Seat the player controls. */
  readonly me: PlayerId;
  /** The training dummy's seat. */
  readonly dummy: PlayerId;
  /** The layout the match is currently playing. */
  readonly boardMode: BoardMode;
  /** Engine time, read at click time. */
  readonly now: () => number;
  /** Receives every engine command result so the caller can log events and re-render. */
  readonly onResult: (result: EngineResult) => void;
  /** Switches between the shared and dual layouts, relayouts the grids and re-renders. */
  readonly onBoardLayout: (layout: 'shared' | 'dual') => void;
  /** Makes the dummy fight as another fighter and re-renders. */
  readonly onDummyCharacter: (characterId: CharacterId) => void;
  /** Re-renders after a change that emits no engine events (the X-ray toggle). */
  readonly onRefresh: () => void;
}

export interface SandboxToolbar {
  /** Keeps the layout toggle in step after the caller switched the layout. */
  setBoardMode(mode: BoardMode): void;
  destroy(): void;
}

type TabId = 'player' | 'dummy' | 'domains' | 'board';

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'player', label: 'Player' },
  { id: 'dummy', label: 'Dummy' },
  { id: 'domains', label: 'Hakari / Domains' },
  { id: 'board', label: 'Board' },
];

const HAZARDS = [
  { kind: 'LAVA', label: '+ Ember Insect' },
  { kind: 'NAILED', label: '+ Cursed Nail' },
  { kind: 'LOCKED', label: '+ Sealed Talisman' },
  { kind: 'FLESH', label: '+ Transfigured Flesh' },
] as const;

/**
 * The dock's offset from its CSS home position. It lives at module level so the dock
 * reopens where the player left it, across matches as well as across minimizing.
 */
let dockOffset = { x: 0, y: 0 };

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function control(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = element('button', 'sandbox-btn', label);
  button.type = 'button';
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function row(...items: HTMLElement[]): HTMLElement {
  const node = element('div', 'sandbox-row');
  node.append(...items);
  return node;
}

export function createSandboxToolbar(options: SandboxToolbarOptions): SandboxToolbar {
  const { root, engine, me, dummy, now, onResult, onBoardLayout, onDummyCharacter, onRefresh } =
    options;

  root.replaceChildren();
  root.classList.add('sandbox-dock');
  root.classList.remove('is-minimized');

  // Header: the drag handle, with the minimize button.
  const head = element('div', 'sandbox-dock-head');
  const heading = element('span', 'sandbox-dock-title', 'Sandbox Lab');
  const minimize = element('button', 'sandbox-dock-minimize', '−');
  minimize.type = 'button';
  minimize.title = 'Minimize to a pill';
  minimize.setAttribute('aria-label', 'Minimize the sandbox lab');
  head.append(heading, minimize);

  const body = element('div', 'sandbox-dock-body');
  const hint = element('p', 'sandbox-hint', 'Drag the header to move the lab. Every command runs on the live engine.');
  const tabBar = element('div', 'sandbox-tabs');
  tabBar.setAttribute('role', 'tablist');
  body.append(hint, tabBar);

  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const panels = new Map<TabId, HTMLElement>();
  let activeTab: TabId = 'player';
  const selectTab = (id: TabId): void => {
    activeTab = id;
    for (const tab of TABS) {
      const selected = tab.id === id;
      tabButtons.get(tab.id)?.setAttribute('aria-selected', String(selected));
      tabButtons.get(tab.id)?.classList.toggle('is-active', selected);
      const panel = panels.get(tab.id);
      if (panel) panel.hidden = !selected;
    }
  };
  for (const tab of TABS) {
    const button = element('button', 'sandbox-tab', tab.label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => selectTab(tab.id));
    tabButtons.set(tab.id, button);
    tabBar.append(button);

    const panel = element('div', 'sandbox-panel');
    panel.setAttribute('role', 'tabpanel');
    panels.set(tab.id, panel);
    body.append(panel);
  }

  // Pill: what the dock becomes when minimized. Clicking it restores the dock in place.
  const pill = element('button', 'sandbox-dock-pill', '🧪 LAB');
  pill.type = 'button';
  pill.title = 'Open the sandbox lab';
  pill.setAttribute('aria-label', 'Open the sandbox lab');
  pill.title = 'Restore the sandbox lab';
  pill.hidden = true;

  root.append(head, body, pill);

  const setMinimized = (minimized: boolean): void => {
    root.classList.toggle('is-minimized', minimized);
    head.hidden = minimized;
    body.hidden = minimized;
    pill.hidden = !minimized;
    // The pill always returns to its bottom-right corner; the drawer keeps any dragged spot.
    if (minimized) dockOffset = { x: 0, y: 0 };
    applyOffset();
  };
  minimize.addEventListener('click', () => setMinimized(true));
  pill.addEventListener('click', () => setMinimized(false));

  // Player panel.
  const playerPanel = panels.get('player');
  const maxHpOf = (): number =>
    engine.getPublicView().players.find((player) => player.id === me)?.maxHp ?? 1;
  const setHp = (hp: (maxHp: number) => number): void => {
    onResult(engine.debugSetHp(me, hp(maxHpOf()), now()));
  };
  playerPanel?.append(
    row(
      control('+50 CE', 'Adds 50 cursed energy', () =>
        onResult(engine.sandboxFillEnergy(me, 50, now())),
      ),
      control('Fill 100 CE', 'Fills the cursed energy pool', () =>
        onResult(engine.sandboxFillEnergy(me, GAME_CONSTANTS.MAX_CURSED_ENERGY, now())),
      ),
    ),
    row(
      control('HP 100%', 'Sets your HP to the maximum', () => setHp((max) => max)),
      control('HP 10%', 'Sets your HP to a tenth of the maximum', () =>
        setHp((max) => Math.ceil(max * 0.1)),
      ),
      control('HP 1', 'Sets your HP to 1', () => setHp(() => 1)),
    ),
    control('Add 50 Barrier', 'Gives you a white barrier', () =>
      onResult(engine.sandboxGrantBarrier(me, 50, now())),
    ),
    control('⚡ Next Hit = Black Flash', 'The next match lands as a Kokusen', () =>
      onResult(engine.debugSetNextHitBlackFlash(me, now())),
    ),
    control('🛡️ Activate Simple Domain', 'Two turns in which incoming sure-hit attacks are neutralized', () =>
      onResult(engine.debugArmSimpleDomain(me, now())),
    ),
  );

  // Dummy panel.
  const dummyPanel = panels.get('dummy');
  const dummyFighter = engine
    .getPublicView()
    .players.find((player) => player.id === dummy)?.characterId;
  const fighterSelect = element('select');
  fighterSelect.id = 'sandbox-dummy-character';
  fighterSelect.setAttribute('aria-label', 'Assign character to dummy');
  for (const id of CHARACTER_IDS) fighterSelect.add(new Option(CHARACTERS[id].name, id));
  if (dummyFighter) fighterSelect.value = dummyFighter;
  fighterSelect.addEventListener('change', () => {
    const chosen = CHARACTER_IDS.find((id) => id === fighterSelect.value);
    if (chosen) onDummyCharacter(chosen);
  });
  const fighterRow = element('div', 'sandbox-row');
  fighterRow.append(fighterSelect);
  const setDummyHp = (hp: (maxHp: number) => number): void => {
    const maxHp = engine.getPublicView().players.find((player) => player.id === dummy)?.maxHp ?? 1;
    onResult(engine.debugSetHp(dummy, hp(maxHp), now()));
  };
  dummyPanel?.append(
    element('label', 'sandbox-label', 'Assign character to dummy'),
    fighterRow,
    row(
      control('Force Dummy Skill 1', "Casts the dummy's skill 1 at full cursed energy", () =>
        onResult(engine.debugForceCast(dummy, 'skill1', now())),
      ),
      control('Force Dummy Domain', "Casts the dummy's Domain Expansion at full cursed energy", () =>
        onResult(engine.debugForceCast(dummy, 'domain', now())),
      ),
    ),
    row(
      control('HP 100%', 'Sets the dummy HP to the maximum', () => setDummyHp((max) => max)),
      control('HP 10%', 'Sets the dummy HP to a tenth of the maximum', () =>
        setDummyHp((max) => Math.ceil(max * 0.1)),
      ),
      control('HP 1', 'Sets the dummy HP to 1', () => setDummyHp(() => 1)),
    ),
    control('Add 50 Barrier to Dummy', 'Gives the dummy a white barrier to punch through', () =>
      onResult(engine.sandboxGrantBarrier(dummy, 50, now())),
    ),
  );

  // Hakari and Domains panel.
  const domainsPanel = panels.get('domains');
  domainsPanel?.append(
    control('🎰 Force Regular Jackpot (1-1-1)', 'Lands the spin on 1-1-1: two turns of immortality and a 100 CE lock', () =>
      onResult(engine.debugForceHakariTier(me, 'REGULAR', now())),
    ),
    control('✨ Force Golden Jackpot (7-7-7)', 'Lands the spin on 7-7-7: three turns of immortality, 50% damage and a Domain reset', () =>
      onResult(engine.debugForceHakariTier(me, 'GOLDEN', now())),
    ),
    control('💥 Force Bankrupt Whiff (x3)', 'Lands the last spin on a miss: the -30% max HP backlash and a pity boost', () =>
      onResult(engine.debugForceHakariTier(me, 'WHIFF', now())),
    ),
    row(
      control('Break My Domain', 'Breaks your active Domain at once', () =>
        onResult(engine.debugBreakDomain(me, now())),
      ),
      control("Break Dummy's Domain", "Breaks the dummy's active Domain at once", () =>
        onResult(engine.debugBreakDomain(dummy, now())),
      ),
    ),
  );

  // Board panel.
  const boardPanel = panels.get('board');
  const sharedButton = control('Shared Board', 'One grid for both fighters', () => {
    if (usesOwnBoards(currentMode)) onBoardLayout('shared');
  });
  const dualButton = control('Dual Boards', 'One grid per fighter', () => {
    if (!usesOwnBoards(currentMode)) onBoardLayout('dual');
  });
  let currentMode: BoardMode = options.boardMode;
  const paintLayout = (): void => {
    const dual = usesOwnBoards(currentMode);
    sharedButton.setAttribute('aria-pressed', String(!dual));
    dualButton.setAttribute('aria-pressed', String(dual));
    sharedButton.classList.toggle('is-active', !dual);
    dualButton.classList.toggle('is-active', dual);
  };
  let xRay = false;
  const xRayButton = control('👁️ Reveal All Cards (X-Ray)', 'Shows every card face while on', () => {
    xRay = engine.debugToggleXRay();
    xRayButton.classList.toggle('is-active', xRay);
    xRayButton.setAttribute('aria-pressed', String(xRay));
    onRefresh();
  });
  xRayButton.setAttribute('aria-pressed', 'false');

  const hazardButtons = HAZARDS.map((hazard) =>
    control(hazard.label, `Plants ${hazard.label.slice(2)} on a random hidden card of your grid`, () =>
      onResult(engine.debugPlantHazard(me, hazard.kind, now())),
    ),
  );

  const synergySelect = element('select');
  synergySelect.id = 'sandbox-synergy';
  synergySelect.setAttribute('aria-label', 'Synergy pair to spawn');
  for (const id of SYNERGY_IDS) synergySelect.add(new Option(SYNERGIES[id].name, id));

  boardPanel?.append(
    element('label', 'sandbox-label', 'Board layout'),
    row(sharedButton, dualButton),
    xRayButton,
    row(
      control('Reshuffle Board', 'Re-deals every grid with a fresh shuffle', () =>
        onResult(engine.sandboxReshuffle(now())),
      ),
      control('Clear Statuses', 'Wipes stuns, burns, debuffs and open domains', () =>
        onResult(engine.sandboxClearStatuses(now())),
      ),
    ),
    element('label', 'sandbox-label', 'Spawn hazard on your grid'),
    ...hazardButtons,
    element('label', 'sandbox-label', 'Lore pair'),
    row(
      synergySelect,
      control('Spawn', 'Puts the selected pair face-up and resolves it', () => {
        const chosen = SYNERGY_IDS.find((id) => id === synergySelect.value);
        if (chosen) onResult(engine.sandboxSpawnSynergy(me, chosen as SynergyId, now()));
      }),
    ),
  );
  paintLayout();

  // Dragging: the header is the handle. The dock moves by transform and stays in the viewport.
  // The stylesheet anchors the dock to the bottom-right corner, so the transform is only the drag offset.
  const applyOffset = (): void => {
    root.style.transform = `translate(${dockOffset.x}px, ${dockOffset.y}px)`;
  };
  const fitIntoView = (): void => {
    if (root.hidden) return;
    const rect = root.getBoundingClientRect();
    const left = rect.left - dockOffset.x;
    const top = rect.top - dockOffset.y;
    dockOffset = {
      x: clamp(dockOffset.x, -left, window.innerWidth - rect.width - left),
      y: clamp(dockOffset.y, -top, window.innerHeight - rect.height - top),
    };
    applyOffset();
  };

  const onHeadDown = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const rect = root.getBoundingClientRect();
    const start = { px: event.clientX, py: event.clientY, ox: dockOffset.x, oy: dockOffset.y };
    const left = rect.left - dockOffset.x;
    const top = rect.top - dockOffset.y;
    const move = (moveEvent: PointerEvent): void => {
      const x = start.ox + moveEvent.clientX - start.px;
      const y = start.oy + moveEvent.clientY - start.py;
      dockOffset = {
        x: clamp(x, -left, window.innerWidth - rect.width - left),
        y: clamp(y, -top, window.innerHeight - rect.height - top),
      };
      applyOffset();
    };
    const stop = (): void => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', stop);
      head.removeEventListener('pointercancel', stop);
    };
    head.setPointerCapture(event.pointerId);
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', stop);
    head.addEventListener('pointercancel', stop);
    event.preventDefault();
  };
  head.addEventListener('pointerdown', onHeadDown);
  window.addEventListener('resize', fitIntoView);

  selectTab(activeTab);
  // Starts as the LAB pill so the drawer never covers the board on arrival.
  setMinimized(true);
  fitIntoView();

  return {
    setBoardMode(mode: BoardMode): void {
      currentMode = mode;
      paintLayout();
    },
    /** The caller drops the reference; listeners die with the nodes that carry them. */
    destroy(): void {
      window.removeEventListener('resize', fitIntoView);
      root.replaceChildren();
      root.classList.remove('sandbox-dock', 'is-minimized');
      root.style.transform = '';
    },
  };
}
