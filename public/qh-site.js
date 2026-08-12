/* public/qh-site.js — hydrates blocks that need data after first paint.
   Server-rendered content is already in the DOM; this only fills the
   placeholders left by events_list, store_list, and contact_form. */
(function () {
  var slug = document.documentElement.getAttribute("data-tenant-slug") || "";
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function get(path) {
    return fetch("/public/" + encodeURIComponent(slug) + path).then(function (r) {
      return r.ok ? r.json() : null;
    });
  }
  document.querySelectorAll(".qh-block-events").forEach(function (node) {
    get("/events").then(function (data) {
      if (!data || !data.events) return;
      var limit = Number(node.getAttribute("data-limit")) || 5;
      data.events.slice(0, limit).forEach(function (ev) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", ev.title));
        if (ev.start_at) card.appendChild(el("p", "", new Date(ev.start_at).toLocaleString()));
        node.appendChild(card);
      });
    });
  });
  document.querySelectorAll(".qh-block-store").forEach(function (node) {
    get("/products").then(function (data) {
      if (!data || !data.products) return;
      var limit = Number(node.getAttribute("data-limit")) || 6;
      data.products.slice(0, limit).forEach(function (p) {
        var card = el("div", "card");
        card.appendChild(el("h3", "", p.name));
        card.appendChild(el("p", "", "$" + ((p.price_cents || 0) / 100).toFixed(2)));
        node.appendChild(card);
      });
    });
  });
  document.querySelectorAll(".qh-block-contact-form").forEach(function (node) {
    var formSlug = node.getAttribute("data-form-slug");
    var form = el("form", "card");
    var name = el("input"); name.name = "name"; name.placeholder = "Your name"; name.required = true;
    var email = el("input"); email.name = "email"; email.type = "email";
    email.placeholder = "Your email"; email.required = true;
    var msg = el("textarea"); msg.name = "message"; msg.placeholder = "How can I help?"; msg.rows = 5;
    var btn = el("button", "btn", node.getAttribute("data-submit-label") || "Send");
    btn.type = "submit";
    [name, email, msg, btn].forEach(function (n) { form.appendChild(n); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      btn.disabled = true;
      fetch("/public/" + encodeURIComponent(slug) + "/forms/" + encodeURIComponent(formSlug), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.value, email: email.value, message: msg.value }),
      }).then(function (r) {
        node.replaceChildren(el("p", "", r.ok ? "Thanks — I'll be in touch." : "Something went wrong."));
      });
    });
    node.appendChild(form);
  });
  document.querySelectorAll(".qh-block-project-intake").forEach(function (node) {
    var projectType = node.getAttribute("data-project-type") || "longarm";
    var form = el("form", "card");
    form.appendChild(el("h3", "", node.getAttribute("data-heading") || "Request a quote"));

    var name = el("input"); name.name = "name"; name.placeholder = "Your name"; name.required = true;
    var email = el("input"); email.type = "email"; email.placeholder = "Your email"; email.required = true;
    var phone = el("input"); phone.placeholder = "Phone (optional)";
    form.appendChild(name); form.appendChild(email); form.appendChild(phone);

    var width = el("input"); width.type = "number"; width.min = "1"; width.max = "200";
    width.placeholder = "Quilt width (inches)";
    var height = el("input"); height.type = "number"; height.min = "1"; height.max = "200";
    height.placeholder = "Quilt height (inches)";
    var blocks = el("input"); blocks.type = "number"; blocks.min = "1";
    blocks.placeholder = "How many T-shirt blocks?";

    if (projectType === "tshirt_quilt") {
      form.appendChild(blocks);
    } else {
      form.appendChild(width); form.appendChild(height);
    }

    var level = document.createElement("select");
    [["edge_to_edge", "Edge to edge"], ["custom", "Custom quilting"]].forEach(function (pair) {
      var o = document.createElement("option");
      o.value = pair[0]; o.textContent = pair[1];
      level.appendChild(o);
    });
    if (projectType !== "tshirt_quilt") form.appendChild(level);

    var addons = {};
    [["batting", "Batting"], ["thread", "Thread"], ["binding", "Binding"],
     ["backingPrep", "Backing preparation"], ["rush", "Rush turnaround"]].forEach(function (pair) {
      var wrap = el("label");
      var cb = document.createElement("input"); cb.type = "checkbox";
      addons[pair[0]] = cb;
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode(" " + pair[1]));
      form.appendChild(wrap);
    });

    var btn = el("button", "btn", node.getAttribute("data-submit-label") || "Get my estimate");
    btn.type = "submit";
    form.appendChild(btn);
    var out = el("div", "muted");
    form.appendChild(out);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      btn.disabled = true;
      var intake = {
        widthIn: Number(width.value) || undefined,
        heightIn: Number(height.value) || undefined,
        blockCount: Number(blocks.value) || undefined,
        serviceLevel: level.value,
      };
      Object.keys(addons).forEach(function (k) { intake[k] = addons[k].checked; });
      fetch("/public/" + encodeURIComponent(slug) + "/projects/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_type: projectType,
          customer_name: name.value,
          customer_email: email.value,
          customer_phone: phone.value,
          intake: intake,
        }),
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (!res.ok) { out.textContent = res.j.error || "Something went wrong."; return; }
          node.replaceChildren();
          node.appendChild(el("h3", "", "Thanks — we have your request."));
          node.appendChild(el("p", "", "Your reference is " + res.j.reference + "."));
          // Suppressed means the rate table can't price this. Show NOTHING
          // rather than $0 — a confident wrong price is worse than no price.
          if (res.j.ballpark && !res.j.ballpark.suppressed) {
            node.appendChild(el("p", "",
              "Estimated ballpark: $" + (res.j.ballpark.total_cents / 100).toFixed(2)));
            node.appendChild(el("p", "muted",
              "This is an estimate only. We'll review the details and send your final quote."));
          }
        })
        .catch(function () {
          // The fetch itself failed to complete — dropped connection, DNS
          // failure, offline — as opposed to a completed response the server
          // rejected (handled in the .then above). Distinct wording so the
          // customer can tell "you said no" from "it never arrived", and the
          // button is re-enabled so they are not stuck on a dead form.
          btn.disabled = false;
          out.textContent = "We couldn't send this — check your connection and try again.";
        });
    });
    node.appendChild(form);
  });
})();
