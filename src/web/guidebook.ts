import {
  CARD_EFFECT_KIND,
  CARD_EFFECT_RULES,
  CHARACTERS,
  CHARACTER_IDS,
  DOMAINS,
  SUPPORTED_BOARD_SIZES,
  GAME_CONSTANTS,
  GAME_PACING,
  SKILLS,
  calculateTurnDuration,
  STATUS_KIND,
  SYNERGIES,
  TRAPS,
  ULTIMATES,
  ULTIMATE_TYPE,
  type AbilityEffect,
  type CardEffectKind,
  type CardSubjectId,
  type CharacterId,
  type StatusKind,
  type VfxCue,
} from '../engine/index.js';
import { cardIconFor, renderCardIcon } from './card-icons.js';
import { createPreviewFx, type PreviewFx } from './preview-fx.js';

// ---------------------------------------------------------------------------
// Copy
//
// Every name, cost, number and rule in the codex is read from the engine catalog,
// so the book cannot describe rules the game does not play. Only the prose that
// explains those numbers lives here.
// ---------------------------------------------------------------------------

/** Explanatory wording per status, kept apart from the terse HUD badges in main.ts. */
const STATUS_COPY: Readonly<Record<StatusKind, string>> = {
  [STATUS_KIND.IMMORTAL]: 'Unkillable: HP stays at 1 instead of dropping to 0',
  [STATUS_KIND.ABSOLUTE_SHIELD]: 'Infinity: negates all incoming damage',
  [STATUS_KIND.SHIELD]: 'Barrier points that soak damage before HP, up to half of max HP',
  [STATUS_KIND.CRITICAL_STRIKE]: 'The next successful match lands as a critical',
  [STATUS_KIND.FLASH_WINDOW]: 'Black Flash triggers on the very next match',
  [STATUS_KIND.PIERCING_ATTACKS]: 'Matches ignore enemy barriers (Kento Nanami, Soul Strike)',
  [STATUS_KIND.DAMAGE_OVER_TIME]: 'Burns for damage at the end of its owner turn',
  [STATUS_KIND.DIVERGENT_MARK]: 'Marks the next match to land a delayed shockwave',
  [STATUS_KIND.SHOCKWAVE]: 'Queued blast that resolves at the end of its owner turn',
  [STATUS_KIND.RESONANCE_RECOIL]: 'Takes extra damage on every mismatch',
  [STATUS_KIND.EXTRA_FLIP]: 'Opens one extra card per attempt',
  [STATUS_KIND.SKIP_TURNS]:
    'Loses that many turns — in simultaneous play it becomes an equal real-time lock-out',
  [STATUS_KIND.SHORT_TIMER]: 'Rushed turn clock; dropped in simultaneous play, which has no turn clock',
  [STATUS_KIND.CE_LOCKED]: 'Cursed energy is pinned at this value',
  [STATUS_KIND.MAX_HP_REDUCTION]: 'Maximum HP is lowered permanently',
  [STATUS_KIND.DOMAIN_NULLIFIED]: 'Its domain sure-hit field is neutralized',
  [STATUS_KIND.GAMBLE_TURN]: 'The next match attempt is a high-stakes gamble: a hit deals double damage and refunds CE, a miss costs HP',
  [STATUS_KIND.DAMAGE_BOOST]: 'Every match strike deals bonus damage',
  [STATUS_KIND.SOUL_STRIKE]: 'Divergent Fist becomes Soul Divergent Strike: a current-HP strike that heals its user',
};

/** How each synergy cue looks on screen, matching the effects in vfx.ts. */
const VFX_COPY: Readonly<Record<VfxCue, string>> = {
  CLAW: 'Three diagonal shadow-ink claw trails rake across the screen with ink splatter and a sharp shake.',
  RATIO: 'The screen dims, a 7:3 grid line cuts across the field, then the impact shatters like glass.',
  CLASH: 'Two crimson-black cursed-energy waves collide at the centre in a clap ring and screen vibration.',
  SIX_EYES: 'A cyan spatial ripple radiates from the matched cards and the whole grid reads in negative contrast.',
  DOMAIN: 'A barrier swells over the arena and the domain name is stamped across the screen.',
  SIMPLE_DOMAIN: 'A tightening barrier ring collapses inward as the counter lands.',
  SKILL: 'A quick cursed-energy pulse around the caster.',
  CLEAVE: 'Three blood-red diagonal katana slashes rake the arena with a heavy screen shake.',
  STRIKE: 'A sharp impact spark wherever the trap fires.',
};

/**
 * Readable names for the summons, tools and eyes that appear on synergy cards.
 * Exported so a card front and the codex cannot drift apart on how they are spelled.
 */
export const SUBJECT_LABELS: Partial<Record<CardSubjectId, string>> = {
  divine_dog: 'Divine Dog',
  ratio_blade: '7:3 Ratio Blade',
  six_eyes: 'Six Eyes',
};

