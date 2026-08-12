/* public/qh-site-builder.js — business tenant site builder.
 * Pages + blocks, appearance, domain and launch.
 * DOM APIs only, no HTML string injection (same rule as qh-admin-ext.js).
 * Relies on globals from admin.html: api(), tenantId, show(), hide().
 *
 * Note on API paths: every route in this file is under /api/tenants/... .
 * The `api()` helper (defined in admin.html) does no path rewriting -- it is
 * a thin fetch(API + path) wrapper, exactly like every call in
 * qh-admin-ext.js (see e.g. `/api/tenants/${tenantId}/galleries` there).
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
    wrap.appendChild(e("label", "", labelText));
    wrap.appendChild(node);
    return wrap;
  }
  function input(value, placeholder) {
    const n = document.createElement("input");
    if (value != null) n.value = value;
    if (placeholder) n.placeholder = placeholder;
    return n;
  }
  function textarea(value, rows) {
    const n = document.createElement("textarea");
    n.rows = rows || 4;
    if (value != null) n.value = value;
    return n;
  }
  // Mirrors pages.ts's server-side `slugify` exactly (same regex), so the
  // live preview in the Slug field matches what will actually be saved.
  function clientSlugify(s) {
    return String(s || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  // ---- Pages -------------------------------------------------------------
  async function renderPages(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Website pages"));
    const list = e("div", "list");
    root.appendChild(list);

    // GET /api/tenants/:id/pages returns a bare array (see pages.ts), not
    // { pages: [...] }.
    const data = await api(`/api/tenants/${tenantId}/pages`);
    const pages = Array.isArray(data) ? data : data.pages || [];
    pages.forEach((pg) => {
      const row = e("div", "card");
      row.appendChild(e("h3", "", pg.title));
      row.appendChild(e("p", "muted", "/" + (pg.slug || "")));
      const edit = e("button", "btn", "Edit");
      edit.addEventListener("click", () => renderPageEditor(root, pg));
      const del = e("button", "btn secondary", "Delete");
      del.addEventListener("click", async () => {
        // No window.confirm: a modal dialog blocks the admin surface.
        if (del.dataset.armed !== "1") {
          del.dataset.armed = "1";
          del.textContent = "Click again to delete";
          return;
        }
        await api(`/api/tenants/${tenantId}/pages/${pg.id}`, { method: "DELETE" });
        renderPages(root);
      });
      row.appendChild(edit);
      row.appendChild(del);
      list.appendChild(row);
    });

    const add = e("button", "btn", "New page");
    add.addEventListener("click", () =>
      renderPageEditor(root, { title: "", slug: "", blocks_json: "[]", published: 0 })
    );
    root.appendChild(add);
  }

  function renderPageEditor(root, pg) {
    root.replaceChildren();
    root.appendChild(e("h2", "", pg.id ? "Edit page" : "New page"));

    const title = input(pg.title, "Page title");
    const slug = input(pg.slug, "Page address — auto-filled from the title; edit to customize, or clear it for the home page");
    // For a brand-new page (no pg.id yet), keep the Slug field in sync with
    // the Title field as the user types, the same way the pre-existing
    // guild page builder always derived a page's URL from its title. This
    // is what makes a blank Slug field rare in practice: a business owner
    // who never touches Slug at all still gets a sensible, unique-looking
    // URL instead of every untouched new page silently colliding on the
    // "home" page's slug (see pages.ts's blank-slug-becomes-"home"
    // normalization). Stops syncing the moment the user edits Slug
    // directly, or when editing an existing page (its slug is already a
    // real, saved value -- retyping the title shouldn't move its URL).
    let slugTouched = !!pg.id;
    slug.addEventListener("input", () => {
      slugTouched = true;
    });
    title.addEventListener("input", () => {
      if (!slugTouched) slug.value = clientSlugify(title.value);
    });
    const seoTitle = input(pg.seo_title || "", "SEO title (defaults to page title)");
    const seoDesc = textarea(pg.seo_description || "", 2);
    const blocks = textarea(pg.blocks_json || "[]", 16);
    const noindex = document.createElement("input");
    noindex.type = "checkbox";
    noindex.checked = pg.noindex === 1;
    const published = document.createElement("input");
    published.type = "checkbox";
    published.checked = pg.published === 1;

    root.appendChild(field("Title", title));
    root.appendChild(field("Slug", slug));
    root.appendChild(field("Blocks (JSON)", blocks));
    root.appendChild(field("SEO title", seoTitle));
    root.appendChild(field("SEO description", seoDesc));
    root.appendChild(field("Hide from search engines", noindex));
    root.appendChild(field("Published", published));

    const status = e("p", "muted", "");
    const save = e("button", "btn", "Save");
    save.addEventListener("click", async () => {
      let parsedBlocks;
      try {
        parsedBlocks = JSON.parse(blocks.value || "[]");
      } catch (err) {
        status.textContent = "Blocks must be valid JSON: " + err.message;
        return;
      }
      const body = {
        title: title.value,
        slug: slug.value,
        // pages.ts's POST/PATCH take a `blocks` array (it stringifies to
        // blocks_json itself via parseBlocks) -- not a pre-stringified
        // blocks_json field.
        blocks: parsedBlocks,
        seo_title: seoTitle.value,
        seo_description: seoDesc.value,
        noindex: noindex.checked,
        published: published.checked,
      };
      try {
        await api(
          pg.id ? `/api/tenants/${tenantId}/pages/${pg.id}` : `/api/tenants/${tenantId}/pages`,
          { method: pg.id ? "PATCH" : "POST", body: JSON.stringify(body) }
        );
        renderPages(root);
      } catch (err) {
        status.textContent = err.message;
      }
    });
    const back = e("button", "btn secondary", "Cancel");
    back.addEventListener("click", () => renderPages(root));
    root.appendChild(save);
    root.appendChild(back);
    root.appendChild(status);
  }

  // ---- Appearance --------------------------------------------------------
  const TOKENS = [
    "primary", "primaryBright", "primaryDark", "secondary", "secondaryBright",
    "accent", "accentBright", "gold", "bg", "card", "textBase", "textMuted", "themeColor",
  ];

  async function renderTheme(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Appearance"));

    const site = await api(`/api/tenants/${tenantId}`);
    let settings = {};
    try { settings = JSON.parse(site.settings_json || "{}"); } catch (err) { settings = {}; }
    const theme = settings.theme || {};
    const fonts = settings.fonts || { heading: "fraunces", body: "inter" };

    const inputs = {};
    TOKENS.forEach((k) => {
      const n = document.createElement("input");
      n.type = "color";
      n.value = /^#[0-9a-fA-F]{6}$/.test(theme[k] || "") ? theme[k] : "#8a2060";
      inputs[k] = n;
      root.appendChild(field(k, n));
    });

    const heading = input(fonts.heading, "heading font key");
    const body = input(fonts.body, "body font key");
    root.appendChild(field("Heading font", heading));
    root.appendChild(field("Body font", body));

    const credit = document.createElement("input");
    credit.type = "checkbox";
    credit.checked = (settings.branding || {}).show_platform_credit !== false;
    root.appendChild(field("Show 'Powered by QuiltHosting'", credit));

    const status = e("p", "muted", "");
    const save = e("button", "btn", "Save appearance");
    save.addEventListener("click", async () => {
      const nextTheme = {};
      TOKENS.forEach((k) => { nextTheme[k] = inputs[k].value; });
      const next = {
        ...settings,
        theme: nextTheme,
        fonts: { heading: heading.value, body: body.value },
        branding: { ...(settings.branding || {}), show_platform_credit: credit.checked },
      };
      try {
        // Tenant PATCH (src/routes/tenants.ts) takes a `settings` object
        // and JSON.stringifies it server-side -- not a pre-stringified
        // settings_json field.
        await api(`/api/tenants/${tenantId}`, {
          method: "PATCH",
          body: JSON.stringify({ settings: next }),
        });
        settings = next;
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = err.message;
      }
    });
    root.appendChild(save);
    root.appendChild(status);
  }

  // ---- Domain & launch ---------------------------------------------------
  async function renderDomain(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Domain & launch"));

    const site = await api(`/api/tenants/${tenantId}`);
    const domain = input(site.custom_domain || "", "yourdomain.com");
    root.appendChild(field("Custom domain", domain));

    const domainStatus = e("p", "muted", "");
    const saveDomain = e("button", "btn", "Save domain");
    saveDomain.addEventListener("click", async () => {
      try {
        // domain.ts exposes GET/PUT on /api/tenants/:id/domain -- there is
        // no POST handler on that router.
        const res = await api(`/api/tenants/${tenantId}/domain`, {
          method: "PUT",
          body: JSON.stringify({ domain: domain.value }),
        });
        domainStatus.replaceChildren();
        const dns = e("pre", "", JSON.stringify(res.dns || res, null, 2));
        domainStatus.appendChild(dns);
      } catch (err) {
        domainStatus.textContent = err.message;
      }
    });
    root.appendChild(saveDomain);
    root.appendChild(domainStatus);

    const launched = document.createElement("input");
    launched.type = "checkbox";
    launched.checked = site.public_launched === 1;
    root.appendChild(field("Site is live to the public", launched));
    root.appendChild(
      e("p", "muted",
        "While this is off, the site stays behind the private-preview password.")
    );

    const launchStatus = e("p", "muted", "");
    const saveLaunch = e("button", "btn", "Save");
    saveLaunch.addEventListener("click", async () => {
      try {
        await api(`/api/tenants/${tenantId}`, {
          method: "PATCH",
          body: JSON.stringify({ public_launched: launched.checked ? 1 : 0 }),
        });
        launchStatus.textContent = "Saved.";
      } catch (err) {
        launchStatus.textContent = err.message;
      }
    });
    root.appendChild(saveLaunch);
    root.appendChild(launchStatus);
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
    root.appendChild(
      e("p", "muted",
        "Used in the site footer and in the structured data search engines read.")
    );

    const site = await api(`/api/tenants/${tenantId}`);
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

    const logo = input(assets.logo_file_id || "", "file id from the Files page");
    root.appendChild(field("Logo file id", logo));

    root.appendChild(e("h3", "", "Navigation"));
    root.appendChild(
      e("p", "muted", "One item per line as 'Label | /path'. Leave empty to list published pages automatically.")
    );
    const navText = textarea(
      (settings.nav || []).map(function (n) { return n.label + " | " + n.href; }).join("\n"),
      6
    );
    root.appendChild(navText);

    const status = e("p", "muted", "");
    const save = e("button", "btn", "Save details");
    save.addEventListener("click", async () => {
      const nextBusiness = {};
      IDENTITY_FIELDS.forEach(function (pair) { nextBusiness[pair[0]] = inputs[pair[0]].value; });
      const nav = navText.value
        .split("\n")
        .map(function (line) { return line.split("|"); })
        .filter(function (parts) { return parts.length >= 2 && parts[0].trim() && parts[1].trim(); })
        .map(function (parts) { return { label: parts[0].trim(), href: parts[1].trim() }; });
      const next = {
        ...settings,
        business: nextBusiness,
        assets: { ...assets, logo_file_id: logo.value.trim() },
        nav: nav,
      };
      try {
        // Tenant PATCH (src/routes/tenants.ts) takes a `settings` object and
        // JSON.stringifies it server-side -- same convention renderTheme
        // above uses, not a pre-stringified settings_json field.
        await api(`/api/tenants/${tenantId}`, {
          method: "PATCH",
          body: JSON.stringify({ settings: next }),
        });
        settings = next;
        status.textContent = "Saved.";
      } catch (err) {
        status.textContent = err.message;
      }
    });
    root.appendChild(save);
    root.appendChild(status);
  }

  window.qhSiteBuilder = { renderPages, renderTheme, renderDomain, renderIdentity };
})();
