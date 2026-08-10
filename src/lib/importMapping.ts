/**
 * CSV column mapping for member import.
 *
 * Pure functions, no database access, so the most data-destructive path in the
 * product is directly testable. Previously this logic lived in the browser and
 * silently discarded every column it did not recognise.
 */

/** Native member fields an imported column can target. */
export const KNOWN_TARGETS = [
  "email",
  "first_name",
  "last_name",
  "phone",
  "status",
  "notes",
  "level_name",
  "end_date",
  "joined_at",
] as const;

export type KnownTarget = (typeof KNOWN_TARGETS)[number];

/**
 * Header synonyms, compared after normalizeHeader().
 * Copied verbatim from the previous client-side mapping in admin.html so
 * migration behaviour does not change for files that already worked.
 */
export const TARGET_SYNONYMS: Record<KnownTarget, string[]> = {
  email: ["email", "emailaddress", "mail"],
  first_name: ["firstname", "first"],
  last_name: ["lastname", "last", "surname"],
  phone: ["phone", "phonenumber", "mobile", "cellphone"],
  status: ["status", "membershipstatus"],
  notes: ["notes", "note", "comments"],
  level_name: [
    "level", "levelname", "membershiplevel", "membershiptype", "membershiplabel",
  ],
  end_date: [
    "enddate", "expiry", "expiration", "expirationdate", "renewaldate",
    "membershipexpires",
  ],
  joined_at: ["joined", "joinedat", "joindate", "membersince"],
};

export type MappingEntry =
  | { kind: "known"; target: KnownTarget }
  | { kind: "custom"; key: string; label: string }
  | { kind: "ignore" };

/**
 * Keyed by COLUMN INDEX, not header text. CSV headers are not unique — an
 * export can contain two "Notes" columns — and keying by string would
 * silently collapse them, which is the same class of bug this module exists
 * to fix.
 */
export type ImportMapping = Record<number, MappingEntry>;

export function normalizeHeader(h: string): string {
  return (h || "").toLowerCase().replace(/[^a-z]/g, "");
}

/** Header -> a safe custom-field key: lowercase, underscores, no leading digit. */
export function slugifyKey(h: string): string {
  const base = (h || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) return "field";
  return /^[0-9]/.test(base) ? `f_${base}` : base;
}

export function proposeMapping(
  header: string[],
  existingCustomFields: Array<{ key: string; label: string }>
): {
  mapping: ImportMapping;
  unmapped: Array<{ index: number; header: string }>;
  duplicates: Array<{ index: number; header: string; target: KnownTarget }>;
} {
  const mapping: ImportMapping = {};
  const unmapped: Array<{ index: number; header: string }> = [];
  const duplicates: Array<{ index: number; header: string; target: KnownTarget }> = [];
  const claimed = new Set<KnownTarget>();
  const usedKeys = new Set<string>();

  header.forEach((raw, index) => {
    const norm = normalizeHeader(raw);

    // Pass 1: known target by synonym.
    const target = (KNOWN_TARGETS as readonly string[]).find((t) =>
      TARGET_SYNONYMS[t as KnownTarget].includes(norm)
    ) as KnownTarget | undefined;

    if (target) {
      if (claimed.has(target)) {
        // First column claiming a target wins; report rather than drop silently.
        mapping[index] = { kind: "ignore" };
        duplicates.push({ index, header: raw, target });
        return;
      }
      claimed.add(target);
      mapping[index] = { kind: "known", target };
      return;
    }

    // Pass 2: an existing custom field, by key or by label.
    const existing = existingCustomFields.find(
      (f) => normalizeHeader(f.key) === norm || normalizeHeader(f.label) === norm
    );
    if (existing) {
      mapping[index] = { kind: "custom", key: existing.key, label: existing.label };
      usedKeys.add(existing.key);
      return;
    }

    // Pass 3: unknown. Ignored by default, but always reported so the admin
    // can promote it to a custom field.
    mapping[index] = { kind: "ignore" };
    unmapped.push({ index, header: raw });
  });

  return { mapping, unmapped, duplicates };
}

/** Split one positional row into native member fields and custom-field values. */
export function applyMapping(
  row: string[],
  mapping: ImportMapping
): { member: Record<string, string>; customFields: Record<string, string> } {
  const member: Record<string, string> = {};
  const customFields: Record<string, string> = {};

  for (const [idxRaw, entry] of Object.entries(mapping)) {
    const idx = Number(idxRaw);
    const value = row[idx];
    // A short row simply has no value for this column — never throw, and never
    // shift the remaining columns.
    if (value === undefined) continue;
    if (entry.kind === "known") member[entry.target] = value;
    else if (entry.kind === "custom") customFields[entry.key] = value;
  }
  return { member, customFields };
}

/**
 * Ensure a proposed custom key does not collide with an existing definition
 * or another new one in the same import. Returns the key to actually use.
 */
export function uniqueCustomKey(
  desired: string,
  taken: Set<string>
): string {
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired}_${n}`)) n++;
  return `${desired}_${n}`;
}
