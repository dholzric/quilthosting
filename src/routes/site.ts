// src/routes/site.ts
// Serves a business tenant's public website: pages, sitemap, robots.

import type { Context } from "hono";
import type { Env, Tenant, Project, ProjectLine, AgreementSignature } from "../types";
import { all, first } from "../lib/db";
import { renderPageHtml, readBranding } from "../lib/site/render";
import { cachedRender } from "../lib/site/cache";
import { tenantPublicBaseUrl } from "../lib/tenantHost";
import { renderQuotePage, renderSignedCopy, renderInvalidLink, renderCannotSign } from "../lib/site/quote";
import { hashToken } from "../lib/projects/token";
import { assertTransition } from "../lib/projects/status";
import type { ProjectStatus } from "../lib/projects/types";
import { buildAgreementSnapshot, CONSENT_TEXT, type AgreementSnapshotLine } from "../lib/projects/agreement";
import { sha256Hex } from "../lib/projects/hash";
import { sendEmail } from "../lib/email";
import { escapeHtml } from "../lib/blocks";
import { generateId } from "../lib/utils/id";

// A shop that never finished configuring its agreement can't produce a
// signable estimate -- shown on GET and enforced again on POST (Task 10 fix
// round 1, Minor #3).
const EMPTY_AGREEMENT_MESSAGE =
  "This shop has not finished setting up a service agreement for this estimate yet. Please check back soon.";

/**
 * A customer-safe explanation for every project status other than
 * 'estimated' -- the only status assertTransition() allows a transition to
 * 'signed' from. Used both when rendering the GET page (so the sign form is
 * never shown for a project that can't accept a signature) and inside
 * signQuote's assertTransition catch block, so a customer is NEVER handed
 * the raw internal string an Error("Illegal transition: a -> b") carries
 * (Task 10 fix round 1, Minor #2).
 */
function cannotSignMessage(status: string): string {
  switch (status) {
    case "declined":
      return "This estimate was declined and is no longer available for signature.";
    case "cancelled":
      return "This project was cancelled and is no longer available for signature.";
    case "submitted":
      return "This project has not been estimated yet. Please check back soon.";
    case "signed":
      return "This estimate has already been signed.";
    case "in_progress":
      return "This project is already in progress.";
    case "completed":
      return "This project has already been completed.";
    default:
      return "This estimate is not currently available for signature.";
  }
}

type PageRow = {
  id: string;
  slug: string;
  title: string;
  content_json: string | null;
  blocks_json: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_image_file_id: string | null;
  noindex: number;
  updated_at: string;
};

/** Shared by the GET quote render and the POST sign handler, so both build
 * the agreement title/body from tenant.settings_json the exact same way --
 * that identical construction is what makes the render-time hash and the
 * sign-time hash comparable at all. */
function readAgreementFields(tenant: Tenant): { title: string; body: string } {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {
    settings = {};
  }
  const longarm = (settings.longarm || {}) as { agreementTitle?: string; agreementBody?: string };
  return {
    title: longarm.agreementTitle || "Service Agreement",
    body: longarm.agreementBody || "",
  };
}

async function loadNav(env: Env, tenant: Tenant) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {
    settings = {};
  }
  const explicit = Array.isArray(settings.nav) ? settings.nav : [];
  if (explicit.length) {
    return explicit
      .filter((n) => typeof n === "object" && n !== null)
      .map((n: Record<string, unknown>) => ({
        label: String(n.label || "").slice(0, 60),
        href: String(n.href || "").slice(0, 500),
        external: !!n.external,
      }))
      .filter((n) => n.label && n.href)
      .slice(0, 20);
  }
  const rows = await all<{ slug: string; title: string; nav_label: string | null }>(
    env.DB.prepare(
      `SELECT slug, title, nav_label FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND coalesce(show_in_nav, 1) = 1 AND coalesce(page_type, 'page') = 'page'
       ORDER BY sort_order, title`
    ).bind(tenant.id)
  );
  return rows.map((r) => ({
    label: r.nav_label || r.title,
    href: r.slug ? `/${r.slug}` : "/",
  }));
}

/**
 * Serve a public site path. Returns null when the path is not a site page so
 * the caller can fall through to the platform's own routes.
 */
