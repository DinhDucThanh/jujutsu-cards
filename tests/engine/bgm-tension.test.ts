import { describe, expect, it } from 'vitest';
import {
  BGM_TENSION_HP_FRACTION,
  BGM_TIER,
  OST_TRACK,
  bgmTrackFor,
  isLowHealth,
  resolveBgmTier,
  trackForTier,
} from '../../src/engine/bgm-tension.js';
import type { PublicMatchView, PublicPlayerView } from '../../src/engine/public-view.js';
import { STATUS_KIND } from '../../src/engine/types.js';

interface PlayerSpec {
  readonly id?: string;
  readonly hp?: number;
  readonly maxHp?: number;
  readonly domain?: boolean;
  readonly immortal?: boolean;
  /** The jackpot kind the player's immortality came from; only meaningful with `immortal`. */
  readonly jackpot?: 'REGULAR' | 'GOLDEN' | 'SUPREME';
}

function player(spec: PlayerSpec = {}): PublicPlayerView {
  return {
    id: spec.id ?? 'p1',
    hp: spec.hp ?? 100,
    maxHp: spec.maxHp ?? 100,
    activeDomain: spec.domain ? { name: 'Unlimited Void' } : null,
    activeEffects: spec.immortal ? [{ kind: STATUS_KIND.IMMORTAL }] : [],
    pachinko: { jackpot: spec.jackpot },
  } as unknown as PublicPlayerView;
}

function view(
  players: readonly PublicPlayerView[],
  extra: { turnOwner?: string | null; result?: unknown; sentencing?: unknown } = {},
): PublicMatchView {
  return {
    players,
    turnOwner: extra.turnOwner === undefined ? players[0]?.id ?? null : extra.turnOwner,
    result: extra.result ?? null,
    sentencing: extra.sentencing ?? null,
  } as unknown as PublicMatchView;
}

const IDLE = { menu: false, modal: null } as const;

describe('isLowHealth', () => {
  it('uses the 30% boundary, inclusive', () => {
    expect(BGM_TENSION_HP_FRACTION).toBe(0.3);
    expect(isLowHealth(30, 100)).toBe(true);
    expect(isLowHealth(31, 100)).toBe(false);
    expect(isLowHealth(0, 100)).toBe(true);
  });

  it('is never low when there is no maximum to compare against', () => {
    expect(isLowHealth(0, 0)).toBe(false);
  });
});

