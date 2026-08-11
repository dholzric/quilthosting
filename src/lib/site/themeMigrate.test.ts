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
  it("round-trips the fields guild.html reads", () => {
    const expanded = expandLegacyTheme({ primary: "#123456", accent: "#654321" });
    const legacy = deriveLegacyTheme(expanded);
    expect(legacy.primary).toBe("#123456");
    expect(legacy.accent).toBe("#654321");
  });

  it("always supplies headerBg so guild.html never renders unstyled", () => {
    expect(deriveLegacyTheme(DEFAULT_THEME).headerBg).toBeTruthy();
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
