import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, GAME_CONSTANTS, SUPPORTED_BOARD_SIZES, ULTIMATE_TYPE, ULTIMATES } from '../../src/engine/index.js';
import {
  characterEntries,
  describeEffect,
  describeEffects,
  domainSummary,
  fieldHazards,
  glossaryTerms,
  synergyEntries,
} from '../../src/web/guidebook.js';

/** Copy must never leak a half-built template. */
function expectReadable(text: string): void {
  expect(text.length).toBeGreaterThan(8);
  expect(text).not.toMatch(/undefined|NaN|\[object/);
}

describe('codex content', () => {
  it('describes every lore pair with its subjects, cue and bonus', () => {
    const entries = synergyEntries();
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.subjects).toHaveLength(2);
      expect(entry.vfx.length).toBeGreaterThan(20);
      expect(entry.bullets.length).toBeGreaterThan(0);
      expectReadable(entry.description);
      for (const bullet of entry.bullets) expectReadable(bullet);
    }

    const divineDog = entries.find((entry) => entry.id === 'divine_dog_pact');
    expect(divineDog?.subjects).toEqual(['Megumi Fushiguro', 'Divine Dog']);
    expect(divineDog?.bullets).toContain('Deals 10 damage to the enemy');
    // Bonus stats come from the engine, so the 7:3 blade must stay armor-piercing.
    const blade = entries.find((entry) => entry.id === 'seven_three_blade');
    expect(blade?.bullets.join(' ')).toContain('30 damage');
    expect(blade?.bullets.join(' ')).toContain('ignores shields');
  });

  it('lists all eleven fighters with a skill and a 100 CE ultimate (Hakari’s Gamble Turn costs 40 CE)', () => {
    const entries = characterEntries();
    expect(entries).toHaveLength(11);
    for (const entry of entries) {
      const expectedSkillCost =
        entry.id === 'kinji_hakari' ? GAME_CONSTANTS.GAMBLE_TURN_CE_COST : GAME_CONSTANTS.SKILL_CE_COST;
      expect(entry.skill.cost).toBe(expectedSkillCost);
      expect(entry.ultimate.cost).toBe(100);
      expect(entry.skill.badge).toBe(`Skill · ${expectedSkillCost} CE`);
      expect(entry.skill.tone).toBe('skill');
      expect(entry.skill.bullets.length).toBeGreaterThan(0);
      expect(entry.ultimate.bullets.length).toBeGreaterThan(0);
      expectReadable(entry.skill.description);
      expectReadable(entry.ultimate.description);
      // Every ability is described with real numbers, never a bare cost.
      for (const bullet of [...entry.skill.bullets, ...entry.ultimate.bullets]) expectReadable(bullet);
    }
  });

  it('labels each ultimate as a domain or as a counter, straight from the catalog', () => {
    const entries = characterEntries();
    for (const entry of entries) {
      const isDomain = entry.ultimate.badge.startsWith('Domain Expansion');
      expect(isDomain).toBe(entry.hasDomain);
      expect(entry.ultimate.tone).toBe(isDomain ? 'domain' : 'counter');
    }

    const gojo = entries.find((entry) => entry.id === 'satoru_gojo');
    expect(gojo?.hasDomain).toBe(true);
    expect(gojo?.ultimate.badge).toBe('Domain Expansion · Unlimited Void · 100 CE');
    const yuji = entries.find((entry) => entry.id === 'yuji_itadori');
    expect(yuji?.hasDomain).toBe(false);
    expect(yuji?.ultimate.badge).toBe('Simple Domain / Maximum · 100 CE');
  });

  it('splits the roster into seven domains and four counters', () => {
    const summary = domainSummary();
    expect(summary.domains).toHaveLength(7);
    expect(summary.counters).toHaveLength(4);
    expect(summary.counters).toEqual(['Yuji Itadori', 'Aoi Todo', 'Nobara Kugisaki', 'Kento Nanami']);
    expectReadable(summary.rule);
    expect(summary.rule).toContain('2 turns');
  });

  it('renders every effect of every ability and synergy as a sentence', () => {
    const texts = [
      ...characterEntries().flatMap((entry) => [...entry.skill.bullets, ...entry.ultimate.bullets]),
      ...synergyEntries().flatMap((entry) => entry.bullets),
    ];
    expect(texts.length).toBeGreaterThan(30);
    for (const text of texts) expectReadable(text);

    // A guard on the renderer itself: distinct effect kinds produce distinct prose,
    // and grids are named explicitly (turn-based dual play flips on your own grid).
    const openers = new Set(texts.map((text) => text.split(' ')[0]));
    expect(openers.size).toBeGreaterThan(3);
    expect(describeEffects([])).toEqual([]);
    expect(describeEffect({ kind: 'BOARD_SWAP', board: 'OPPONENT', count: 2 })).toContain("the enemy's grid");
    expect(describeEffect({ kind: 'SCOUT', board: 'OWN', pool: 'PAIR', count: 2, revealMs: 2000, cue: 'SKILL' })).toContain(
      'your grid',
    );
  });

  it('documents the traps and planted card modifiers', () => {
    const hazards = fieldHazards();
    expect(hazards).toHaveLength(5);
    const trap = hazards.find((hazard) => hazard.tone === 'trap');
    expect(trap?.name).toBe("Sukuna's Finger");
    expect(trap?.note).toContain('+30 CE');
    for (const hazard of hazards) expectReadable(hazard.note);
    expect(hazards.filter((hazard) => hazard.tone === 'planted')).toHaveLength(4);
  });

  it('documents pairing itself, including the repeated roster on the largest grid', () => {
    const terms = glossaryTerms();
    expect(terms.length).toBeGreaterThanOrEqual(6);
    for (const term of terms) {
      expect(term.name.length).toBeGreaterThan(3);
      expectReadable(term.body);
      expect(term.bullets.length).toBeGreaterThan(0);
      for (const bullet of term.bullets) expectReadable(bullet);
    }

    const pairs = terms.find((term) => term.id === 'pairs');
    expect(pairs).toBeDefined();
    const text = [pairs?.body, ...(pairs?.bullets ?? [])].join(' ');
    expect(text).toContain('same fighter');
    expect(text).toContain('interchangeable');
    // The numbers come from the engine, not from prose that can drift.
    expect(text).toContain(`${Math.max(...SUPPORTED_BOARD_SIZES)} card grid`);
    expect(text).toContain(`${Math.max(...SUPPORTED_BOARD_SIZES) / 2} pairs`);
    expect(text).toContain(`${CHARACTER_IDS.length} fighter roster`);
  });

  it('keeps the domain label consistent with the ultimate type in the catalog', () => {
    const domains = Object.values(ULTIMATES).filter((ultimate) => ultimate.type === ULTIMATE_TYPE.DOMAIN);
    expect(domains).toHaveLength(7);
    expect(domainSummary().domains).toHaveLength(domains.length);
  });

  it('documents both Board Clear modes and the three Awakening Surge blessings', () => {
    const awakening = glossaryTerms().find((term) => term.id === 'awakening');
    expect(awakening).toBeDefined();
    const text = [awakening?.body, ...(awakening?.bullets ?? [])].join(' ');
    expect(text).toContain('Manual choice');
    expect(text).toContain('Instant random');
    expect(text).toContain('3.5 seconds');
    expect(text).toContain('Latent Black Flash');
    expect(text).toContain('Sorcery Restoration');
    expect(text).toContain('Six Eyes Insight');
  });
});
