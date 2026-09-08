/**
 * Allowlist HTML sanitizer for tenant-authored rich text.
 *
 * The Worker runtime has no DOM, so this is a small hand-written tokenizer
 * plus a re-serializer. The security property is structural, not textual:
 * the output is rebuilt from the parsed model (allowed tag names, allowed
 * attribute names, validated attribute values, escaped text) and never
 * contains a byte of the input that was not first decoded, checked, and
 * re-encoded. Anything the tokenizer cannot classify is dropped or emitted
 * as escaped text, so a parser differential between this code and a browser
 * can only lose legitimate content, never leak a tag or attribute through.
 *
 * Why it exists: `text` / `html` page blocks and legacy `content_json.html`
 * were interpolated verbatim into the public guild page, the business SSR
 * renderer, and the admin editor preview (`innerHTML`) -- all on the
 * application origin where admin/portal sessions live in localStorage. A
 * stored `<img src=x onerror=...>` was a full account takeover.
 *
 * Known, deliberate limitations:
 *   - The `style` attribute is dropped entirely (no CSS allowlist yet).
 *   - `id` is dropped (prevents DOM clobbering of `localStorage`, `location`,
 *     form controls, etc.).
 *   - Bare relative URLs (`page.html`) are rejected; use `/page`, `./page`,
 *     `../page`, `#anchor`, `?query`, or an absolute http(s) URL.
 *   - `<script>` / `<style>` in the "custom code" block are stripped on the
 *     application origin -- there is no safe way to run tenant script there.
 */

export type SanitizeOptions = {
  /** Allow `<iframe>` from a fixed set of embed hosts (YouTube, Vimeo, Google Maps). */
  allowEmbeds?: boolean;
};

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s",
  "del", "ins", "a", "ul", "ol", "li", "blockquote", "pre", "code", "img", "figure",
  "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "hr", "span",
  "div", "small", "sub", "sup", "mark",
]);

/** Elements whose entire subtree is discarded, not just the tag. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "svg", "math", "template", "noscript", "object", "embed",
  "iframe", "textarea", "xmp", "plaintext", "title", "head", "frameset", "frame",
]);

const VOID_TAGS = new Set(["br", "hr", "img"]);

const GLOBAL_ATTRS = new Set(["class", "title", "lang", "dir"]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  ol: new Set(["start"]),
  iframe: new Set(["src", "allow", "allowfullscreen", "width", "height", "title", "loading"]),
};

const SAFE_REL_TOKENS = new Set(["nofollow", "noopener", "noreferrer", "external", "ugc", "sponsored"]);

const EMBED_HOSTS = new Set([
  "www.youtube.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "www.google.com",
]);

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "sms:"]);
const IMAGE_SCHEMES = new Set(["http:", "https:"]);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  Tab: "\t", NewLine: "\n", colon: ":", semi: ";", sol: "/", bsol: "\\", num: "#",
  quest: "?", excl: "!", lpar: "(", rpar: ")", equals: "=", grave: "`", lsqb: "[",
  rsqb: "]", lbrace: "{", rbrace: "}", percnt: "%", commat: "@", ast: "*", plus: "+",
  comma: ",", period: ".", lowbar: "_", verbar: "|", tilde: "~", dollar: "$",
  copy: "©", reg: "®", trade: "™", mdash: "—", ndash: "–",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  sbquo: "‚", bdquo: "„", bull: "•", middot: "·", deg: "°",
  plusmn: "±", times: "×", divide: "÷", euro: "€", pound: "£",
  yen: "¥", cent: "¢", sect: "§", para: "¶", laquo: "«",
  raquo: "»", iexcl: "¡", iquest: "¿", frac12: "½", frac14: "¼",
  frac34: "¾", sup2: "²", sup3: "³", micro: "µ", larr: "←",
  rarr: "→", uarr: "↑", darr: "↓", harr: "↔", hearts: "♥",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  shy: "­", dagger: "†", Dagger: "‡", permil: "‰", prime: "′",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä",
  Aring: "Å", AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É",
  Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í", Icirc: "Î",
  Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó",
  Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù",
  Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ",
  szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã",
  auml: "ä", aring: "å", aelig: "æ", ccedil: "ç", egrave: "è",
  eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í",
  icirc: "î", iuml: "ï", eth: "ð", ntilde: "ñ", ograve: "ò",
  oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý",
  thorn: "þ", yuml: "ÿ", OElig: "Œ", oelig: "œ", Scaron: "Š",
  scaron: "š", Yuml: "Ÿ",
};

/** Legacy names browsers decode even without a trailing semicolon. */
const LEGACY_NO_SEMI = new Set(["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"]);

