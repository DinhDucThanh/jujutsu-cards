import { GAME_CONSTANTS, GAME_PACING } from './constants.js';
import {
  STATUS_KIND,
  type AbilityEffect,
  type CardSubjectId,
  type CharacterId,
  type DomainId,
  type SkillId,
  type SynergyId,
  type TrapId,
  type UltimateId,
  type VfxCue,
} from './types.js';

/**
 * A transformed form that swaps the fighter's skill slot while it lasts. The engine does the
 * swap itself; the codex uses this to show the second skill beside the base one.
 */
export interface CharacterStance {
  readonly stanceName: string;
  readonly stanceBadge: string;
  readonly skillId: SkillId;
  /** Codex copy for the stance's skill. Written by hand, since the skill's own effects are placeholders. */
  readonly bullets: readonly string[];
}

export interface CharacterDefinition {
  readonly id: CharacterId;
  readonly name: string;
  /** Short flavour line shown on the setup screen. */
  readonly title: string;
  readonly skillId: SkillId;
  readonly ultimateId: UltimateId;
  /** Alternate skill forms, shown as switchable stances in the codex. */
  readonly alternateStances?: readonly CharacterStance[];
}

export interface DomainDefinition {
  readonly id: DomainId;
  readonly name: string;
  readonly ownerId: CharacterId;
}

export interface TrapDefinition {
  readonly id: TrapId;
  readonly name: string;
  /**
   * Short title printed on the card face. The codex uses `name` ("Sukuna's Finger"),
   * the card uses this ("Finger"), so the trap reads as an object rather than as the
   * fighter whose card it happens to be.
   */
  readonly cardTitle: string;
  readonly subject: CardSubjectId;
  readonly cursedEnergyGain: number;
}

export interface SynergyDefinition {
  readonly id: SynergyId;
  readonly name: string;
  readonly subjects: readonly [CardSubjectId, CardSubjectId];
  readonly vfx: VfxCue;
  readonly description: string;
  readonly effects: readonly AbilityEffect[];
}

export const DOMAINS: Readonly<Record<DomainId, DomainDefinition>> = {
  unlimited_void: { id: 'unlimited_void', name: 'Unlimited Void', ownerId: 'satoru_gojo' },
  malevolent_shrine: { id: 'malevolent_shrine', name: 'Malevolent Shrine', ownerId: 'sukuna' },
  chimera_shadow_garden: { id: 'chimera_shadow_garden', name: 'Chimera Shadow Garden', ownerId: 'megumi_fushiguro' },
  idle_death_gamble: { id: 'idle_death_gamble', name: 'Idle Death Gamble', ownerId: 'kinji_hakari' },
  self_embodiment_of_perfection: {
    id: 'self_embodiment_of_perfection',
    name: 'Self-Embodiment of Perfection',
    ownerId: 'mahito',
  },
  coffin_of_the_iron_mountain: {
    id: 'coffin_of_the_iron_mountain',
    name: 'Coffin of the Iron Mountain',
    ownerId: 'jogo',
  },
  deadly_sentencing: {
    id: 'deadly_sentencing',
    name: 'Deadly Sentencing',
    ownerId: 'higuruma',
  },
};

export const CHARACTERS: Readonly<Record<CharacterId, CharacterDefinition>> = {
  yuji_itadori: {
    id: 'yuji_itadori',
    name: 'Yuji Itadori',
    title: 'Divergent Fist / Simple Domain',
    skillId: 'divergent_fist',
    ultimateId: 'soul_strike',
  },
  aoi_todo: {
    id: 'aoi_todo',
    name: 'Aoi Todo',
    title: 'Boogie Woogie / 120% Potential',
    skillId: 'boogie_woogie',
    ultimateId: 'potential_120',
  },
  nobara_kugisaki: {
    id: 'nobara_kugisaki',
    name: 'Nobara Kugisaki',
    title: 'Straw Doll Technique',
    skillId: 'hairpin',
    ultimateId: 'resonance_burst',
  },
  mahito: {
    id: 'mahito',
    name: 'Mahito',
    title: 'Idle Transfiguration',
    skillId: 'idle_transfiguration',
    ultimateId: 'self_embodiment_of_perfection',
  },
  kento_nanami: {
    id: 'kento_nanami',
    name: 'Kento Nanami',
    title: '7:3 Ratio',
    skillId: 'critical_ratio',
    ultimateId: 'overtime_collapse',
  },
  jogo: {
    id: 'jogo',
    name: 'Jogo',
    title: 'Disaster Flames / Seal Absorption',
    skillId: 'ember_insects',
    ultimateId: 'coffin_of_the_iron_mountain',
  },
  satoru_gojo: {
    id: 'satoru_gojo',
    name: 'Satoru Gojo',
    title: 'Limitless',
    skillId: 'infinity',
    ultimateId: 'unlimited_void',
  },
  sukuna: {
    id: 'sukuna',
    name: 'Ryomen Sukuna',
    title: 'King of Curses',
    skillId: 'cleave',
    ultimateId: 'malevolent_shrine',
  },
  megumi_fushiguro: {
    id: 'megumi_fushiguro',
    name: 'Megumi Fushiguro',
    title: 'Ten Shadows Technique',
    skillId: 'ten_shadows_nue',
    ultimateId: 'chimera_shadow_garden',
  },
  kinji_hakari: {
    id: 'kinji_hakari',
    name: 'Kinji Hakari',
    title: 'Idle Death Gamble',
    skillId: 'gamble_turn',
    ultimateId: 'idle_death_gamble',
  },
  higuruma: {
    id: 'higuruma',
    name: 'Hiromi Higuruma',
    title: 'Gavel Strike / Deadly Sentencing',
    skillId: 'gavel_strike',
    ultimateId: 'deadly_sentencing',
    alternateStances: [
      {
        stanceName: "Executioner's Stance",
        stanceBadge: "🗡️ EXECUTIONER'S SWORD",
        skillId: 'executioners_sword',
        bullets: [
          'True damage that ignores barriers: 25 / 35 / 45 / 55 by the trial mistakes (1 to 4).',
          `Lasts ${GAME_CONSTANTS.EXECUTIONER_TURNS} turns, then the sword fades.`,
          'Cursed energy is wiped when the sword fades, so it cannot chain into a domain.',
        ],
      },
    ],
  },
};

