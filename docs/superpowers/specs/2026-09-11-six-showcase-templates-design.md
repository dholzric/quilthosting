# Six Showcase Templates Design

**Author:** Codex  
**Date:** 2026-09-11  
**Status:** Approved direction; detailed specification for owner review

## Purpose

Add six new QuiltHosting template IDs that look and behave like six independently art-directed websites. Existing templates remain unchanged. Three templates serve guilds and three serve businesses. The work succeeds only when neutralized side-by-side renders have clearly different silhouettes, page rhythms, navigation, imagery, content hierarchy, and conversion paths.

This project corrects the current failure mode in which many kit names, palettes, and hero images sit on essentially the same page structure. Shared rendering, data, accessibility, and transaction behavior remain product infrastructure; they cannot dictate a single visible composition.

## New collection

| ID | Name | Audience | Family | Primary job |
|---|---|---|---|---|
| `quilt-biennial` | Quilt Biennial | Guild | Poster | Promote a show, entries, program, and attendance |
| `common-thread-review` | Common Thread Review | Guild | Journal | Publish guild stories, programs, archives, and membership |
| `patchwork-social` | Patchwork Social | Guild | Collage | Recruit members through lively community activity |
| `atelier-noir` | Atelier Noir | Business | Cinema | Present premium work and convert commission inquiries |
| `fieldstone-retreat` | Fieldstone Retreat | Business | Destination | Sell stays, workshops, and retreat inquiries |
| `heirloom-house` | Heirloom House | Business | Salon | Explain a refined commission process and book consultations |

All six IDs are additive. They appear in the featured collection only after their complete page system passes the visual and functional gates below.

## Shared implementation boundary

The existing server renderer, section data, design tokens, sanitization, tenant scoping, preview endpoint, image routing, and interactive-island hooks remain authoritative. The designs may add semantic composition classes, shell variants, and a small number of section variants. Tenant data stores named recipes, never arbitrary CSS utilities.

Each template receives:

- Five or six authored pages with audience-specific sample copy.
- A distinct header, home opening, section rhythm, image language, secondary-page treatment, and footer.
- Original responsive artwork at 480, 960, and 1600 pixels with provenance notices.
- A rendered picker thumbnail and full example preview.
- Desktop, tablet, phone, and narrow-phone review artifacts.
- A practical no-image fallback that preserves hierarchy and primary actions.

Existing template JSON, IDs, installed pages, and appearance settings are not rewritten.

## Art direction

### Quilt Biennial

The page behaves like a contemporary exhibition poster. A compressed utility bar carries date and venue. The wordmark and navigation form a hard horizontal masthead. The home opening uses monumental stacked typography beside or over a cropped exhibition image, followed by numbered program rows rather than cards. Entry deadlines, categories, jurors, sponsors, and visit details use rules, labels, and tabular spacing. The gallery runs edge to edge and may alternate two- and three-column bands.

Mobile preserves the poster character through oversized but bounded type, horizontal rules, numeric labels, and image crops. It must not collapse into generic rounded cards.

Pages: Home, The Show, Enter a Quilt, Program, Plan Your Visit, Contact.

### Common Thread Review

The site resembles an independent textile journal. A centered publication masthead, issue line, date, and compact navigation establish the shell. The opening balances a lead story, portrait textile image, deck, and smaller dispatches. Long-form pages use readable measure, pull quotes, captions, bylines, and archival lists. Events read as an editorial calendar. Membership is presented as supporting the publication and community.

Mobile becomes a disciplined single-column reading experience while retaining issue metadata, rules, captions, and hierarchy.

Pages: Current Issue, Dispatches, Gatherings, Archive, About the Guild, Subscribe and Join.

### Patchwork Social

The site feels assembled by an energetic contemporary community without becoming chaotic. The shell uses a compact wordmark, bright utility labels, and a menu that resembles a notice strip. The opening layers two or three differently scaled images with paper edges and controlled rotation. Content uses staggered bulletin cards, handwritten-style accent labels used sparingly, event tickets, member snapshots, and a community pinboard.

On narrow screens, overlap and rotation reduce substantially; color blocks, labels, and varied crop ratios retain the identity. Focus order follows DOM order regardless of visual positioning.

Pages: Home, Meet Us, Sew With Us, Calendar, Member Work, Join.

### Atelier Noir

The site is a cinematic portfolio for a premium quilt studio. Navigation overlays the opening image and becomes a quiet solid bar after the first viewport. A nearly full-screen composition uses one strong image, low-set title, project metadata, and a restrained inquiry action. Portfolio pages use dark project chapters, large image sequences, material notes, and generous pauses. Services and process avoid card grids in favor of numbered editorial stages.

Mobile uses immersive crops without hiding essential text or actions. Reduced motion removes reveal and parallax effects while preserving the final composition.

Pages: Home, Selected Work, Commissions, Process, Studio, Inquiry.

### Fieldstone Retreat

The site sells a place. A panoramic opening establishes landscape and season, with a light information panel containing capacity, location, next availability, and inquiry action. Subsequent sections move through an itinerary timeline, room and workspace bands, amenities, host information, map/location details, and practical FAQs. Dates and facts remain scannable and visually separate from narrative copy.

Mobile places the information panel directly after the image and turns the itinerary into a vertical route. No text overlays depend on a specific image crop.