const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,8})|#([0-9]{1,8})|([A-Za-z][A-Za-z0-9]{0,31}))(;?)/g;

/** Decode character references the way a browser would, conservatively. */
export function decodeEntities(input: string): string {
  if (input.indexOf("&") === -1) return input;
  return input.replace(ENTITY_RE, (match, hex, dec, name, semi) => {
    if (hex !== undefined || dec !== undefined) {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return "�";
      }
      return String.fromCodePoint(cp);
    }
    if (name !== undefined) {
      const val = NAMED_ENTITIES[name];
      if (val === undefined) return match;
      if (!semi && !LEGACY_NO_SEMI.has(name)) return match;
      return val;
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Removes ASCII C0/C1 control characters (defeats `java\tscript:`-style scheme obfuscation). */
export function stripControlChars(input: string): string {
  const s = String(input || "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 31 || code === 127) continue;
    if (code >= 128 && code <= 159) continue;
    out += s[i];
  }
  return out;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/;

/**
 * Validate a URL for a link (`href`) or image (`src`) context.
 *
 * Returns the cleaned URL, or `null` when it must not be emitted. Allowed:
 * http/https (plus mailto/tel/sms for links), and relative references that
 * start with `/`, `#`, `?`, `./`, or `../`. Rejected: every other scheme
 * (`javascript:`, `data:`, `vbscript:`, `blob:`, ...), protocol-relative
 * `//host` values, and bare relative paths (which are ambiguous with
 * malformed scheme tricks). Control characters are stripped before matching
 * so `java\tscript:` and `JaVaScRiPt:` cannot smuggle a scheme past the check.
 * Does not HTML-escape; callers still route the result through an attribute
 * escaper.
 */
export function sanitizeUrl(url: string, kind: "link" | "image"): string | null {
  const cleaned = stripControlChars(url).trim();
  if (!cleaned) return null;
  if (cleaned.length > 4000) return null;
  // Protocol-relative and backslash variants navigate off-origin.
  if (cleaned.startsWith("//") || cleaned.startsWith("/\\") || cleaned.startsWith("\\")) return null;
  if (
    cleaned.startsWith("/") ||
    cleaned.startsWith("#") ||
    cleaned.startsWith("?") ||
    cleaned.startsWith("./") ||
    cleaned.startsWith("../")
  ) {
    return cleaned;
  }
  const m = cleaned.match(SCHEME_RE);
  if (!m) return null;
  const scheme = m[1].toLowerCase() + ":";
  const allowed = kind === "link" ? LINK_SCHEMES : IMAGE_SCHEMES;
  return allowed.has(scheme) ? cleaned : null;
}

/** iframe `src` must be https on one of the known embed hosts. */
function sanitizeEmbedUrl(url: string): string | null {
  const cleaned = stripControlChars(url).trim();
  if (!cleaned || cleaned.length > 4000) return null;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (!EMBED_HOSTS.has(host)) return null;
  if (host === "www.google.com" && !parsed.pathname.startsWith("/maps/embed")) return null;
  if ((host === "www.youtube.com" || host === "www.youtube-nocookie.com") && !parsed.pathname.startsWith("/embed/")) {
    return null;
  }
  if (host === "player.vimeo.com" && !parsed.pathname.startsWith("/video/")) return null;
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Attr = { name: string; value: string };
type Token =
  | { kind: "text"; text: string }
  | { kind: "start"; name: string; attrs: Attr[]; selfClosing: boolean }
  | { kind: "end"; name: string };

function isAsciiAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Tokenize HTML into text / start / end tokens. Comments, bogus comments
 * (`<!...`, `<?...`), and CDATA sections are consumed and dropped. A tag that
 * hits end-of-input before its `>` is dropped entirely, mirroring the HTML
 * spec's EOF-in-tag rule.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) tokens.push({ kind: "text", text: input.slice(textStart, end) });
  };

  while (i < n) {
    if (input[i] !== "<") {
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) {
      i++;
      continue;
    }

    // Comment / bogus comment / CDATA / doctype: drop.
    if (next === "!" || next === "?") {
      flushText(i);
      if (input.startsWith("<!--", i)) {
        // Spec quirks: "<!-->" and "<!--->" are complete comments.
        if (input.startsWith("<!-->", i)) {
          i += 5;
        } else if (input.startsWith("<!--->", i)) {
          i += 6;
        } else {
          const close = input.indexOf("-->", i + 4);
          if (close === -1) {
            // Also accept "--!>" per spec; otherwise the comment runs to EOF.
            const alt = input.indexOf("--!>", i + 4);
            i = alt === -1 ? n : alt + 4;
          } else {
            i = close + 3;
          }
        }
      } else {
        const close = input.indexOf(">", i + 2);
        i = close === -1 ? n : close + 1;
      }
      textStart = i;
      continue;
    }

    // End tag.
    if (next === "/") {
      const c2 = input[i + 2];
      if (c2 === undefined) {
        i++;
        continue;
      }
      if (c2 === ">") {
        // "</>" is dropped.
        flushText(i);
        i += 3;
        textStart = i;
        continue;
      }
      if (!isAsciiAlpha(c2)) {
        // Bogus comment.
        flushText(i);
        const close = input.indexOf(">", i + 2);
        i = close === -1 ? n : close + 1;
        textStart = i;
        continue;
      }
      flushText(i);
      let j = i + 2;
      let name = "";
      while (j < n && !isWs(input[j]) && input[j] !== ">" && input[j] !== "/") {
        name += input[j];
        j++;
      }
      // Attributes on end tags are ignored; consume to ">".
      const close = input.indexOf(">", j);
      if (close === -1) {
        i = n; // EOF in tag: drop.
        textStart = i;
        break;
      }
      tokens.push({ kind: "end", name: name.toLowerCase() });
      i = close + 1;
      textStart = i;
      continue;
    }

    // Start tag.
    if (isAsciiAlpha(next)) {
      flushText(i);
      let j = i + 1;
      let name = "";
      while (j < n && !isWs(input[j]) && input[j] !== ">" && input[j] !== "/") {
        name += input[j];
        j++;
      }
      const attrs: Attr[] = [];
      const seen = new Set<string>();
      let selfClosing = false;
      let closed = false;
      while (j < n) {
        // Skip whitespace and stray slashes.
        while (j < n && (isWs(input[j]) || input[j] === "/")) {
          if (input[j] === "/" && input[j + 1] === ">") selfClosing = true;
          j++;
        }
        if (j >= n) break;
        if (input[j] === ">") {
          closed = true;
          j++;
          break;
        }
        // Attribute name: runs until whitespace, "/", ">", or "=" (except a leading "=").
        let aname = "";
        if (input[j] === "=") {
          aname += "=";
          j++;
        }
        while (j < n && !isWs(input[j]) && input[j] !== "/" && input[j] !== ">" && input[j] !== "=") {
          aname += input[j];
          j++;
        }
        while (j < n && isWs(input[j])) j++;
        let avalue = "";
        if (j < n && input[j] === "=") {
          j++;
          while (j < n && isWs(input[j])) j++;
          if (j < n && (input[j] === '"' || input[j] === "'")) {
            const q = input[j];
            const end = input.indexOf(q, j + 1);
            if (end === -1) {
              // Unterminated quoted value: EOF in tag, drop the tag.
              j = n;
              break;
            }
            avalue = input.slice(j + 1, end);
            j = end + 1;
          } else {
            while (j < n && !isWs(input[j]) && input[j] !== ">") {
              avalue += input[j];
              j++;
            }
          }
        }
        const lname = aname.toLowerCase();
        if (lname && !seen.has(lname)) {
          seen.add(lname);
          attrs.push({ name: lname, value: decodeEntities(avalue) });
        }
      }
      if (!closed) {
        // EOF inside the tag: the tag and everything after it is discarded.
        i = n;
        textStart = i;
        break;
      }
      tokens.push({ kind: "start", name: name.toLowerCase(), attrs, selfClosing });
      i = j;
      textStart = i;
      continue;
    }

    // A lone "<" is text.
    i++;
  }
  flushText(Math.min(i, n));
  return tokens;
}

// ---------------------------------------------------------------------------
// Attribute filtering
// ---------------------------------------------------------------------------

const DIMENSION_RE = /^\d{1,5}%?$/;
const INT_RE = /^-?\d{1,6}$/;
const ALLOW_POLICY_RE = /^[a-z0-9 ;*'\-:.\/]*$/i;

function filterClass(value: string): string {
  return value
    .split(/\s+/)
    .filter((t) => t && !/^qh-admin/i.test(t))
    .join(" ");
}

function filterAttrs(tag: string, attrs: Attr[], opts: SanitizeOptions): Attr[] {
  const out: Attr[] = [];
  const tagAllowed = TAG_ATTRS[tag];
  let targetBlank = false;
  let relIndex = -1;

  for (const a of attrs) {
    const name = a.name;
    const value = a.value;
    // Hard denials before any allowlist lookup.
    if (name.startsWith("on")) continue;
    if (name === "style" || name === "id" || name === "srcdoc" || name === "srcset" || name === "formaction") continue;
    if (name.includes(":")) continue; // xlink:href, xml:*, etc.

    if (GLOBAL_ATTRS.has(name)) {
      if (name === "class") {
        const cls = filterClass(value);
        if (cls) out.push({ name, value: cls });
      } else if (name === "dir") {
        const v = value.trim().toLowerCase();
        if (v === "ltr" || v === "rtl" || v === "auto") out.push({ name, value: v });
      } else if (name === "lang") {
        if (/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(value.trim())) out.push({ name, value: value.trim() });
      } else {
        out.push({ name, value });
      }
      continue;
    }

    if (!tagAllowed || !tagAllowed.has(name)) continue;

    switch (name) {
      case "href": {
        const u = sanitizeUrl(value, "link");
        if (u !== null) out.push({ name, value: u });
        break;
      }
      case "src": {
        if (tag === "iframe") {
          const u = sanitizeEmbedUrl(value);
          if (u !== null) out.push({ name, value: u });
        } else {
          const u = sanitizeUrl(value, "image");
          if (u !== null) out.push({ name, value: u });
        }
        break;
      }
      case "target": {
        if (value.trim().toLowerCase() === "_blank") {
          targetBlank = true;
          out.push({ name, value: "_blank" });
        }
        break;
      }
      case "rel": {
        const tokens = value
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => SAFE_REL_TOKENS.has(t));
        if (tokens.length) {
          relIndex = out.length;
          out.push({ name, value: tokens.join(" ") });
        }
        break;
      }
      case "width":
      case "height": {
        const v = value.trim();
        if (DIMENSION_RE.test(v)) out.push({ name, value: v });
        break;
      }
      case "colspan":
      case "rowspan":
      case "start": {
        const v = value.trim();
        if (INT_RE.test(v)) out.push({ name, value: v });
        break;
      }
      case "loading": {
        const v = value.trim().toLowerCase();
        if (v === "lazy" || v === "eager") out.push({ name, value: v });
        break;
      }
      case "alt":
      case "title":
        out.push({ name, value });
        break;
      case "allow": {
        const v = value.trim();
        if (ALLOW_POLICY_RE.test(v)) out.push({ name, value: v });
        break;
      }
      case "allowfullscreen":
        out.push({ name, value: "" });
        break;
      default:
        break;
    }
  }

  if (tag === "a" && targetBlank) {
    if (relIndex >= 0) {
      const tokens = out[relIndex].value.split(" ");
      for (const t of ["noopener", "noreferrer"]) if (!tokens.includes(t)) tokens.push(t);
      out[relIndex] = { name: "rel", value: tokens.join(" ") };
    } else {
      out.push({ name: "rel", value: "noopener noreferrer" });
    }
  }

  // An iframe without a validated src is pointless and must not be emitted.
  if (tag === "iframe" && !out.some((a) => a.name === "src")) return [];
  void opts;
  return out;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

const MAX_DEPTH = 64;

/**
 * Sanitize tenant-authored HTML to the allowlist documented at the top of
 * this file. Idempotent: `sanitizeHtml(sanitizeHtml(x)) === sanitizeHtml(x)`.
 */
export function sanitizeHtml(input: string, opts: SanitizeOptions = {}): string {
  const src = String(input ?? "");
  if (!src) return "";
  const allowEmbeds = !!opts.allowEmbeds;
  const tokens = tokenize(src);
  const out: string[] = [];
  const stack: string[] = [];

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];

    if (tok.kind === "text") {
      out.push(escText(decodeEntities(tok.text)));
      continue;
    }

    if (tok.kind === "end") {
      const idx = stack.lastIndexOf(tok.name);
      if (idx === -1) continue; // stray close tag
      while (stack.length > idx) {
        out.push(`</${stack.pop()}>`);
      }
      continue;
    }

    // Start tag.
    const name = tok.name;
    const isEmbed = name === "iframe" && allowEmbeds;

    if (DROP_WITH_CONTENT.has(name) && !isEmbed) {
      if (VOID_TAGS.has(name) || name === "embed") continue;
      // Skip every token up to the matching close tag, counting nesting.
      let depth = 1;
      let k = t + 1;
      for (; k < tokens.length; k++) {
        const inner = tokens[k];
        if (inner.kind === "start" && inner.name === name && !inner.selfClosing) depth++;
        else if (inner.kind === "end" && inner.name === name) {
          depth--;
          if (depth === 0) break;
        }
      }
      t = k; // resumes after the close tag (or at EOF)
      continue;
    }

    if (isEmbed) {
      const attrs = filterAttrs("iframe", tok.attrs, opts);
      // Never keep iframe children (fallback content) -- skip to close tag.
      let k = t + 1;
      let depth = 1;
      for (; k < tokens.length; k++) {
        const inner = tokens[k];
        if (inner.kind === "start" && inner.name === "iframe" && !inner.selfClosing) depth++;
        else if (inner.kind === "end" && inner.name === "iframe") {
          depth--;
          if (depth === 0) break;
        }
      }
      t = k;
      if (attrs.length) out.push(`<iframe${serializeAttrs(attrs)}></iframe>`);
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      // Unknown / disallowed wrapper: drop the tag, keep (sanitized) children.
      continue;
    }

    const attrs = filterAttrs(name, tok.attrs, opts);
    if (VOID_TAGS.has(name)) {
      out.push(`<${name}${serializeAttrs(attrs)}>`);
      continue;
    }
    if (stack.length >= MAX_DEPTH) continue;
    out.push(`<${name}${serializeAttrs(attrs)}>`);
    stack.push(name);
  }

  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}

function serializeAttrs(attrs: Attr[]): string {
  let s = "";
  for (const a of attrs) {
    if (a.name === "allowfullscreen") {
      s += " allowfullscreen";
      continue;
    }
    s += ` ${a.name}="${escAttr(a.value)}"`;
  }
  return s;
}
