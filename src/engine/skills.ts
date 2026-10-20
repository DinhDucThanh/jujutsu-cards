import { GAME_CONSTANTS, GAME_PACING } from './constants.js';
import {
  CARD_EFFECT_KIND,
  STATUS_KIND,
  ULTIMATE_TYPE,
  type AbilityEffect,
  type SkillDefinition,
  type SkillId,
  type StatusSpec,
  type UltimateDefinition,
  type UltimateId,
} from './types.js';

const S = STATUS_KIND;

/**
 * Barrier grant shared by every Simple Domain / Maximum Technique. It is a one-shot
 * grant: the engine banks the points in `PlayerState.shield` (capped at half of the
 * caster's max HP) instead of storing a lasting status.
 */
function barrier(): StatusSpec {
  return { status: S.SHIELD, value: GAME_CONSTANTS.SHIELD_GRANT, turns: null };
}

/**
 * Active skills: 50 CE each. `effects` is the data contract the engine interprets,
 * so the UI can show names, costs and descriptions without duplicating any rules.
 *
 * Duration convention: `turns` counts the owner's own turn ends, so an effect that
 * must outlive the turn it was cast on (a shield, a seal, corrupted cards) needs 2
 * to cover the opponent's next turn.
 */
export const SKILLS: Readonly<Record<SkillId, SkillDefinition>> = {
  divergent_fist: {
    id: 'divergent_fist',
    name: 'Divergent Fist',
    characterId: 'yuji_itadori',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'True damage: 25 that bypasses enemy barriers. While Soul Strike is active it becomes Soul Divergent Strike.',
    effects: [
      {
        kind: 'DAMAGE',
        target: 'OPPONENT',
        amount: GAME_CONSTANTS.DIVERGENT_FIST_TRUE_DAMAGE,
        piercing: true,
      },
    ],
  },
  boogie_woogie: {
    id: 'boogie_woogie',
    name: 'Boogie Woogie',
    characterId: 'aoi_todo',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'Swaps the grid coordinates of 2 random face-down cards on the enemy grid.',
    effects: [{ kind: 'BOARD_SWAP', board: 'OPPONENT', count: 2 }],
  },
  hairpin: {
    id: 'hairpin',
    name: 'Hairpin',
    characterId: 'nobara_kugisaki',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'Detonates a face-down enemy card for 10 damage, shows it, and plants a cursed nail.',
    effects: [
      { kind: 'DETONATE_CARD', board: 'OPPONENT', damage: 10, revealMs: GAME_PACING.CARD_DETONATION_REVEAL_MS },
      {
        kind: 'PLANT_MODIFIER',
        board: 'OPPONENT',
        modifier: CARD_EFFECT_KIND.NAILED,
        count: 1,
        turnsRemaining: null,
      },
    ],
  },
  critical_ratio: {
    id: 'critical_ratio',
    name: '7:3 Ratio',
    characterId: 'kento_nanami',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'Your next successful match is a 2.5x critical that cuts straight through enemy barriers.',
    effects: [
      {
        kind: 'STATUS',
        target: 'SELF',
        spec: { status: S.CRITICAL_STRIKE, value: GAME_CONSTANTS.CRITICAL_STRIKE_MULTIPLIER, turns: 1 },
      },
      // Armor pierce: the Ratio cut finds the weak point, so the barrier does not soak it.
      { kind: 'STATUS', target: 'SELF', spec: { status: S.PIERCING_ATTACKS, value: 1, turns: 1 } },
    ],
  },
  infinity: {
    id: 'infinity',
    name: 'Infinity',
    characterId: 'satoru_gojo',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'An absolute shield that negates all incoming damage and debuffs for one turn.',
    effects: [{ kind: 'STATUS', target: 'SELF', spec: { status: S.ABSOLUTE_SHIELD, value: 1, turns: 2 } }],
  },
  cleave: {
    id: 'cleave',
    name: 'Cleave',
    characterId: 'sukuna',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: "A ranged slash for 25% of the target's CURRENT HP that never touches the cards.",
    effects: [
      {
        kind: 'DAMAGE',
        target: 'OPPONENT',
        amount: 0,
        piercing: false,
        currentHpFraction: GAME_CONSTANTS.CLEAVE_CURRENT_HP_FRACTION,
      },
    ],
  },
  ten_shadows_nue: {
    id: 'ten_shadows_nue',
    name: 'Ten Shadows: Nue',
    characterId: 'megumi_fushiguro',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'Reveals 2 random face-down cards for 2s.',
    effects: [
      {
        kind: 'SCOUT',
        board: 'OWN',
        pool: 'HIDDEN',
        count: 2,
        revealMs: GAME_PACING.CARD_PEEK_REVEAL_DURATION_MS,
        cue: 'SKILL',
      },
    ],
  },
  idle_transfiguration: {
    id: 'idle_transfiguration',
    name: 'Idle Transfiguration',
    characterId: 'mahito',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'Corrupts 3 enemy cards with transfigured flesh, hiding their real faces for a turn.',
    effects: [
      {
        kind: 'PLANT_MODIFIER',
        board: 'OPPONENT',
        modifier: CARD_EFFECT_KIND.FLESH,
        count: 3,
        turnsRemaining: 2,
      },
    ],
  },
  ember_insects: {
    id: 'ember_insects',
    name: 'Ember Insects',
    characterId: 'jogo',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'Traps 2 enemy cards: flipping one explodes for 15 damage and drains 10 CE.',
    effects: [
      { kind: 'PLANT_MODIFIER', board: 'OPPONENT', modifier: CARD_EFFECT_KIND.LAVA, count: 2, turnsRemaining: null },
    ],
  },
  gamble_turn: {
    id: 'gamble_turn',
    name: 'Gamble Turn',
    characterId: 'kinji_hakari',
    cost: GAME_CONSTANTS.GAMBLE_TURN_CE_COST,
    description:
      'Your next match is a high-stakes gamble: a hit deals 2x damage, refunds 40 CE and grants a bonus flip; a miss costs 15% max HP and your turn.',
    effects: [{ kind: 'STATUS', target: 'SELF', spec: { status: S.GAMBLE_TURN, value: 1, turns: 1 } }],
  },
  gavel_strike: {
    id: 'gavel_strike',
    name: 'Gavel Strike',
    characterId: 'higuruma',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description: 'A sentence handed down: 10 damage that barriers soak, plus 10 piercing damage that they cannot.',
    effects: [
      { kind: 'DAMAGE', target: 'OPPONENT', amount: 10, piercing: false },
      { kind: 'DAMAGE', target: 'OPPONENT', amount: 10, piercing: true },
    ],
  },
  executioners_sword: {
    id: 'executioners_sword',
    name: "Executioner's Sword",
    characterId: 'higuruma',
    cost: GAME_CONSTANTS.SKILL_CE_COST,
    description:
      'Replaces Gavel Strike while the sentence lasts. True damage that ignores barriers, scaled by the trial mistakes (25 / 35 / 45 / 55).',
    // Placeholder amount: the engine swaps in the damage the trial actually earned.
    effects: [{ kind: 'DAMAGE', target: 'OPPONENT', amount: 25, piercing: true }],
  },
};

