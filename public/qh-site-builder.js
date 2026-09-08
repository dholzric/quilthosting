/* public/qh-site-builder.js — business tenant site builder screens.
 * Page list, appearance (theme presets), domain & launch, business details
 * and the site menu. The page EDITOR itself is shared with the guild
 * builder: window.qhOpenPageEditor / window.qhNavEditor live in admin.html.
 * DOM APIs only, no HTML string injection (same rule as qh-admin-ext.js).
 * Relies on globals from admin.html: api(), tenantId, tenantSlug, show(),
 * hide(), qhOpenPageEditor(), qhNavEditor(), canWriteArea(), applyReadOnlyState().
 *
 * Note on API paths: every route in this file is under /api/tenants/... .
 * The `api()` helper (defined in admin.html) does no path rewriting -- it is
 * a thin fetch(API + path) wrapper.
 */
(function () {
  function e(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function field(labelText, node) {
    const wrap = e("div", "field");
    const label = e("label", "", labelText);
    wrap.appendChild(label);
    wrap.appendChild(node);
    return wrap;
  }
  function input(value, placeholder) {
    const n = document.createElement("input");
    if (value != null) n.value = value;
    if (placeholder) n.placeholder = placeholder;
    return n;
  }
  function button(label, cls, onClick) {
    const b = e("button", cls || "", label);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  // Two-click arm pattern (no window.confirm). Returns true on the second click.
  function armed(btn, label) {
    if (btn.dataset.armed === "1") return true;
    btn.dataset.armed = "1";
    btn.dataset.label = btn.textContent;
    btn.textContent = label;
    btn.classList.add("wb-armed");
    setTimeout(function () {
      if (btn.isConnected && btn.dataset.armed === "1") {
        btn.dataset.armed = "";
        btn.textContent = btn.dataset.label;
        btn.classList.remove("wb-armed");
      }
    }, 4000);
    return false;
  }
  function pagePath(slug) {
    return !slug || slug === "home" ? "/" : "/" + slug;
  }
  function finishReadOnly(page) {
    if (typeof applyReadOnlyState === "function") applyReadOnlyState(page);
  }

  // ---- Pages -------------------------------------------------------------
  let showTrash = false;

  async function renderPages(root) {
    root.replaceChildren();
    const head = e("div", "wb-head");
    const titleBox = e("div");
    titleBox.appendChild(e("h2", "", "Website pages"));
    titleBox.appendChild(e("p", "muted", "Edits stay private until you click Publish. Deleted pages go to the trash first."));
    head.appendChild(titleBox);
    const actions = e("div", "wb-head-actions");
    // The business site is served on the tenant host, never on the admin origin.
    const tenant = (typeof currentTenant !== "undefined" && currentTenant) || {};
    const siteHost = tenant.custom_domain ? "https://" + tenant.custom_domain : "https://" + tenantSlug + ".quilthosting.com";
    const previewSite = e("a", "btn secondary", "Open site ↗");
    previewSite.href = siteHost + "/";
    previewSite.target = "_blank";
    previewSite.rel = "noopener";
    previewSite.title = "Opens your site on its own address";
    actions.appendChild(previewSite);
    const add = button("New page", "", function () {
      window.qhOpenPageEditor(null, { tenantType: "business", onBack: function () { renderPages(root); } });
    });
    add.setAttribute("data-write", "");
    actions.appendChild(add);
    head.appendChild(actions);
    root.appendChild(head);

    const card = e("div", "card");
    root.appendChild(card);
    const tabs = e("div", "wb-tabs");
    tabs.setAttribute("role", "tablist");
    const tabPages = button("Pages", "secondary" + (showTrash ? "" : " on"), function () { showTrash = false; renderPages(root); });
    tabPages.setAttribute("role", "tab");
    const tabTrash = button("Trash", "secondary" + (showTrash ? " on" : ""), function () { showTrash = true; renderPages(root); });
    tabTrash.setAttribute("role", "tab");
    tabs.appendChild(tabPages);
    tabs.appendChild(tabTrash);
    card.appendChild(tabs);

    const msg = e("p", "muted");
    msg.style.fontSize = "0.85rem";
    msg.setAttribute("aria-live", "polite");

    // GET /api/tenants/:id/pages returns a bare array (see pages.ts).
    let pages = [];
    try {
      const data = await api("/api/tenants/" + tenantId + "/pages" + (showTrash ? "?trash=1" : ""));
      pages = (Array.isArray(data) ? data : data.pages || []).filter(function (p) { return (p.page_type || "page") !== "blog_post"; });
    } catch (err) {
      msg.textContent = err.message;
    }
    tabPages.textContent = "Pages" + (showTrash ? "" : " (" + pages.length + ")");
    if (showTrash) tabTrash.textContent = "Trash (" + pages.length + ")";

    const table = e("table", "wb-pages-list");
    const thead = e("thead");
    const hr = e("tr");
    ["Title", "Address", "Status", "Updated", ""].forEach(function (h) { hr.appendChild(e("th", "", h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = e("tbody");
    table.appendChild(tbody);
    if (!pages.length) {
      const tr = e("tr");
      const td = e("td", "muted", showTrash ? "Trash is empty." : "No pages yet — click “New page” to start.");
      td.colSpan = 5;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    pages.forEach(function (pg) {
      const tr = e("tr");
      const t = e("td");
      t.appendChild(e("strong", "", pg.title));
      tr.appendChild(t);
      tr.appendChild(e("td", "muted", pagePath(pg.slug)));
      const st = e("td");
      st.appendChild(e("span", "badge" + (pg.published ? " active" : ""), pg.published ? "Published" : "Unpublished"));
      if (pg.has_draft) {
        st.appendChild(document.createTextNode(" "));
        const b = e("span", "badge pending", "Unpublished changes");
        b.title = "Edits saved but not yet published";
        st.appendChild(b);
      }
      tr.appendChild(st);
      tr.appendChild(e("td", "", new Date(pg.draft_updated_at || pg.updated_at).toLocaleDateString()));
      const act = e("td", "wb-row-actions");
      if (showTrash) {
        const restore = button("Restore", "secondary", async function () {
          try {
            await api("/api/tenants/" + tenantId + "/pages/" + pg.id + "/restore", { method: "POST" });
            showTrash = false;
            renderPages(root);
          } catch (err) { msg.textContent = err.message; }
        });
        restore.setAttribute("data-write", "");
        const forever = button("Delete permanently", "secondary", async function () {
          if (!armed(forever, "Click again to delete forever")) return;
          try {
            await api("/api/tenants/" + tenantId + "/pages/" + pg.id + "?permanent=1", { method: "DELETE" });
            renderPages(root);
          } catch (err) { msg.textContent = err.message; }
        });
        forever.setAttribute("data-write", "");
        act.appendChild(restore);
        act.appendChild(forever);
      } else {
        act.appendChild(button("Edit", "secondary", function () {
          window.qhOpenPageEditor(pg, { tenantType: "business", onBack: function () { renderPages(root); } });
        }));
        act.appendChild(button("Preview draft", "secondary", function () {
          window.qhOpenPageEditor(pg, { tenantType: "business", mode: "preview", onBack: function () { renderPages(root); } });
        }));
        const del = button("Delete", "secondary", async function () {
          if (!armed(del, "Click again to move to trash")) return;
          try {
            await api("/api/tenants/" + tenantId + "/pages/" + pg.id, { method: "DELETE" });
            msg.textContent = "Moved to trash. You can restore it from the Trash tab.";
            renderPages(root);
          } catch (err) { msg.textContent = err.message; }
        });
        del.setAttribute("data-write", "");
        act.appendChild(del);
      }
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
    card.appendChild(table);
    card.appendChild(msg);
    finishReadOnly("site-pages");
  }

  // ---- Appearance ------------------------------------------------------
  // The design controls (palette library, type pair, shape, rhythm, header,
  // footer, pattern) are the shared panel in admin.html (window.qhDesignPanel):
  // business tenants are always on the section renderer, so this is the
  // whole screen.
  async function renderTheme(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Appearance"));
    root.appendChild(e("p", "muted", "Choose your colors, fonts and layout. The sample updates as you choose; your site changes when you save."));
    const host = e("div", "card");
    root.appendChild(host);
    await window.qhDesignPanel(host, { tenantType: "business", showCredit: true });
    finishReadOnly("site-theme");
  }

  // ---- Domain & launch ---------------------------------------------------
  async function renderDomain(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Domain & launch"));

    const site = await api("/api/tenants/" + tenantId);
    const domain = input(site.custom_domain || "", "yourdomain.com");
    root.appendChild(field("Custom domain", domain));

    const domainStatus = e("p", "muted", "");
    const saveDomain = button("Save domain", "", async function () {
      try {
        // domain.ts exposes GET/PUT on /api/tenants/:id/domain.
        const res = await api("/api/tenants/" + tenantId + "/domain", {
          method: "PUT",
          body: JSON.stringify({ domain: domain.value }),
        });
        domainStatus.replaceChildren();
        const dns = res.dns || res;
        const list = e("ul");
        (Array.isArray(dns) ? dns : [dns]).forEach(function (rec) {
          if (rec && typeof rec === "object") {
            list.appendChild(e("li", "", Object.keys(rec).map(function (k) { return k + ": " + rec[k]; }).join(" · ")));
          } else if (rec != null) {
            list.appendChild(e("li", "", String(rec)));
          }
        });
        domainStatus.appendChild(e("span", "", "Add these DNS records at your domain registrar:"));
        domainStatus.appendChild(list);
      } catch (err) {
        domainStatus.textContent = err.message;
      }
    });
    saveDomain.setAttribute("data-write", "");
    root.appendChild(saveDomain);
    root.appendChild(domainStatus);

    const launched = document.createElement("input");
    launched.type = "checkbox";
    launched.checked = site.public_launched === 1;
    root.appendChild(field("Site is live to the public", launched));
    root.appendChild(e("p", "muted", "While this is off, the site stays behind the private-preview password."));

    const launchStatus = e("p", "muted", "");
    const saveLaunch = button("Save", "", async function () {
      try {
        await api("/api/tenants/" + tenantId, {
          method: "PATCH",
          body: JSON.stringify({ public_launched: launched.checked ? 1 : 0 }),
        });
        launchStatus.textContent = "Saved.";
      } catch (err) {
        launchStatus.textContent = err.message;
      }
    });
    saveLaunch.setAttribute("data-write", "");
    root.appendChild(saveLaunch);
    root.appendChild(launchStatus);
    finishReadOnly("site-domain");
  }

  // ---- Business identity + navigation ------------------------------------
  const IDENTITY_FIELDS = [
    ["name", "Business name"],
    ["phone", "Phone"],
    ["email", "Email"],
    ["street", "Street"],
    ["city", "City"],
    ["state", "State"],
    ["zip", "ZIP"],
  ];

  async function renderIdentity(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Business details"));
    root.appendChild(e("p", "muted", "Used in the site footer and in the structured data search engines read."));

    const site = await api("/api/tenants/" + tenantId);
    let settings = {};
    try { settings = JSON.parse(site.settings_json || "{}"); } catch (err) { settings = {}; }
    const business = settings.business || {};
    const assets = settings.assets || {};

    const inputs = {};
    IDENTITY_FIELDS.forEach(function (pair) {
      const n = input(business[pair[0]] || "", pair[1]);
      inputs[pair[0]] = n;
      root.appendChild(field(pair[1], n));
    });

    // Logo: pick from the image library instead of typing a file id.
    const logoWrap = e("div");
    const logoLabel = e("label", "", "Logo");
    logoWrap.appendChild(logoLabel);
    const logoPreview = e("div", "wb-thumb");
    logoPreview.style.maxWidth = "240px";
    logoPreview.style.aspectRatio = "3 / 1";
    logoWrap.appendChild(logoPreview);
    let logoFileId = assets.logo_file_id || "";
    async function drawLogo() {
      logoPreview.replaceChildren();
      if (!logoFileId) { logoPreview.textContent = "No logo yet"; return; }
      const img = document.createElement("img");
      img.alt = "";
      try {
        const res = await fetch("/api/tenants/" + tenantId + "/files/" + logoFileId + "/download", { headers: { Authorization: "Bearer " + localStorage.getItem("gb_token") } });
        if (res.ok) img.src = URL.createObjectURL(await res.blob());
      } catch (err) { /* leave empty */ }
      logoPreview.appendChild(img);
    }
    drawLogo();
    const logoActions = e("div", "wb-image-actions");
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/gif,image/webp";
    fileInput.className = "hidden";
    fileInput.tabIndex = -1;
    const logoMsg = e("span", "wb-hint", "");
    logoActions.appendChild(button("Upload logo", "secondary", function () { fileInput.click(); }));
    fileInput.addEventListener("change", async function () {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      logoMsg.textContent = "Uploading…";
      try {
        const res = await fetch("/api/tenants/" + tenantId + "/files?filename=" + encodeURIComponent(f.name), {
          method: "POST",
          headers: { Authorization: "Bearer " + localStorage.getItem("gb_token"), "Content-Type": f.type || "application/octet-stream" },
          body: f,
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || "Upload failed");
        logoFileId = data.id;
        logoMsg.textContent = "Uploaded — save details to keep it.";
        drawLogo();
      } catch (err) { logoMsg.textContent = err.message; }
      fileInput.value = "";
    });
    logoActions.appendChild(button("Remove", "secondary", function () { logoFileId = ""; drawLogo(); }));
    logoActions.appendChild(fileInput);
    logoWrap.appendChild(logoActions);
    logoWrap.appendChild(logoMsg);
    root.appendChild(logoWrap);

    root.appendChild(e("h3", "", "Site menu"));
    root.appendChild(e("p", "muted", "Leave empty to list published pages automatically, or arrange your own menu here."));
    let pages = [];
    try {
      const data = await api("/api/tenants/" + tenantId + "/pages");
      pages = (Array.isArray(data) ? data : data.pages || []).filter(function (p) { return (p.page_type || "page") !== "blog_post"; });
    } catch (err) { pages = []; }
    const navHost = e("div");
    root.appendChild(navHost);
    const navEditor = window.qhNavEditor(navHost, {
      items: settings.nav || [],
      pages: pages,
      linkFor: function (p) { return pagePath(p.slug); },
      emptyText: "No custom menu — published pages are listed automatically.",
    });

    const status = e("p", "muted", "");
    status.setAttribute("aria-live", "polite");
    const save = button("Save details", "", async function () {
      const nextBusiness = {};
      IDENTITY_FIELDS.forEach(function (pair) { nextBusiness[pair[0]] = inputs[pair[0]].value; });
      const next = Object.assign({}, settings, {
        business: nextBusiness,
        assets: Object.assign({}, assets, { logo_file_id: logoFileId }),
        nav: navEditor.getItems(),
      });
      try {
        // Tenant PATCH takes a `settings` object and stores it whole -- send
        // the merged object so theme/fonts/branding survive.
        await api("/api/tenants/" + tenantId, {
          method: "PATCH",
          body: JSON.stringify({ settings: next }),
        });
        settings = next;
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = err.message;
      }
    });
    save.setAttribute("data-write", "");
    save.style.marginTop = "0.75rem";
    root.appendChild(save);
    root.appendChild(status);
    finishReadOnly("site-identity");
  }

  window.qhSiteBuilder = { renderPages, renderTheme, renderDomain, renderIdentity };
})();
