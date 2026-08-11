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
})();
