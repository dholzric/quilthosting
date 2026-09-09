/**
 * src/lib/households.ts — household memberships, and the one place that
 * decides whether a person is an active member.
 *
 * A household is one payment, one membership row, and N people. The
 * membership belongs to the PAYER; everybody else's membership is DERIVED:
 *
 *     a person is an active member if they have an active membership of
 *     their own, OR they are in a household whose payer has one.
 *
 * That sentence used to be written out longhand as `status = 'active'` in
 * half a dozen queries — the roster, the public directory, the member-photo
 * route, the portal, event member pricing, and the plan cap. Six copies of a
 * rule is six chances for a household spouse to be a member on the directory
 * and a stranger at the door. So the rule is written ONCE here, as a SQL
 * fragment (`activeMembershipFilter`) that drops in exactly where those
 * comparisons used to sit, and `src/lib/households.test.ts` asserts that no
 * other SQL in src/routes or src/lib decides membership on its own.
 *
 * WHY A CASE AND NOT AN OR. The obvious fragment is "own status is active OR
 * the payer's membership is active", but that can only ever ADD members, and
 * the case that matters is subtraction: when a payer's membership lapses,
 * `src/lib/renewals.ts` flips the PAYER's members.status to 'lapsed' and
 * never touches the people who were riding on that payment. An OR would
 * leave them active forever. So a non-payer household member's activeness is
 * read from a MEMBERSHIP ROW — the payer's, or one of their own if they also
 * bought one — and never from their own stale members.status; everyone else
 * keeps the members.status test the rest of the product has always used.
 *
 * NOTHING HERE IS INFERRED. A household exists because someone said so in
 * the join form, the admin, or an import column — never because two rows
 * share a surname or an address.
 */
import type { Env } from "../types";
import { all, first } from "./db";
import { generateId } from "./utils/id";

export type HouseholdRole = "payer" | "member";

export type HouseholdPerson = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: HouseholdRole;
};

export type Household = {
  id: string;
  name: string;
  payer_member_id: string;
  members: HouseholdPerson[];
};

/**
 * Hard ceiling on people in one household, enforced by the levels editor and
 * by every add path. A "household" of fifty is a chapter, and a chapter is
 * already a tenant relationship (see src/routes/chapters.ts).
 */
export const MAX_HOUSEHOLD_PEOPLE = 12;

/** Table/column aliases are interpolated, so they must be plain identifiers. */
const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertAlias(alias: string): string {
  if (!ALIAS_RE.test(alias)) {
    throw new Error(`activeMembershipFilter: "${alias}" is not a SQL identifier`);
  }
  return alias;
}

/**
 * The SQL fragment for "this person is an active member", written against a
 * `members` alias. Takes no bind parameters, so it is a drop-in replacement
 * for the `<alias>.status = 'active'` it supersedes; the caller keeps its own
 * tenant_id binding.
 *
 *     `SELECT ... FROM members m WHERE m.tenant_id = ? AND ${activeMembershipFilter("m")}`
 *
 * The alias must expose `id`, `tenant_id` and `status`, which every row of
 * `members` does. Household lookups are correlated on tenant_id as well as
 * member id so a household can never reach across tenants.
 */
export function activeMembershipFilter(memberAlias: string): string {
  const a = assertAlias(memberAlias);
  return `(CASE WHEN EXISTS (
    SELECT 1 FROM household_members qh_hm
      JOIN households qh_h ON qh_h.id = qh_hm.household_id
                          AND qh_h.tenant_id = ${a}.tenant_id
     WHERE qh_hm.member_id = ${a}.id AND qh_hm.role <> 'payer'
  ) THEN (EXISTS (
    SELECT 1 FROM household_members qh_hm2
      JOIN households qh_h2 ON qh_h2.id = qh_hm2.household_id
                           AND qh_h2.tenant_id = ${a}.tenant_id
      JOIN memberships qh_ms ON qh_ms.member_id = qh_h2.payer_member_id
                            AND qh_ms.tenant_id = qh_h2.tenant_id
                            AND qh_ms.status = 'active'
     WHERE qh_hm2.member_id = ${a}.id
  ) OR EXISTS (
    SELECT 1 FROM memberships qh_own
     WHERE qh_own.member_id = ${a}.id AND qh_own.tenant_id = ${a}.tenant_id
       AND qh_own.status = 'active'
  )) ELSE ${a}.status = 'active' END)`;
}