const MODIFIER_COPY: Readonly<Record<CardEffectKind, string>> = {
  [CARD_EFFECT_KIND.NAILED]: 'Cursed nail: springs on whoever flips the card',
  [CARD_EFFECT_KIND.LAVA]: 'Ember insect: detonates on whoever flips the card',
  [CARD_EFFECT_KIND.FLESH]: 'Transfigured flesh: hides the real face of the card',
  [CARD_EFFECT_KIND.LOCKED]: 'Sealed: the card cannot be flipped while it holds',
};

export interface CodexAbility {
  readonly name: string;
  readonly cost: number;
  /** Short pill above the name, e.g. `Skill · 50 CE`. */
  readonly badge: string;
  readonly tone: 'skill' | 'domain' | 'counter';
  readonly description: string;
  readonly bullets: readonly string[];
}

/** One rules entry of the glossary tab. */
export interface CodexTerm {
  /** Anchor id, so a future deep link or test can find the entry. */
  readonly id: string;
  readonly name: string;
  /** Cost chip shown next to the name, when the term has one. */
  readonly cost: string | null;
  readonly body: string;
  readonly bullets: readonly string[];
}

export interface CodexSynergy {
  readonly id: string;
  readonly name: string;
  readonly subjects: readonly string[];
  /** What the pair plays on screen. */
  readonly vfx: string;
  /** The cue the "Preview VFX" button replays, when the pair has one. */
  readonly cue: VfxCue;
  readonly description: string;
  readonly bullets: readonly string[];
}

/** A switchable skill form, such as Higuruma's Executioner's Sword. */
export interface CodexStance {
  /** The tab label that selects this form. */
  readonly label: string;
  readonly skill: CodexAbility;
}

export interface CodexCharacter {
  readonly id: CharacterId;
  readonly name: string;
  readonly title: string;
  /** True when the ultimate is a real Domain Expansion rather than a counter. */
  readonly hasDomain: boolean;
  readonly skill: CodexAbility;
  /** Alternate skill forms; empty for fighters with a single skill. */
  readonly stances: readonly CodexStance[];
  readonly ultimate: CodexAbility;
}

function subjectLabel(subject: CardSubjectId): string {
  return CHARACTERS[subject as CharacterId]?.name ?? SUBJECT_LABELS[subject] ?? subject.replace(/_/g, ' ');
}

function turnsNote(turns: number | null): string {
  return turns === null ? 'until the match ends' : `for ${turns} turn${turns === 1 ? '' : 's'}`;
}

function gridNote(board: 'OWN' | 'OPPONENT'): string {
  return board === 'OWN' ? 'your grid' : "the enemy's grid";
}

