// Parametric quilt-block art. Each pattern is one repeatable SVG tile drawn
// with <rect> and <polygon> only, colored from the site's derived roles, and
// used as a low-opacity background for pattern heroes/bands and empty states.
// License-free and on-brand for the audience; no raster assets involved.

export type PatternId = "none" | "nine-patch" | "flying-geese" | "log-cabin" | "churn-dash" | "bear-paw";

export const PATTERN_IDS: readonly PatternId[] = [
  "none",
  "nine-patch",
  "flying-geese",
  "log-cabin",
  "churn-dash",
  "bear-paw",
];

/** a = foreground (brand), b = secondary (dark/brandAlt), c = ground/accent. */
export type PatternColors = { a: string; b: string; c: string };

// Colors land inside an SVG attribute inside a CSS url() inside an HTML
// style attribute. Only a plain hex literal is allowed through; anything else
// (a role value that failed to derive, or a hostile string) becomes neutral
// gray rather than a quote that could close the attribute.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function safeColor(value: string): string {
  return HEX.test(value) ? value : "#808080";
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x='${fmt(x)}' y='${fmt(y)}' width='${fmt(w)}' height='${fmt(h)}' fill='${fill}'/>`;
}

function poly(points: [number, number][], fill: string): string {
  return `<polygon points='${points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ")}' fill='${fill}'/>`;
}

/** 3x3 squares alternating a/b in a checkerboard. */
function ninePatch(t: number, a: string, b: string): string {
  const u = t / 3;
  const out: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push(rect(c * u, r * u, u, u, (r + c) % 2 === 0 ? a : b));
    }
  }
  return out.join("");
}

/** Two geese stacked, each a wide triangle pointing right on a sky ground. */
function flyingGeese(t: number, a: string, b: string, c: string): string {
  const h = t / 2;
  const out: string[] = [];
  for (let i = 0; i < 2; i++) {
    const y = i * h;
    out.push(rect(0, y, t, h, i === 0 ? c : b));
    out.push(
      poly(
        [
          [0, y],
          [t, y + h / 2],
          [0, y + h],
        ],
        a
      )
    );
  }
  return out.join("");
}

/** Concentric strips: light (a) top/left, dark (b) bottom/right, c center. */
function logCabin(t: number, a: string, b: string, c: string): string {
  const s = t / 8;
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const i = k * s;
    const w = t - 2 * i;
    out.push(rect(i, i, w - s, s, a)); // top
    out.push(rect(i + w - s, i, s, w - s, b)); // right
    out.push(rect(i + s, i + w - s, w - s, s, b)); // bottom
    out.push(rect(i, i + s, s, w - s, a)); // left
  }
  out.push(rect(3 * s, 3 * s, t - 6 * s, t - 6 * s, c));
  return out.join("");
}

/** Corner half-square triangles plus bars on each edge around an open center. */
function churnDash(t: number, a: string, b: string, c: string): string {
  const u = t / 3;
  return [
    rect(0, 0, t, t, c),
    poly([[0, 0], [u, 0], [0, u]], a),
    poly([[2 * u, 0], [t, 0], [t, u]], a),
    poly([[t, 2 * u], [t, t], [2 * u, t]], a),
    poly([[0, 2 * u], [u, t], [0, t]], a),
    rect(u, 0, u, u / 2, b),
    rect(u, t - u / 2, u, u / 2, b),
    rect(0, u, u / 2, u, b),
    rect(t - u / 2, u, u / 2, u, b),
  ].join("");
}

/** A paw: one large square with two claws along the top and two along the left. */
function bearPaw(t: number, a: string, b: string, c: string): string {
  const u = t / 4;
  return [
    rect(0, 0, t, t, c),
    rect(u, u, 2 * u, 2 * u, a),
    poly([[u, u], [u, 0], [2 * u, u]], b),
    poly([[2 * u, u], [2 * u, 0], [3 * u, u]], b),
    poly([[u, u], [0, u], [u, 2 * u]], b),
    poly([[u, 2 * u], [0, 2 * u], [u, 3 * u]], b),
  ].join("");
}

/** One SVG tile for the pattern, or "" for "none". Single-quoted attributes only. */
export function patternSvg(id: PatternId, colors: PatternColors, tile = 96): string {
  if (id === "none") return "";
  const t = Number.isFinite(tile) && tile > 0 ? tile : 96;
  const a = safeColor(colors.a);
  const b = safeColor(colors.b);
  const c = safeColor(colors.c);
  let body: string;
  switch (id) {
    case "nine-patch":
      body = ninePatch(t, a, b);
      break;
    case "flying-geese":
      body = flyingGeese(t, a, b, c);
      break;
    case "log-cabin":
      body = logCabin(t, a, b, c);
      break;
    case "churn-dash":
      body = churnDash(t, a, b, c);
      break;
    case "bear-paw":
      body = bearPaw(t, a, b, c);
      break;
    default:
      return "";
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${fmt(t)}' height='${fmt(t)}' viewBox='0 0 ${fmt(t)} ${fmt(t)}' shape-rendering='crispEdges'>${body}</svg>`;
}

/**
 * CSS background-image value: url("data:image/svg+xml;utf8,...") or "none".
 * The payload is percent-encoded for the characters that break a data URI
 * or the surrounding double-quoted url() / HTML style attribute.
 */
export function patternDataUri(id: PatternId, colors: PatternColors, tile = 96): string {
  const svg = patternSvg(id, colors, tile);
  if (!svg) return "none";
  const encoded = svg.replace(/[%#<>"\r\n]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `url("data:image/svg+xml;utf8,${encoded}")`;
}
