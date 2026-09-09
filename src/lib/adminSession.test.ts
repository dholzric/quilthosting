// src/lib/adminSession.test.ts
//
// Which guild the admin opens on is decided by three pieces of per-device
// state in public/admin.html: gb_tenant_id (the last guild selected),
// gb_firstrun (a wizard left open here) and the token. Each one outlives the
// session that wrote it, so each needs a rule about when it stops applying —
// otherwise a platform admin, who is a member of every guild, lands on the
// same one forever with no route back to the picker.
//
// Source assertions, like adminNavGating.test.ts: the admin is a static page
// with no build step, so these read the real file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN = readFileSync(path.join(REPO_ROOT, "public/admin.html"), "utf8").replace(/\r\n/g, "\n");

function fnSource(name: string): string {
  const m = new RegExp(`\\n {4}(?:async )?function ${name}\\(`).exec(ADMIN);
  if (!m) throw new Error(`function ${name} not found in admin.html`);
  const rest = ADMIN.slice(m.index + 1);
  const end = rest.slice(1).search(/\n {4}(?:async function |function |const |let |window\.|\/\*)/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe("admin.html — which guild you land on", () => {
  it("signing in clears the last selection, so a platform admin gets the picker", () => {
    const login = fnSource("doLogin");
    expect(login).toContain('localStorage.removeItem("gb_tenant_id")');
    expect(login).toContain("tenantId = null");
    // The global has to be cleared too: enterApp() reads the variable, not storage.
    expect(login.indexOf("tenantId = null")).toBeLessThan(login.indexOf("await enterApp()"));
  });

  it("enterApp still resumes the last guild on a reload (that path is not a sign-in)", () => {
    const enter = fnSource("enterApp");
    expect(enter).toContain("isPlatformAdmin && !forcePicker && tenantId && guilds.some");
  });

  it("a finished wizard never reopens — the server's done flag wins over the local marker", () => {
    const resume = fnSource("resumeFirstRun");
    expect(resume).toContain("if (state.done)");
    const doneAt = resume.indexOf("if (state.done)");
    // Checked before the wizard takes over the screen.
    expect(doneAt).toBeGreaterThan(-1);
    expect(doneAt).toBeLessThan(resume.indexOf("frAdoptTenant("));
    expect(resume.slice(doneAt, doneAt + 200)).toContain("removeItem(FR_MARKER)");
  });

  it("signing out clears every per-device pointer, the wizard marker included", () => {
    const out = fnSource("logout");
    for (const key of ['"gb_token"', "FR_MARKER", '"gb_tenant_id"', '"gb_tenant_slug"', '"gb_platform_admin"']) {
      expect(out, key).toContain(`localStorage.removeItem(${key})`);
    }
  });
});