/** Renders one effect of the engine's effect language as a sentence. */
export function describeEffect(effect: AbilityEffect): string {
  switch (effect.kind) {
    case 'STATUS': {
      const who = effect.target === 'SELF' ? 'You' : 'The enemy';
      return `${who}: ${STATUS_COPY[effect.spec.status].toLowerCase()} ${turnsNote(effect.spec.turns)}`;
    }
    case 'DAMAGE': {
      const who = effect.target === 'SELF' ? 'yourself' : 'the enemy';
      const piercing = effect.piercing ? ' and ignores shields' : '';
      if (effect.maxHpFraction !== undefined) {
        return `Deals ${Math.round(effect.maxHpFraction * 100)}% of the target's maximum HP to ${who}${piercing}`;
      }
      return `Deals ${effect.amount} damage to ${who}${piercing}`;
    }
    case 'MAX_HP_CUT':
      return `Permanently lowers ${effect.target === 'SELF' ? 'your' : 'the enemy'}'s maximum HP by ${Math.round(
        effect.fraction * 100,
      )}%`;
    case 'HEAL':
      return `Restores ${effect.amount} HP`;
    case 'CE_GAIN':
      return `Refunds ${effect.amount} CE`;
    case 'CE_SIPHON':
      return `Siphons up to ${effect.amount} CE from the enemy`;
    case 'CE_DRAIN':
      return `Drains ${effect.amount} CE from ${effect.target === 'SELF' ? 'yourself' : 'the enemy'}`;
    case 'BOARD_SWAP':
      return `Swaps ${effect.count} face-down cards on ${gridNote(effect.board)}, breaking their layout`;
    case 'COURTROOM_TRIAL':
      return `Puts the enemy on trial for ${effect.rounds} rounds. Each wrong guess seals one of their hidden cards, and the verdict then holds for ${GAME_PACING.COURTROOM_VERDICT_INSPECTION_MS / 1000}s showing the card picked and the card that really held the target`;
    case 'PLANT_MODIFIER': {
      const rules = CARD_EFFECT_RULES[effect.modifier];
      const parts = [
        rules.damage > 0 ? `${rules.damage} damage` : '',
        rules.stunMs > 0 ? `${rules.stunMs / 1000}s stun` : '',
        rules.ceDrain > 0 ? `${rules.ceDrain} CE drained` : '',
      ].filter(Boolean);
      const note = `${MODIFIER_COPY[effect.modifier]} on ${effect.count} card(s) of ${gridNote(effect.board)}`;
      return `${note}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'SCOUT': {
      const seconds = `${effect.revealMs / 1000}s`;
      if (effect.pool === 'PAIR') return `Reveals a matching pair on ${gridNote(effect.board)} for ${seconds}`;
      if (effect.pool === 'ALL') return `Reveals every face-down card on ${gridNote(effect.board)} for ${seconds}`;
      return `Reveals ${effect.count} random card(s) on ${gridNote(effect.board)} for ${seconds}`;
    }
    case 'DETONATE_CARD':
      return `Shows a face-down card on ${gridNote(effect.board)} for ${
        effect.revealMs / 1000
      }s and deals ${effect.damage} damage to the enemy`;
    case 'AUTO_MATCH_PAIRS':
      return `Immediately resolves ${effect.count} matching pair(s) on ${gridNote(effect.board)}`;
    case 'DOMAIN_COUNTER':
      return `Neutralizes an active enemy domain ${turnsNote(effect.turns)}`;
    case 'PACHINKO_OPEN':
      return `Opens the Idle Death Gamble slot machine with ${effect.spins} free re-spins`;
  }
}

export function describeEffects(effects: readonly AbilityEffect[]): string[] {
  return effects.map((effect) => describeEffect(effect));
}

/** Every lore pair, with the cue it plays and the bonus it pays. */
export function synergyEntries(): CodexSynergy[] {
  return Object.values(SYNERGIES).map((synergy) => ({
    id: synergy.id,
    name: synergy.name,
    subjects: synergy.subjects.map(subjectLabel),
    cue: synergy.vfx,
    vfx: VFX_COPY[synergy.vfx],
    description: synergy.description,
    bullets: describeEffects(synergy.effects),
  }));
}

/** The full roster: a 50 CE skill and a 100 CE ultimate for each fighter. */
export function characterEntries(): CodexCharacter[] {
  return CHARACTER_IDS.map((id) => {
    const character = CHARACTERS[id];
    const skill = SKILLS[character.skillId];
    const ultimate = ULTIMATES[character.ultimateId];
    const hasDomain = ultimate.type === ULTIMATE_TYPE.DOMAIN;
    const domain = ultimate.domainId === null ? null : DOMAINS[ultimate.domainId];
    return {
      id,
      name: character.name,
      title: character.title,
      hasDomain,
      skill: {
        name: skill.name,
        cost: skill.cost,
        badge: `Skill · ${skill.cost} CE`,
        tone: 'skill',
        description: skill.description,
        bullets: describeEffects(skill.effects),
      },
      stances: (character.alternateStances ?? []).map((stance) => {
        const stanceSkill = SKILLS[stance.skillId];
        return {
          label: stance.stanceName,
          skill: {
            name: stanceSkill.name,
            cost: stanceSkill.cost,
            badge: stance.stanceBadge,
            tone: 'skill',
            description: stanceSkill.description,
            bullets: [...stance.bullets],
          },
        };
      }),
      ultimate: {
        name: ultimate.name,
        cost: ultimate.cost,
        badge: hasDomain
          ? `Domain Expansion${domain === null ? '' : ` · ${domain.name}`} · ${ultimate.cost} CE`
          : `Simple Domain / Maximum · ${ultimate.cost} CE`,
        tone: hasDomain ? 'domain' : 'counter',
        description: ultimate.description,
        bullets: describeEffects(ultimate.effects),
      },
    };
  });
}

/** Which fighters open a domain and which answer one, plus the clash rule. */
export function domainSummary(): { domains: string[]; counters: string[]; rule: string } {
  const entries = characterEntries();
  return {
    domains: entries.filter((entry) => entry.hasDomain).map((entry) => entry.name),
    counters: entries.filter((entry) => !entry.hasDomain).map((entry) => entry.name),
    rule: `A Simple Domain or Maximum Technique that meets an active domain neutralizes its sure-hit field ${turnsNote(
      GAME_CONSTANTS.DOMAIN_COUNTER_TURNS,
    )}. A true domain lasts ${GAME_CONSTANTS.DOMAIN_DURATION_TURNS} of its owner's turns and boosts their damage.`,
  };
}

/** Traps and planted card modifiers, i.e. what can be waiting face down. */
export function fieldHazards(): Array<{ name: string; note: string; tone: 'trap' | 'planted' }> {
  const traps = Object.values(TRAPS).map((trap) => ({
    name: trap.name,
    note: `Flipped alone it grants +${trap.cursedEnergyGain} CE and never ends the turn.`,
    tone: 'trap' as const,
  }));
  const modifiers = Object.values(CARD_EFFECT_KIND).map((kind) => {
    const rules = CARD_EFFECT_RULES[kind];
    const parts = [
      rules.damage > 0 ? `${rules.damage} damage` : '',
      rules.stunMs > 0 ? `${rules.stunMs / 1000}s stun` : '',
      rules.ceDrain > 0 ? `${rules.ceDrain} CE drained` : '',
    ].filter(Boolean);
    const [name, ...effect] = MODIFIER_COPY[kind].split(':');
    return {
      name: name ?? kind,
      tone: 'planted' as const,
      note: `${effect.join(':').trim()}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}.`,
    };
  });
  return [...traps, ...modifiers];
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export interface GuideBookOptions {
  /** The modal shell from index.html; its tabs and panes are filled in here. */
  readonly root: HTMLElement;
  /** The top-bar button that opens the codex. */
  readonly trigger: HTMLElement;
  // Previews are drawn by the codex itself, inside each pair's own clipped canvas, so a
  // preview can never paint across the window or layer over the modal.
}

export interface GuideBook {
  open(): void;
  /** Opens the codex directly on one tab, e.g. `rules` from the New Match dialog. */
  openTab(id: string): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

interface Section {
  readonly id: string;
  readonly label: string;
  readonly pane: HTMLElement;
  readonly tab: HTMLButtonElement;
}

const TAB_KEYS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowLeft: -1 };

/**
 * Builds the Sorcery Codex: one scrollable, keyboard-navigable modal with a tab per
 * reference section. Content is rendered once at construction and only shown or
 * hidden afterwards, so opening it mid-match costs a single class toggle.
 */
export function createGuideBook(options: GuideBookOptions): GuideBook {
  const { root, trigger } = options;
  const panel = find<HTMLElement>(root, '.codex-panel');
  const tabBar = find<HTMLElement>(root, '.codex-tabs');
  const body = find<HTMLElement>(root, '#codex-body');
  const closeButton = find<HTMLButtonElement>(root, '.codex-close');
  let lastFocused: HTMLElement | null = null;
  /** One teardown per preview canvas, run when the codex closes. */
  const previews: Array<() => void> = [];

  const sections: Section[] = [
    buildSection('rules', 'How to Play & Modes', renderRulesTab),
    buildSection('synergy', 'Synergy Pairs', () => renderSynergyTab((destroy) => previews.push(destroy))),
    buildSection('roster', 'Characters & Skills', renderRosterTab),
    buildSection('glossary', 'Glossary & Rules', renderGlossaryTab),
  ];
  tabBar.replaceChildren(...sections.map((section) => section.tab));
  body.replaceChildren(...sections.map((section) => section.pane));
  const opening = sections[0];
  if (!opening) throw new Error('The codex needs at least one section');
  select(opening);

  function buildSection(id: string, label: string, render: () => HTMLElement): Section {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'codex-tab';
    tab.id = `codex-tab-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `codex-pane-${id}`);
    tab.setAttribute('aria-selected', 'false');
    tab.textContent = label;

    const pane = document.createElement('section');
    pane.className = 'codex-pane';
    pane.id = `codex-pane-${id}`;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tab.id);
    pane.append(render());

    const section: Section = { id, label, pane, tab };
    tab.addEventListener('click', () => select(section));
    return section;
  }

  /** Shows one section and hides the rest, following the ARIA tab pattern. */
  function select(target: Section): void {
    for (const section of sections) {
      const active = section === target;
      section.tab.setAttribute('aria-selected', String(active));
      section.tab.tabIndex = active ? 0 : -1;
      section.tab.classList.toggle('active', active);
      section.pane.hidden = !active;
    }
    target.pane.scrollTop = 0;
  }

  function step(from: Section, delta: number): void {
    const index = sections.indexOf(from);
    const next = sections[(index + delta + sections.length) % sections.length];
    if (!next) return;
    select(next);
    next.tab.focus();
  }

  function isOpen(): boolean {
    return !root.hidden;
  }

  function open(): void {
    if (isOpen()) return;
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.hidden = false;
    // Restart the entrance animation even when reopened quickly.
    panel.classList.remove('entered');
    void panel.offsetWidth;
    panel.classList.add('entered');
    panel.focus();
  }

  function close(): void {
    if (!isOpen()) return;
    // A preview left running would keep drawing into a hidden modal; kill every loop and
    // wipe its canvas before the codex disappears.
    for (const destroy of previews) destroy();
    root.hidden = true;
    lastFocused?.focus();
    lastFocused = null;
  }

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  closeButton.addEventListener('click', close);

  // Clicking the scrim, but not the panel itself, dismisses the codex.
  root.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-close]')) close();
  });

  tabBar.addEventListener('keydown', (event) => {
    const delta = TAB_KEYS[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      const from = sections.find((section) => section.tab === document.activeElement) ?? sections[0];
      if (from) step(from, delta);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? sections[0] : sections[sections.length - 1];
      if (target) {
        select(target);
        target.tab.focus();
      }
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') trapFocus(event);
  });

  /** Keeps Tab inside the dialog while it is open. */
  function trapFocus(event: KeyboardEvent): void {
    const focusable = [...panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')].filter(
      (element) => element.tabIndex >= 0 && element.offsetParent !== null,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openTab(id: string): void {
    const target = sections.find((section) => section.id === id);
    if (!target) return;
    open();
    select(target);
    target.tab.focus();
  }

  return { open, openTab, close, toggle: () => (isOpen() ? close() : open()), isOpen };
}

// ---------------------------------------------------------------------------
// Section rendering
// ---------------------------------------------------------------------------

/** Plain-language rules the New Match dialog used to carry. Grouped so each card scans on its own. */
const RULE_CARDS: ReadonlyArray<{ readonly title: string; readonly items: readonly string[] }> = [
  {
    title: 'Board layouts',
    items: [
      'Dual boards (simultaneous): each fighter owns a grid, dealt and shuffled separately, so trap positions are never read off the other grid. Both act at once.',
      'Dual boards (turn based): the same two grids on strict turns. You flip on your own grid and your techniques sabotage theirs.',
      'Shared board: one grid, strict turns.',
      'The turn clock tightens as the match goes on: 25 seconds for the first ten turns, 20 until turn 20, then 15.',
      'Sandbox: a training ground against an immortal Cursed Training Dummy that never takes a turn, with no clock and a debug drawer for testing skills, Kokusen and armor-piercing on demand.',
      'Online / LAN: one player hosts and shares the five-character room code, the other joins it. The host’s board layout, grid size and fighters apply to both, and every card flip travels over a direct peer-to-peer connection. No game server is involved.',
    ],
  },
  {
    title: 'Matching',
    items: [
      'Flip cards to match pairs. A pair damages the opponent, grants +15 CE and keeps your turn.',
      'Two cards match when they show the same fighter. A 6 × 6 grid repeats the roster, so two copies of one fighter complete each other even when they came from different pairs.',
      'A mismatch costs 3 CE and passes the turn, after both cards stay visible for one second.',
      'Traps grant CE when flipped alone and never end your turn.',
      'Endless boards: when every pair on a grid is matched the grid is reshuffled and re-dealt. Your HP, CE, buffs and combo all carry over, so long HP pools are playable.',
    ],
  },
  {
    title: 'Black Flash',
    items: [
      'A second match in the same turn is a Black Flash: 2.5× damage, +10 HP, +20 barrier, +25 CE.',
    ],
  },
  {
    title: 'Skills & domains',
    items: [
      'Every fighter has a 50 CE skill and a 100 CE ultimate.',
      'Domains open a field. Simple Domain and Maximum Techniques neutralize an enemy domain instead.',
    ],
  },
  {
    title: 'Lore synergy pairs',
    items: [
      'Divine Dog, 7:3 Ratio Blade, Brotherhood Sync and Six Eyes fire a screen VFX and a bonus effect when matched.',
    ],
  },
  {
    title: 'Sound',
    items: [
      'Every effect is synthesized in the browser, so nothing is downloaded. The speaker button in the top bar (or M) mutes the match, and the choice is remembered for the next visit.',
    ],
  },
];

function renderRulesTab(): HTMLElement {
  const fragment = document.createElement('div');
  fragment.className = 'codex-stack';
  fragment.append(
    heading(
      'How to play & modes',
      'The rules behind every match, in the order you meet them: the board, the matching, then the abilities.',
    ),
  );

  const grid = document.createElement('div');
  grid.className = 'codex-rule-grid';
  for (const card of RULE_CARDS) {
    const block = document.createElement('section');
    block.className = 'codex-rule-card';
    const name = document.createElement('h4');
    name.textContent = card.title;
    const list = document.createElement('ul');
    for (const item of card.items) {
      const line = document.createElement('li');
      line.textContent = item;
      list.append(line);
    }
    block.append(name, list);
    grid.append(block);
  }
  fragment.append(grid);
  return fragment;
}

function renderSynergyTab(registerPreview: (destroy: () => void) => void): HTMLElement {
  const fragment = document.createElement('div');
  fragment.className = 'codex-stack';

  fragment.append(
    heading(
      'Lore synergy pairs',
      `Match both cards of a pair to fire its screen effect and bonus. Every deal can hold up to ${Object.keys(SYNERGIES).length} of them.`,
    ),
  );

  const grid = document.createElement('div');
  grid.className = 'codex-cards';
  for (const synergy of synergyEntries()) {
    const card = document.createElement('article');
    card.className = 'codex-card';
    card.dataset.synergy = synergy.id;

    const pair = document.createElement('div');
    pair.className = 'codex-pair';
    synergy.subjects.forEach((subject, index) => {
      if (index > 0) {
        const plus = document.createElement('span');
        plus.className = 'codex-plus';
        plus.textContent = '+';
        pair.append(plus);
      }
      const chip = document.createElement('span');
      chip.className = 'codex-subject';
      chip.textContent = subject;
      pair.append(chip);
    });

    const title = document.createElement('h3');
    title.textContent = synergy.name;

    const vfx = document.createElement('p');
    vfx.className = 'codex-vfx';
    const tag = document.createElement('span');
    tag.className = 'codex-tag';
    tag.textContent = 'VFX';
    vfx.append(tag, document.createTextNode(synergy.vfx));

    const stats = document.createElement('ul');
    stats.className = 'codex-stats';
    for (const bullet of synergy.bullets) {
      const item = document.createElement('li');
      item.textContent = bullet;
      stats.append(item);
    }

    card.append(pair, title, vfx);
    card.append(previewStage(synergy, registerPreview), stats);
    grid.append(card);
  }
  fragment.append(grid);

  fragment.append(heading('Field hazards', 'What can be waiting face down, and what techniques leave behind.'));
  const hazards = document.createElement('ul');
  hazards.className = 'codex-hazards';
  for (const hazard of fieldHazards()) {
    const item = document.createElement('li');
    item.className = `hazard-${hazard.tone}`;
    const name = document.createElement('strong');
    name.textContent = hazard.name;
    item.append(name, document.createTextNode(` — ${hazard.note}`));
    hazards.append(item);
  }
  fragment.append(hazards);

  return fragment;
}

/**
 * `[▶ Preview VFX]`: a boxed canvas plus its button. The effect is drawn inside the box
 * only, auto-stops after two seconds and is torn down when the codex closes.
 */
function previewStage(
  synergy: CodexSynergy,
  registerPreview: (destroy: () => void) => void,
): HTMLElement {
  const stage = document.createElement('div');
  stage.className = 'codex-vfx-preview-box';
  stage.dataset.preview = synergy.id;
  const canvas = document.createElement('canvas');
  canvas.className = 'codex-vfx-preview-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.append(canvas);

  const fx: PreviewFx = createPreviewFx(canvas);
  registerPreview(() => fx.destroy());
  stage.append(previewButton(synergy, fx));
  return stage;
}

function previewButton(synergy: CodexSynergy, fx: PreviewFx): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'codex-preview';
  button.dataset.preview = synergy.id;
  button.title = `Play the ${synergy.name} effect again`;
  const icon = document.createElement('span');
  icon.className = 'play';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '▶';
  button.append(icon, document.createTextNode('Preview VFX'));
  button.addEventListener('click', () => fx.play(synergy.cue));
  return button;
}

/**
 * The rules glossary. Every number is read from the engine constants and catalogs, so
 * the book can never describe a rule the game does not play.
 */
export function glossaryTerms(): CodexTerm[] {
  const shieldCeiling = `${Math.round(GAME_CONSTANTS.SHIELD_FRACTION_OF_MAX_HP * 100)}% of maximum HP`;
  const piercers = [...Object.values(SKILLS), ...Object.values(ULTIMATES)]
    .filter((ability) =>
      ability.effects.some(
        (effect) => effect.kind === 'STATUS' && effect.spec.status === STATUS_KIND.PIERCING_ATTACKS,
      ),
    )
    .map((ability) => `${CHARACTERS[ability.characterId].name} · ${ability.name}`);
  const domains = Object.values(DOMAINS).map(
    (domain) => `${domain.name} — ${CHARACTERS[domain.ownerId].name}`,
  );
  const counters = characterEntries()
    .filter((entry) => !entry.hasDomain)
    .map((entry) => `${entry.name} · ${entry.ultimate.name}`);
  const clock = (turn: number): string => `${calculateTurnDuration(turn) / 1000}s`;

  const roster = CHARACTER_IDS.length;
  const biggestGrid = Math.max(...SUPPORTED_BOARD_SIZES);
  const biggestPairs = biggestGrid / 2;

  return [
    {
      id: 'pairs',
      name: 'Pairs & Matching',
      cost: null,
      body: 'A turn is a run of flips. Two face-up cards pair when they show the same fighter — not merely the same dealt pair — so on a grid that repeats the roster, two copies of one fighter complete each other.',
      bullets: [
        `An attempt opens ${GAME_CONSTANTS.BASE_FLIP_LIMIT} cards (three under Chimera Shadow Garden).`,
        `A match deals damage, pays +${GAME_CONSTANTS.MATCH_CE_GAIN} CE and keeps the turn; a mismatch costs ${GAME_CONSTANTS.MISMATCH_CE_PENALTY} CE and passes it.`,
        `The ${biggestGrid} card grid needs ${biggestPairs} pairs from a ${roster} fighter roster, so the deal repeats fighters there and those copies are interchangeable.`,
        'A lore synergy card only ever completes its own partner, even when a plain pair shows the same fighter.',
      ],
    },
    {
      id: 'barrier',
      name: 'Barrier (Shield)',
      cost: null,
      body: 'Cursed reinforcement wrapped around a fighter. It soaks incoming damage point for point before any of it reaches HP.',
      bullets: [
        `Ceiling: ${shieldCeiling}; a grant that would exceed it is clipped.`,
        `A Simple Domain or Maximum Technique raises ${GAME_CONSTANTS.SHIELD_GRANT} barrier.`,
        `A Black Flash adds ${GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN} barrier on top of its ${GAME_CONSTANTS.BLACK_FLASH_HEAL} HP.`,
        `Piercing strikes ignore it completely: ${piercers.join('; ')}.`,
      ],
    },
    {
      id: 'domain',
      name: 'Domain Expansion',
      cost: `${GAME_CONSTANTS.DOMAIN_CE_COST} CE`,
      body: 'The pinnacle of jujutsu sorcery: an enclosed barrier that imposes a sure-hit field on the battlefield until it is countered or it collapses.',
      bullets: [
        `Lasts ${turnsNote(GAME_CONSTANTS.DOMAIN_DURATION_TURNS)} of its owner, then collapses.`,
        `Multiplies its owner's damage by ×${GAME_CONSTANTS.DOMAIN_BOOST} while it stands.`,
        `A fighter cannot hold two domains at once.`,
        `Domains in play: ${domains.join('; ')}.`,
      ],
    },
    {
      id: 'simple-domain',
      name: 'Simple Domain & Anti-Domain Techniques',
      cost: `${GAME_CONSTANTS.DOMAIN_CE_COST} CE`,
      body: 'The answer sorcerers without an innate domain are taught: a smaller barrier that cancels the sure-hit field of an enemy domain instead of contesting it.',
      bullets: [
        `Cancels an active enemy domain ${turnsNote(GAME_CONSTANTS.DOMAIN_COUNTER_TURNS)}.`,
        'Cannot be used while your own domain is already open.',
        `Counters available: ${counters.join('; ')}.`,
      ],
    },
    {
      id: 'black-flash',
      name: 'Black Flash (Kokusen)',
      cost: null,
      body: 'A spatial distortion that occurs when cursed energy lands within 0.000001 seconds of a physical hit. It is forced by consecutive matches, not by luck.',
      bullets: [
        `Triggers on the ${GAME_CONSTANTS.BLACK_FLASH_STREAK_LENGTH}${GAME_CONSTANTS.BLACK_FLASH_STREAK_LENGTH === 2 ? 'nd' : 'th'} consecutive match of a turn streak; a widened window (Soul Strike, Brotherhood Sync) makes the next match one.`,
        `Damage ×${GAME_CONSTANTS.BLACK_FLASH_CRIT_MULTIPLIER}.`,
        `Restores ${GAME_CONSTANTS.BLACK_FLASH_HEAL} HP, raises ${GAME_CONSTANTS.BLACK_FLASH_SHIELD_GAIN} barrier and pays +${GAME_CONSTANTS.BLACK_FLASH_CE_GAIN} CE.`,
      ],
    },
    {
      id: 'hazards',
      name: 'Cursed Traps & Hazards',
      cost: null,
      body: 'What can be waiting face down. A trap is a single card; modifiers are planted on cards by techniques and are public information once announced.',
      bullets: fieldHazards().map((hazard) => `${hazard.name} — ${hazard.note}`),
    },
    {
      id: 'turn-clock',
      name: 'Turn Clock',
      cost: null,
      body: 'Thinking time is part of the match. The budget tightens as the game goes on, so a stalled turn resolves itself.',
      bullets: [
        `Turns 1-${GAME_CONSTANTS.TURN_TIME_MID_FROM_TURN - 1}: ${clock(1)}.`,
        `Turns ${GAME_CONSTANTS.TURN_TIME_MID_FROM_TURN}-${GAME_CONSTANTS.TURN_TIME_LATE_FROM_TURN - 1}: ${clock(GAME_CONSTANTS.TURN_TIME_MID_FROM_TURN)}.`,
        `Turn ${GAME_CONSTANTS.TURN_TIME_LATE_FROM_TURN} and later: ${clock(GAME_CONSTANTS.TURN_TIME_LATE_FROM_TURN)}.`,
        'A match keeps the turn and refreshes the clock; a miss passes both on.',
        'No clock runs in simultaneous dual play or against the training dummy.',
      ],
    },
    {
      id: 'awakening',
      name: 'Board Clear (Awakening Surge)',
      cost: null,
      body: 'Clear a whole grid and its clearer claims an Awakening Surge blessing before the fresh grid is dealt. The board clear reward setting decides how the blessing is picked.',
      bullets: [
        'Manual choice: the match pauses and the clearer picks one of three blessings. The clock resumes after the pick; without one in time the clearer is granted Sorcery Restoration.',
        'Instant random: nothing pauses and no popup opens. One of the three blessings is rolled at once and a banner shows under the clearer’s HUD for 3.5 seconds.',
        'Simultaneous (dual) boards default to instant random, so real-time play never stops for a pick.',
        'Latent Black Flash: the next matched pair on the fresh grid is guaranteed a Black Flash.',
        `Sorcery Restoration: +${GAME_CONSTANTS.AWAKENING_RESTORE_BARRIER} Barrier and +${GAME_CONSTANTS.AWAKENING_RESTORE_CE} CE, instantly.`,
        `Six Eyes Insight: two matched pairs on the fresh grid glow cyan for ${GAME_CONSTANTS.SIX_EYES_REVEAL_MS / 1000}s.`,
      ],
    },
  ];
}