export async function serveBusinessSite(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant
): Promise<Response | null> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const host = c.req.header("host") || url.host;
  const baseUrl = tenantPublicBaseUrl(c.env, tenant, host);

  if (path === "/robots.txt") {
    // A launched business site is meant to be crawled. Point at its own
    // sitemap, not the platform's.
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Tenant-uploaded images (logo, OG image, and anything else uploaded
  // through the Files admin page). tenant_id in the WHERE clause is what
  // stops one tenant's file id from reading another tenant's image -- see
  // siteGate's TENANT_IMAGE_PATH_RE for the allowlist that lets this path
  // shape through the private-preview gate in the first place.
  const imgMatch = path.match(/^\/img\/([A-Za-z0-9_-]{1,64})$/);
  if (imgMatch) {
    const fileRow = await first<{ r2_key: string; content_type: string | null }>(
      c.env.DB.prepare(
        `SELECT r2_key, content_type FROM files WHERE id = ? AND tenant_id = ?`
      ).bind(imgMatch[1], tenant.id)
    );
    if (!fileRow) return new Response("Not found", { status: 404 });
    // Security: this route is served on the tenant's own first-party
    // origin, so echoing back whatever content_type was recorded at upload
    // time (fileRoutes.post("/") accepts ANY Content-Type a caller with
    // upload rights sends) would let a stored `text/html` file execute as
    // same-origin script on the tenant's live site -- stored XSS, not
    // cross-tenant, but real. A route named /img/ has no legitimate reason
    // to serve anything but an actual raster image, so this allowlists the
    // handful of real image types and 404s on everything else rather than
    // guessing or falling back to a default. image/svg+xml is deliberately
    // EXCLUDED: SVG is active content (it can carry inline <script>) and
    // would reopen the same hole even though its MIME type looks image-y.
    const ALLOWED_IMAGE_TYPES = new Set([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/avif",
    ]);
    const contentType = fileRow.content_type || "";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      return new Response("Not found", { status: 404 });
    }
    const obj = await c.env.FILES.get(fileRow.r2_key);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": contentType,
        // Belt-and-suspenders alongside the allowlist above: even if a
        // browser tried to sniff the body into a different interpretation
        // than the declared (already-allowlisted) type, this forbids it.
        "X-Content-Type-Options": "nosniff",
        // File ids are immutable -- a replaced image gets a new id, so this
        // can be cached forever without a purge.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (path === "/sitemap.xml") {
    const rows = await all<{ slug: string; updated_at: string }>(
      c.env.DB.prepare(
        `SELECT slug, updated_at FROM pages
         WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
           AND coalesce(noindex, 0) = 0
         ORDER BY sort_order, title`
      ).bind(tenant.id)
    );
    const urls = rows
      .map((r) => {
        const loc = r.slug ? `${baseUrl}/${r.slug}` : `${baseUrl}/`;
        return `<url><loc>${loc}</loc><lastmod>${(r.updated_at || "").slice(0, 10)}</lastmod></url>`;
      })
      .join("");
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
      { headers: { "Content-Type": "application/xml; charset=utf-8" } }
    );
  }

  // Customer quote page. Matched BEFORE the page-slug lookup below.
  //
  // There is no collision with a page whose slug is "quote": a page slug is
  // one path segment, this is two, and pages.ts's slugify strips "/", so
  // "quote/<token>" can never equal a stored slug. No reserved-slug
  // machinery is needed.
  //
  // No siteGate change is required either: rule 5 already passes any path
  // that is not a reserved platform prefix, and "quote" is not in
  // PLATFORM_PATH_PREFIXES (src/lib/platformPaths.ts:53).
  const quoteMatch = path.match(/^\/quote\/([A-Za-z0-9_-]{20,120})$/);
  const signMatch = path.match(/^\/quote\/([A-Za-z0-9_-]{20,120})\/sign$/);

  if (quoteMatch || signMatch) {
    const rawToken = (quoteMatch || signMatch)![1];
    const tokenHash = await hashToken(rawToken);
    // Scoped to the resolved (Host-header) tenant, not just the token hash.
    // access_token_hash is already globally unique (idx_projects_token_hash),
    // so this AND is defense in depth rather than the only thing preventing
    // a token minted for tenant A from resolving on tenant B's host -- but
    // it also means a request that reaches the wrong tenant's host for a
    // given token fails the SAME way as an unknown token, not with a
    // different error, which matters for property 4 below.
    const project = await first<Project>(
      c.env.DB.prepare(
        `SELECT * FROM projects WHERE access_token_hash = ? AND tenant_id = ?`
      ).bind(tokenHash, tenant.id)
    );

    // Looked up BEFORE the expiry gate below. A signed project's customer
    // must always be able to retrieve their own copy of what they agreed to
    // -- the one thing this whole table exists to answer -- independent of
    // the access token's normal 90-day TTL (Task 9's resend-link window).
    // Without this reorder, the token going stale after a signature already
    // exists would 404 the customer out of their own signed record forever
    // (Task 10 fix round 1, Important #3).
    //
    // Issued UNCONDITIONALLY -- binding "" when there is no project -- not
    // guarded behind `if (project)`. Guarding it made an unknown token cost
    // one round trip and an expired-unsigned token cost two, even though
    // both return byte-identical responses: a timing oracle for "this token
    // existed once" that fix round 1 introduced by accident (fix round 2,
    // Finding 3). No project has id "", so this is a real query that always
    // finds nothing when `project` is null, rather than a conditional skip.
    const signature = await first<AgreementSignature>(
      c.env.DB.prepare(
        `SELECT * FROM agreement_signatures WHERE project_id = ? AND tenant_id = ?`
      ).bind(project?.id ?? "", tenant.id)
    );

    const expired =
      !!project?.token_expires_at &&
      new Date(project.token_expires_at).getTime() < Date.now();

    // Invalid and expired-with-no-signature return the SAME response, same
    // status. Distinguishing them would let the endpoint be probed to learn
    // which tokens exist (or existed). Expired-WITH-a-signature is NOT
    // folded into this branch -- see the comment above.
    if (!project || (expired && !signature)) {
      return new Response(renderInvalidLink(tenant), {
        status: 404,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex",
        },
      });
    }

    if (signMatch) {
      if (c.req.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      return signQuote(c, tenant, project, tokenHash);
    }

    let html: string;
    if (signature) {
      // Signed copy renders from the signature row alone -- see quote.ts's
      // renderSignedCopy for why (Important #2). No project_lines query.
      html = renderSignedCopy({ tenant, project, signature, baseUrl });
    } else if (project.status !== "estimated") {
      // A terminal (or not-yet-estimated) status can never legally reach
      // 'signed' -- assertTransition() would refuse it anyway, but showing
      // a full sign form the customer can fill in and submit only to be
      // rejected on POST is a bad UX and, worse, an unnecessary place for an
      // internal transition string to almost leak (Minor #2).
      html = renderCannotSign(tenant, project, cannotSignMessage(project.status));
    } else {
      const { title: agreementTitle, body: agreementBody } = readAgreementFields(tenant);
      if (!agreementBody.trim()) {
        // A shop that never wrote terms has nothing for a customer to agree
        // to -- refuse to render the signing form (Minor #3).
        html = renderCannotSign(tenant, project, EMPTY_AGREEMENT_MESSAGE);
      } else {
        const lines = await all<ProjectLine>(
          c.env.DB.prepare(
            `SELECT * FROM project_lines WHERE project_id = ? ORDER BY sort_order`
          ).bind(project.id)
        );
        // Hash the EXACT snapshot being rendered below, using the same
        // buildAgreementSnapshot() call signQuote uses to rebuild it at POST
        // time -- including the SAME line items, so a re-itemise between
        // this render and the POST is caught the same way an edited
        // agreement body is (Important #1). The hash is round-tripped
        // through a hidden form field so the POST can prove (see signQuote)
        // that the text about to be signed matches what was on screen when
        // the customer clicked -- not whatever happens to be live by the
        // time the request arrives.
        const snapshotLines: AgreementSnapshotLine[] = lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitCents: l.unit_cents,
          amountCents: l.amount_cents,
        }));
        const snapshot = buildAgreementSnapshot({
          title: agreementTitle,
          body: agreementBody,
          project: {
            reference: project.reference,
            customerName: project.customer_name,
            totalCents: project.total_cents,
          },
          lines: snapshotLines,
        });
        const agreementSha256 = await sha256Hex(snapshot);
        html = renderQuotePage({
          tenant,
          project,
          lines,
          baseUrl,
          agreementTitle,
          agreementBody,
          agreementSha256,
        });
      }
    }

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The token is in the URL path. Without this, any outbound link the
        // customer clicks hands their quote to a third party in a Referer
        // header.
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex",
        "Cache-Control": "no-store",
      },
    });
  }

  const slug = path === "/" ? "" : path.replace(/^\/+/, "").replace(/\/+$/, "");
  // Home page convention: an empty slug, or a page explicitly named "home".
  const row = await first<PageRow>(
    c.env.DB.prepare(
      `SELECT id, slug, title, content_json, blocks_json, seo_title, seo_description,
              og_image_file_id, coalesce(noindex, 0) AS noindex, updated_at
       FROM pages
       WHERE tenant_id = ? AND published = 1 AND is_members_only = 0
         AND slug = ?
       LIMIT 1`
    ).bind(tenant.id, slug || "home")
  );

  if (!row) return null;

  const nav = await loadNav(c.env, tenant);
  const { showPlatformCredit } = readBranding(tenant.settings_json);

  let logoFileId = "";
  try {
    logoFileId = String(
      (JSON.parse(tenant.settings_json || "{}").assets || {}).logo_file_id || ""
    );
  } catch {
    logoFileId = "";
  }
  const logoUrl = logoFileId ? `${baseUrl}/img/${logoFileId}` : null;
  const ogImageUrl = row.og_image_file_id ? `${baseUrl}/img/${row.og_image_file_id}` : null;

  return cachedRender({
    host,
    path,
    // Folds in tenant.updated_at, not just the page's own updated_at:
    // business identity (name/phone/address), the logo file id, and nav all
    // live in tenant.settings_json, not on the pages row, and
    // src/routes/tenants.ts's PATCH handler bumps tenants.updated_at
    // unconditionally on every settings save (tenants.ts:167-168). Without
    // this, saving Business Details wouldn't change the cache key at all --
    // the owner could edit her phone number, save, reload, and see nothing
    // change for up to the 24h edge TTL, with no way to force a refresh.
    //
    // Each component is percent-encoded BEFORE being joined with ":", not
    // after -- siteCacheKey only applies one outer encodeURIComponent to
    // the whole string it's handed, so an unescaped ":" here would rely on
    // neither timestamp ever containing a literal ":" itself to stay
    // injective. Both today's formats (SQLite's `datetime('now')` and
    // `Date.prototype.toISOString()`) happen to start "YYYY-MM-DD" before
    // any colon, so a collision can't actually happen right now -- but
    // that's an unenforced property of two unrelated timestamp formats, not
    // something this code guarantees. Encoding each side first turns any
    // ":" or "%" inside either raw value into %3A / %25, so the two
    // components can never be reparsed into a different (page, tenant)
    // pair no matter what either timestamp format does later.
    updatedAt: `${encodeURIComponent(row.updated_at)}:${encodeURIComponent(tenant.updated_at)}`,
    build: () =>
      renderPageHtml({
        tenant: { name: tenant.name, slug: tenant.slug, settings_json: tenant.settings_json },
        page: {
          title: row.title,
          slug: slug,
          seo_title: row.seo_title,
          seo_description: row.seo_description,
          og_image_file_id: row.og_image_file_id,
          noindex: row.noindex,
          content_json: row.content_json,
          blocks_json: row.blocks_json,
        },
        nav,
        baseUrl,
        logoUrl,
        ogImageUrl,
        showPlatformCredit,
      }),
  });
}

