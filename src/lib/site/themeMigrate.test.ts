import { describe, it, expect } from "vitest";
import {
  expandLegacyTheme,
  deriveLegacyTheme,
  fontsFromLegacy,
  readTenantTheme,
} from "./themeMigrate";
import { DEFAULT_THEME, DEFAULT_FONTS } from "./theme";

describe("expandLegacyTheme", () => {
  it("maps the two legacy colors onto their tokens", () => {
    const t = expandLegacyTheme({ primary: "#123456", accent: "#654321" });
    expect(t.primary).toBe("#123456");
    expect(t.accent).toBe("#654321");
  });

  it("fills the remaining eleven tokens from the default", () => {
    const t = expandLegacyTheme({ primary: "#123456" });
    expect(t.gold).toBe(DEFAULT_THEME.gold);
    expect(t.textMuted).toBe(DEFAULT_THEME.textMuted);
    expect(Object.keys(t)).toHaveLength(13);
  });

  it("uses headerBg as the card token when present", () => {
    expect(expandLegacyTheme({ headerBg: "#fff8f0" }).card).toBe("#fff8f0");
  });

  it("passes an already-expanded theme through unchanged", () => {
    // Idempotent: the backfill must be safe to run twice.
    const already = { ...DEFAULT_THEME, primary: "#abcdef" };
    expect(expandLegacyTheme(already)).toEqual(already);
  });

  it("returns the default for null or empty input", () => {
    expect(expandLegacyTheme(null)).toEqual(DEFAULT_THEME);
    expect(expandLegacyTheme({})).toEqual(DEFAULT_THEME);
  });

  it("drops unsafe colors rather than propagating them", () => {
    expect(expandLegacyTheme({ primary: "}</style>" }).primary).toBe(DEFAULT_THEME.primary);
  });
});

describe("deriveLegacyTheme", () => {
  it("round-trips the fields guild.html reads, when the tenant actually set them", () => {
    const raw = { primary: "#123456", accent: "#654321" };
    const expanded = expandLegacyTheme(raw);
    // The real public.ts call site passes the raw stored theme as the second
    // argument (deriveLegacyTheme(tokens, settings.theme)) — presence is
    // determined against that raw object, not the expanded ThemeConfig.
    const legacy = deriveLegacyTheme(expanded, raw);
    expect(legacy.primary).toBe("#123456");
    expect(legacy.accent).toBe("#654321");
  });

  it("omits primary, accent, and headerBg entirely for an unconfigured tenant, so guild.html falls through to the platform default", () => {
    // guild.html's applyTheme() only overrides colors when theme.primary is
    // truthy (public/guild.html:921). An unconfigured tenant's settings_json
    // is '{}' (src/routes/tenants.ts, src/routes/chapters.ts), so there is
    // no stored theme at all. Unconditionally supplying DEFAULT_THEME's
    // colors here would repaint every such guild site purple instead of
    // leaving it on the platform's real default brand color
    // (--brand in public/qh.css). guild.html never reads headerBg at all,
    // so there is no "must supply it" requirement either.
    expect(deriveLegacyTheme(DEFAULT_THEME)).toEqual({});
    expect(deriveLegacyTheme(DEFAULT_THEME, {})).toEqual({});
    expect(deriveLegacyTheme(DEFAULT_THEME, null)).toEqual({});
  });

  it("omits only the unset fields when the stored theme partially configures the tenant", () => {
    const raw = { accent: "#654321" }; // primary/headerBg never set
    const expanded = expandLegacyTheme(raw);
    const legacy = deriveLegacyTheme(expanded, raw);
    expect(legacy).not.toHaveProperty("primary");
    expect(legacy).not.toHaveProperty("headerBg");
    expect(legacy.accent).toBe("#654321");
  });

  it("produces no primary key end-to-end for an unconfigured tenant's settings_json", () => {
    // Mirrors the real /public/:slug/site path: readTenantTheme parses
    // settings_json and expands it; deriveLegacyTheme derives the legacy
    // payload against the (empty) stored theme.
    const settings = JSON.parse("{}");
    const { theme: tokens } = readTenantTheme("{}");
    const legacy = deriveLegacyTheme(tokens, settings.theme);
    expect(legacy).not.toHaveProperty("primary");
    expect(legacy).toEqual({});
  });

  it("passes through font and style from the stored legacy source, since neither has a ThemeConfig equivalent", () => {
    // guild.html reads theme.font and theme.style directly (public/guild.html
    // applyTheme()), and public/admin.html has live dropdowns that set them.
    // ThemeConfig carries no such tokens, so deriveLegacyTheme accepts the
    // original stored legacy object as an optional second argument purely to
    // avoid dropping these two fields.
    const legacy = deriveLegacyTheme(DEFAULT_THEME, { font: "serif", style: "modern" });
    expect(legacy.font).toBe("serif");
    expect(legacy.style).toBe("modern");
  });

  it("omits font and style when no legacy source is given or they are unset", () => {
    expect(deriveLegacyTheme(DEFAULT_THEME).font).toBeUndefined();
    expect(deriveLegacyTheme(DEFAULT_THEME, {}).style).toBeUndefined();
  });

  it("ignores unrecognized font/style values rather than passing them through", () => {
    const legacy = deriveLegacyTheme(DEFAULT_THEME, {
      font: "comic-sans" as any,
      style: "wacky" as any,
    });
    expect(legacy.font).toBeUndefined();
    expect(legacy.style).toBeUndefined();
  });
});

describe("fontsFromLegacy", () => {
  it("maps the legacy font enum onto font keys", () => {
    expect(fontsFromLegacy({ font: "serif" })).toEqual({ heading: "lora", body: "lora" });
    expect(fontsFromLegacy({ font: "rounded" })).toEqual({ heading: "nunito", body: "nunito" });
    expect(fontsFromLegacy({ font: "system" })).toEqual(DEFAULT_FONTS);
  });

  it("defaults when font is absent", () => {
    expect(fontsFromLegacy({})).toEqual(DEFAULT_FONTS);
    expect(fontsFromLegacy(null)).toEqual(DEFAULT_FONTS);
  });
});

describe("readTenantTheme", () => {
  it("reads theme and fonts out of settings_json", () => {
    const json = JSON.stringify({ theme: { primary: "#111111" }, fonts: { heading: "lora", body: "inter" } });
    const { theme, fonts } = readTenantTheme(json);
    expect(theme.primary).toBe("#111111");
    expect(fonts).toEqual({ heading: "lora", body: "inter" });
  });

  it("survives malformed json", () => {
    const { theme, fonts } = readTenantTheme("{not json");
    expect(theme).toEqual(DEFAULT_THEME);
    expect(fonts).toEqual(DEFAULT_FONTS);
  });
});
