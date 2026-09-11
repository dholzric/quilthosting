# Template design baseline

This baseline separates source inventory from rendered evidence. The generated [audit JSON](./baseline-audit.json) records the exact Git revision, dirty paths, package version, registered and on-disk kits, page and section use, imagery reference prefixes, and repeated home and secondary-page sequences.

Run:

```powershell
npm run kits:audit
npm run kits:validate
npx tsc --noEmit
npm run photos:check
```

The source audit does not establish visual quality, unique-photo counts, browser behavior, production readiness, or live URL health. Browser captures at 1440, 768, 390, and 320 pixels remain required for Cinema, Destination, Poster, Collage, Journal, Salon, Heritage, and Minimal. Captures must identify the fixture and revision and wait for fonts and images.

Current priority defects:

1. Design previews must distinguish kit examples from the tenant's actual draft or published page.
2. Applying appearance must preserve authored content and make the full composition choice explicit.
3. The six composition families need whole-site desktop/mobile review with the same content and imagery.
4. The picker needs a curated featured set and rendered thumbnails before exposing the full catalogue.
5. Image provenance, responsive variants, missing-media fallbacks, and editor round trips need browser evidence.
