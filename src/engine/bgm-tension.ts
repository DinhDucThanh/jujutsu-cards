import type { PublicMatchView, PublicPlayerView } from './public-view.js';
import { STATUS_KIND } from './types.js';

/**
 * Which music the match deserves, as the player hears it.
 *
 * The audio engine lives in `src/utils/bgm.ts` and never sees the rules; this module is the
 * rule, kept beside the other presentation rules (`sound-cues.ts`) so a new win condition or
 * a new damage source cannot change the music by accident. The tier is read from public state
 * rather than announced by an event, because it is a *condition*, not a moment: a domain
 * expiring has to bring the music back down just as surely as casting one brings it up.
 */

/** Either fighter at or below this share of its own maximum is fighting for its life. */
export const BGM_TENSION_HP_FRACTION = 0.3;

/**
 * The priority tiers, highest first. The resolver returns the first one whose condition
 * holds, so a higher tier always preempts a lower one and only one of them ever plays.
 */
export const BGM_TIER = {
  /** 7-7-7 Idle Death Gamble jackpot: its immortality is running. Overrides everything. */
  JACKPOT_GOLDEN: 'JACKPOT_GOLDEN',
  /** Any other Idle Death Gamble jackpot whose immortality is running. */
  JACKPOT_REGULAR: 'JACKPOT_REGULAR',
  /** Higuruma's courtroom or the Idle Death Gamble slot is open. */
  MODAL_MINIGAME: 'MODAL_MINIGAME',
  /** A Domain Expansion is open on the board. */
  DOMAIN: 'DOMAIN',
  /** The acting player is at or below {@link BGM_TENSION_HP_FRACTION} of max HP. */
  LOW_HP: 'LOW_HP',
  /** Normal in-game combat. */
  BATTLE: 'BATTLE',
  /** Initial load, lobby, setup and the Sorcery Codex, plus a finished match. */
  MAIN_MENU: 'MAIN_MENU',
} as const;
export type BgmTier = (typeof BGM_TIER)[keyof typeof BGM_TIER];

/** The procedural tracks. Each tier maps onto one of them; the modal tier picks by modal. */
export const OST_TRACK = {
  MENU_THEME: 'MENU_THEME',
  BATTLE_THEME: 'BATTLE_THEME',
  LOW_HP_THEME: 'LOW_HP_THEME',
  DOMAIN_GENERIC_THEME: 'DOMAIN_GENERIC_THEME',
  HIGURUMA_COURT_THEME: 'HIGURUMA_COURT_THEME',
  HAKARI_SPIN_THEME: 'HAKARI_SPIN_THEME',
  JACKPOT_REGULAR_THEME: 'JACKPOT_REGULAR_THEME',
  JACKPOT_GOLDEN_THEME: 'JACKPOT_GOLDEN_THEME',
} as const;
export type OstTrack = (typeof OST_TRACK)[keyof typeof OST_TRACK];

/** Which modal minigame, if any, is on screen. */
export type BgmModal = 'COURTROOM' | 'SLOT' | null;

/** Scene facts the public match view does not carry: the menus and the open modal. */
export interface BgmSceneInput {
  /** True while the setup screen, lobby, or Sorcery Codex is the thing on screen. */
  readonly menu: boolean;
  readonly modal: BgmModal;
}

/** True when `hp` is at or below {@link BGM_TENSION_HP_FRACTION} of `maxHp`. */
export function isLowHealth(hp: number, maxHp: number): boolean {
  if (maxHp <= 0) return false;
  return hp <= maxHp * BGM_TENSION_HP_FRACTION;
}

function isFevered(player: PublicPlayerView): boolean {
  return player.activeEffects.some((effect) => effect.kind === STATUS_KIND.IMMORTAL);
}

/** The jackpot kind whose immortality this player is still under, if any. */
function activeJackpot(player: PublicPlayerView): 'REGULAR' | 'GOLDEN' | 'SUPREME' | undefined {
  return isFevered(player) ? player.pachinko.jackpot : undefined;
}

/**
 * The tier a match deserves. A finished match, or no match at all, is the main menu: the
 * result screen wants a quiet sting, not a combat loop still driving at the loser.
 */
export function resolveBgmTier(view: PublicMatchView | null, scene: BgmSceneInput): BgmTier {
  if (view === null || view.result !== null) return BGM_TIER.MAIN_MENU;
  const jackpots = view.players.map(activeJackpot);
  if (jackpots.includes('SUPREME')) return BGM_TIER.JACKPOT_GOLDEN;
  if (jackpots.some((jackpot) => jackpot !== undefined)) return BGM_TIER.JACKPOT_REGULAR;
  if (scene.modal !== null || view.sentencing !== null) return BGM_TIER.MODAL_MINIGAME;
  if (view.players.some((player) => player.activeDomain !== null)) return BGM_TIER.DOMAIN;
  if (actingPlayers(view).some((player) => isLowHealth(player.hp, player.maxHp))) return BGM_TIER.LOW_HP;
  if (scene.menu) return BGM_TIER.MAIN_MENU;
  return BGM_TIER.BATTLE;
}

/** The player whose turn it is when the mode has one; every player in DUAL, where both act. */
function actingPlayers(view: PublicMatchView): readonly PublicPlayerView[] {
  if (view.turnOwner === null) return view.players;
  return view.players.filter((player) => player.id === view.turnOwner);
}

/** The track a tier plays. The modal tier plays the slot's spin theme or the courtroom theme. */
export function trackForTier(tier: BgmTier, modal: BgmModal = null): OstTrack {
  switch (tier) {
    case BGM_TIER.JACKPOT_GOLDEN:
      return OST_TRACK.JACKPOT_GOLDEN_THEME;
    case BGM_TIER.JACKPOT_REGULAR:
      return OST_TRACK.JACKPOT_REGULAR_THEME;
    case BGM_TIER.MODAL_MINIGAME:
      return modal === 'SLOT' ? OST_TRACK.HAKARI_SPIN_THEME : OST_TRACK.HIGURUMA_COURT_THEME;
    case BGM_TIER.DOMAIN:
      return OST_TRACK.DOMAIN_GENERIC_THEME;
    case BGM_TIER.LOW_HP:
      return OST_TRACK.LOW_HP_THEME;
    case BGM_TIER.BATTLE:
      return OST_TRACK.BATTLE_THEME;
    case BGM_TIER.MAIN_MENU:
      return OST_TRACK.MENU_THEME;
  }
}

/** The track for a public view and scene: the one call the audio engine needs. */
export function bgmTrackFor(view: PublicMatchView | null, scene: BgmSceneInput): OstTrack {
  return trackForTier(resolveBgmTier(view, scene), scene.modal);
}
