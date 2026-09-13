// Design review — the sheet a reviewer works through for the starter library.
//
// The Design panel offers 120 starter designs and nobody had ever looked at
// them side by side. This serves the list (name, character, audience, and the
// screenshot the panel already ships) and stores one row per reviewer per
// design: a score out of ten, what they thought, and whether we should offer
// it as a default.
//
// Deliberately NOT behind a login. The people reviewing are collaborators who
// already hold the site-gate password and are not users of any guild; asking
// them to hold an account to leave a comment is the thing that stops reviews
// happening. The site gate is the access control, the page is unlisted, and
// nothing here reads or writes tenant data.
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { all } from "../lib/db";
import { KITS } from "../lib/site/kits";

export const designReviewRoutes = new Hono<{ Bindings: Env }>();

/** A reviewer names themselves; it is a label, not an identity. */
const REVIEWER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KIT_IDS = new Set(KITS.map((k) => k.id));

const reviewSchema = z.object({
  kit: z.string().refine((v) => KIT_IDS.has(v), "Unknown design"),
  reviewer: z.string().regex(REVIEWER_RE, "Bad reviewer name"),
  rating: z.number().int().min(1).max(10).nullable().optional(),
  comment: z.string().max(2000).optional(),
  isDefault: z.boolean().optional(),
});

type ReviewRow = {
  kit_id: string;
  reviewer: string;
  rating: number | null;
  comment: string;
  is_default: number;
  updated_at: string;
};

/** GET /design-review/kits — the library, with everything the sheet shows. */
designReviewRoutes.get("/kits", (c) =>
  c.json({
    kits: KITS.map((k) => ({
      id: k.id,
      name: k.name,
      audience: k.audience,
      character: k.character ?? "",
      // The screenshot the Design panel already ships; no second pipeline.
      shot: `/kit-shots/${k.id}.webp`,
    })),
  })
);

/** GET /design-review/entries?reviewer=x — one reviewer's sheet, or everyone's. */
designReviewRoutes.get("/entries", async (c) => {
  const reviewer = (c.req.query("reviewer") || "").toLowerCase();
  if (reviewer && !REVIEWER_RE.test(reviewer)) return c.json({ error: "Bad reviewer name" }, 400);
  const rows = reviewer
    ? await all<ReviewRow>(
        c.env.DB.prepare("SELECT * FROM design_reviews WHERE reviewer = ? ORDER BY kit_id").bind(reviewer)
      )
    : await all<ReviewRow>(c.env.DB.prepare("SELECT * FROM design_reviews ORDER BY reviewer, kit_id"));
  return c.json({
    entries: rows.map((r) => ({
      kit: r.kit_id,
      reviewer: r.reviewer,
      rating: r.rating,
      comment: r.comment,
      isDefault: !!r.is_default,
      updatedAt: r.updated_at,
    })),
  });
});

/** PUT /design-review/entries — save one design's row for one reviewer. */
designReviewRoutes.put("/entries", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Expected JSON" }, 400);
  }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || "Invalid review" }, 400);
  }
  const r = parsed.data;
  const reviewer = r.reviewer.toLowerCase();
  // An empty row is a cleared row: keeping it would leave a reviewer's sheet
  // showing designs they had actually wiped.
  const blank = (r.rating ?? null) === null && !(r.comment || "").trim() && !r.isDefault;
  if (blank) {
    await c.env.DB.prepare("DELETE FROM design_reviews WHERE kit_id = ? AND reviewer = ?")
      .bind(r.kit, reviewer)
      .run();
    return c.json({ ok: true, cleared: true });
  }
  await c.env.DB.prepare(
    `INSERT INTO design_reviews (kit_id, reviewer, rating, comment, is_default, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kit_id, reviewer) DO UPDATE SET
       rating = excluded.rating,
       comment = excluded.comment,
       is_default = excluded.is_default,
       updated_at = excluded.updated_at`
  )
    .bind(r.kit, reviewer, r.rating ?? null, (r.comment || "").slice(0, 2000), r.isDefault ? 1 : 0, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

/** GET /design-review/summary — what the review actually concluded. */
designReviewRoutes.get("/summary", async (c) => {
  const rows = await all<{ kit_id: string; n: number; avg: number; picks: number }>(
    c.env.DB.prepare(
      `SELECT kit_id,
              COUNT(rating) AS n,
              ROUND(AVG(rating), 2) AS avg,
              SUM(is_default) AS picks
         FROM design_reviews
        GROUP BY kit_id
        ORDER BY picks DESC, avg DESC`
    )
  );
  return c.json({ designs: rows });
});