/** The same question, for one member, in TypeScript. */
export async function isActiveMember(
  db: D1Database,
  tenantId: string,
  memberId: string
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db
      .prepare(
        `SELECT 1 AS ok FROM members m
         WHERE m.id = ? AND m.tenant_id = ? AND ${activeMembershipFilter("m")}`
      )
      .bind(memberId, tenantId)
  );
  return !!row;
}

/**
 * What a level charges for a household of `people` (the payer included).
 *
 * price_cents buys the first person; each additional person adds
 * household_add_cents, which is 0 on every level that has not been edited —
 * plenty of guilds want "couples join together" at a flat rate. A level with
 * household_max = 1 has no household price: `people` is clamped to at least
 * one, so an individual level always quotes its own price.
 */
export function householdPriceCents(
  level: { price_cents: number; household_add_cents?: number | null },
  people: number
): number {
  const base = Math.max(0, Math.round(Number(level.price_cents) || 0));
  const add = Math.max(0, Math.round(Number(level.household_add_cents) || 0));
  const count = Math.max(1, Math.floor(Number(people) || 1));
  return base + add * (count - 1);
}

/** How many people this level's household holds (1 = an individual level). */
export function householdMax(level: { household_max?: number | null }): number {
  const n = Math.floor(Number(level.household_max) || 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_HOUSEHOLD_PEOPLE, n);
}

/** True when this level sells a household rather than one person. */
export function isHouseholdLevel(level: { household_max?: number | null }): boolean {
  return householdMax(level) > 1;
}

/**
 * The statements that create a household, as a list the caller can commit in
 * the same batch as the member rows it references. `memberIds` are the
 * non-payer people; the payer gets the 'payer' row.
 */
export function buildCreateHouseholdStatements(
  db: D1Database,
  params: {
    tenantId: string;
    householdId: string;
    name: string;
    payerMemberId: string;
    memberIds: string[];
    now: string;
  }
): D1PreparedStatement[] {
  const { tenantId, householdId, name, payerMemberId, memberIds, now } = params;
  const stmts = [
    db
      .prepare(
        `INSERT INTO households (id, tenant_id, name, payer_member_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(householdId, tenantId, name, payerMemberId, now, now),
    db
      .prepare(
        `INSERT INTO household_members (household_id, member_id, role, added_at)
         VALUES (?, ?, 'payer', ?)`
      )
      .bind(householdId, payerMemberId, now),
  ];
  for (const id of memberIds) {
    if (id === payerMemberId) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO household_members (household_id, member_id, role, added_at)
           VALUES (?, ?, 'member', ?)`
        )
        .bind(householdId, id, now)
    );
  }
  return stmts;
}

/**
 * Create a household in one batch. Returns its id.
 *
 * The UNIQUE (member_id) index on household_members is what stops a person
 * belonging to two households, so a second attempt to enrol someone fails the
 * whole batch rather than half-writing a household.
 */
export async function createHousehold(
  db: D1Database,
  tenantId: string,
  payerMemberId: string,
  name: string,
  memberIds: string[],
  now: string
): Promise<string> {
  const householdId = generateId();
  await db.batch(
    buildCreateHouseholdStatements(db, {
      tenantId,
      householdId,
      name,
      payerMemberId,
      memberIds,
      now,
    })
  );
  return householdId;
}

/**
 * Move an existing member into an existing household.
 *
 * Throws when the household is full or belongs to another tenant, and lets
 * the UNIQUE (member_id) index reject anyone who is already in a household —
 * the check-then-insert would otherwise race with a concurrent join.
 */
export async function addToHousehold(
  db: D1Database,
  tenantId: string,
  householdId: string,
  memberId: string,
  now: string,
  maxPeople = MAX_HOUSEHOLD_PEOPLE
): Promise<void> {
  const household = await first<{ id: string }>(
    db
      .prepare("SELECT id FROM households WHERE id = ? AND tenant_id = ?")
      .bind(householdId, tenantId)
  );
  if (!household) throw new Error("Household not found");

  const member = await first<{ id: string }>(
    db
      .prepare("SELECT id FROM members WHERE id = ? AND tenant_id = ?")
      .bind(memberId, tenantId)
  );
  if (!member) throw new Error("Member not found");

  const countRow = await first<{ cnt: number }>(
    db
      .prepare("SELECT COUNT(*) AS cnt FROM household_members WHERE household_id = ?")
      .bind(householdId)
  );
  if ((countRow?.cnt ?? 0) >= Math.min(MAX_HOUSEHOLD_PEOPLE, Math.max(1, maxPeople))) {
    throw new Error("This household is full");
  }

  await db
    .prepare(
      `INSERT INTO household_members (household_id, member_id, role, added_at)
       VALUES (?, ?, 'member', ?)`
    )
    .bind(householdId, memberId, now)
    .run();
}

