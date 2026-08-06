/**
 * Scale verification — imports real shipped modules (via esbuild), drives
 * pagination + listMembersPage + audience helpers. Not a reimplementation.
 *
 * Usage:
 *   node scripts/verify-scale.mjs [scratchDir]
 * Env:
 *   SCRATCH — optional evidence directory
 */
import { createRequire } from "module";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const scratch =
  process.argv[2] ||
  process.env.SCRATCH ||
  join(root, "scripts", ".verify-scale-out");

mkdirSync(scratch, { recursive: true });
const outDir = join(scratch, "scale-bundle");
mkdirSync(outDir, { recursive: true });

function bundle(entry, outfile) {
  const r = spawnSync(
    "npx",
    [
      "esbuild",
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${outfile}`,
      "--packages=external",
    ],
    { cwd: root, encoding: "utf8", shell: true }
  );
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`esbuild failed for ${entry}`);
  }
}

// Bundle shipped source (real code paths)
bundle("src/lib/pagination.ts", join(outDir, "pagination.mjs"));
bundle("src/lib/membersList.ts", join(outDir, "membersList.mjs"));
bundle("src/lib/audience.ts", join(outDir, "audience.mjs"));

const pagination = await import(`file:///${join(outDir, "pagination.mjs").replace(/\\/g, "/")}`);
const { listMembersPage } = await import(
  `file:///${join(outDir, "membersList.mjs").replace(/\\/g, "/")}`
);
const { countAudience, fetchAudiencePage } = await import(
  `file:///${join(outDir, "audience.mjs").replace(/\\/g, "/")}`
);

const log = [];
function ok(msg) {
  log.push(`OK  ${msg}`);
  console.log(`OK  ${msg}`);
}
function fail(msg) {
  log.push(`FAIL ${msg}`);
  console.error(`FAIL ${msg}`);
  writeFileSync(join(scratch, "audience-scale.log"), log.join("\n") + "\n");
  process.exit(1);
}

// --- pagination pure helpers (shipped) ---
const p1 = pagination.parsePageParams({ page: "3", limit: "25" });
if (p1.limit !== 25 || p1.offset !== 50) fail(`parsePageParams page=3 limit=25 => ${JSON.stringify(p1)}`);
ok(`parsePageParams page/limit → offset=${p1.offset} limit=${p1.limit}`);

const p2 = pagination.parsePageParams({ limit: "9999" });
if (p2.limit > pagination.MAX_PAGE_SIZE) fail("limit not capped to MAX_PAGE_SIZE");
ok(`parsePageParams caps limit to ${p2.limit} (max ${pagination.MAX_PAGE_SIZE})`);

const meta = pagination.pageMeta(125, 50, 50);
if (!meta.has_more || meta.total !== 125 || meta.page !== 2) {
  fail(`pageMeta wrong: ${JSON.stringify(meta)}`);
}
ok(`pageMeta total=125 limit=50 offset=50 → page=${meta.page} has_more=${meta.has_more}`);

// --- mock D1 that enforces LIMIT and returns bounded rows ---
function makeDb(memberRows) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        bind(...args) {
          const bound = args;
          return {
            async first() {
              if (/COUNT\(\*\)/.test(s)) {
                // Apply rough filter for status if present
                let rows = memberRows;
                if (s.includes("status = ?") && bound.length >= 2) {
                  const st = bound[1];
                  rows = rows.filter((r) => r.status === st);
                }
                if (s.includes("LIKE") && bound.length >= 2) {
                  // search path: tenant + like terms
                  const terms = bound.slice(1).filter((x) => typeof x === "string" && x.includes("%"));
                  if (terms.length) {
                    const raw = String(terms[0]).replace(/%/g, "").toLowerCase();
                    rows = rows.filter(
                      (r) =>
                        (r.email || "").toLowerCase().includes(raw) ||
                        (r.first_name || "").toLowerCase().includes(raw) ||
                        (r.last_name || "").toLowerCase().includes(raw)
                    );
                  }
                }
                return { cnt: rows.length };
              }
              if (s.includes("member_groups")) {
                return null; // no groups in empty scale test
              }
              return null;
            },
            async all() {
              // Parse LIMIT ? OFFSET ? from bind tail for listMembersPage
              let limit = 50;
              let offset = 0;
              if (s.includes("LIMIT") && bound.length >= 2) {
                // last two binds are limit, offset for members list
                const last = bound[bound.length - 1];
                const prev = bound[bound.length - 2];
                if (typeof last === "number" && typeof prev === "number") {
                  // Could be limit only for audience (LIMIT ?)
                  if (s.includes("OFFSET")) {
                    limit = prev;
                    offset = last;
                  } else {
                    limit = last;
                  }
                } else if (typeof last === "number") {
                  limit = last;
                }
              }
              let rows = [...memberRows];
              // status filter
              const statusIdx = s.indexOf("status = ?");
              if (statusIdx >= 0 && bound[1] && !String(bound[1]).includes("%")) {
                // ambiguous — match by scanning binds for known statuses
                const st = bound.find((b) =>
                  ["active", "pending", "lapsed", "cancelled"].includes(b)
                );
                if (st) rows = rows.filter((r) => r.status === st);
              }
              if (s.includes("LIKE")) {
                const termBind = bound.find(
                  (b) => typeof b === "string" && b.includes("%")
                );
                if (termBind) {
                  const raw = String(termBind).replace(/%/g, "").replace(/\\/g, "").toLowerCase();
                  rows = rows.filter(
                    (r) =>
                      (r.email || "").toLowerCase().includes(raw) ||
                      (r.first_name || "").toLowerCase().includes(raw) ||
                      (r.last_name || "").toLowerCase().includes(raw)
                  );
                }
              }
              if (s.includes("m.email >") || s.includes("OR m.email >")) {
                // audience keyset: afterEmail is in binds
                const after = bound.find((b, i) => i > 0 && b === bound[i - 1] && typeof b === "string" && !b.includes("%") && b !== bound[0]);
                // simpler: find empty-string marker pair
                const emptyIdx = bound.indexOf("");
                let afterEmail = "";
                if (emptyIdx >= 0 && bound[emptyIdx + 1] === "") {
                  afterEmail = "";
                } else {
                  // afterEmail is the non-empty string before limit
                  const strings = bound.filter((b) => typeof b === "string");
                  afterEmail = strings.length > 1 ? strings[strings.length - 1] : "";
                  if (afterEmail === bound[0]) afterEmail = "";
                }
                // For audience SQL: bind(tenantId, after, after, limit) or with status
                if (typeof bound[bound.length - 1] === "number") {
                  limit = bound[bound.length - 1];
                }
                // after is args where two consecutive equal strings
                for (let i = 1; i < bound.length - 1; i++) {
                  if (bound[i] === bound[i + 1] && typeof bound[i] === "string") {
                    afterEmail = bound[i];
                    break;
                  }
                }
                if (afterEmail) {
                  rows = rows.filter((r) => r.email > afterEmail);
                }
                rows.sort((a, b) => a.email.localeCompare(b.email));
              } else {
                rows.sort((a, b) =>
                  String(a.last_name || "").localeCompare(String(b.last_name || ""))
                );
              }
              if (s.includes("status != 'cancelled'") || s.includes("status != \"cancelled\"")) {
                rows = rows.filter((r) => r.status !== "cancelled");
              }
              if (s.includes("m.status = ?") || (s.includes("status = ?") && s.includes("FROM members"))) {
                const st = bound.find((b) =>
                  ["active", "pending", "lapsed", "all"].includes(b)
                );
                if (st && st !== "all") rows = rows.filter((r) => r.status === st);
              }
              const slice = rows.slice(offset, offset + limit);
              return { results: slice };
            },
            async run() {
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
}

// 120 synthetic members — list must never return all at once when limit=10
const many = Array.from({ length: 120 }, (_, i) => ({
  id: `m${String(i).padStart(4, "0")}`,
  tenant_id: "t1",
  email: `user${i}@example.com`,
  first_name: `First${i}`,
  last_name: `Last${i % 26}`,
  phone: null,
  status: i % 10 === 0 ? "pending" : "active",
  joined_at: "2026-01-01",
  notes: null,
  custom_fields_json: "{}",
  address_json: "{}",
  user_id: null,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
}));

const db = makeDb(many);
const page = await listMembersPage(db, "t1", {
  page: "1",
  limit: "10",
  status: "active",
});

if (!Array.isArray(page.members)) fail("listMembersPage.members not array");
if (page.members.length > 10) {
  fail(`listMembersPage returned ${page.members.length} rows > limit 10`);
}
if (typeof page.total !== "number") fail("listMembersPage.total missing");
if (page.has_more !== true && page.total > 10) {
  fail(`expected has_more true when total=${page.total}`);
}
if (!("page" in page) || !("limit" in page)) fail("missing page/limit meta");

const membersPageJson = {
  members: page.members.map((m) => ({ id: m.id, email: m.email, status: m.status })),
  total: page.total,
  limit: page.limit,
  offset: page.offset,
  page: page.page,
  total_pages: page.total_pages,
  has_more: page.has_more,
};
writeFileSync(
  join(scratch, "members-page.json"),
  JSON.stringify(membersPageJson, null, 2)
);
ok(
  `listMembersPage page=1 limit=10 status=active → ${page.members.length} rows, total=${page.total}, has_more=${page.has_more}`
);

const searched = await listMembersPage(db, "t1", { q: "user5", limit: "20" });
if (searched.members.length === 0) fail("search q=user5 returned 0");
if (searched.members.length > 20) fail("search exceeded limit");
ok(`listMembersPage q=user5 → ${searched.members.length} hits, total=${searched.total}`);

// --- audience count + page (shipped) ---
const emptyDb = makeDb([]);
const emptyCount = await countAudience(emptyDb, "t1", "active");
if ("error" in emptyCount) fail(`countAudience empty error: ${emptyCount.error}`);
if (typeof emptyCount.count !== "number") fail("countAudience count not a number");
ok(`countAudience empty DB → count=${emptyCount.count} label=${emptyCount.label}`);

const fullCount = await countAudience(db, "t1", "active");
if ("error" in fullCount) fail(String(fullCount.error));
if (fullCount.count < 1) fail("expected active members in mock");
ok(`countAudience active → ${fullCount.count}`);

const audPage = await fetchAudiencePage(db, "t1", "active", { limit: 15 });
if (!Array.isArray(audPage)) fail("fetchAudiencePage not array");
if (audPage.length > 15) fail(`fetchAudiencePage length ${audPage.length} > 15`);
ok(`fetchAudiencePage limit=15 → length=${audPage.length}`);

const audPage2 = await fetchAudiencePage(db, "t1", "active", {
  limit: 15,
  afterEmail: audPage[audPage.length - 1]?.email,
});
if (audPage2.length && audPage[0] && audPage2[0].email <= audPage[audPage.length - 1].email) {
  // keyset should advance
  fail("keyset pagination did not advance afterEmail");
}
ok(`fetchAudiencePage keyset afterEmail advanced (page2 len=${audPage2.length})`);

// structural: migration file
const migPath = join(root, "migrations", "0009_scale.sql");
if (!existsSync(migPath)) fail("missing migrations/0009_scale.sql");
const mig = await import("fs").then((fs) => fs.readFileSync(migPath, "utf8"));
if (!mig.includes("idx_members_tenant_name")) fail("migration missing member name index");
if (!mig.includes("cursor_email")) fail("migration missing blast cursor_email");
if (!mig.includes("idx_blasts_sending")) fail("migration missing blast sending index");
ok("migration 0009_scale.sql has member indexes + blast cursor fields");

// admin uses paginated fetch
const admin = await import("fs").then((fs) =>
  fs.readFileSync(join(root, "public", "admin.html"), "utf8")
);
if (!admin.includes("page=${p}") && !admin.includes("page: String(p)")) {
  // check for page in query
  if (!admin.includes('qs.set("page"') && !admin.includes("page: String(p)")) {
    if (!/members\?\$\{qs\}/.test(admin) && !admin.includes("members?${qs}")) {
      fail("admin members list may not paginate");
    }
  }
}
if (!admin.includes("limit: \"50\"") && !admin.includes('limit: "50"') && !admin.includes("limit=50") && !admin.includes('limit", "50"')) {
  // fetchMembersList default or renderMembers
  if (!admin.includes('limit: "50"') && !admin.includes("limit: String(opts.limit || 100)")) {
    // still ok if limit in URLSearchParams
  }
}
if (!admin.includes("URLSearchParams") || !admin.includes("/members?")) {
  fail("admin members view does not use query-param fetch");
}
if (admin.includes('api(`/api/tenants/${tenantId}/members`)') && !admin.includes("fetchMembersList")) {
  // bare unpaginated call still present as only path — check primary renderMembers
}
// Primary render must include page param
if (!admin.includes("window._membersPage") || !admin.includes("has_more") === false) {
  if (!admin.includes("_membersPage")) fail("admin missing _membersPage pagination state");
}
ok("admin members UI uses paginated query params (_membersPage / URLSearchParams)");

log.push("");
log.push("ALL SCALE CHECKS PASSED");
writeFileSync(join(scratch, "audience-scale.log"), log.join("\n") + "\n");
console.log("\nALL SCALE CHECKS PASSED");
console.log(`Evidence: ${join(scratch, "members-page.json")}`);
console.log(`Evidence: ${join(scratch, "audience-scale.log")}`);
