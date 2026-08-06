/** Personalize blast subject/body with merge fields (WA-style macros). */

export type MergeContext = {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  guild_name?: string | null;
  level_name?: string | null;
  end_date?: string | null;
};

const FIELD_ALIASES: Record<string, keyof MergeContext> = {
  first_name: "first_name",
  firstname: "first_name",
  first: "first_name",
  last_name: "last_name",
  lastname: "last_name",
  last: "last_name",
  email: "email",
  guild_name: "guild_name",
  guild: "guild_name",
  organization: "guild_name",
  level_name: "level_name",
  level: "level_name",
  membership_level: "level_name",
  end_date: "end_date",
  renewal_date: "end_date",
  expires: "end_date",
};

function formatValue(key: keyof MergeContext, ctx: MergeContext): string {
  const v = ctx[key];
  if (v == null || v === "") {
    if (key === "first_name") return "there";
    return "";
  }
  if (key === "end_date") {
    try {
      return new Date(v).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return String(v).slice(0, 10);
    }
  }
  return String(v);
}

/**
 * Replace {{field}} and {field} tokens (case-insensitive).
 * Unknown fields become empty string.
 */
export function applyMergeFields(template: string, ctx: MergeContext): string {
  if (!template) return template;
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|\{([a-zA-Z0-9_]+)\}/g,
    (_match, a: string, b: string) => {
      const raw = (a || b || "").toLowerCase();
      const key = FIELD_ALIASES[raw];
      if (!key) return "";
      return formatValue(key, ctx);
    }
  );
}

export type EmailLayout = "plain" | "newsletter" | "announcement";

/** Wrap body content in a branded layout (no drag-drop editor — simple templates). */
export function wrapEmailLayout(
  layout: EmailLayout,
  opts: {
    guildName: string;
    subject: string;
    bodyHtml: string;
  }
): string {
  const brand = "#b5501f";
  const paper = "#faf7f2";
  const ink = "#221f1a";
  const muted = "#8a847a";

  if (layout === "plain") {
    return `<div style="font-family:system-ui,sans-serif;line-height:1.6;max-width:600px;color:${ink}">${opts.bodyHtml}</div>`;
  }

  if (layout === "announcement") {
    return `
<div style="font-family:system-ui,sans-serif;background:${paper};padding:24px 12px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e7dfd2">
    <div style="background:${brand};color:#fff;padding:18px 24px;font-size:18px;font-weight:600">${escapeHtml(opts.guildName)}</div>
    <div style="padding:24px;line-height:1.65;color:${ink}">
      <h1 style="font-size:22px;margin:0 0 12px;color:${ink}">${escapeHtml(opts.subject)}</h1>
      ${opts.bodyHtml}
    </div>
    <div style="padding:14px 24px;background:#f4efe7;color:${muted};font-size:12px">
      Sent by ${escapeHtml(opts.guildName)} via QuiltHosting
    </div>
  </div>
</div>`.trim();
  }

  // newsletter
  return `
<div style="font-family:system-ui,sans-serif;background:${paper};padding:24px 12px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e7dfd2">
    <div style="height:6px;background:linear-gradient(90deg,${brand},#d9a441,#5f7d64,#5b7ea3,#8c5a74)"></div>
    <div style="padding:20px 24px 8px;border-bottom:1px solid #e7dfd2">
      <div style="font-size:13px;color:${muted};text-transform:uppercase;letter-spacing:0.06em">${escapeHtml(opts.guildName)}</div>
      <div style="font-size:20px;font-weight:600;color:${ink};margin-top:4px">${escapeHtml(opts.subject)}</div>
    </div>
    <div style="padding:24px;line-height:1.65;color:${ink}">
      ${opts.bodyHtml}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e7dfd2;color:${muted};font-size:12px">
      You're receiving this as a member of ${escapeHtml(opts.guildName)}.
    </div>
  </div>
</div>`.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert plain text (or light HTML) body into HTML paragraphs if needed. */
export function bodyToHtml(bodyHtml: string | undefined, bodyText: string | undefined): string {
  if (bodyHtml) return bodyHtml;
  const text = bodyText || "";
  return `<div style="font-family:system-ui,sans-serif;line-height:1.6">${text
    .split("\n")
    .map((p) => `<p style="margin:0 0 0.75em">${p || "&nbsp;"}</p>`)
    .join("")}</div>`;
}
