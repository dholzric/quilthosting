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

  // ---- Appearance --------------------------------------------------------
  const TOKENS = [
    ["primary", "Main color"], ["primaryBright", "Main color (light)"], ["primaryDark", "Main color (dark)"],
    ["secondary", "Secondary color"], ["secondaryBright", "Secondary (light)"], ["accent", "Accent"],
    ["accentBright", "Accent (light)"], ["gold", "Highlight"], ["bg", "Page background"], ["card", "Card background"],
    ["textBase", "Text"], ["textMuted", "Muted text"], ["themeColor", "Browser bar color"],
  ];
  // Copied from src/lib/site/theme.ts (DEFAULT_THEME) and
  // src/lib/site/themePresets.ts (THEME_PRESETS). The admin is a static page
  // and cannot import Worker code, so keep these in sync by hand.
  const DEFAULT_THEME = {
    primary: "#8a2060", primaryBright: "#c060a0", primaryDark: "#6a1048", secondary: "#6a4060",
    secondaryBright: "#e090c8", accent: "#a04080", accentBright: "#f0c8e0", gold: "#f0c060",
    bg: "#fcf6fa", card: "#fdf4f8", textBase: "#2a2530", textMuted: "#504852", themeColor: "#c060a0",
  };
  const THEME_PRESETS = [
    { name: "Berry (default)", theme: DEFAULT_THEME },
    { name: "Ocean", theme: Object.assign({}, DEFAULT_THEME, {
      primary: "#1f6f8b", primaryBright: "#2a9d8f", primaryDark: "#14505c", secondary: "#3d5a6c",
      secondaryBright: "#8ecae6", accent: "#457b9d", accentBright: "#cfe8ef", gold: "#e9c46a", themeColor: "#2a9d8f",
    }) },
    { name: "Forest", theme: Object.assign({}, DEFAULT_THEME, {
      primary: "#2d6a4f", primaryBright: "#40916c", primaryDark: "#1b4332", secondary: "#52796f",
      secondaryBright: "#95d5b2", accent: "#588157", accentBright: "#d8f3dc", gold: "#e9c46a", themeColor: "#40916c",
    }) },
    { name: "Charcoal", theme: Object.assign({}, DEFAULT_THEME, {
      primary: "#3a3a3c", primaryBright: "#5a5a5e", primaryDark: "#1f1f21", secondary: "#55555a",
      secondaryBright: "#9a9aa2", accent: "#6b6b70", accentBright: "#e2e2e6", gold: "#d4a017",
      bg: "#f6f6f7", card: "#ffffff", themeColor: "#3a3a3c",
    }) },
  ];
  // Copied from src/lib/site/fonts.ts FONT_OPTIONS (key -> label, css stack).
  const FONTS = [
    ["inter", "Inter", "'Inter', system-ui, sans-serif"],
    ["fraunces", "Fraunces", "'Fraunces', Georgia, serif"],
    ["playfair", "Playfair Display", "'Playfair Display', Georgia, serif"],
    ["lora", "Lora", "'Lora', Georgia, serif"],
    ["merriweather", "Merriweather", "'Merriweather', Georgia, serif"],
    ["cormorant", "Cormorant", "'Cormorant', Georgia, serif"],
    ["poppins", "Poppins", "'Poppins', system-ui, sans-serif"],
    ["sourcesans", "Source Sans 3", "'Source Sans 3', system-ui, sans-serif"],
    ["worksans", "Work Sans", "'Work Sans', system-ui, sans-serif"],
    ["nunito", "Nunito", "'Nunito', system-ui, sans-serif"],
  ];
  function fontStack(key) {
    const f = FONTS.find(function (x) { return x[0] === key; });
    return f ? f[2] : FONTS[0][2];
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance(rgb) {
    const c = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  // WCAG 2 contrast ratio between two hex colors (null if either is invalid).
  function contrast(a, b) {
    const ra = hexToRgb(a), rb = hexToRgb(b);
    if (!ra || !rb) return null;
    const la = luminance(ra), lb = luminance(rb);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function sameTheme(a, b) {
    return TOKENS.every(function (t) { return String(a[t[0]] || "").toLowerCase() === String(b[t[0]] || "").toLowerCase(); });
  }

  async function renderTheme(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Appearance"));
    root.appendChild(e("p", "muted", "Pick a color scheme and fonts. The sample below updates as you choose; your site changes when you save."));

    const site = await api("/api/tenants/" + tenantId);
    let settings = {};
    try { settings = JSON.parse(site.settings_json || "{}"); } catch (err) { settings = {}; }
    const theme = Object.assign({}, DEFAULT_THEME, settings.theme || {});
    const fonts = Object.assign({ heading: "fraunces", body: "inter" }, settings.fonts || {});
    const inputs = {};

    // Live sample.
    const sample = e("div", "wb-font-sample");
    const sampleTitle = e("div", "wb-preset-sample", "Your business name");
    const sampleBody = e("p", "", "A short line about what you do and how to get in touch.");
    sampleBody.style.margin = "0.35rem 0 0.6rem";
    const sampleBtn = e("span", "btn", "Request a quote");
    sample.appendChild(sampleTitle);
    sample.appendChild(sampleBody);
    sample.appendChild(sampleBtn);
    const contrastNote = e("p", "wb-contrast");
    contrastNote.setAttribute("aria-live", "polite");

    function currentTheme() {
      const t = {};
      TOKENS.forEach(function (tok) { t[tok[0]] = inputs[tok[0]].value; });
      return t;
    }
    function refreshSample() {
      const t = currentTheme();
      sample.style.background = t.bg;
      sample.style.color = t.textBase;
      sample.style.borderColor = t.accentBright;
      sampleTitle.style.color = t.primary;
      sampleTitle.style.fontFamily = fontStack(headingSel.value);
      sampleBody.style.color = t.textMuted;
      sampleBody.style.fontFamily = fontStack(bodySel.value);
      sampleBtn.style.background = t.primary;
      sampleBtn.style.fontFamily = fontStack(bodySel.value);
      const ratio = contrast(t.textBase, t.bg);
      if (ratio == null) { contrastNote.className = "wb-contrast"; contrastNote.textContent = ""; }
      else if (ratio < 4.5) { contrastNote.className = "wb-contrast bad"; contrastNote.textContent = "Text on the page background is hard to read (contrast " + ratio.toFixed(1) + ":1, aim for 4.5:1 or more). Try a darker text color or a lighter background."; }
      else { contrastNote.className = "wb-contrast ok"; contrastNote.textContent = "Text is easy to read on the page background (contrast " + ratio.toFixed(1) + ":1)."; }
      presetGrid.querySelectorAll(".wb-preset").forEach(function (btn) {
        const p = THEME_PRESETS[Number(btn.dataset.idx)];
        btn.classList.toggle("on", sameTheme(p.theme, t));
        btn.setAttribute("aria-pressed", String(sameTheme(p.theme, t)));
      });
    }

    // Presets.
    root.appendChild(e("h3", "", "Color scheme"));
    const presetGrid = e("div", "wb-presets");
    THEME_PRESETS.forEach(function (p, idx) {
      const btn = e("button", "wb-preset");
      btn.type = "button";
      btn.dataset.idx = String(idx);
      btn.setAttribute("aria-label", "Use the " + p.name + " color scheme");
      const sw = e("div", "wb-preset-swatches");
      ["primary", "primaryBright", "accentBright", "gold", "bg"].forEach(function (k) {
        const s = e("span");
        s.style.background = p.theme[k];
        s.style.border = "1px solid rgba(0,0,0,0.08)";
        sw.appendChild(s);
      });
      btn.appendChild(sw);
      btn.appendChild(e("div", "wb-preset-name", p.name));
      const samp = e("div", "wb-preset-sample", "Aa");
      samp.style.color = p.theme.primary;
      samp.style.fontFamily = fontStack(fonts.heading);
      btn.appendChild(samp);
      btn.addEventListener("click", function () {
        TOKENS.forEach(function (tok) { inputs[tok[0]].value = p.theme[tok[0]]; });
        refreshSample();
      });
      presetGrid.appendChild(btn);
    });
    root.appendChild(presetGrid);

    // Fonts.
    root.appendChild(e("h3", "", "Fonts"));
    const fontRow = e("div", "form-row");
    const headingSel = document.createElement("select");
    const bodySel = document.createElement("select");
    FONTS.forEach(function (f) {
      [headingSel, bodySel].forEach(function (sel) {
        const o = document.createElement("option");
        o.value = f[0];
        o.textContent = f[1];
        o.style.fontFamily = f[2];
        sel.appendChild(o);
      });
    });
    headingSel.value = FONTS.some(function (f) { return f[0] === fonts.heading; }) ? fonts.heading : "fraunces";
    bodySel.value = FONTS.some(function (f) { return f[0] === fonts.body; }) ? fonts.body : "inter";
    headingSel.addEventListener("change", refreshSample);
    bodySel.addEventListener("change", refreshSample);
    fontRow.appendChild(field("Headings", headingSel));
    fontRow.appendChild(field("Body text", bodySel));
    root.appendChild(fontRow);

    root.appendChild(e("h3", "", "Sample"));
    root.appendChild(sample);
    root.appendChild(contrastNote);

    // Advanced: the raw 13 tokens.
    const adv = e("details");
    adv.appendChild(e("summary", "", "Advanced — fine-tune every color"));
    const grid = e("div", "wb-tokens");
    TOKENS.forEach(function (tok) {
      const n = document.createElement("input");
      n.type = "color";
      n.value = /^#[0-9a-fA-F]{6}$/.test(theme[tok[0]] || "") ? theme[tok[0]] : DEFAULT_THEME[tok[0]];
      n.setAttribute("aria-label", tok[1]);
      n.addEventListener("input", refreshSample);
      inputs[tok[0]] = n;
      const label = e("label", "", tok[1]);
      label.appendChild(n);
      grid.appendChild(label);
    });
    adv.appendChild(grid);
    root.appendChild(adv);

    const credit = document.createElement("input");
    credit.type = "checkbox";
    credit.checked = (settings.branding || {}).show_platform_credit !== false;
    const creditLabel = e("label", "wb-check");
    creditLabel.appendChild(credit);
    creditLabel.appendChild(document.createTextNode(" Show “Powered by QuiltHosting” in the footer"));
    creditLabel.style.marginTop = "1rem";
    root.appendChild(creditLabel);

    const status = e("p", "muted", "");
    status.setAttribute("aria-live", "polite");
    const save = button("Save appearance", "", async function () {
      const next = Object.assign({}, settings, {
        theme: currentTheme(),
        fonts: { heading: headingSel.value, body: bodySel.value },
        branding: Object.assign({}, settings.branding || {}, { show_platform_credit: credit.checked }),
      });
      try {
        // Tenant PATCH (src/routes/tenants.ts) takes a `settings` object and
        // JSON.stringifies it server-side (full replace -- always send the
        // merged object).
        await api("/api/tenants/" + tenantId, { method: "PATCH", body: JSON.stringify({ settings: next }) });
        settings = next;
        status.textContent = "Saved. Your site now uses this look.";
      } catch (err) {
        status.textContent = err.message;
      }
    });
    save.setAttribute("data-write", "");
    save.style.marginTop = "0.75rem";
    root.appendChild(save);
    root.appendChild(status);
    refreshSample();
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
