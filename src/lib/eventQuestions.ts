export type EventQuestion = {
  key: string;
  label: string;
  type: "text" | "select";
  required?: boolean;
  options?: string[];
};

export type EventSettings = {
  questions?: EventQuestion[];
};

export function parseEventSettings(settingsJson: string | null | undefined): EventSettings {
  try {
    const o = JSON.parse(settingsJson || "{}");
    if (!o || typeof o !== "object") return {};
    return o as EventSettings;
  } catch {
    return {};
  }
}

export function normalizeQuestions(raw: unknown): EventQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: EventQuestion[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    let key = String(r.key || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
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
    const type = r.type === "select" ? "select" : "text";
    const options =
      type === "select" && Array.isArray(r.options)
        ? r.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 40)
        : undefined;
    if (type === "select" && (!options || !options.length)) continue;
    out.push({
      key,
      label,
      type,
      required: !!r.required,
      options,
    });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Filter and validate answers against defined questions.
 * Returns filtered answers or an error message.
 */
export function validateAnswers(
  questions: EventQuestion[],
  raw: unknown
): { ok: true; answers: Record<string, string> } | { ok: false; error: string } {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const v = input[q.key];
    const s = v == null ? "" : String(v).trim().slice(0, 500);
    if (q.required && !s) {
      return { ok: false, error: `"${q.label}" is required` };
    }
    if (q.type === "select" && s && q.options && !q.options.includes(s)) {
      return { ok: false, error: `Invalid option for "${q.label}"` };
    }
    if (s) answers[q.key] = s;
  }
  return { ok: true, answers };
}