/**
 * Ultimates: 100 CE each. Domain users open a true Domain Expansion; Yuji, Todo,
 * Nobara, Nanami, Mahito's peers without a barrier use a Simple Domain / Maximum
 * Technique that neutralizes an enemy domain instead.
 */
export const ULTIMATES: Readonly<Record<UltimateId, UltimateDefinition>> = {
  soul_strike: {
    id: 'soul_strike',
    name: 'Simple Domain & Soul Strike',
    characterId: 'yuji_itadori',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.SIMPLE_DOMAIN_MAXIMUM,
    domainId: null,
    description:
      'Neutralizes an enemy domain and raises a barrier; your matches pierce barriers and Black Flash for 2 turns.',
    effects: [
      { kind: 'DOMAIN_COUNTER', turns: GAME_CONSTANTS.DOMAIN_COUNTER_TURNS },
      { kind: 'STATUS', target: 'SELF', spec: barrier() },
      { kind: 'STATUS', target: 'SELF', spec: { status: S.PIERCING_ATTACKS, value: 1, turns: 2 } },
      { kind: 'STATUS', target: 'SELF', spec: { status: S.SOUL_STRIKE, value: 1, turns: 2 } },
      { kind: 'STATUS', target: 'SELF', spec: { status: S.FLASH_WINDOW, value: 1, turns: 2 } },
    ],
  },
  potential_120: {
    id: 'potential_120',
    name: '120% Potential',
    characterId: 'aoi_todo',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.SIMPLE_DOMAIN_MAXIMUM,
    domainId: null,
    description:
      'Neutralizes an enemy domain, raises a barrier, and reveals a matching pair for 2 seconds.',
    effects: [
      { kind: 'DOMAIN_COUNTER', turns: GAME_CONSTANTS.DOMAIN_COUNTER_TURNS },
      { kind: 'STATUS', target: 'SELF', spec: barrier() },
      {
        kind: 'SCOUT',
        board: 'OWN',
        pool: 'PAIR',
        count: 2,
        revealMs: GAME_PACING.CARD_PEEK_REVEAL_DURATION_MS,
        cue: 'SIMPLE_DOMAIN',
      },
    ],
  },
  resonance_burst: {
    id: 'resonance_burst',
    name: 'Resonance Burst',
    characterId: 'nobara_kugisaki',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.SIMPLE_DOMAIN_MAXIMUM,
    domainId: null,
    description:
      'Neutralizes an enemy domain, raises a barrier, hits for 20, and deals 10 recoil per enemy mismatch for 2 turns.',
    effects: [
      { kind: 'DOMAIN_COUNTER', turns: GAME_CONSTANTS.DOMAIN_COUNTER_TURNS },
      { kind: 'STATUS', target: 'SELF', spec: barrier() },
      { kind: 'DAMAGE', target: 'OPPONENT', amount: 20, piercing: false },
      { kind: 'STATUS', target: 'OPPONENT', spec: { status: S.RESONANCE_RECOIL, value: 10, turns: 2 } },
    ],
  },
  overtime_collapse: {
    id: 'overtime_collapse',
    name: 'Overtime Collapse',
    characterId: 'kento_nanami',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.SIMPLE_DOMAIN_MAXIMUM,
    domainId: null,
    description:
      'Neutralizes an enemy domain, raises a barrier, resolves a matching pair, heals 15, and hits for 20.',
    effects: [
      { kind: 'DOMAIN_COUNTER', turns: GAME_CONSTANTS.DOMAIN_COUNTER_TURNS },
      { kind: 'STATUS', target: 'SELF', spec: barrier() },
      { kind: 'AUTO_MATCH_PAIRS', board: 'OWN', count: 1 },
      { kind: 'HEAL', amount: 15 },
      { kind: 'DAMAGE', target: 'OPPONENT', amount: 20, piercing: false },
    ],
  },
  deadly_sentencing: {
    id: 'deadly_sentencing',
    name: 'Deadly Sentencing',
    characterId: 'higuruma',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.DOMAIN,
    domainId: 'deadly_sentencing',
    description:
      'Domain Expansion: a 4-round courtroom trial. Find the named card among 4 shuffled face-down cards; each wrong pick seals a card on the enemy grid.',
    effects: [{ kind: 'COURTROOM_TRIAL', rounds: GAME_CONSTANTS.COURTROOM_ROUNDS }],
  },
  unlimited_void: {
    id: 'unlimited_void',
    name: 'Unlimited Void',
    characterId: 'satoru_gojo',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.DOMAIN,
    domainId: 'unlimited_void',
    description: 'Domain Expansion: the enemy loses their next turn and is rushed to a 5s turn after that.',
    effects: [
      { kind: 'STATUS', target: 'OPPONENT', spec: { status: S.SKIP_TURNS, value: 1, turns: null } },
      { kind: 'STATUS', target: 'OPPONENT', spec: { status: S.SHORT_TIMER, value: GAME_CONSTANTS.SHORT_TURN_TIME_MS, turns: 1 } },
    ],
  },
  malevolent_shrine: {
    id: 'malevolent_shrine',
    name: 'Malevolent Shrine',
    characterId: 'sukuna',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.DOMAIN,
    domainId: 'malevolent_shrine',
    description: 'Domain Expansion: cleaves 2 pairs off your grid and inflicts 10 bleed damage per turn for 2 turns.',
    effects: [
      { kind: 'AUTO_MATCH_PAIRS', board: 'OWN', count: 2 },
      { kind: 'STATUS', target: 'OPPONENT', spec: { status: S.DAMAGE_OVER_TIME, value: 10, turns: 2 } },
    ],
  },
  chimera_shadow_garden: {
    id: 'chimera_shadow_garden',
    name: 'Chimera Shadow Garden',
    characterId: 'megumi_fushiguro',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.DOMAIN,
    domainId: 'chimera_shadow_garden',
    description: 'Domain Expansion: for 2 turns you may open up to 3 cards per attempt.',
    effects: [{ kind: 'STATUS', target: 'SELF', spec: { status: S.EXTRA_FLIP, value: 1, turns: 2 } }],
  },
  self_embodiment_of_perfection: {
    id: 'self_embodiment_of_perfection',
    name: 'Self-Embodiment of Perfection',
    characterId: 'mahito',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.DOMAIN,
    domainId: 'self_embodiment_of_perfection',
    description: 'Domain Expansion: permanently lowers the enemy maximum HP by 25%.',
    effects: [
      {
        kind: 'MAX_HP_CUT',
        target: 'OPPONENT',
        fraction: GAME_CONSTANTS.SOUL_CUT_MAX_HP_FRACTION,
      },
    ],
  },
  coffin_of_the_iron_mountain: {
    id: 'coffin_of_the_iron_mountain',
    name: 'Coffin of the Iron Mountain',
    characterId: 'jogo',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.DOMAIN,
    domainId: 'coffin_of_the_iron_mountain',
    description: 'Domain Expansion: burns the enemy for 8 per turn over 3 turns and seals 2 of their cards.',
    effects: [
      { kind: 'STATUS', target: 'OPPONENT', spec: { status: S.DAMAGE_OVER_TIME, value: 8, turns: 3 } },
      {
        kind: 'PLANT_MODIFIER',
        board: 'OPPONENT',
        modifier: CARD_EFFECT_KIND.LOCKED,
        count: 2,
        turnsRemaining: 2,
      },
    ],
  },
  idle_death_gamble: {
    id: 'idle_death_gamble',
    name: 'Idle Death Gamble',
    characterId: 'kinji_hakari',
    cost: GAME_CONSTANTS.DOMAIN_CE_COST,
    type: ULTIMATE_TYPE.DOMAIN,
    domainId: 'idle_death_gamble',
    description:
      'Domain Expansion: a 3-spin pachinko slot. Triple odd numbers grant 2 turns of immortality with CE locked at max; triple even numbers or 7-7-7 grant 3 turns with +50% damage and a Domain reset; three misses cost 30% max HP.',
    effects: [{ kind: 'PACHINKO_OPEN', spins: GAME_CONSTANTS.PACHINKO_SPINS }],
  },
};

/**
 * Yuji's Soul Divergent Strike: what Divergent Fist becomes while Soul Strike is active.
 * Deals piercing damage equal to a share of the target's current HP, then heals the caster.
 */
export const SOUL_DIVERGENT_STRIKE_EFFECTS: readonly AbilityEffect[] = [
  {
    kind: 'DAMAGE',
    target: 'OPPONENT',
    amount: 0,
    piercing: true,
    currentHpFraction: GAME_CONSTANTS.SOUL_STRIKE_CURRENT_HP_FRACTION,
  },
  { kind: 'HEAL', amount: GAME_CONSTANTS.SOUL_STRIKE_HEAL },
];

export const SKILL_IDS = Object.keys(SKILLS) as SkillId[];
export const ULTIMATE_IDS = Object.keys(ULTIMATES) as UltimateId[];
