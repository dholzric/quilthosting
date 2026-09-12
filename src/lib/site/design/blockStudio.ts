// The block studio.
//
// Every guild gets a quilt block of its own, drawn from its name. Two guilds
// that pick the same palette still get different sites — which is the thing
// 120 hand-authored kits never achieved, because every one of them varied only
// paint and any two guilds choosing the same kit got the same page.
//
// Deterministic, and that is the whole point: a guild's block must be THEIRS
// and must never change underneath them. Same name in, same block out, on
// every render, forever. So no Math.random, no Date, no counters — a hash of
// the name seeds a small PRNG and everything else falls out of that.
//
// Output is one repeatable SVG tile, the same shape patternSvg already
// returns, so the block flows through the plumbing that exists: pattern
// opacity, tile size, hero media, section grounds.

/** a = brand, b = dark/secondary, c = accent, d = page ground. */
export type BlockColors = { a: string; b: string; c: string; d: string };

/**
 * The unit a block is pieced from. These are the real ones — a quilter reading
 * the recipe should recognise every name on this list.
 */
export const BLOCK_UNITS = [
  "half-square",
  "quarter-square",
  "flying-goose",
  "square-in-square",
  "four-patch",
  "rail",
] as const;
export type BlockUnit = (typeof BLOCK_UNITS)[number];

export type BlockRecipe = {
  /** Units across and down. Quilt blocks are square, so one number. */
  grid: number;
  /** The unit this block is mostly pieced from. */
  unit: BlockUnit;
  /** Rotational symmetry applied to the quarter: 1 = none, 4 = pinwheel. */
  symmetry: 1 | 2 | 4;
  /** The hash the whole thing came from, for support and for tests. */
  seed: string;
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Colors land in an SVG attribute inside a CSS url() inside a style attribute. */
function safe(value: string, fallback = "#808080"): string {
  return HEX.test(value) ? value : fallback;
}

/** FNV-1a. Small, fast, and stable across engines — which matters here. */
export function seedOf(name: string): number {
  let h = 2166136261 >>> 0;
  const s = String(name || "").trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** xorshift32. Deterministic from the seed, which is the entire contract. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * What this guild's block is. Separated from the drawing so the admin can
 * show the recipe in words — "Flying geese, 5 × 5, pinwheel" — which is how a
 * quilter would describe it to another quilter.
 */
export function blockRecipe(name: string): BlockRecipe {
  const seed = seedOf(name);
  const r = rng(seed);
  // 4, 5 or 6 units across. Below 4 there is no block; above 6 it reads as
  // noise once it is scaled down to a background.
  const grid = 4 + (seed % 3);
  const unit = BLOCK_UNITS[Math.floor(r() * BLOCK_UNITS.length) % BLOCK_UNITS.length];
  const sym = [1, 2, 4, 4][Math.floor(r() * 4)] as 1 | 2 | 4;
  return { grid, unit, symmetry: sym, seed: seed.toString(16).padStart(8, "0") };
}

function poly(points: number[][], fill: string): string {
  return `<polygon points='${points.map((p) => `${round(p[0])},${round(p[1])}`).join(" ")}' fill='${fill}'/>`;
}
function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x='${round(x)}' y='${round(y)}' width='${round(w)}' height='${round(h)}' fill='${fill}'/>`;
}
function round(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** One unit, drawn at (x,y) with side s, rotated in quarter turns. */
function drawUnit(unit: BlockUnit, x: number, y: number, s: number, turn: number, fg: string, bg: string): string {
  const body = (() => {
    switch (unit) {
      case "half-square":
        return poly([[0, 0], [s, 0], [0, s]], fg);
      case "quarter-square":
        return poly([[0, 0], [s, 0], [s / 2, s / 2]], fg) + poly([[0, s], [s, s], [s / 2, s / 2]], fg);
      case "flying-goose":
        return poly([[s / 2, 0], [s, s], [0, s]], fg);
      case "square-in-square":
        return poly([[s / 2, 0], [s, s / 2], [s / 2, s], [0, s / 2]], fg);
      case "four-patch":
        return rect(0, 0, s / 2, s / 2, fg) + rect(s / 2, s / 2, s / 2, s / 2, fg);
      default:
        return rect(0, 0, s, s / 3, fg) + rect(0, (2 * s) / 3, s, s / 3, fg);
    }
  })();
  const rot = turn % 4 === 0 ? "" : ` rotate(${(turn % 4) * 90} ${round(s / 2)} ${round(s / 2)})`;
  return `<g transform='translate(${round(x)} ${round(y)})${rot}'>${rect(0, 0, s, s, bg)}${body}</g>`;
}

/**
 * One repeatable SVG tile: this guild's block. Single-quoted attributes only,
 * because the string ends up inside a double-quoted HTML style attribute.
 */
export function signatureBlockSvg(name: string, colors: BlockColors, tile = 96): string {
  const t = Number.isFinite(tile) && tile > 0 ? tile : 96;
  const { grid, unit, symmetry } = blockRecipe(name);
  const r = rng(seedOf(name));
  const a = safe(colors.a), b = safe(colors.b), c = safe(colors.c), d = safe(colors.d, "#ffffff");
  const s = t / grid;
  const fills = [a, b, c];

  // Draw one quadrant, then mirror it out to the symmetry the recipe asked
  // for. Real blocks are symmetric; drawing every cell independently gives
  // confetti, not piecing.
  const half = Math.ceil(grid / 2);
  const cells: { turn: number; fg: string; bg: string }[][] = [];
  for (let gy = 0; gy < half; gy++) {
    cells[gy] = [];
    for (let gx = 0; gx < half; gx++) {
      cells[gy][gx] = {
        turn: Math.floor(r() * 4),
        fg: fills[Math.floor(r() * fills.length)],
        bg: r() < 0.62 ? d : fills[Math.floor(r() * fills.length)],
      };
    }
  }

  const parts: string[] = [rect(0, 0, t, t, d)];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const sx = symmetry === 1 ? gx % half : gx < half ? gx : grid - 1 - gx;
      const sy = symmetry === 4 ? (gy < half ? gy : grid - 1 - gy) : gy % half;
      const cell = cells[Math.min(sy, half - 1)][Math.min(sx, half - 1)];
      // Mirroring a unit means turning it, or the seams do not meet.
      let turn = cell.turn;
      if (symmetry !== 1 && gx >= half) turn = (turn + 1) % 4;
      if (symmetry === 4 && gy >= half) turn = (turn + 2) % 4;
      parts.push(drawUnit(unit, gx * s, gy * s, s, turn, cell.fg, cell.bg));
    }
  }
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' width='${t}' height='${t}' viewBox='0 0 ${t} ${t}' shape-rendering='crispEdges'>` +
    parts.join("") +
    `</svg>`
  );
}

/** The tile as a CSS `url("data:…")` value, ready for background-image. */
export function signatureBlockUri(name: string, colors: BlockColors, tile = 96): string {
  const svg = signatureBlockSvg(name, colors, tile);
  const encoded = svg.replace(/[%#<>"\r\n]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `url("data:image/svg+xml;utf8,${encoded}")`;
}

/** "Flying geese · 5 × 5 · pinwheel" — how a quilter would describe it. */
export function describeBlock(name: string): string {
  const { grid, unit, symmetry } = blockRecipe(name);
  const unitName = unit.replace(/-/g, " ");
  const sym = symmetry === 4 ? "pinwheel" : symmetry === 2 ? "mirrored" : "scrappy";
  return `${unitName.charAt(0).toUpperCase()}${unitName.slice(1)} · ${grid} × ${grid} · ${sym}`;
}
