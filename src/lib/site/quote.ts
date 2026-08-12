// The customer-facing quote/estimate page and its signed-copy view. This is
// the only page a customer sees before they have any account or session —
// their access token IS the auth, so every render here has to be safe to
// show to an anonymous holder of a capability URL.
//
// escapeHtml is reused from ../blocks (Task 7's export), not redefined here.
// This feature already has one private duplicate of the same four
// replacements (src/lib/email/merge.ts); a third copy in this file would be
// exactly the kind of drift the SHA-256 note on hash.ts warns against.

import { escapeHtml } from "../blocks";
import { buildRootVars } from "./theme";
import { readTenantTheme } from "./themeMigrate";
import { CONSENT_TEXT } from "../projects/agreement";
import { formatMoney } from "../utils/money";
import type { Project, ProjectLine, AgreementSignature, Tenant } from "../../types";

function shell(tenant: Tenant, title: string, bodyHtml: string): string {
  const { theme, fonts } = readTenantTheme(tenant.settings_json);
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/qh-site.css">
<style>:root{${buildRootVars(theme, fonts)}}
@media print{.qh-no-print{display:none}}</style>
</head><body class="qh-quote">${bodyHtml}</body></html>`;
}

function linesTable(lines: ProjectLine[], totalCents: number): string {
  const rows = lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.description)}</td><td>${escapeHtml(
          String(l.quantity)
        )}</td><td>${escapeHtml(formatMoney(l.amount_cents))}</td></tr>`
    )
    .join("");
  return `<table class="qh-quote-lines">
<thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><th colspan="2">Total</th><th>${escapeHtml(formatMoney(totalCents))}</th></tr></tfoot></table>`;
}

function parseSettings(settingsJson: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(settingsJson || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function renderInvalidLink(tenant: Tenant): string {
  // Deliberately identical for an unknown token and an expired one -- see
  // src/routes/site.ts's route branch. Distinguishing the two here would
  // undo the point of returning the same response upstream.
  return shell(
    tenant,
    "Link no longer valid",
    `<main class="qh-quote-main"><h1>This link is no longer valid</h1>
<p>Please contact ${escapeHtml(tenant.name)} for an up-to-date link.</p></main>`
  );
}

export function renderQuotePage(args: {
  tenant: Tenant;
  project: Project;
  lines: ProjectLine[];
  baseUrl: string;
}): string {
  const { tenant, project, lines } = args;
  const settings = parseSettings(tenant.settings_json);
  const longarm = (settings.longarm || {}) as { agreementTitle?: string; agreementBody?: string };
  const title = longarm.agreementTitle || "Service Agreement";

  return shell(
    tenant,
    `Estimate ${project.reference}`,
    `<main class="qh-quote-main">
<h1>Estimate ${escapeHtml(project.reference)}</h1>
<p>Prepared for ${escapeHtml(project.customer_name)}</p>
${linesTable(lines, project.total_cents)}
${project.estimate_notes ? `<p class="qh-quote-notes">${escapeHtml(project.estimate_notes)}</p>` : ""}
<section class="qh-agreement"><h2>${escapeHtml(title)}</h2>
<pre class="qh-agreement-body">${escapeHtml(longarm.agreementBody || "")}</pre></section>
<form id="qh-sign" class="qh-no-print">
  <label>Type your full name to sign
    <input name="signer_name" required maxlength="200" autocomplete="name">
  </label>
  <label><input type="checkbox" name="consent" required> ${escapeHtml(CONSENT_TEXT)}</label>
  <button type="submit" class="btn">Sign agreement</button>
  <p class="qh-sign-status" role="status"></p>
</form>
<script>
(function(){
  var f=document.getElementById('qh-sign');
  var s=f.querySelector('.qh-sign-status');
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var btn=f.querySelector('button'); btn.disabled=true;
    fetch(location.pathname+'/sign',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({signer_name:f.signer_name.value,consent:f.consent.checked})
    }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(res){
        if(!res.ok){btn.disabled=false;s.textContent=res.j.error||'Something went wrong.';return;}
        location.reload();
      })
      .catch(function(){btn.disabled=false;s.textContent='Something went wrong. Please try again.';});
  });
})();
</script>
</main>`
  );
}

export function renderSignedCopy(args: {
  tenant: Tenant;
  project: Project;
  lines: ProjectLine[];
  signature: AgreementSignature;
  baseUrl: string;
}): string {
  const { tenant, project, lines, signature } = args;
  return shell(
    tenant,
    `Signed agreement ${project.reference}`,
    `<main class="qh-quote-main">
<h1>Signed agreement ${escapeHtml(project.reference)}</h1>
${linesTable(lines, project.total_cents)}
<section class="qh-agreement"><h2>${escapeHtml(signature.agreement_title)}</h2>
<pre class="qh-agreement-body">${escapeHtml(signature.agreement_text)}</pre></section>
<section class="qh-signature">
  <p>Signed by <strong>${escapeHtml(signature.signer_name)}</strong> on ${escapeHtml(signature.signed_at)}</p>
  <p>${escapeHtml(signature.consent_text)}</p>
  <p class="qh-hash">Document fingerprint (SHA-256): <code>${escapeHtml(signature.agreement_sha256)}</code></p>
</section>
<button class="btn qh-no-print" onclick="window.print()">Print / Save PDF</button>
</main>`
  );
}