/**
 * POST /quote/:token/sign — the e-signature ceremony.
 *
 * Idempotent by design AND by schema. The pre-check below (SELECT before
 * INSERT) is only a fast path for the common case -- a double-click or a
 * client retry -- and is deliberately NOT trusted to be race-free on its
 * own: two concurrent POSTs for the same project can both pass that SELECT
 * before either INSERT lands. This feature has already had four
 * check-then-act races land as bugs (the reference counter, the member
 * upsert in send-estimate, the intake_json optimistic-concurrency link, and
 * this endpoint's own INSERT-vs-UNIQUE-index race from fix round 1), so the
 * actual guarantee here is the UNIQUE index on agreement_signatures
 * (project_id) plus `ON CONFLICT(project_id) DO NOTHING RETURNING id`:
 * exactly one concurrent request gets a row back and is the one that
 * performs the status transition and sends notifications. Every other
 * request -- whether it lost the pre-check or lost the INSERT itself --
 * returns the same { ok: true, already_signed: true } response.
 */
async function signQuote(
  c: Context<{ Bindings: Env }>,
  tenant: Tenant,
  project: Project,
  tokenHash: string
): Promise<Response> {
  const existing = await first<AgreementSignature>(
    c.env.DB.prepare(
      `SELECT * FROM agreement_signatures WHERE project_id = ? AND tenant_id = ?`
    ).bind(project.id, tenant.id)
  );
  if (existing) {
    return c.json({ ok: true, already_signed: true });
  }

  const body = await c.req
    .json<{ signer_name?: string; consent?: boolean; agreement_sha256?: string }>()
    .catch(() => ({}) as { signer_name?: string; consent?: boolean; agreement_sha256?: string });
  const signerName = String(body.signer_name || "").trim().slice(0, 200);
  if (!signerName) return c.json({ error: "Type your full name to sign" }, 400);
  if (body.consent !== true) return c.json({ error: "You must agree to the terms" }, 400);

  try {
    assertTransition(project.status as ProjectStatus, "signed");
  } catch {
    // NEVER return the raw Error("Illegal transition: a -> b") string to an
    // anonymous token holder -- it's an internal implementation detail, not
    // customer-facing copy (Minor #2). cannotSignMessage() gives the same
    // status-aware explanation the GET page would have shown instead of the
    // sign form in the first place.
    return c.json({ error: cannotSignMessage(project.status) }, 409);
  }

  const { title: agreementTitle, body: agreementBody } = readAgreementFields(tenant);
  if (!agreementBody.trim()) {
    // Mirrors the GET-side refusal (Minor #3): a shop with no configured
    // terms has nothing for the customer to be signing.
    return c.json({ error: EMPTY_AGREEMENT_MESSAGE }, 409);
  }

  // Re-queried live, not trusted from whatever the GET rendered a moment
  // ago -- exactly like agreementTitle/agreementBody above. A shop can
  // re-itemise a project's line items (PUT /projects/:id/lines has no
  // status guard) between the customer loading the page and clicking Sign;
  // folding the live lines into the same snapshot/hash the GET page hashed
  // is what makes that edit show up as a hash mismatch below instead of
  // silently signing a different breakdown than the one on screen
  // (Important #1).
  const liveLines = await all<ProjectLine>(
    c.env.DB.prepare(
      `SELECT * FROM project_lines WHERE project_id = ? ORDER BY sort_order`
    ).bind(project.id)
  );
  const snapshotLines: AgreementSnapshotLine[] = liveLines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unitCents: l.unit_cents,
    amountCents: l.amount_cents,
  }));

  // Rebuilt from whatever is live in tenant settings AND live project_lines
  // right now -- the same way the GET handler built it moments ago to
  // render the page this POST is a response to. Those two builds are only
  // guaranteed to match if nothing changed settings.longarm or the line
  // items in between, which is exactly what the hash comparison below
  // verifies before anything is persisted: the signature must attest to the
  // text (and the pricing breakdown) that was actually on screen, not to
  // whatever happens to be live by the time the request lands.
  const snapshot = buildAgreementSnapshot({
    title: agreementTitle,
    body: agreementBody,
    project: {
      reference: project.reference,
      customerName: project.customer_name,
      totalCents: project.total_cents,
    },
    lines: snapshotLines,
  });
  const hash = await sha256Hex(snapshot);

  // Fail closed, same discipline as the price gate: a missing or malformed
  // submitted hash is treated as a mismatch, never as "no opinion, sign
  // whatever is live". This is what turns "the shop edited the agreement (or
  // re-itemised the lines) between page load and click" from a silent,
  // undetectable gap into a rejected request the customer's browser
  // automatically reloads to re-review. It proves the text hashed is the
  // text that was rendered to the browser -- it does not, and cannot, prove
  // the human actually read it before clicking Sign; that is not a claim
  // any server-side check can make.
  const submittedHash =
    typeof body.agreement_sha256 === "string" ? body.agreement_sha256.trim() : "";
  if (!submittedHash || submittedHash !== hash) {
    return c.json(
      {
        error:
          "This agreement has been updated since you loaded this page. Please reload and review it before signing.",
      },
      409
    );
  }

  const now = new Date().toISOString();

  const insertStmt = c.env.DB.prepare(
    `INSERT INTO agreement_signatures
       (id, tenant_id, project_id, signer_name, signer_email, consent_text,
        agreement_title, agreement_text, agreement_sha256, signing_token_hash,
        signer_ip, signer_user_agent, signed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO NOTHING
     RETURNING id`
  ).bind(
    generateId(),
    tenant.id,
    project.id,
    signerName,
    project.customer_email,
    CONSENT_TEXT,
    agreementTitle,
    snapshot,
    hash,
    tokenHash,
    c.req.header("cf-connecting-ip") || null,
    (c.req.header("user-agent") || "").slice(0, 500) || null,
    now
  );

  const updateStmt = c.env.DB.prepare(
    // The status predicate is load-bearing twice over (Important #4, the
    // feature's FIFTH check-then-act race): it's what stops an owner's
    // concurrent cancel/decline -- landing between this request's earlier
    // assertTransition() read and this write -- from being silently
    // reverted back to 'signed' underneath them, and it's what keeps this
    // statement SAFE to run unconditionally in the same batch as the INSERT
    // even when the INSERT no-ops for a race loser: DO NOTHING'd INSERT +
    // WHERE-guarded UPDATE are each independently self-correct regardless of
    // whether the other one actually changed anything this time.
    `UPDATE projects SET status = 'signed', signed_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'estimated'`
  ).bind(now, now, project.id, tenant.id);

  // Run together as ONE batch/transaction, not as two sequential round
  // trips. Sequential calls left a window where the INSERT could commit and
  // the UPDATE could then fail (worker eviction, transient D1 error) --
  // leaving a permanently-orphaned signature attached to a project stuck in
  // 'estimated', because every later POST short-circuits on the `existing`
  // pre-check above and never revisits the status write.
  const [insertResult] = await c.env.DB.batch<{ id: string }>([insertStmt, updateStmt]);
  const inserted = insertResult.results[0] ?? null;

  if (!inserted) {
    // Lost the race at the database level: some other concurrent request's
    // INSERT won. This is the normal, expected outcome of a double-click or
    // retry racing another in-flight request -- not an error -- so the loser
    // must NOT re-run the status transition or send a second pair of emails.
    return c.json({ ok: true, already_signed: true });
  }

  // The customer's own permanent copy, independent of any link surviving:
  // full agreement text (already includes the line items, per Important
  // #1) plus the fingerprint that proves it hasn't been altered since. If
  // this email is lost, the signed page itself remains reachable forever
  // now (Important #3's expiry-gate fix) -- but the shop should not be the
  // only party holding a durable copy.
  const requestUrl = new URL(c.req.url);
  const quoteUrl = `${requestUrl.origin}${requestUrl.pathname.replace(/\/sign$/, "")}`;
  await sendEmail(c.env, {
    to: project.customer_email,
    subject: `Signed — ${project.reference}`,
    html: `<p>Thank you. Your agreement for ${escapeHtml(project.reference)} is signed.</p>
<p>For your records, here is the complete agreement you signed:</p>
<pre style="white-space:pre-wrap;font-family:inherit;border:1px solid #ddd;padding:12px">${escapeHtml(snapshot)}</pre>
<p>Document fingerprint (SHA-256): <code>${escapeHtml(hash)}</code></p>
<p><a href="${escapeHtml(quoteUrl)}">View your signed agreement online</a></p>`,
  }).catch(() => undefined);

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(tenant.settings_json || "{}");
  } catch {
    settings = {};
  }
  const ownerEmail = (settings.business as { email?: string } | undefined)?.email;
  if (ownerEmail) {
    await sendEmail(c.env, {
      to: ownerEmail,
      subject: `${project.reference} signed by ${signerName}`,
      html: `<p>${escapeHtml(signerName)} signed ${escapeHtml(project.reference)}.</p>`,
    }).catch(() => undefined);
  }

  return c.json({ ok: true });
}
