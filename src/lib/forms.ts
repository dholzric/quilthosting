/** Form / survey field definitions with simple conditional visibility. */

export type FormFieldType = "text" | "textarea" | "select" | "checkbox" | "email" | "number";

export type ShowIf = {
  field: string;
  /** equals | not_equals | contains | not_empty */
  op?: "equals" | "not_equals" | "contains" | "not_empty";
  value?: string;
};

export type FormField = {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
  show_if?: ShowIf;
};

export function normalizeFormFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    let key = String(r.key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    if (!key) {
      const label = String(r.label || "").trim();
      key = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 40);
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = String(r.label || key).trim().slice(0, 120);
    if (!label) continue;
    const type = (
      ["text", "textarea", "select", "checkbox", "email", "number"].includes(String(r.type))
        ? String(r.type)
        : "text"
    ) as FormFieldType;
    const options =
      type === "select" && Array.isArray(r.options)
        ? r.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 40)
        : undefined;
    if (type === "select" && (!options || !options.length)) continue;
    let show_if: ShowIf | undefined;
    if (r.show_if && typeof r.show_if === "object") {
      const s = r.show_if as Record<string, unknown>;
      const field = String(s.field || "").trim();
      if (field) {
        const opRaw = String(s.op || "equals");
        const op = (
          ["equals", "not_equals", "contains", "not_empty"].includes(opRaw)
            ? opRaw
            : "equals"
        ) as ShowIf["op"];
        show_if = { field, op, value: s.value != null ? String(s.value) : undefined };
      }
    }
    out.push({
      key,
      label,
      type,
      required: !!r.required,
      options,
      show_if,
    });
    if (out.length >= 40) break;
  }
  return out;
}

export function fieldVisible(field: FormField, answers: Record<string, string>): boolean {
  const rule = field.show_if;
  if (!rule?.field) return true;
  const v = (answers[rule.field] ?? "").trim();
  const expected = (rule.value ?? "").trim();
  switch (rule.op || "equals") {
    case "not_empty":
      return v.length > 0;
    case "contains":
      return v.toLowerCase().includes(expected.toLowerCase());
    case "not_equals":
      return v !== expected;
    case "equals":
    default:
      return v === expected;
  }
}

export function validateFormAnswers(
  fields: FormField[],
  raw: unknown
): { ok: true; answers: Record<string, string> } | { ok: false; error: string } {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  // First pass: collect all raw strings
  const draft: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "boolean") draft[k] = v ? "yes" : "";
    else if (v != null) draft[k] = String(v).trim().slice(0, 2000);
  }
  const answers: Record<string, string> = {};
  for (const f of fields) {
    if (!fieldVisible(f, draft)) continue;
    const s = draft[f.key] || "";
    if (f.required && !s) {
      return { ok: false, error: `"${f.label}" is required` };
    }
    if (f.type === "select" && s && f.options && !f.options.includes(s)) {
      return { ok: false, error: `Invalid option for "${f.label}"` };
    }
    if (f.type === "email" && s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
      return { ok: false, error: `"${f.label}" must be a valid email` };
    }
    if (f.type === "number" && s && Number.isNaN(Number(s))) {
      return { ok: false, error: `"${f.label}" must be a number` };
    }
    if (s) answers[f.key] = s;
  }
  return { ok: true, answers };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}
