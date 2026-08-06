/* QuiltHosting admin extensions: photo galleries, treasurer reports, and
 * volunteer sign-up sheets. Built with DOM APIs (no HTML string injection).
 *
 * Relies on globals provided by admin.html: api(), navigate(), tenantId,
 * token, API, show()/hide().
 */
(function () {
  function e(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function field(labelText, input) {
    const wrap = e("div");
    wrap.appendChild(e("label", "", labelText));
    wrap.appendChild(input);
    return wrap;
  }
  function input(id, placeholder, type) {
    const n = document.createElement("input");
    n.id = id;
    if (placeholder) n.placeholder = placeholder;
    if (type) n.type = type;
    return n;
  }
  function money(cents) {
    return "$" + ((cents || 0) / 100).toFixed(2);
  }
  function table(headers, rows) {
    const t = e("table");
    const thead = e("thead");
    const hr = e("tr");
    headers.forEach((h) => hr.appendChild(e("th", "", h)));
    thead.appendChild(hr);
    const tbody = e("tbody");
    rows.forEach((cells) => {
      const tr = e("tr");
      cells.forEach((cell) => {
        const td = e("td");
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell == null ? "" : String(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.append(thead, tbody);
    return t;
  }
  function card(...kids) {
    const c = e("div", "card");
    kids.forEach((k) => k && c.appendChild(k));
    return c;
  }

  // ---------------------------------------------------------------- Galleries

  window.renderGalleriesAdmin = async function (el) {
    const galleries = await api(`/api/tenants/${tenantId}/galleries`);
    el.replaceChildren();
    el.appendChild(e("h2", "", "Photo Galleries"));
    el.appendChild(
      e("p", "muted", 'Show-and-tell, quilt shows, retreats. Public galleries appear on your guild site under "Photos".')
    );

    // --- new gallery form ---
    const form = card(e("h3", "", "New gallery"));
    const row = e("div", "form-row");
    row.appendChild(field("Title", input("gal-title", "Fall Quilt Show 2026")));
    const chkWrap = e("div");
    chkWrap.style.cssText = "display:flex;align-items:end;padding-bottom:0.5rem";
    const chkLabel = e("label");
    chkLabel.style.cssText = "display:flex;align-items:center;gap:0.4rem;margin:0";
    const chk = input("gal-members", "", "checkbox");
    chkLabel.append(chk, document.createTextNode("Members only"));
    chkWrap.appendChild(chkLabel);
    row.appendChild(chkWrap);
    form.appendChild(row);
    form.appendChild(field("Description", input("gal-desc", "Quilts from our October show")));
    const createBtn = e("button", "", "Create gallery");
    createBtn.style.marginTop = "0.5rem";
    const msg = e("span", "muted");
    msg.style.marginLeft = "0.75rem";
    createBtn.addEventListener("click", async () => {
      const title = document.getElementById("gal-title").value.trim();
      if (!title) {
        msg.textContent = "Title is required.";
        return;
      }
      try {
        await api(`/api/tenants/${tenantId}/galleries`, {
          method: "POST",
          body: JSON.stringify({
            title,
            description: document.getElementById("gal-desc").value.trim() || undefined,
            is_members_only: document.getElementById("gal-members").checked,
          }),
        });
        navigate("galleries");
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    form.append(createBtn, msg);
    el.appendChild(form);

    for (const g of galleries) el.appendChild(galleryCard(g));
  };

  function galleryCard(g) {
    const c = card();
    const row = e("div", "row");
    const left = e("div");
    left.appendChild(e("strong", "", g.title));
    left.appendChild(
      e(
        "div",
        "muted",
        `${g.photo_count} photo${g.photo_count === 1 ? "" : "s"} · ` +
          (g.is_members_only ? "Members only" : "Public") +
          " · " +
          (g.published ? "Published" : "Draft")
      )
    );
    const right = e("div");
    const file = input("", "", "file");
    file.accept = "image/*";
    file.style.display = "none";
    file.addEventListener("change", () => uploadPhoto(g.id, file));
    const addBtn = e("button", "secondary", "Add photo");
    addBtn.addEventListener("click", () => file.click());
    const delBtn = e("button", "secondary", "Delete");
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete gallery "${g.title}" and all its photos?`)) return;
      await api(`/api/tenants/${tenantId}/galleries/${g.id}`, { method: "DELETE" });
      navigate("galleries");
    });
    right.append(file, addBtn, delBtn);
    row.append(left, right);
    c.appendChild(row);

    const grid = e("div", "qh-photo-grid");
    grid.style.marginTop = "0.9rem";
    c.appendChild(grid);
    loadGalleryPhotos(g.id, grid);
    return c;
  }

  async function loadGalleryPhotos(galleryId, grid) {
    const photos = await api(`/api/tenants/${tenantId}/galleries/${galleryId}/photos`);
    grid.replaceChildren();
    for (const ph of photos) {
      const fig = e("figure", "qh-photo");
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = ph.caption || "";
      // Authorized fetch → object URL (members-only galleries need the token)
      fetch(`${API}/api/tenants/${tenantId}/galleries/${galleryId}/photos/${ph.id}/raw`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => r.blob())
        .then((b) => {
          img.src = URL.createObjectURL(b);
        })
        .catch(() => {});
      fig.appendChild(img);
      const cap = e("figcaption", "muted", ph.caption || "");
      const del = e("button", "secondary", "Remove");
      del.style.marginTop = "0.35rem";
      del.addEventListener("click", async () => {
        if (!confirm("Remove this photo?")) return;
        await api(`/api/tenants/${tenantId}/galleries/${galleryId}/photos/${ph.id}`, {
          method: "DELETE",
        });
        navigate("galleries");
      });
      cap.appendChild(document.createElement("br"));
      cap.appendChild(del);
      fig.appendChild(cap);
      grid.appendChild(fig);
    }
  }

  async function uploadPhoto(galleryId, fileInput) {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const caption = prompt("Caption for this photo (optional):", "") || "";
    const res = await fetch(
      `${API}/api/tenants/${tenantId}/galleries/${galleryId}/photos` +
        `?filename=${encodeURIComponent(f.name)}&caption=${encodeURIComponent(caption)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": f.type || "image/jpeg" },
        body: f,
      }
    );
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || "Upload failed");
      return;
    }
    fileInput.value = "";
    navigate("galleries");
  }

  // ------------------------------------------------------------------ Reports

  window.renderReports = async function (el) {
    const year = window._reportYear || new Date().getFullYear();
    const [rep, membersRaw] = await Promise.all([
      api(`/api/tenants/${tenantId}/stats/annual?year=${year}`),
      api(`/api/tenants/${tenantId}/members`),
    ]);
    const members = Array.isArray(membersRaw)
      ? membersRaw
      : membersRaw.items || membersRaw.members || [];

    el.replaceChildren();
    el.appendChild(e("h2", "", "Reports"));

    const bar = e("div", "toolbar");
    const yLabel = e("label", "", "Year");
    yLabel.style.margin = "0";
    const yInput = input("rep-year", "", "number");
    yInput.value = String(year);
    yInput.style.maxWidth = "110px";
    const show = e("button", "secondary", "Show");
    show.addEventListener("click", () => {
      window._reportYear = Number(yInput.value) || new Date().getFullYear();
      navigate("reports");
    });
    bar.append(yLabel, yInput, show);
    el.appendChild(bar);

    const stats = e("div", "stats");
    const tiles = [
      ["Gross revenue", money(rep.revenue.gross_cents)],
      ["Refunded", money(rep.revenue.refunded_cents)],
      ["Net", money(rep.revenue.net_cents)],
      ["Members joined", rep.members.joined],
      ["Events held", rep.events.count],
      ["Event signups", rep.events.registrations],
    ];
    for (const [label, value] of tiles) {
      const tile = e("div", "stat");
      tile.appendChild(e("div", "label", label));
      tile.appendChild(e("div", "value", String(value)));
      stats.appendChild(tile);
    }
    el.appendChild(stats);

    const revCard = card(e("h3", "", "Revenue by category"));
    if (!rep.revenue.by_type.length) revCard.appendChild(e("p", "muted", "No payments this year"));
    else
      revCard.appendChild(
        table(
          ["Category", "Payments", "Total"],
          rep.revenue.by_type.map((r) => [r.type, r.payments, money(r.total_cents)])
        )
      );
    el.appendChild(revCard);

    const evCard = card(e("h3", "", "Top events by attendance"));
    if (!rep.events.top.length) evCard.appendChild(e("p", "muted", "No events this year"));
    else
      evCard.appendChild(
        table(
          ["Event", "Registrations"],
          rep.events.top.map((r) => [r.title, r.registrations])
        )
      );
    el.appendChild(evCard);

    // --- member statement ---
    const stCard = card(e("h3", "", "Member statement / donation receipt"));
    stCard.appendChild(
      e("p", "muted", "Pick a member to produce a printable year-end statement.")
    );
    const sel = document.createElement("select");
    sel.style.maxWidth = "340px";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Choose a member…";
    sel.appendChild(blank);
    for (const m of members) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email;
      sel.appendChild(o);
    }
    const out = e("div");
    out.style.marginTop = "1rem";
    const stBtn = e("button", "", "Show statement");
    stBtn.style.marginTop = "0.5rem";
    stBtn.addEventListener("click", async () => {
      out.replaceChildren();
      if (!sel.value) return;
      const st = await api(
        `/api/tenants/${tenantId}/stats/statement?member_id=${sel.value}&year=${year}`
      );
      const box = e("div");
      box.style.cssText = "border:1px solid var(--border);border-radius:8px;padding:1rem";
      box.appendChild(e("h3", "", `${st.tenant.name} — ${st.year} statement`));
      const who =
        [st.member.first_name, st.member.last_name].filter(Boolean).join(" ") || st.member.email;
      box.appendChild(e("p", "muted", `${who} · ${st.member.email}`));
      if (!st.payments.length) box.appendChild(e("p", "muted", "No payments in this year."));
      else
        box.appendChild(
          table(
            ["Date", "Type", "Description", "Amount", "Status"],
            st.payments.map((pm) => [
              new Date(pm.created_at).toLocaleDateString(),
              pm.type,
              pm.description || "—",
              money(pm.amount_cents),
              pm.status,
            ])
          )
        );
      const totals = e("p");
      totals.style.marginTop = "0.75rem";
      const strong = e("strong", "", `Total paid: ${money(st.totals.paid_cents)}`);
      totals.appendChild(strong);
      if (st.totals.donations_cents)
        totals.appendChild(
          document.createTextNode(` · Donations: ${money(st.totals.donations_cents)}`)
        );
      box.appendChild(totals);
      const printBtn = e("button", "secondary", "Print");
      printBtn.addEventListener("click", () => window.print());
      box.appendChild(printBtn);
      out.appendChild(box);
    });
    stCard.append(sel, stBtn, out);
    el.appendChild(stCard);
  };

  // --------------------------------------------------------- Volunteer sheets

  window.loadVolunteersAdmin = async function (eventId) {
    const box = document.getElementById("vol-admin");
    if (!box) return;
    const data = await api(`/api/tenants/${tenantId}/events/${eventId}/volunteers`);
    const slots = data.slots || [];
    box.replaceChildren();

    const c = card();
    c.style.marginTop = "1rem";
    const head = e("div", "row");
    head.appendChild(e("h3", "", "Volunteer sign-up sheet"));
    if (slots.length) {
      const exp = e("button", "secondary", "Export CSV");
      exp.addEventListener("click", async () => {
        const res = await fetch(
          `${API}/api/tenants/${tenantId}/events/${eventId}/volunteers.csv`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "volunteers.csv";
        a.click();
        URL.revokeObjectURL(a.href);
      });
      head.appendChild(exp);
    }
    c.appendChild(head);

    if (!slots.length) {
      c.appendChild(
        e("p", "muted", 'No sign-up slots yet — add one below (e.g. "Bring refreshments", "Setup crew").')
      );
    } else {
      c.appendChild(
        table(
          ["Slot", "Filled", "Volunteers", ""],
          slots.map((st) => {
            const titleCell = e("div");
            titleCell.appendChild(e("strong", "", st.title));
            if (st.description) titleCell.appendChild(e("div", "muted", st.description));
            const names =
              st.signups.map((g) => g.name || g.email).join(", ") || "—";
            const rm = e("button", "secondary", "Remove");
            rm.addEventListener("click", async () => {
              if (!confirm(`Remove the "${st.title}" sign-up slot? Its sign-ups are removed too.`))
                return;
              await api(
                `/api/tenants/${tenantId}/events/${eventId}/volunteers/${st.id}`,
                { method: "DELETE" }
              );
              window.loadVolunteersAdmin(eventId);
            });
            return [titleCell, `${st.signups.length} / ${st.needed}`, names, rm];
          })
        )
      );
    }

    const row = e("div", "form-row");
    row.style.marginTop = "0.75rem";
    row.appendChild(field("New slot", input("vs-title", "Bring refreshments")));
    const needed = input("vs-needed", "", "number");
    needed.value = "1";
    needed.min = "1";
    row.appendChild(field("How many needed", needed));
    c.appendChild(row);
    c.appendChild(field("Details (optional)", input("vs-desc", "Cookies, coffee, or fruit")));
    const add = e("button", "", "Add slot");
    add.style.marginTop = "0.5rem";
    add.addEventListener("click", async () => {
      const title = document.getElementById("vs-title").value.trim();
      if (!title) return;
      await api(`/api/tenants/${tenantId}/events/${eventId}/volunteers`, {
        method: "POST",
        body: JSON.stringify({
          title,
          needed: Number(document.getElementById("vs-needed").value) || 1,
          description: document.getElementById("vs-desc").value.trim() || undefined,
        }),
      });
      window.loadVolunteersAdmin(eventId);
    });
    c.appendChild(add);
    box.appendChild(c);
  };
})();
