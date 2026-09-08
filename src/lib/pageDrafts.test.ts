// src/lib/pageDrafts.test.ts
// Pure helpers behind the draft/publish workflow: row serialisation,
// legacy-revision block recovery, and the redirect statement set a slug
// rename produces.
import { describe, it, expect } from "vitest";
import {
  serializePage,
  revisionBlocks,
  revisionOf,
  slugRedirectStatements,
  revisionSnapshotStatement,
  pruneRevisionsStatement,
  MAX_PAGE_REVISIONS,
  type PageRecord,
} from "./pageDrafts";

function recordingDb() {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql: sql.replace(/\s+/g, " ").trim(), binds });
          return { __sql: sql };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const base: PageRecord = {
  id: "p1",
  slug: "about",
  title: "About",
  content_json: JSON.stringify({ html: "<p>legacy</p>" }),
  blocks_json: JSON.stringify([{ type: "divider" }]),
  is_members_only: 0,
  published: 1,
  sort_order: 0,
  updated_at: "2026-09-01T00:00:00.000Z",
};

describe("serializePage", () => {
  it("parses blocks, reports has_draft=0 and draft_blocks=null with no draft", () => {
    const out = serializePage(base);
    expect(out.blocks).toEqual([{ type: "divider" }]);
    expect(out.has_draft).toBe(0);
    expect(out.draft_blocks).toBeNull();
    expect(out.revision).toBe(1); // pre-0025 row -> default
  });

  it("parses draft_blocks and reports has_draft=1 when a draft exists (even an empty one)", () => {
    const out = serializePage({ ...base, draft_blocks_json: "[]", revision: 7 });
    expect(out.has_draft).toBe(1);
    expect(out.draft_blocks).toEqual([]);
    expect(out.revision).toBe(7);
  });

  it("malformed JSON degrades to [] rather than throwing", () => {
    const out = serializePage({ ...base, blocks_json: "{not json", draft_blocks_json: "nope" });
    expect(out.blocks).toEqual([]);
    expect(out.draft_blocks).toEqual([]);
  });
});

describe("revisionOf", () => {
  it("defaults to 1 for missing/zero/garbage", () => {
    expect(revisionOf({})).toBe(1);
    expect(revisionOf({ revision: 0 })).toBe(1);
    expect(revisionOf({ revision: null })).toBe(1);
    expect(revisionOf({ revision: 12 })).toBe(12);
  });
});

describe("revisionBlocks", () => {
  it("prefers blocks_json", () => {
    expect(revisionBlocks({ blocks_json: JSON.stringify([{ type: "divider" }]), content_json: '{"html":"<p>x</p>"}' })).toEqual([
      { type: "divider" },
    ]);
  });

  it("wraps legacy content_json HTML in a sanitized html block", () => {
    const out = revisionBlocks({ blocks_json: null, content_json: JSON.stringify({ html: "<p>hi</p><script>x()</script>" }) });
    expect(out).toEqual([{ type: "html", html: "<p>hi</p>" }]);
  });

  it("returns [] for a blank legacy body", () => {
    expect(revisionBlocks({ blocks_json: null, content_json: JSON.stringify({ html: "   " }) })).toEqual([]);
    expect(revisionBlocks({ blocks_json: null, content_json: null })).toEqual([]);
  });
});

describe("slugRedirectStatements", () => {
  it("produces drop-from-new, re-point-chains, and upsert old->new, in that order", () => {
    const { db, calls } = recordingDb();
    const stmts = slugRedirectStatements(db, "t1", "old", "new", "now");
    expect(stmts).toHaveLength(3);
    expect(calls[0].sql).toBe("DELETE FROM page_redirects WHERE tenant_id = ? AND from_slug = ?");
    expect(calls[0].binds).toEqual(["t1", "new"]);
    expect(calls[1].sql).toBe("UPDATE page_redirects SET to_slug = ? WHERE tenant_id = ? AND to_slug = ?");
    expect(calls[1].binds).toEqual(["new", "t1", "old"]);
    expect(calls[2].sql).toMatch(/^INSERT INTO page_redirects/);
    expect(calls[2].sql).toContain("ON CONFLICT(tenant_id, from_slug) DO UPDATE");
    expect(calls[2].binds).toEqual(["t1", "old", "new", "now"]);
  });

  it("is a no-op for an unchanged or blank slug", () => {
    const { db } = recordingDb();
    expect(slugRedirectStatements(db, "t1", "same", "same", "now")).toEqual([]);
    expect(slugRedirectStatements(db, "t1", "", "new", "now")).toEqual([]);
  });
});

describe("revisionSnapshotStatement / pruneRevisionsStatement", () => {
  it("the snapshot insert is guarded on the expected revision", () => {
    const { db, calls } = recordingDb();
    revisionSnapshotStatement(db, {
      id: "r1",
      tenantId: "t1",
      page: base,
      kind: "publish",
      createdBy: "u1",
      now: "now",
      expectedRevision: 3,
    });
    expect(calls[0].sql).toContain("WHERE EXISTS (SELECT 1 FROM pages WHERE id = ? AND tenant_id = ? AND revision = ?)");
    expect(calls[0].binds).toEqual(["r1", "t1", "p1", "publish", "About", base.blocks_json, base.content_json, "u1", "now", "p1", "t1", 3]);
  });

  it("prune keeps the newest MAX_PAGE_REVISIONS", () => {
    const { db, calls } = recordingDb();
    pruneRevisionsStatement(db, "t1", "p1");
    expect(calls[0].sql).toContain(`LIMIT ${MAX_PAGE_REVISIONS}`);
    expect(MAX_PAGE_REVISIONS).toBe(50);
    expect(calls[0].binds).toEqual(["t1", "p1", "p1"]);
  });
});