describe('resolveBgmTier', () => {
  it('is the main menu with no match, or once the match has a result', () => {
    expect(resolveBgmTier(null, IDLE)).toBe(BGM_TIER.MAIN_MENU);
    expect(resolveBgmTier(view([player()], { result: { winner: 'p1' } }), IDLE)).toBe(BGM_TIER.MAIN_MENU);
  });

  it('is the main menu while the setup screen or codex is showing', () => {
    expect(resolveBgmTier(view([player(), player({ id: 'p2' })]), { menu: true, modal: null })).toBe(
      BGM_TIER.MAIN_MENU,
    );
  });

  it('is battle in normal combat', () => {
    expect(resolveBgmTier(view([player(), player({ id: 'p2' })]), IDLE)).toBe(BGM_TIER.BATTLE);
  });

  it('is low HP when the acting player is at or below 30%', () => {
    const acting = view([player({ hp: 30 }), player({ id: 'p2' })]);
    expect(resolveBgmTier(acting, IDLE)).toBe(BGM_TIER.LOW_HP);
  });

  it('ignores low HP on the player who is not acting', () => {
    const waiting = view([player(), player({ id: 'p2', hp: 10 })], { turnOwner: 'p1' });
    expect(resolveBgmTier(waiting, IDLE)).toBe(BGM_TIER.BATTLE);
  });

  it('counts both fighters as acting when there is no turn owner', () => {
    const shared = view([player(), player({ id: 'p2', hp: 10 })], { turnOwner: null });
    expect(resolveBgmTier(shared, IDLE)).toBe(BGM_TIER.LOW_HP);
  });

  it('is a domain when a domain expansion is active on the board', () => {
    expect(resolveBgmTier(view([player({ domain: true }), player({ id: 'p2' })]), IDLE)).toBe(BGM_TIER.DOMAIN);
  });

  it('is the modal minigame while a modal is open or a sentencing is running', () => {
    expect(resolveBgmTier(view([player()]), { menu: false, modal: 'COURTROOM' })).toBe(BGM_TIER.MODAL_MINIGAME);
    expect(resolveBgmTier(view([player()], { sentencing: { victimId: 'p2' } }), IDLE)).toBe(
      BGM_TIER.MODAL_MINIGAME,
    );
  });

  it('is the regular jackpot while a regular jackpot immortality is active, above the modal', () => {
    const fever = view([player({ immortal: true, jackpot: 'REGULAR' }), player({ id: 'p2', hp: 5, domain: true })]);
    expect(resolveBgmTier(fever, { menu: false, modal: 'SLOT' })).toBe(BGM_TIER.JACKPOT_REGULAR);
  });

  it('is the golden jackpot while a 7-7-7 immortality is active, above every other tier', () => {
    const golden = view([player({ immortal: true, jackpot: 'SUPREME' }), player({ id: 'p2', hp: 5, domain: true })]);
    expect(resolveBgmTier(golden, { menu: false, modal: 'COURTROOM' })).toBe(BGM_TIER.JACKPOT_GOLDEN);
  });

  it('drops the jackpot tier once its immortality has ended', () => {
    const lapsed = view([player({ jackpot: 'SUPREME' })]);
    expect(resolveBgmTier(lapsed, IDLE)).toBe(BGM_TIER.BATTLE);
  });

  it('prefers the modal minigame over a domain and low HP', () => {
    const crowded = view([player({ hp: 5, domain: true })], { sentencing: { victimId: 'p2' } });
    expect(resolveBgmTier(crowded, IDLE)).toBe(BGM_TIER.MODAL_MINIGAME);
  });

  it('prefers a domain over low HP', () => {
    expect(resolveBgmTier(view([player({ hp: 5, domain: true })]), IDLE)).toBe(BGM_TIER.DOMAIN);
  });
});

describe('trackForTier', () => {
  it('maps each tier onto its track', () => {
    expect(trackForTier(BGM_TIER.JACKPOT_GOLDEN)).toBe(OST_TRACK.JACKPOT_GOLDEN_THEME);
    expect(trackForTier(BGM_TIER.JACKPOT_REGULAR)).toBe(OST_TRACK.JACKPOT_REGULAR_THEME);
    expect(trackForTier(BGM_TIER.DOMAIN)).toBe(OST_TRACK.DOMAIN_GENERIC_THEME);
    expect(trackForTier(BGM_TIER.LOW_HP)).toBe(OST_TRACK.LOW_HP_THEME);
    expect(trackForTier(BGM_TIER.BATTLE)).toBe(OST_TRACK.BATTLE_THEME);
    expect(trackForTier(BGM_TIER.MAIN_MENU)).toBe(OST_TRACK.MENU_THEME);
  });

  it('plays the courtroom theme for the courtroom and the spin theme for the slot', () => {
    expect(trackForTier(BGM_TIER.MODAL_MINIGAME, 'COURTROOM')).toBe(OST_TRACK.HIGURUMA_COURT_THEME);
    expect(trackForTier(BGM_TIER.MODAL_MINIGAME, 'SLOT')).toBe(OST_TRACK.HAKARI_SPIN_THEME);
  });
});

describe('bgmTrackFor', () => {
  it('goes from battle to low HP and back as the acting fighter is hurt and heals', () => {
    expect(bgmTrackFor(view([player()]), IDLE)).toBe(OST_TRACK.BATTLE_THEME);
    expect(bgmTrackFor(view([player({ hp: 30 })]), IDLE)).toBe(OST_TRACK.LOW_HP_THEME);
    expect(bgmTrackFor(view([player({ hp: 31 })]), IDLE)).toBe(OST_TRACK.BATTLE_THEME);
  });

  it('returns to the menu theme once the match is over', () => {
    expect(bgmTrackFor(null, IDLE)).toBe(OST_TRACK.MENU_THEME);
  });
});
