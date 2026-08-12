/* public/qh-projects.js — longarm project queue, estimate builder, rate table.
 * DOM APIs only, no HTML string injection (same rule as qh-site-builder.js).
 * Relies on globals from admin.html: api(), tenantId, token (for authorized
 * file fetches — see the photo gallery below).
 *
 * Note on API paths: every route in this file is under /api/tenants/... .
 * The `api()` helper (defined in admin.html) does no path rewriting -- it is
 * a thin fetch(API + path) wrapper, same convention as qh-site-builder.js.
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
  function money(cents) {
    return "$" + ((Number(cents) || 0) / 100).toFixed(2);
  }

  const STATUSES = ["submitted", "estimated", "signed", "in_progress", "completed", "declined", "cancelled"];

  // ---- Queue ---------------------------------------------------------------

  async function renderQueue(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Projects"));

    const filter = document.createElement("select");
    const anyOpt = document.createElement("option");
    anyOpt.value = "";
    anyOpt.textContent = "All statuses";
    filter.appendChild(anyOpt);
    STATUSES.forEach(function (s) {
      const o = document.createElement("option");
      o.value = s;
      o.textContent = s.replace("_", " ");
      filter.appendChild(o);
    });
    root.appendChild(field("Status", filter));

    const status = e("p", "muted", "");
    root.appendChild(status);
    const list = e("div", "list");
    root.appendChild(list);

    async function load() {
      list.replaceChildren();
      status.textContent = "Loading…";
      try {
        const q = filter.value ? "?status=" + encodeURIComponent(filter.value) : "";
        const rows = await api("/api/tenants/" + tenantId + "/projects" + q);
        status.textContent = "";
        const items = Array.isArray(rows) ? rows : [];
        if (!items.length) {
          list.appendChild(e("p", "muted", "No projects match this filter."));
          return;
        }
        items.forEach(function (p) {
          const card = e("div", "card");
          card.appendChild(e("h3", "", p.reference + " — " + p.customer_name));
          // total_cents === 0 with no way here to see line rows: this is the
          // shape a suppressed ballpark is stored as (Task 11 brief's "known
          // state"), so a bare $0.00 would misleadingly read as "quoted
          // free." Showing a neutral placeholder instead makes the queue
          // never claim a price the shop never gave. The rare legitimate
          // case of a real, fully-discounted $0 quote reads the same way
          // here; the detail view (which has the line rows) tells those
          // apart correctly.
          const totalText = Number(p.total_cents) > 0 ? money(p.total_cents) : "No ballpark yet";
          card.appendChild(
            e(
              "p",
              "muted",
              String(p.project_type).replace("_", " ") + " · " + String(p.status).replace("_", " ") + " · " + totalText
            )
          );
          const open = e("button", "btn", "Open");
          open.addEventListener("click", function () {
            renderDetail(root, p.id);
          });
          card.appendChild(open);
          list.appendChild(card);
        });
      } catch (err) {
        status.textContent = err.message;
      }
    }
    filter.addEventListener("change", load);
    await load();
  }

  // ---- Detail / estimate builder --------------------------------------------

  async function renderDetail(root, projectId) {
    root.replaceChildren();
    root.appendChild(e("p", "muted", "Loading…"));
    let data;
    try {
      data = await api("/api/tenants/" + tenantId + "/projects/" + projectId);
    } catch (err) {
      root.replaceChildren();
      root.appendChild(e("p", "error", err.message));
      const back = e("button", "btn secondary", "Back to queue");
      back.addEventListener("click", function () {
        renderQueue(root);
      });
      root.appendChild(back);
      return;
    }
    root.replaceChildren();
    const p = data.project;
    const lines = data.lines || [];

    root.appendChild(e("h2", "", "Project " + p.reference));
    root.appendChild(
      e("p", "muted", p.customer_name + " · " + p.customer_email + (p.customer_phone ? " · " + p.customer_phone : ""))
    );

    // See the note in renderQueue: no line rows and a zero total is how a
    // suppressed ballpark is stored. Here we actually have the line rows, so
    // this check is exact rather than a heuristic.
    const suppressed = lines.length === 0 && Number(p.total_cents) === 0;
    root.appendChild(
      e(
        "p",
        "",
        "Current total: " +
          (suppressed ? "No ballpark yet — a rate may be missing, or no estimate has been built yet." : money(p.total_cents))
      )
    );

    let intake = {};
    try {
      intake = JSON.parse(p.intake_json || "{}");
    } catch (err) {
      intake = {};
    }
    const intakeList = e("ul");
    Object.keys(intake).forEach(function (k) {
      if (k === "photoFileIds") return;
      intakeList.appendChild(e("li", "", k + ": " + String(intake[k])));
    });
    root.appendChild(e("h3", "", "Intake"));
    root.appendChild(intakeList);

    if (Array.isArray(intake.photoFileIds) && intake.photoFileIds.length) {
      root.appendChild(e("h3", "", "Photos"));
      const gallery = e("div", "list");
      root.appendChild(gallery);
      intake.photoFileIds.forEach(function (fid) {
        const img = document.createElement("img");
        img.alt = "Intake photo";
        img.style.maxWidth = "200px";
        gallery.appendChild(img);
        // The download route sits behind tenant auth (Bearer token) like
        // every other /api/tenants/... route — an <img src="..."> request
        // carries no Authorization header and would just 401. Fetch with
        // the token and hand the browser a blob URL instead, the same
        // pattern qh-admin-ext.js uses for gallery photos.
        fetch(API + "/api/tenants/" + tenantId + "/files/" + encodeURIComponent(fid) + "/download", {
          headers: { Authorization: "Bearer " + token },
        })
          .then(function (r) {
            if (!r.ok) throw new Error("download failed");
            return r.blob();
          })
          .then(function (b) {
            img.src = URL.createObjectURL(b);
          })
          .catch(function () {
            img.replaceWith(e("span", "muted", "Photo unavailable"));
          });
      });
    }

    root.appendChild(e("h3", "", "Estimate lines"));
    const linesWrap = e("div", "list");
    root.appendChild(linesWrap);
    const rows = [];

    function addRow(line) {
      const row = e("div", "card");
      const desc = input(line ? line.description : "", "Description");
      const qty = input(line ? line.quantity : 1, "Qty");
      qty.type = "number";
      qty.step = "0.01";
      const unit = input(line ? (line.unit_cents / 100).toFixed(2) : "0.00", "Unit $");
      unit.type = "number";
      unit.step = "0.01";
      const amount = input(line ? (line.amount_cents / 100).toFixed(2) : "0.00", "Amount $");
      amount.type = "number";
      amount.step = "0.01";
      const del = e("button", "btn secondary", "Remove");
      del.addEventListener("click", function () {
        const i = rows.indexOf(entry);
        if (i >= 0) rows.splice(i, 1);
        row.remove();
      });
      [field("Description", desc), field("Qty", qty), field("Unit $", unit), field("Amount $", amount)].forEach(function (n) {
        row.appendChild(n);
      });
      row.appendChild(del);
      linesWrap.appendChild(row);
      const entry = { desc: desc, qty: qty, unit: unit, amount: amount };
      rows.push(entry);
    }

    lines.forEach(addRow);
    const addBtn = e("button", "btn secondary", "Add line");
    addBtn.addEventListener("click", function () {
      addRow(null);
    });
    root.appendChild(addBtn);

    const linesStatus = e("p", "muted", "");
    const totalDisplay = e("p", "", "");
    const saveLines = e("button", "btn", "Save lines");
    saveLines.addEventListener("click", async function () {
      if (saveLines.disabled) return; // guard against a double-click firing two PUTs
      saveLines.disabled = true;
      linesStatus.textContent = "Saving…";
      try {
        const payload = rows.map(function (r) {
          return {
            kind: "service",
            description: r.desc.value,
            quantity: Number(r.qty.value) || 1,
            unit_cents: Math.round((Number(r.unit.value) || 0) * 100),
            amount_cents: Math.round((Number(r.amount.value) || 0) * 100),
          };
        });
        // PUT replaces all lines; the server recomputes totals from them and
        // ignores any client-supplied total (Task 11 brief). We only trust
        // res.total_cents for the redisplay below, never a locally-summed
        // figure.
        const res = await api("/api/tenants/" + tenantId + "/projects/" + projectId + "/lines", {
          method: "PUT",
          body: JSON.stringify({ lines: payload }),
        });
        linesStatus.textContent = "Saved.";
        // Same suppressed-vs-zero distinction as the initial render above:
        // zero lines and a zero total together mean "nothing here yet";
        // any saved line, even one that legitimately totals to $0, is a
        // deliberate figure she entered and should be shown as such.
        const isSuppressed = payload.length === 0 && Number(res.total_cents) === 0;
        totalDisplay.textContent =
          "Current total: " +
          (isSuppressed ? "No ballpark yet — a rate may be missing, or no estimate has been built yet." : money(res.total_cents));
      } catch (err) {
        // Leave the entered values in the form untouched (nothing here
        // resets rows[] or the inputs) and say plainly that the save did
        // not happen, rather than showing "Saved." on a failed request.
        linesStatus.textContent = "Save failed: " + err.message;
      } finally {
        saveLines.disabled = false;
      }
    });
    root.appendChild(saveLines);
    root.appendChild(linesStatus);
    root.appendChild(totalDisplay);

    const actionsStatus = e("p", "muted", "");

    const send = e("button", "btn", "Send estimate to customer");
    send.addEventListener("click", async function () {
      if (send.disabled) return; // guard against a double-click sending two estimate emails
      send.disabled = true;
      actionsStatus.textContent = "Sending…";
      try {
        await api("/api/tenants/" + tenantId + "/projects/" + projectId + "/send-estimate", { method: "POST" });
        actionsStatus.textContent = "Estimate sent.";
        await renderDetail(root, projectId); // reload so status/total reflect the server's new state
        return;
      } catch (err) {
        actionsStatus.textContent = err.message;
      } finally {
        send.disabled = false;
      }
    });
    root.appendChild(send);

    const resend = e("button", "btn secondary", "Resend link");
    resend.title = "Mints a fresh customer link and invalidates the previous one. Does not send an email — copy the link shown below to her yourself.";
    resend.addEventListener("click", async function () {
      if (resend.disabled) return;
      resend.disabled = true;
      actionsStatus.textContent = "Minting new link…";
      try {
        const res = await api("/api/tenants/" + tenantId + "/projects/" + projectId + "/resend-link", { method: "POST" });
        let site = {};
        try {
          site = await api("/api/tenants/" + tenantId);
        } catch (err) {
          site = {};
        }
        const host = site.custom_domain ? site.custom_domain.replace(/^www\./, "") : tenantSlug + ".quilthosting.com";
        const url = "https://" + host + "/quote/" + res.token;
        actionsStatus.textContent = "New link (previous one no longer works): " + url;
      } catch (err) {
        actionsStatus.textContent = err.message;
      } finally {
        resend.disabled = false;
      }
    });
    root.appendChild(resend);

    const advance = document.createElement("select");
    STATUSES.forEach(function (s) {
      const o = document.createElement("option");
      o.value = s;
      o.textContent = s.replace("_", " ");
      if (s === p.status) o.selected = true;
      advance.appendChild(o);
    });
    const saveStatus = e("button", "btn secondary", "Update status");
    saveStatus.addEventListener("click", async function () {
      if (saveStatus.disabled) return;
      saveStatus.disabled = true;
      actionsStatus.textContent = "Updating…";
      try {
        await api("/api/tenants/" + tenantId + "/projects/" + projectId, {
          method: "PATCH",
          body: JSON.stringify({ status: advance.value }),
        });
        actionsStatus.textContent = "Status updated.";
        await renderDetail(root, projectId);
        return;
      } catch (err) {
        // The server enforces the status machine, not this dropdown (see
        // src/lib/projects/status.ts) — an illegal transition comes back as
        // a 409 naming both states. Show that exact message rather than a
        // generic failure notice, and leave the dropdown as she left it.
        actionsStatus.textContent = err.message;
      } finally {
        saveStatus.disabled = false;
      }
    });
    root.appendChild(field("Status", advance));
    root.appendChild(saveStatus);
    root.appendChild(actionsStatus);

    const back = e("button", "btn secondary", "Back to queue");
    back.addEventListener("click", function () {
      renderQueue(root);
    });
    root.appendChild(back);
  }

  // ---- Rates & agreement -----------------------------------------------------

  const RATE_FIELDS = [
    ["edgeToEdgeCentsPer100SqIn", "Edge-to-edge quilting (cents per 100 sq in)"],
    ["customCentsPer100SqIn", "Custom quilting (cents per 100 sq in)"],
    ["battingCentsPer100SqIn", "Batting (cents per 100 sq in)"],
    ["threadFlatCents", "Thread (flat, cents)"],
    ["bindingCentsPerLinearInch", "Binding (cents per linear inch)"],
    ["backingPrepFlatCents", "Backing preparation (flat, cents)"],
    ["customDesignFlatCents", "Custom design fee (flat, cents)"],
    ["tshirtPerBlockCents", "T-shirt quilt, per block (cents)"],
    ["tshirtFinishingFlatCents", "T-shirt quilt finishing (flat, cents)"],
    ["rushPercent", "Rush surcharge (percent, e.g. 25 for 25%)"],
  ];

  async function renderRates(root) {
    root.replaceChildren();
    root.appendChild(e("h2", "", "Quilting rates & agreement"));
    root.appendChild(
      e(
        "p",
        "muted",
        "Rates marked “cents per 100 sq in” are entered scaled by 100: $0.025 per square inch is entered as 250, " +
          "not 2.5 or 0.025. This is the single easiest field to get wrong here, and a wrong entry mis-prices every quote " +
          "that uses it."
      )
    );
    root.appendChild(
      e(
        "p",
        "muted",
        "Leave any rate blank to turn it off. If a rate a customer's request needs is missing, the public estimate form " +
          "shows no price at all for that request rather than $0 — silence, not a false “free.”"
      )
    );

    const status = e("p", "muted", "Loading…");
    root.appendChild(status);

    let site;
    try {
      site = await api("/api/tenants/" + tenantId);
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    status.textContent = "";

    let settings = {};
    try {
      settings = JSON.parse(site.settings_json || "{}");
    } catch (err) {
      settings = {};
    }
    const longarm = settings.longarm || {};

    const inputs = {};
    RATE_FIELDS.forEach(function (pair) {
      const n = input(longarm[pair[0]] != null ? longarm[pair[0]] : "", "blank = off");
      n.type = "number";
      n.min = "0";
      inputs[pair[0]] = n;
      root.appendChild(field(pair[1], n));
    });

    const prefix = input(longarm.referencePrefix || "", "e.g. SSQ");
    root.appendChild(field("Reference prefix", prefix));

    const minimums = {};
    [
      ["longarm", "Longarm minimum (cents)"],
      ["custom_quilt", "Custom quilt minimum (cents)"],
      ["tshirt_quilt", "T-shirt quilt minimum (cents)"],
    ].forEach(function (pair) {
      const existing = (longarm.minimumCents || {})[pair[0]];
      const n = input(existing != null ? existing : "", "blank = no minimum");
      n.type = "number";
      n.min = "0";
      minimums[pair[0]] = n;
      root.appendChild(field(pair[1], n));
    });

    const agreementTitle = input(longarm.agreementTitle || "Service Agreement", "");
    root.appendChild(field("Agreement title", agreementTitle));
    const agreementBody = document.createElement("textarea");
    agreementBody.rows = 14;
    agreementBody.value = longarm.agreementBody || "";
    root.appendChild(field("Agreement text", agreementBody));
    root.appendChild(
      e(
        "p",
        "muted",
        "Every signature stores its own snapshot of this exact text (and the line items) at the moment the customer " +
          "signed. Editing this text — even saving right now — never changes what a customer already agreed to; it only " +
          "affects agreements signed after the change."
      )
    );

    const saveStatus = e("p", "muted", "");
    const save = e("button", "btn", "Save rates");
    save.addEventListener("click", async function () {
      if (save.disabled) return;
      save.disabled = true;
      saveStatus.textContent = "Saving…";
      try {
        const next = Object.assign({}, longarm, {
          referencePrefix: prefix.value.trim(),
          agreementTitle: agreementTitle.value,
          agreementBody: agreementBody.value,
          minimumCents: {},
        });
        RATE_FIELDS.forEach(function (pair) {
          const v = inputs[pair[0]].value.trim();
          // A blank field must actually remove the rate, not just skip
          // overwriting it — `next` starts as a copy of the previously
          // saved `longarm` object, so leaving this as "skip when blank"
          // would silently keep the old value forever and a shop clearing
          // a rate to turn it off would see the field go blank in the UI
          // while the old price kept being charged underneath.
          if (v === "") delete next[pair[0]];
          else next[pair[0]] = Math.round(Number(v));
        });
        Object.keys(minimums).forEach(function (k) {
          const v = minimums[k].value.trim();
          if (v !== "") next.minimumCents[k] = Math.round(Number(v));
        });
        await api("/api/tenants/" + tenantId, {
          method: "PATCH",
          body: JSON.stringify({ settings: Object.assign({}, settings, { longarm: next }) }),
        });
        settings = Object.assign({}, settings, { longarm: next });
        saveStatus.textContent = "Saved.";
      } catch (err) {
        saveStatus.textContent = "Save failed: " + err.message;
      } finally {
        save.disabled = false;
      }
    });
    root.appendChild(save);
    root.appendChild(saveStatus);
  }

  window.qhProjects = { renderQueue, renderRates };
})();
