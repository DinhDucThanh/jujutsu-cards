import {
  DOMAINS,
  STATUS_KIND,
  ULTIMATES,
  ULTIMATE_TYPE,
  type DomainId,
  type PlayerState,
  type PublicPlayerView,
} from '../engine/index.js';

/**
 * The domain widget under a fighter's technique buttons.
 *
 * It answers one question the log cannot: *is a domain standing right now, and is it
 * actually doing anything?* Four states are possible, and the engine tells them apart
 * without any extra bookkeeping:
 *
 *  - no domain and no counter window → the idle slate row,
 *  - an `activeDomain` carrying `DOMAIN_NULLIFIED` → the domain is open but its sure-hit
 *    field is cancelled, so it is drawn in amber with the counter's remaining turns,
 *  - an `activeDomain` on its own → the purple domain state, with its sure-hit line,
 *  - an `activeSimpleDomain` window → a cyan anti-domain that is armed and waiting.
 *
 * A domain owner can never hold a counter window at the same time (the catalog's counters
 * live on the ultimates of sorcerers with no domain), so the states never overlap.
 */
export interface DomainStatusData {
  readonly isActive: boolean;
  readonly type: 'NONE' | 'DOMAIN' | 'SIMPLE_DOMAIN';
  readonly name: string;
  /** Turns left on the domain, or on the counter window. */
  readonly turnsRemaining: number;
  /** True when a Simple Domain has cancelled this domain's sure-hit field. */
  readonly isNeutralized: boolean;
  readonly neutralizedTurnsRemaining: number;
  readonly sureHitDescription: string | null;
}

/**
 * One short line per domain, taken from the ultimate's own rules text so the widget can
 * never promise a sure-hit the engine does not play. The keys are checked against the
 * catalog by the test suite.
 */
export const DOMAIN_SURE_HIT: Readonly<Record<DomainId, string>> = {
  unlimited_void: 'Locks the enemy out for a turn, then rushes their next turn.',
  malevolent_shrine: 'Cleaves two pairs off your grid and bleeds the enemy for 2 turns.',
  chimera_shadow_garden: 'Raises your flip limit for 2 turns.',
  idle_death_gamble: 'Jackpot odds on unkillable HP and pinned cursed energy.',
  self_embodiment_of_perfection: 'Permanently cuts 25% off the enemy maximum HP.',
  coffin_of_the_iron_mountain: 'Burns the enemy for 3 turns and seals 2 of their cards.',
  deadly_sentencing: 'Puts the enemy on a 4-round trial. Each wrong guess seals one of their cards.',
};

/** Reads the four-state domain status out of a player, live. */
export function domainStatusOf(player: PlayerState | PublicPlayerView): DomainStatusData {
  const nullified = player.activeEffects.find((effect) => effect.kind === STATUS_KIND.DOMAIN_NULLIFIED);

  if (player.activeDomain) {
    const domain = DOMAINS[player.activeDomain.domainId];
    return {
      isActive: true,
      type: 'DOMAIN',
      name: domain.name,
      turnsRemaining: player.activeDomain.turnsRemaining,
      isNeutralized: nullified !== undefined,
      neutralizedTurnsRemaining: nullified?.turnsRemaining ?? 0,
      sureHitDescription: DOMAIN_SURE_HIT[player.activeDomain.domainId] ?? null,
    };
  }

  if (player.activeSimpleDomain) {
    return {
      isActive: true,
      type: 'SIMPLE_DOMAIN',
      name: ULTIMATES[player.activeSimpleDomain.ultimateId].name,
      turnsRemaining: player.activeSimpleDomain.turnsRemaining,
      isNeutralized: false,
      neutralizedTurnsRemaining: 0,
      sureHitDescription: null,
    };
  }

  return {
    isActive: false,
    type: 'NONE',
    name: '',
    turnsRemaining: 0,
    isNeutralized: false,
    neutralizedTurnsRemaining: 0,
    sureHitDescription: null,
  };
}

/**
 * Renders the status into `container`, replacing whatever was there. Built from plain
 * nodes and CSS classes: this project ships no component framework.
 */
export function renderDomainStatus(container: HTMLElement, status: DomainStatusData, playerName: string): void {
  const state = !status.isActive || status.type === 'NONE'
    ? 'none'
    : status.type === 'DOMAIN'
      ? status.isNeutralized
        ? 'neutralized'
        : 'domain'
      : 'counter';

  // Rendering runs on every frame; the widget only rebuilds when the state it shows
  // actually changed, so a standing domain does not allocate 60 times a second.
  const key = `${state}|${status.name}|${status.turnsRemaining}|${status.neutralizedTurnsRemaining}|${playerName}`;
  if (container.dataset.key === key) return;
  container.dataset.key = key;

  const box = document.createElement('div');
  box.className = `domain-status domain-status--${state}`;
  box.dataset.state = state;
  container.replaceChildren(box);

  if (state === 'none') {
    const idle = document.createElement('span');
    idle.className = 'domain-status-idle';
    idle.textContent = 'No Domain Active';
    box.append(idle);
    return;
  }

  const head = document.createElement('div');
  head.className = 'domain-status-head';
  const glyph = document.createElement('span');
  glyph.className = 'domain-status-glyph';
  glyph.textContent = state === 'domain' ? '🔮' : state === 'neutralized' ? '⚠️' : '💠';
  const title = document.createElement('span');
  title.className = 'domain-status-name';
  title.textContent = state === 'neutralized' ? `${playerName}'s ${status.name}` : status.name;
  const turns = document.createElement('span');
  turns.className = 'domain-status-turns';
  turns.textContent =
    state === 'domain' ? `${status.turnsRemaining} Turn(s)` : `${status.turnsRemaining}T left`;
  head.append(glyph, title, turns);
  box.append(head);

  if (state === 'domain' && status.sureHitDescription !== null) {
    const line = document.createElement('p');
    line.className = 'domain-status-line';
    line.textContent = `Sure-Hit: ${status.sureHitDescription}`;
    box.append(line);
    return;
  }

  if (state === 'neutralized') {
    const foot = document.createElement('div');
    foot.className = 'domain-status-foot';
    const flag = document.createElement('span');
    flag.className = 'domain-status-flag';
    flag.textContent = '🛡️ [NEUTRALIZED]';
    const note = document.createElement('span');
    note.className = 'domain-status-line';
    note.textContent = `Sure-Hit Disabled (${status.neutralizedTurnsRemaining}T left)`;
    foot.append(flag, note);
    box.append(foot);
    return;
  }

  const line = document.createElement('p');
  line.className = 'domain-status-line';
  line.textContent = 'Anti-Domain Active: Nullifies enemy sure-hit effects.';
  box.append(line);
}

/** Tooltip copy for the widget, so a hover explains the state in words as well. */
export function domainStatusTitle(status: DomainStatusData): string {
  if (!status.isActive) return 'No domain is standing and no Simple Domain is armed.';
  if (status.type === 'SIMPLE_DOMAIN') {
    return `${status.name}: a ${ULTIMATE_TYPE.SIMPLE_DOMAIN_MAXIMUM} counter. Cancels an active enemy domain's sure-hit effects for ${status.turnsRemaining} more turn(s).`;
  }
  if (status.isNeutralized) {
    return `${status.name} is open but neutralized: its sure-hit field is disabled for ${status.neutralizedTurnsRemaining} more turn(s), and it collapses in ${status.turnsRemaining}.`;
  }
  return `${status.name}: sure-hit field active for ${status.turnsRemaining} more turn(s).`;
}