/**
 * Take someone out of a household without deleting them.
 *
 * Their membership was DERIVED from the payer, so it ends the moment the
 * household_members row goes: the same statement therefore drops them to
 * 'lapsed' unless they hold a membership of their own. Without that they
 * would fall back to the plain `members.status = 'active'` branch of
 * activeMembershipFilter and stay a member off the back of a payment nobody
 * made for them.
 *
 * Removing the PAYER dissolves the household — there is exactly one payer by
 * design, and a household with none would leave everybody's membership
 * deriving from a person who is no longer there.
 */
export async function removeFromHousehold(
  db: D1Database,
  tenantId: string,
  memberId: string,
  now: string
): Promise<void> {
  const row = await first<{ household_id: string; role: string; payer_member_id: string }>(
    db
      .prepare(
        `SELECT hm.household_id, hm.role, h.payer_member_id
           FROM household_members hm
           JOIN households h ON h.id = hm.household_id
          WHERE hm.member_id = ? AND h.tenant_id = ?`
      )
      .bind(memberId, tenantId)
  );
  if (!row) return; // Not in a household: nothing to undo.

  const dissolving = row.role === "payer" || row.payer_member_id === memberId;

  /** Drop a derived member to 'lapsed' unless they pay for themselves. */
  const lapse = (id: string) =>
    db
      .prepare(
        `UPDATE members SET status = 'lapsed', updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM memberships ms
              WHERE ms.tenant_id = ? AND ms.member_id = ? AND ms.status = 'active'
           )`
      )
      .bind(now, id, tenantId, tenantId, id);

  if (dissolving) {
    const people = await all<{ member_id: string; role: string }>(
      db
        .prepare("SELECT member_id, role FROM household_members WHERE household_id = ?")
        .bind(row.household_id)
    );
    const stmts: D1PreparedStatement[] = [];
    for (const p of people) {
      if (p.member_id === row.payer_member_id) continue;
      stmts.push(lapse(p.member_id));
    }
    stmts.push(
      db.prepare("DELETE FROM household_members WHERE household_id = ?").bind(row.household_id),
      db
        .prepare("DELETE FROM households WHERE id = ? AND tenant_id = ?")
        .bind(row.household_id, tenantId),
      db
        .prepare(
          `UPDATE memberships SET household_id = NULL, updated_at = ?
           WHERE tenant_id = ? AND household_id = ?`
        )
        .bind(now, tenantId, row.household_id)
    );
    await db.batch(stmts);
    return;
  }

  await db.batch([
    lapse(memberId),
    db
      .prepare("DELETE FROM household_members WHERE household_id = ? AND member_id = ?")
      .bind(row.household_id, memberId),
  ]);
}

/** The household this member belongs to, payer first, or null. */
export async function householdFor(
  db: D1Database,
  tenantId: string,
  memberId: string
): Promise<Household | null> {
  const head = await first<{ id: string; name: string; payer_member_id: string }>(
    db
      .prepare(
        `SELECT h.id, h.name, h.payer_member_id
           FROM household_members hm
           JOIN households h ON h.id = hm.household_id
          WHERE hm.member_id = ? AND h.tenant_id = ?`
      )
      .bind(memberId, tenantId)
  );
  if (!head) return null;
  const members = await all<HouseholdPerson>(
    db
      .prepare(
        `SELECT m.id, m.email, m.first_name, m.last_name, hm.role
           FROM household_members hm
           JOIN members m ON m.id = hm.member_id AND m.tenant_id = ?
          WHERE hm.household_id = ?
          ORDER BY CASE hm.role WHEN 'payer' THEN 0 ELSE 1 END,
                   m.last_name COLLATE NOCASE, m.first_name COLLATE NOCASE, m.email`
      )
      .bind(tenantId, head.id)
  );
  return { id: head.id, name: head.name, payer_member_id: head.payer_member_id, members };
}

/**
 * Household name + id for a page of members, keyed by member id — one query
 * for the whole roster page rather than one per row.
 */