export const TRAPS: Readonly<Record<TrapId, TrapDefinition>> = {
  sukuna_finger: {
    id: 'sukuna_finger',
    name: "Sukuna's Finger",
    cardTitle: 'Finger',
    subject: 'sukuna',
    cursedEnergyGain: 30,
  },
};

/** Matched lore pairs. Each one fires its VFX cue and its bonus effect. */
export const SYNERGIES: Readonly<Record<SynergyId, SynergyDefinition>> = {
  divine_dog_pact: {
    id: 'divine_dog_pact',
    name: 'Divine Dog Pact',
    subjects: ['megumi_fushiguro', 'divine_dog'],
    vfx: 'CLAW',
    description: 'Divine Dog rakes the screen: +10 damage and a random matching pair revealed for 2s.',
    effects: [
      { kind: 'DAMAGE', target: 'OPPONENT', amount: 10, piercing: false },
      {
        kind: 'SCOUT',
        board: 'OWN',
        pool: 'PAIR',
        count: 2,
        revealMs: GAME_PACING.CARD_PEEK_REVEAL_DURATION_MS,
        cue: 'CLAW',
      },
    ],
  },
  seven_three_blade: {
    id: 'seven_three_blade',
    name: '7:3 Ratio Blade',
    subjects: ['kento_nanami', 'ratio_blade'],
    vfx: 'RATIO',
    description: 'A precise 7:3 cut: 30 armor-piercing damage that ignores barriers.',
    effects: [{ kind: 'DAMAGE', target: 'OPPONENT', amount: 30, piercing: true }],
  },
  brotherhood_barrage: {
    id: 'brotherhood_barrage',
    name: 'Brotherhood Sync',
    subjects: ['yuji_itadori', 'aoi_todo'],
    vfx: 'CLASH',
    description: 'A twin cursed-energy clap: refunds 25 CE and widens the Black Flash window.',
    effects: [
      { kind: 'CE_GAIN', amount: 25 },
      { kind: 'STATUS', target: 'SELF', spec: { status: STATUS_KIND.FLASH_WINDOW, value: 1, turns: 1 } },
    ],
  },
  six_eyes_vision: {
    id: 'six_eyes_vision',
    name: 'Six Eyes',
    subjects: ['satoru_gojo', 'six_eyes'],
    vfx: 'SIX_EYES',
    description: 'Six Eyes read the whole field: every face-down card is revealed for 3s.',
    effects: [
      {
        kind: 'SCOUT',
        board: 'OWN',
        pool: 'ALL',
        count: 0,
        revealMs: GAME_PACING.SKILL_CARD_REVEAL_DURATION_MS,
        cue: 'SIX_EYES',
      },
    ],
  },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS) as CharacterId[];
export const SYNERGY_IDS = Object.keys(SYNERGIES) as SynergyId[];

/** Pair id prefix used for synergy pairs when a board is dealt. */
export const SYNERGY_PAIR_PREFIX = 'syn:';

export function isCharacterId(value: string): value is CharacterId {
  return Object.hasOwn(CHARACTERS, value);
}

/** Resolves the lore synergy behind a `syn:<id>` pair id, if the pair is a synergy pair. */
export function synergyByPairId(pairId: string): SynergyDefinition | null {
  if (!pairId.startsWith(SYNERGY_PAIR_PREFIX)) return null;
  const id = pairId.slice(SYNERGY_PAIR_PREFIX.length);
  return Object.hasOwn(SYNERGIES, id) ? (SYNERGIES[id as SynergyId] ?? null) : null;
}
