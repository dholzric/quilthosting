# Kit authoring

The authoring brief for site kits lives at the repo root: **[`QuiltHostingTemplates.md`](../QuiltHostingTemplates.md)**. It is the single source of truth for the kit JSON format (schema v1, frozen), the section catalogue, palette and type-pair ids, copy and imagery rules, and the review checklist. Hand that file, alone, to Codex, GLM, or a designer.

Quick reference for engineers:

| What | Where |
|---|---|
| Kit files | `src/lib/site/kits/<id>.json` (reference kit: `heritage.json`) |
| Schema + validator | `src/lib/site/kits/schema.ts` (`kitSchema`, `validateKit`) |
| Applying a kit | `src/lib/site/kits/apply.ts` (`kitPageRows`, `kitSettingsJson`, `substitutePlaceholders`, `sectionsToLegacyBlocks`) |
| Registry | `src/lib/site/kits/index.ts` (`KITS`, `kitById`) — add a new kit here |
| Validate | `npm run kits:validate` (per-kit issues, then `vitest run src/lib/site/kits`) |
| Preview | `npm run kits:preview` — needs a local Worker and `PLAYWRIGHT_PATH`; see the header of `scripts/kits-preview.mjs`. Output: `docs/kit-gallery/` |
| New guild seed | `src/lib/starterSite.ts` derives the legacy five-page block seed from the Heritage kit |
