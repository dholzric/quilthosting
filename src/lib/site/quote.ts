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
  // The title/body actually rendered below, and the SHA-256 of the exact
  // buildAgreementSnapshot() string built from them -- computed by the
  // caller (src/routes/site.ts) using the SAME function and the SAME inputs
  // signQuote will use to rebuild the snapshot at POST time. Round-tripped
  // through a hidden field so the POST can prove the text it is about to
  // hash and sign is the text that was actually on screen when the customer
  // clicked -- not merely "whatever is live in settings right now", which
  // could have changed underneath them between page load and click.
  //
  // This proves the text HASHED is the text RENDERED. It does not, and
  // cannot, prove the human actually read it -- that is a claim no
  // client-side mechanism can make, and this code does not pretend to.
  agreementTitle: string;
  agreementBody: string;
  agreementSha256: string;
}): string {
  const { tenant, project, lines, agreementTitle, agreementBody, agreementSha256 } = args;

  return shell(
    tenant,
    `Estimate ${project.reference}`,
    `<main class="qh-quote-main">
<h1>Estimate ${escapeHtml(project.reference)}</h1>
<p>Prepared for ${escapeHtml(project.customer_name)}</p>
${linesTable(lines, project.total_cents)}
${project.estimate_notes ? `<p class="qh-quote-notes">${escapeHtml(project.estimate_notes)}</p>` : ""}
<section class="qh-agreement"><h2>${escapeHtml(agreementTitle)}</h2>
<pre class="qh-agreement-body">${escapeHtml(agreementBody)}</pre></section>
<form id="qh-sign" class="qh-no-print">
  <input type="hidden" name="agreement_sha256" value="${escapeHtml(agreementSha256)}">
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
      body:JSON.stringify({
        signer_name:f.signer_name.value,
        consent:f.consent.checked,
        agreement_sha256:f.agreement_sha256.value
      })
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