Pages: Home, The House, Retreats, Your Weekend, Workshops, Plan Your Stay.

### Heirloom House

The site is a restrained commission salon. A formal centered wordmark, small navigation, and framed opening image create the shell. The home page uses an invitation-like title, narrow introductory copy, a curated portfolio procession, material details, testimonial excerpts, and a consultation action. Process pages use elegant numbered steps. Portfolio images have consistent museum-like framing and captions.

Mobile preserves centered composition and whitespace while reducing ornamental framing. The consultation path remains visible without a sticky obstruction.

Pages: Home, Commissions, Portfolio, Materials, Process, Consultation.

## Imagery

Generate one coherent original visual set per template rather than reusing a single hero across unrelated pages. Artwork must support the intended crop ratios and be useful as replaceable sample media. Each set includes a hero, at least two supporting images, responsive derivatives, dimensions, alt text, and an asset-level `LICENSE.txt` provenance notice.

Generated imagery is labelled as sample artwork and never represented as a real guild, venue, customer quilt, testimonial, or completed commission. Templates prompt owners to replace it before launch.

## Rendering extensions

Composition must affect the complete page system, not only the first hero. Family recipes may control:

- Header positioning, density, overlay behavior, and mobile navigation treatment.
- Home-opener geometry and secondary-page title geometry.
- Container relationships, section spacing, grid tracks, and deliberate full-bleed regions.
- Image crops, frames, captions, layering, and gallery rhythm.
- Event, feature, process, testimonial, and information-list presentation.
- Footer organization and final conversion treatment.

Explicit section style and variant choices continue to win over family defaults. Immersive image treatment requires usable media. Missing media produces a designed text opening rather than an empty tall viewport.

New section variants are allowed only when an existing semantic section cannot express the design. Each new variant must ship with schema validation, renderer output, editor control, thumbnail, responsive styles, fixtures, and tests in the same change.

## Picker and previews

The six templates appear as a named “Showcase” collection ahead of the broader catalogue after approval. Picker thumbnails come from the real renderer and representative fixture, not a shared schematic miniature. Cards display audience and design purpose. Guilds see the three guild showcase designs; businesses see the three business showcase designs.

Selecting a template first opens its example website. Choosing “Use this design” then shows the tenant’s current draft or published home page with the new appearance before saving. Applying appearance preserves pages, content, section IDs, images, navigation, publishing state, revisions, and unrelated settings.

## Motion and interaction

Motion supports each art direction but remains optional:

- Cinema may reveal project metadata and gently settle imagery.
- Poster may use immediate rule and type transitions.
- Journal may reveal rows without moving reading position.
- Collage may settle layered pieces by a few pixels.
- Destination may progress an itinerary marker.
- Salon may fade framed work with restrained timing.

All content exists before JavaScript. Keyboard operation and focus order follow the semantic document. `prefers-reduced-motion` produces the final state without transitional movement. Preview mode cannot submit registration, checkout, donation, newsletter, email, or publishing requests.

## Visual acceptance gates

All six templates are rendered with the same neutral palette, type pair, copy lengths, and image set for a silhouette comparison. Each pair must differ on at least four of these axes:

1. Header and navigation arrangement.
2. Home-opener geometry.
3. Image composition and crop language.
4. Content grid and information hierarchy.
5. Section rhythm and transitions.
6. Secondary-page title treatment.
7. Footer structure.

A template fails if reviewers primarily distinguish it by color, font, name, or hero image. It also fails if its secondary pages revert to the same repeated stack of rounded cards.

Review sizes are 1440, 768, 390, and 320 pixels. Required states include normal content, long title, long organization name, missing hero image, no logo, populated dynamic data, empty dynamic data, reduced motion, keyboard navigation, and 200% zoom. There must be no document-level horizontal overflow, clipped focus, broken local image request, or new console error.

## Functional acceptance gates

- New IDs are unique, registered, catalogued, audience-correct, and schema-valid.
- Every internal link resolves to a kit page or supported system page.
- Draft preview, published preview, application, reload, and public rendering retain the selected composition.
- Applying appearance does not mutate page rows.
- Existing 114 templates render and remain selectable for compatible tenants.
- Transaction hooks work on public pages and issue no mutation requests inside previews.
- Local image paths reject traversal and resolve responsive variants.
- Full TypeScript, unit, kit, media, and browser suites pass.

## Delivery sequence

Wave one implements Quilt Biennial, Common Thread Review, and Atelier Noir. They are rendered side by side and revised until each passes the distinctness gate. Wave two implements Patchwork Social, Fieldstone Retreat, and Heirloom House using lessons from wave one. Shared renderer changes are reviewed again against wave one to prevent convergence.

The final delivery includes six new template IDs, source artwork and provenance, rendered thumbnails, desktop/mobile comparison sheets, test results, byte changes, and a family-level PASS or REVISE verdict. Deployment occurs only after every featured template passes; an incomplete template may remain registered outside Showcase for review.

## Styling technology

Use the existing semantic CSS and design tokens for the production implementation. A Tailwind comparison is not part of this visual milestone because it does not create visual distinction by itself and would add build-system work before the compositions are proven. The finished DOM and art direction can be evaluated for utility extraction later without changing tenant data or the visual contract.
