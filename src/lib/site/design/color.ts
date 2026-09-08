// Colour math for the site design system: sRGB <-> OKLCH, WCAG contrast,
// and the two helpers token derivation is built on (tint, bestInk).
//
// OKLCH is used because equal steps in L look equal to the eye, so "make
// this 0.02 lighter" behaves the same for a mustard and a navy. Standard
// matrices from Björn Ottosson's OKLab reference implementation.

export type Oklch = { l: number; c: number; h: number };

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * "#rgb" | "#rrggbb" | "#rrggbbaa" (alpha dropped) -> "#rrggbb" lowercase,
 * or null when the value is not a hex colour. Accepts unknown input so
 * callers can pass raw settings values straight through.
 */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = HEX_RE.exec(value.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return "#" + h.slice(0, 6);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? "#000000";
  return [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const ch = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return "#" + ch(r) + ch(g) + ch(b);
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear) as [number, number, number];
  const [L, a, bb] = linearToOklab(r, g, b);
  const c = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: c < 1e-6 ? 0 : c, h: c < 1e-6 ? 0 : h };
}

const EPS = 1e-4;

function inGamut(rgb: [number, number, number]): boolean {
  return rgb.every((v) => v >= -EPS && v <= 1 + EPS);
}

/**
 * OKLCH -> "#rrggbb". Out-of-gamut colours are brought back by reducing
 * chroma (binary search) at the same lightness and hue, so a tint never
 * shifts hue when it hits the sRGB edge. Lightness is clamped to 0..1.
 */
export function oklchToHex(l: number, c: number, h: number): string {
  const L = Math.min(1, Math.max(0, l));
  const rad = (h * Math.PI) / 180;
  const toLinear = (chroma: number) =>
    oklabToLinear(L, chroma * Math.cos(rad), chroma * Math.sin(rad));
  let rgb = toLinear(Math.max(0, c));
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = Math.max(0, c);
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(toLinear(mid))) lo = mid;
      else hi = mid;
    }
    rgb = toLinear(lo);
  }
  const [r, g, b] = rgb.map(linearToSrgb) as [number, number, number];
  return rgbToHex(r, g, b);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1..21, symmetric. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** Same hue and chroma as `hex`, lightness set to `l` (0..1), gamut-clipped. */
export function tint(hex: string, l: number): string {
  const { c, h } = hexToOklch(hex);
  return oklchToHex(l, c, h);
}

/** Whichever of near-black / white reads better on `bg`. */
export function bestInk(bg: string): "#111111" | "#ffffff" {
  return contrastRatio("#111111", bg) >= contrastRatio("#ffffff", bg)
    ? "#111111"
    : "#ffffff";
}
