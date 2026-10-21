// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MOBILE_PARTICLES,
  MOBILE_MAX_WIDTH,
  createCueBurst,
  particleBudget,
} from '../../src/web/vfx.js';

/**
 * The particle ceiling drops with the screen. A phone fills and blends every particle each
 * frame while it is already compositing a blurred board, so thirty is the strict maximum
 * there; a desktop keeps the full budget.
 */
describe('particle budget', () => {
  const originalWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
  });

  it('caps a phone viewport at thirty particles and a desktop at forty-two', () => {
    expect(particleBudget(390)).toBe(MAX_MOBILE_PARTICLES);
    expect(particleBudget(MOBILE_MAX_WIDTH)).toBe(MAX_MOBILE_PARTICLES);
    expect(particleBudget(MOBILE_MAX_WIDTH + 1)).toBe(42);
    expect(particleBudget(1440)).toBe(42);
  });

  it('holds a real burst to the phone ceiling', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const burst = createCueBurst('CLASH', 800, 600);
    expect(burst.particles.length).toBeGreaterThan(0);
    expect(burst.particles.length).toBeLessThanOrEqual(MAX_MOBILE_PARTICLES);
  });

  it('keeps the fuller choreography on a desktop viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const phone = createCueBurst('CLASH', 800, 600).particles.length;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const desktop = createCueBurst('CLASH', 800, 600).particles.length;
    expect(phone).toBeLessThanOrEqual(MAX_MOBILE_PARTICLES);
    expect(desktop).toBeGreaterThan(phone);
    expect(desktop).toBeLessThanOrEqual(42);
  });
});