function renderGlossaryTab(): HTMLElement {
  const fragment = document.createElement('div');
  fragment.className = 'codex-stack';
  fragment.append(
    heading(
      'Glossary & rules',
      'Barriers, domains, Kokusen and everything that can be waiting face down — read from the same constants the engine plays.',
    ),
  );

  const list = document.createElement('dl');
  list.className = 'codex-terms';
  for (const term of glossaryTerms()) {
    const item = document.createElement('div');
    item.className = 'codex-term';
    item.id = `codex-term-${term.id}`;

    const name = document.createElement('dt');
    name.textContent = term.name;
    if (term.cost !== null) {
      const tag = document.createElement('span');
      tag.className = 'codex-tag';
      tag.textContent = term.cost;
      name.append(tag);
    }

    const body = document.createElement('dd');
    body.textContent = term.body;
    const bullets = document.createElement('ul');
    bullets.className = 'codex-stats';
    for (const bullet of term.bullets) {
      const line = document.createElement('li');
      line.textContent = bullet;
      bullets.append(line);
    }
    body.append(bullets);

    item.append(name, body);
    list.append(item);
  }
  fragment.append(list);
  return fragment;
}

function renderRosterTab(): HTMLElement {
  const fragment = document.createElement('div');
  fragment.className = 'codex-stack';
  const summary = domainSummary();

  fragment.append(
    heading(
      'Domain clash',
      'Six fighters open a true Domain Expansion. Four answer one with a Simple Domain or Maximum Technique.',
    ),
  );

  const legend = document.createElement('div');
  legend.className = 'codex-legend';
  for (const [label, names, tone] of [
    ['Domain Expansion', summary.domains, 'domain'],
    ['Simple Domain / Maximum counter', summary.counters, 'counter'],
  ] as const) {
    const column = document.createElement('div');
    column.className = `legend-${tone}`;
    const title = document.createElement('h4');
    title.textContent = `${label} (${names.length})`;
    const list = document.createElement('ul');
    for (const name of names) {
      const item = document.createElement('li');
      item.textContent = name;
      list.append(item);
    }
    column.append(title, list);
    legend.append(column);
  }
  const rule = document.createElement('p');
  rule.className = 'codex-rule';
  rule.textContent = summary.rule;
  legend.append(rule);
  fragment.append(legend);

  fragment.append(heading('Roster', 'Every fighter carries one 50 CE skill and one 100 CE ultimate.'));
  const rows = document.createElement('div');
  rows.className = 'codex-rows';
  for (const character of characterEntries()) {
    const row = document.createElement('article');
    row.className = 'codex-row';
    row.dataset.character = character.id;

    const who = document.createElement('div');
    who.className = 'codex-who';
    // The fighter's pair emblem, the same one the battle grid and the courtroom draw.
    const emblem = document.createElement('span');
    emblem.className = 'codex-emblem';
    const icon = cardIconFor(character.id, false);
    if (icon !== null) emblem.innerHTML = renderCardIcon(icon);
    const name = document.createElement('h3');
    name.textContent = character.name;
    const title = document.createElement('span');
    title.className = 'codex-title';
    title.textContent = character.title;
    const affinity = document.createElement('span');
    affinity.className = `codex-affinity ${character.hasDomain ? 'domain' : 'counter'}`;
    affinity.textContent = character.hasDomain ? 'Domain Expansion' : 'Simple Domain counter';
    who.append(emblem, name, title, affinity);

    const abilities = document.createElement('div');
    abilities.className = 'codex-abilities';
    const skillSlot = character.stances.length > 0 ? skillSwitcher(character) : abilityBlock(character.skill);
    abilities.append(skillSlot, abilityBlock(character.ultimate));

    row.append(who, abilities);
    rows.append(row);
  }
  fragment.append(rows);

  return fragment;
}

