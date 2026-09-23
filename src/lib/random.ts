/**
 * Deterministic pseudo-randomness.
 *
 * Transitions, effects and particle overlays all scatter things at random, but
 * the preview and the export must scatter them in exactly the same places —
 * otherwise a transition would "shuffle" between the canvas and the file. Every
 * one of those call sites therefore seeds an LCG from a stable string (the layer
 * id plus the effect's own seed), never from Math.random.
 */

/** FNV-1a. Turns "layer-3:in:glitch" into a stable 32-bit seed. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Numerical Recipes LCG. Returns a function producing 0..1. */
export function rngFor(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Convenience: a seeded generator from a string key. */
export const rngFrom = (key: string) => rngFor(hashSeed(key));
