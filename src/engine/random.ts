/** Source of uniformly distributed 32-bit unsigned integers. */
export interface RandomSource {
  nextUint32(): number;
}

/**
 * Deterministic PRNG (mulberry32). Same seed => same sequence. Not
 * cryptographically secure: use only for replays, tests and simulations.
 */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed | 0;
  return {
    nextUint32(): number {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    },
  };
}

/** Production source backed by the platform CSPRNG. */
export function createCryptoRandom(): RandomSource {
  const buffer = new Uint32Array(1);
  return {
    nextUint32(): number {
      globalThis.crypto.getRandomValues(buffer);
      return buffer[0] ?? 0;
    },
  };
}

/**
 * Uniform integer in [0, bound) using rejection sampling, avoiding the modulo
 * bias that a plain `nextUint32() % bound` would introduce.
 */
export function randomInt(rng: RandomSource, bound: number): number {
  if (!Number.isInteger(bound) || bound <= 0 || bound > 0x100000000) {
    throw new RangeError(`randomInt bound must be an integer in (0, 2^32], got ${bound}`);
  }
  const range = 0x100000000;
  const limit = range - (range % bound);
  let value: number;
  do {
    value = rng.nextUint32();
  } while (value >= limit);
  return value % bound;
}

/** Uniform float in [0, 1), built on the uniform integer helper. */
export function randomUnit(rng: RandomSource): number {
  return randomInt(rng, 1_000_000) / 1_000_000;
}

/** Returns a new array containing the items in uniformly random order. */
export function fisherYatesShuffle<T>(items: readonly T[], rng: RandomSource): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const current = out[i] as T;
    out[i] = out[j] as T;
    out[j] = current;
  }
  return out;
}
