import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS } from '../../src/engine/index.js';
import type { CardSubjectId } from '../../src/engine/index.js';
import {
  CARD_VISUALS,
  TRAP_ICON,
  cardIconFor,
  cardIconKeys,
  isCardIconKey,
  renderCardIcon,
  type CardIconKey,
} from '../../src/web/card-icons.js';

const ALL_SUBJECTS = Object.keys(CARD_VISUALS) as CardSubjectId[];

/** Every emblem a subject can wear, pair or synergy, so the mapping can be checked whole. */
function referencedIcons(): CardIconKey[] {
  const keys: CardIconKey[] = [];
  for (const visual of Object.values(CARD_VISUALS)) {
    if (visual.pairIcon !== null) keys.push(visual.pairIcon);
    if (visual.synergyIcon !== null) keys.push(visual.synergyIcon);
  }
  keys.push(...Object.values(TRAP_ICON));
  return keys;
}

describe('card icon registry', () => {
  it('renders each registered icon as a 100-unit inline SVG', () => {
    for (const key of cardIconKeys()) {
      const svg = renderCardIcon(key);
      expect(svg, key).toMatch(/^<svg [^>]*viewBox="0 0 100 100"/);
      expect(svg, key).toMatch(/<\/svg>$/);
    }
  });

  it('registers the 11 pair emblems, the 8 synergy halves and the trap emblem', () => {
    const keys = cardIconKeys();
    expect(keys).toHaveLength(20);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('draws nothing for an unknown key, so a typo cannot inject markup', () => {
    expect(renderCardIcon('not_an_icon')).toBe('');
    expect(renderCardIcon('__proto__')).toBe('');
    expect(isCardIconKey('constructor')).toBe(false);
  });

  it('gives every icon a distinct drawing', () => {
    const bodies = cardIconKeys().map((key) => renderCardIcon(key));
    expect(new Set(bodies).size).toBe(bodies.length);
  });
});

describe('subject emblem mapping', () => {
  it('maps every standard fighter to its own pair emblem', () => {
    const pairIcons = CHARACTER_IDS.map((id) => CARD_VISUALS[id].pairIcon);
    for (const icon of pairIcons) expect(icon).not.toBeNull();
    expect(new Set(pairIcons).size).toBe(CHARACTER_IDS.length);
  });

  it('only references icons that exist in the registry', () => {
    for (const icon of referencedIcons()) {
      expect(isCardIconKey(icon), icon).toBe(true);
    }
  });

  it('uses all 20 registered icons across the mapping', () => {
    expect(new Set(referencedIcons())).toEqual(new Set(cardIconKeys()));
  });

  it('gives a synergy card its synergy half and a pair card its pair emblem', () => {
    expect(cardIconFor('aoi_todo', true)).toBe('synergy_todo_rock');
    expect(cardIconFor('aoi_todo', false)).toBe('todo');
    expect(cardIconFor('kento_nanami', true)).toBe('synergy_nanami_blade');
  });

  it('falls back to the synergy emblem for subjects that only exist in a synergy', () => {
    expect(cardIconFor('divine_dog', false)).toBe('synergy_megumi_dog');
    expect(cardIconFor('ratio_blade', false)).toBe('synergy_nanami_ratio');
    expect(cardIconFor('six_eyes', false)).toBe('synergy_gojo_sixeyes');
  });

  it('shows the pair emblem on a synergy card for a fighter with no synergy half', () => {
    expect(cardIconFor('sukuna', true)).toBe('sukuna');
  });

  it('keeps every subject in the single source table', () => {
    for (const id of CHARACTER_IDS) expect(ALL_SUBJECTS).toContain(id);
    expect(ALL_SUBJECTS).toEqual(expect.arrayContaining(['divine_dog', 'ratio_blade', 'six_eyes']));
  });
});

describe('subject accents', () => {
  it('keeps Mahito and Aoi Todo visibly apart', () => {
    expect(CARD_VISUALS.mahito.accent).not.toBe(CARD_VISUALS.aoi_todo.accent);
  });

  it('gives every subject a hex accent colour', () => {
    for (const id of ALL_SUBJECTS) {
      expect(CARD_VISUALS[id].accent, id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