/** The skill slot of a fighter with stances: tabs pick the base skill or a transformed form. */
function skillSwitcher(character: CodexCharacter): HTMLElement {
  const forms = [{ label: 'Base skill', ability: character.skill }, ...character.stances.map((stance) => ({ label: stance.label, ability: stance.skill }))];

  const wrap = document.createElement('div');
  wrap.className = 'codex-skill-switch';
  const tabs = document.createElement('div');
  tabs.className = 'codex-stance-tabs';
  tabs.setAttribute('role', 'tablist');
  const slot = document.createElement('div');
  slot.className = 'codex-stance-slot';

  const show = (index: number): void => {
    const form = forms[index];
    if (!form) return;
    slot.replaceChildren(abilityBlock(form.ability));
    [...tabs.children].forEach((tab, i) => {
      tab.classList.toggle('active', i === index);
      tab.setAttribute('aria-selected', String(i === index));
    });
  };

  forms.forEach((form, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'codex-stance-tab';
    tab.setAttribute('role', 'tab');
    tab.textContent = form.label;
    tab.addEventListener('click', () => show(index));
    tabs.append(tab);
  });

  wrap.append(tabs, slot);
  show(0);
  return wrap;
}

function abilityBlock(ability: CodexAbility): HTMLElement {
  const block = document.createElement('div');
  block.className = `codex-ability ${ability.tone}`;

  const badge = document.createElement('span');
  badge.className = 'ability-badge';
  badge.textContent = ability.badge;

  const name = document.createElement('h4');
  name.textContent = ability.name;

  const description = document.createElement('p');
  description.textContent = ability.description;

  const bullets = document.createElement('ul');
  for (const bullet of ability.bullets) {
    const item = document.createElement('li');
    item.textContent = bullet;
    bullets.append(item);
  }

  block.append(badge, name, description, bullets);
  return block;
}

function heading(title: string, note: string): HTMLElement {
  const block = document.createElement('div');
  block.className = 'codex-section-head';
  const name = document.createElement('h3');
  name.textContent = title;
  const text = document.createElement('p');
  text.textContent = note;
  block.append(name, text);
  return block;
}

function find<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Codex markup is missing ${selector}`);
  return element;
}
