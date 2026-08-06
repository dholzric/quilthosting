/**
 * Minimal RFC 5545 (.ics) generation — no dependencies.
 * Used for guild event feeds and per-event "Add to calendar" downloads.
 */

export type IcalEvent = {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start_at: string;
  end_at?: string | null;
  url?: string;
  updated_at?: string | null;
};

/** Escape per RFC 5545 §3.3.11 (order matters: backslash first). */
function esc(v: string): string {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** UTC basic format: 20261013T183000Z */
function toIcsDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    "Z"
  );
}

/** Fold long lines to 75 octets with a leading space on continuations. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let idx = 0;
  while (idx < line.length) {
    const take = idx === 0 ? 75 : 74;
    out.push((idx === 0 ? "" : " ") + line.slice(idx, idx + take));
    idx += take;
  }
  return out.join("\r\n");
}

export function buildIcs(
  calendarName: string,
  events: IcalEvent[],
  opts: { domain?: string } = {}
): string {
  const domain = opts.domain || "quilthosting.com";
  const stamp = toIcsDate(new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//QuiltHosting//Guild Events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calendarName)}`,
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const ev of events) {
    const start = toIcsDate(ev.start_at);
    if (!start) continue;
    // Default to a 2-hour block when no end time is set
    const end = ev.end_at
      ? toIcsDate(ev.end_at)
      : toIcsDate(new Date(new Date(ev.start_at).getTime() + 2 * 3600_000).toISOString());
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.id}@${domain}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${start}`);
    if (end) lines.push(`DTEND:${end}`);
    lines.push(fold(`SUMMARY:${esc(ev.title)}`));
    if (ev.description) lines.push(fold(`DESCRIPTION:${esc(ev.description)}`));
    if (ev.location) lines.push(fold(`LOCATION:${esc(ev.location)}`));
    if (ev.url) lines.push(fold(`URL:${esc(ev.url)}`));
    if (ev.updated_at) {
      const seq = toIcsDate(ev.updated_at);
      if (seq) lines.push(`LAST-MODIFIED:${seq}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

export function icsResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=900",
    },
  });
}