export async function householdsForMembers(
  db: D1Database,
  tenantId: string,
  memberIds: string[]
): Promise<Map<string, { id: string; name: string; role: HouseholdRole }>> {
  const out = new Map<string, { id: string; name: string; role: HouseholdRole }>();
  const ids = [...new Set(memberIds.filter((id) => typeof id === "string" && id))];
  if (!ids.length) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await all<{ member_id: string; id: string; name: string; role: string }>(
    db
      .prepare(
        `SELECT hm.member_id, h.id, h.name, hm.role
           FROM household_members hm
           JOIN households h ON h.id = hm.household_id
          WHERE h.tenant_id = ? AND hm.member_id IN (${placeholders})`
      )
      .bind(tenantId, ...ids)
  );
  for (const r of rows) {
    out.set(r.member_id, {
      id: r.id,
      name: r.name,
      role: r.role === "payer" ? "payer" : "member",
    });
  }
  return out;
}

/** True when this member already belongs to some household in this tenant. */
export async function inAnyHousehold(
  db: D1Database,
  tenantId: string,
  memberId: string
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db
      .prepare(
        `SELECT 1 AS ok FROM household_members hm
           JOIN households h ON h.id = hm.household_id
          WHERE hm.member_id = ? AND h.tenant_id = ?`
      )
      .bind(memberId, tenantId)
  );
  return !!row;
}

/**
 * Which of these emails already belong to a household in this tenant.
 * Used by the join form so "Dana is already in the Alvarez household" is a
 * 409 with a name in it, not a UNIQUE-constraint stack trace.
 */
export async function emailsAlreadyInHousehold(
  db: D1Database,
  tenantId: string,
  emails: string[]
): Promise<string[]> {
  const list = [...new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean))];
  if (!list.length) return [];
  const placeholders = list.map(() => "?").join(", ");
  const rows = await all<{ email: string }>(
    db
      .prepare(
        `SELECT m.email FROM members m
           JOIN household_members hm ON hm.member_id = m.id
           JOIN households h ON h.id = hm.household_id AND h.tenant_id = m.tenant_id
          WHERE m.tenant_id = ? AND m.email IN (${placeholders})`
      )
      .bind(tenantId, ...list)
  );
  return rows.map((r) => r.email);
}

/**
 * Welcome the people a payer just bought a membership for.
 *
 * Each one gets their OWN magic-link sign-in, because the whole point of a
 * household level is that the second quilter is a member in her own right:
 * she can sign in, appear in the directory and register at member prices.
 * Only the payer gets the payment receipt — nobody else was charged, and a
 * receipt for someone else's card is at best confusing.
 *
 * Best effort by design: this runs after the payment is committed, and a
 * bounced welcome must never cost anybody their membership. Failures are
 * logged and swallowed per person.
 */
export async function sendHouseholdWelcomes(
  env: Env,
  params: {
    tenantId: string;
    payerMemberId: string;
    guildName: string;
    slug: string;
  }
): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };
  const household = await householdFor(env.DB, params.tenantId, params.payerMemberId);
  if (!household) return result;

  const [{ sendEmail, magicLinkEmail }, { issueMagicToken, revokeAuthToken }] =
    await Promise.all([import("./email"), import("./auth")]);
  const baseUrl = env.APP_URL || "http://localhost:8787";

  for (const person of household.members) {
    if (person.role === "payer") continue;
    try {
      const email = person.email.toLowerCase().trim();
      const existing = await first<{ id: string; email: string; name: string | null }>(
        env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?").bind(email)
      );
      const now = new Date().toISOString();
      const user = existing ?? { id: generateId(), email, name: null };
      const { token, jti } = await issueMagicToken(env.DB, env.JWT_SECRET, user);
      const loginUrl = `${baseUrl}/auth/verify?token=${token}&slug=${encodeURIComponent(
        params.slug
      )}`;
      const { subject, html } = magicLinkEmail({ guildName: params.guildName, loginUrl });
      const sent = await sendEmail(env, {
        to: email,
        subject: `You're a member of ${params.guildName}`,
        html: `<p>${escapeHtml(household.name)} now has a membership with ${escapeHtml(
          params.guildName
        )}, and you are on it. Use the link below to sign in to your own member portal.</p>${html}`,
      });
      if (!sent.success) {
        await revokeAuthToken(env.DB, jti);
        result.failed++;
        continue;
      }
      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, null, ?, ?)`
        )
          .bind(user.id, email, now, now)
          .run();
      }
      // subject is overridden above; magicLinkEmail's own subject is unused.
      void subject;
      result.sent++;
    } catch (e) {
      console.warn("household welcome failed", e);
      result.failed++;
    }
  }
  return result;
}

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string
  );
}
