/* public/qh-site.js — interactive islands for the server-rendered tenant site.
 * The HTML is complete before this runs; each module wakes only when its hook is
 * in the page. Context: <body data-qh-slug data-qh-base data-qh-type>; every
 * request goes to `${qhBase}/public/${qhSlug}/…`. DOM APIs only — no innerHTML.
 * Modules: initNav, initJoin, initRegister, initCart, initDonate, initCalendar,
 * initLightbox, initVolunteer, initNewsletter, initDirectorySearch (+ initReturnFlags
 * and the legacy .qh-block-* hydration from the business renderer), booted from boot(). */
(function () {
  "use strict";

  var qhSlug = "", qhBase = location.origin, qhType = "guild", reducedMotion = false;
  var NETWORK_ERR = "We couldn't reach the server — check your connection and try again.";

  function readContext() {
    var ds = (document.body && document.body.dataset) || {};
    qhSlug = ds.qhSlug || document.documentElement.getAttribute("data-tenant-slug") || "";
    qhBase = ds.qhBase || location.origin;
    qhType = ds.qhType || "guild";
    reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  // ---- DOM + network helpers ---------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function button(cls, text, label) {
    var b = el("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    return b;
  }
  function fieldset(legend) { var f = el("fieldset", "qh-form__slots"); f.appendChild(el("legend", "", legend)); return f; }
  function textInput(type, name, placeholder, required) {
    var i = el("input");
    i.type = type; i.name = name; i.placeholder = placeholder || ""; i.required = !!required;
    if (type === "email") i.autocomplete = "email";
    return i;
  }
  function labelled(text, input) { var l = el("label"); l.append(el("span", "", text), input); return l; }
  function money(cents) { return "$" + ((cents || 0) / 100).toFixed(2); }
  function nearestHeading(node) {
    var card = node.closest("article,li,.qh-level,.qh-product,.qh-event,section");
    var h = card && card.querySelector("h1,h2,h3,h4");
    return h ? h.textContent.trim() : "";
  }
  function busy(node, on) { if (on) node.setAttribute("aria-busy", "true"); else node.removeAttribute("aria-busy"); }
  /** The single network path: resolves {ok, status, data}; a non-JSON body becomes {}. */
  function api(path, init) {
    return fetch(qhBase + "/public/" + encodeURIComponent(qhSlug) + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        return { ok: r.ok, status: r.status, data: data || {} };
      });
    });
  }
  function postJson(path, body) {
    return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  function fail(res, fallback) { return new Error(res.data.error || fallback); }
  function errMsg(err) { return err instanceof TypeError ? NETWORK_ERR : err.message; }
  function toastErr(err) { toast("err", errMsg(err)); }
  /** Stripe hand-off, identical to guild.html: a checkout_url in the response wins over any message. */
  function go(data) { if (data.checkout_url) location.href = data.checkout_url; return !!data.checkout_url; }
  function askEmail() { var v = prompt("Email for your receipt:"); return v ? v.trim() : ""; }
  var toastEl = null, toastTimer = 0;
  function toast(kind, msg) {
    if (!toastEl) {
      toastEl = el("div", "qh-flash");
      toastEl.setAttribute("role", "status"); toastEl.setAttribute("aria-live", "polite");
      toastEl.style.cssText = "position:fixed;left:1rem;right:1rem;bottom:1rem;z-index:60;max-width:32rem;margin:0 auto;" +
        "padding:.9rem 1.1rem;background:var(--_surface);color:var(--_ink);border:1px solid var(--_border);" +
        "border-left-width:5px;border-radius:var(--_radius);box-shadow:var(--_shadow)";
      document.body.appendChild(toastEl);
    }
    toastEl.className = "qh-flash qh-flash--" + (kind === "ok" ? "ok" : "err");
    toastEl.style.borderLeftColor = kind === "ok" ? "var(--_accent)" : "var(--_primary)";
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 7000);
  }
  // ---- Dialog plumbing (created once, focus trapped, Escape closes) --------
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
    'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function trapFocus(container) {
    container.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var items = $$(FOCUSABLE, container).filter(function (n) { return !n.hidden && n.offsetParent !== null; });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  function openModal(dialog, opener) {
    dialog.qhOpener = opener || document.activeElement;
    if (typeof dialog.showModal === "function") { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute("open", "");
    var first = $$(FOCUSABLE, dialog).filter(function (n) { return !n.classList.contains("qh-dialog__close"); })[0];
    if (first) first.focus();
  }
  function closeModal(dialog) {
    if (typeof dialog.close === "function" && dialog.open) dialog.close(); else dialog.removeAttribute("open");
  }
  /** Shared wiring for every <dialog>: Escape (both key and native cancel), focus trap, focus restore. */
  function wireDialog(d, onKey) {
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); closeModal(d); }
      else if (onKey) onKey(e);
    });
    d.addEventListener("cancel", function (e) { e.preventDefault(); closeModal(d); });
    d.addEventListener("close", function () { if (d.qhOpener && d.qhOpener.focus) d.qhOpener.focus(); });
    trapFocus(d);
    document.body.appendChild(d);
  }
  var dialogSeq = 0;
  function makeDialog(cls, title) {
    var d = document.createElement("dialog");
    d.className = "qh-dialog " + (cls || "");
    var h = el("h2", "", title), head = el("div", "qh-dialog__head"), body = el("div", "qh-dialog__body");
    h.id = "qh-dialog-title-" + (++dialogSeq);
    d.setAttribute("aria-labelledby", h.id);
    var close = button("qh-dialog__close qh-btn qh-btn--ghost", "×", "Close");
    close.addEventListener("click", function () { closeModal(d); });
    head.append(h, close);
    var err = el("p", "qh-form__error");
    err.setAttribute("role", "alert");
    err.hidden = true;
    d.append(head, body, err);
    wireDialog(d);
    return {
      el: d, title: h, body: body,
      open: function (opener) { err.hidden = true; openModal(d, opener); },
      close: function () { closeModal(d); },
      fail: function (msg) { err.textContent = msg; err.hidden = false; },
    };
  }
  /** Join custom fields and event questions share one shape: {key,label,type,required,options}. */
  function customFieldInput(f) {
    var input = f.type === "select" ? el("select") : textInput("text", f.key);
    if (f.type === "select") {
      [""].concat(f.options || []).forEach(function (o) { var opt = el("option", "", o || "—"); opt.value = o; input.appendChild(opt); });
    }
    input.dataset.cfKey = f.key;
    if (f.required) input.required = true;
    return input;
  }
  // ---- Signup dialog (join + register share it, as in guild.html) ----------
  var signup = null;
  function ensureSignup() {
    if (signup) return signup;
    var dlg = makeDialog("qh-dialog--signup", ""), form = el("form", "qh-form");
    var first = textInput("text", "first_name", "First name"), last = textInput("text", "last_name", "Last name");
    var email = textInput("email", "email", "you@example.com", true), custom = el("div", "qh-form__custom");
    var submit = el("button", "qh-btn qh-btn--primary", "Continue");
    submit.type = "submit";
    form.append(labelled("First name", first), labelled("Last name", last), labelled("Email", email), custom, submit);
    form.addEventListener("submit", submitSignup);
    dlg.body.appendChild(form);
    signup = { dlg: dlg, first: first, last: last, email: email, custom: custom, submit: submit, action: null };
    return signup;
  }
  function openSignup(title, action, opener) {
    var s = ensureSignup();
    s.action = action;
    s.dlg.title.textContent = title;
    s.submit.textContent = action.type === "join" ? "Join" : "Register";
    s.custom.replaceChildren();
    (action.fields || []).forEach(function (f) {
      s.custom.appendChild(labelled(f.label + (f.required ? " *" : ""), customFieldInput(f)));
    });
    s.dlg.open(opener);
  }
  function submitSignup(e) {
    e.preventDefault();
    var s = signup, a = s.action;
    var email = s.email.value.trim();
    if (!email) { s.dlg.fail("Email is required."); return; }
    var body = { email: email, first_name: s.first.value.trim() || undefined, last_name: s.last.value.trim() || undefined };
    var extra = {};
    $$("[data-cf-key]", s.custom).forEach(function (i) { if (i.value) extra[i.dataset.cfKey] = i.value; });
    var path;
    if (a.type === "join") {
      body.level_id = a.levelId;
      if (Object.keys(extra).length) body.custom_fields = extra;
      path = "/join";
    } else {
      body.name = [body.first_name, body.last_name].filter(Boolean).join(" ") || undefined;
      if (Object.keys(extra).length) body.custom_answers = extra;
      path = "/events/" + encodeURIComponent(a.eventId) + "/register";
    }
    s.submit.disabled = true;
    postJson(path, body).then(function (res) {
      if (!res.ok) throw fail(res, "Something went wrong");
      if (go(res.data)) return;
      s.dlg.close();
      if (a.type === "join") toast("ok", res.data.message || "Membership activated — welcome!");
      else toast("ok", (res.data.message || "Registered!") + " Your ticket code is " + res.data.ticket_code + ".");
    }).catch(function (err) { s.dlg.fail(errMsg(err)); }).then(function () { s.submit.disabled = false; });
  }
  function openEventSignup(ev, opener) {
    if (!ev.registration_open) { toast("err", ev.title + " — registration is closed."); return; }
    openSignup("Register — " + ev.title, { type: "event", eventId: ev.id, fields: ev.questions || [] }, opener);
  }
  // ---- Module: nav (phone drawer; .qh-drawer is a <dialog> in the stylesheet) --
  function initNav() {
    var toggle = document.querySelector(".qh-nav-toggle"), drawer = document.querySelector(".qh-drawer");
    if (!toggle || !drawer) return;
    var panel = drawer.querySelector(".qh-drawer__panel") || drawer, isDialog = drawer.tagName === "DIALOG";
    if (!drawer.id) drawer.id = "qh-drawer";
    toggle.setAttribute("aria-controls", drawer.id); toggle.setAttribute("aria-expanded", "false");
    function isOpen() { return isDialog ? drawer.open : drawer.hasAttribute("open"); }
    function open() {
      if (isDialog && typeof drawer.showModal === "function") { if (!drawer.open) drawer.showModal(); } else drawer.setAttribute("open", "");
      toggle.setAttribute("aria-expanded", "true");
      var f = drawer.querySelector(".qh-drawer__close") || drawer.querySelector(FOCUSABLE);
      if (f) f.focus();
    }
    var refocusToggle = true;
    function finishClose() {
      if (isDialog && drawer.open) drawer.close(); else drawer.removeAttribute("open");
      toggle.setAttribute("aria-expanded", "false");
      if (refocusToggle) toggle.focus(); // only after close: nothing outside a modal can take focus while it's open
    }
    function close(refocus) {
      if (!isOpen()) return;
      refocusToggle = refocus !== false;
      // Slide out unless the visitor asked for reduced motion (then close at once).
      if (!reducedMotion && typeof panel.animate === "function") {
        var anim = panel.animate([{ transform: "none" }, { transform: "translateX(100%)" }], { duration: 180, easing: "ease-in" });
        anim.onfinish = anim.oncancel = finishClose;
      } else finishClose();
    }
    toggle.addEventListener("click", function () { if (isOpen()) close(); else open(); });
    $$(".qh-drawer__close", drawer).forEach(function (b) { b.addEventListener("click", function () { close(); }); });
    drawer.addEventListener("click", function (e) { if (e.target === drawer) close(); });
    drawer.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); close(); } });
    drawer.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    $$("a[href]", drawer).forEach(function (a) { a.addEventListener("click", function () { close(false); }); });
    trapFocus(drawer);
    // Widening past the drawer breakpoint drops the drawer so it can't sit open behind the desktop nav.
    if (window.matchMedia) window.matchMedia("(min-width: 800px)").addEventListener("change", function (ev) { if (ev.matches && isOpen()) finishClose(); });
  }
  // ---- Module: join ([data-join="levelId"]) -----------------------------------
  var infoPromise = null;
  function loadInfo() {
    if (!infoPromise) infoPromise = api("/info").then(function (r) { return r.ok ? r.data : {}; }, function () { return {}; });
    return infoPromise;
  }
  function initJoin() {
    $$("[data-join]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var levelId = btn.getAttribute("data-join");
        var name = btn.getAttribute("data-join-name") || nearestHeading(btn);
        busy(btn, true);
        loadInfo().then(function (info) {
          busy(btn, false);
          openSignup(name ? "Join — " + name : "Join", { type: "join", levelId: levelId, fields: info.join_fields || [] }, btn);
        });
      });
    });
  }
  // ---- Module: register ([data-register], .qh-cta[id^="register-"]) ----------
  function initRegister() {
    $$('[data-register], .qh-cta[id^="register-"]').forEach(function (hook) {
      var eventId = hook.getAttribute("data-register") || hook.id.replace(/^register-/, "");
      var target = hook.matches("a,button") ? hook : hook.querySelector("a,button");
      if (!eventId || !target) return;
      target.addEventListener("click", function (e) {
        e.preventDefault();
        busy(target, true);
        api("/events/" + encodeURIComponent(eventId)).then(function (res) {
          busy(target, false);
          if (!res.ok) throw fail(res, "Event not found");
          openEventSignup(res.data.event || res.data, target);
        }).catch(function (err) { busy(target, false); toastErr(err); });
      });
    });
  }
  // ---- Module: cart / buy ([data-add], [data-buy]) ---------------------------
  // Page-local, like guild.html: name/price come from data-name/data-price or the product card.
  var cart = [], cartBar = null; // {product_id, name, price_cents, quantity}
  function productInfo(btn) {
    var raw = btn.getAttribute("data-price"), cents = raw === null ? NaN : Number(raw); // Number(null) is 0, not "missing"
    if (!Number.isFinite(cents)) {
      var card = btn.closest(".qh-product,article,li");
      var priceEl = card && card.querySelector(".qh-product__price");
      var m = priceEl && /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(priceEl.textContent);
      cents = m ? Math.round(Number(m[1].replace(/,/g, "")) * 100) : 0;
    }
    return { name: btn.getAttribute("data-name") || nearestHeading(btn) || "Item", cents: cents };
  }
  function renderCartBar() {
    if (!cartBar) {
      cartBar = el("div", "qh-cart-bar qh-product");
      cartBar.setAttribute("role", "region");
      cartBar.setAttribute("aria-label", "Cart");
      (document.querySelector(".qh-store .qh-container, .qh-store") || document.body).appendChild(cartBar);
    }
    cartBar.replaceChildren();
    cartBar.hidden = !cart.length;
    if (!cart.length) return;
    var count = cart.reduce(function (n, i) { return n + i.quantity; }, 0);
    var sub = cart.reduce(function (s, i) { return s + i.price_cents * i.quantity; }, 0);
    var list = el("ul");
    cart.forEach(function (i) { list.appendChild(el("li", "", i.quantity + "× " + i.name + " — " + money(i.price_cents * i.quantity))); });
    var checkout = button("qh-btn qh-btn--primary", "Checkout cart");
    checkout.addEventListener("click", checkoutCart);
    cartBar.append(el("h3", "qh-product__name", "Cart (" + count + (count === 1 ? " item)" : " items)")),
      list, el("p", "qh-product__price", "Subtotal " + money(sub)), checkout);
  }
  function addToCart(id, name, cents) {
    var existing = cart.filter(function (i) { return i.product_id === id; })[0];
    if (existing) existing.quantity += 1;
    else cart.push({ product_id: id, name: name, price_cents: cents, quantity: 1 });
    renderCartBar();
    toast("ok", name + " added to your cart.");
  }
  function checkoutCart() {
    var email = cart.length ? askEmail() : "";
    if (!email) return;
    postJson("/cart/checkout", {
      email: email,
      items: cart.map(function (i) { return { product_id: i.product_id, quantity: i.quantity }; }),
    }).then(function (res) {
      if (!res.ok) throw fail(res, "Checkout failed");
      if (go(res.data)) return;
      cart = []; renderCartBar();
      toast("ok", res.data.message || "Order complete!");
    }).catch(toastErr);
  }
  function buyProduct(id) {
    var email = askEmail();
    if (!email) return;
    postJson("/products/" + encodeURIComponent(id) + "/buy", { email: email }).then(function (res) {
      if (!res.ok) throw fail(res, "Purchase failed");
      if (!go(res.data)) toast("ok", res.data.message || "Purchase complete!");
    }).catch(toastErr);
  }
  function initCart() {
    var buys = $$("[data-buy]"), adds = $$("[data-add]");
    if (!buys.length && !adds.length) return;
    buys.forEach(function (btn) {
      btn.addEventListener("click", function (e) { e.preventDefault(); buyProduct(btn.getAttribute("data-buy")); });
    });
    adds.forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var p = productInfo(btn);
        addToCart(btn.getAttribute("data-add"), p.name, p.cents);
      });
    });
  }
  // ---- Module: donate ([data-donate="cents"]; below $1 or non-numeric prompts) --
  function initDonate() {
    $$("[data-donate]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var cents = Number(btn.getAttribute("data-donate"));
        if (!Number.isFinite(cents) || cents < 100) {
          var dollars = Number(prompt("Donation amount in dollars:"));
          if (!Number.isFinite(dollars) || dollars < 1) return;
          cents = Math.round(dollars * 100);
        }
        busy(btn, true);
        postJson("/donate", { amount_cents: cents }).then(function (res) {
          busy(btn, false);
          if (!res.ok) throw fail(res, "Something went wrong");
          if (!go(res.data)) toast("ok", res.data.message || "Thank you!");
        }).catch(function (err) { busy(btn, false); toastErr(err); });
      });
    });
  }
  // ---- Module: calendar (.qh-events--calendar[data-month]) -------------------
  var calLib = null;
  function loadCalLib() {
    if (window.qhCal && window.qhCal.render) return Promise.resolve(window.qhCal);
    if (calLib) return calLib;
    calLib = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/qh-cal.js";
      s.async = true;
      s.onload = function () { if (window.qhCal && window.qhCal.render) resolve(window.qhCal); else reject(new Error("calendar unavailable")); };
      s.onerror = function () { reject(new Error("calendar unavailable")); };
      document.head.appendChild(s);
    });
    return calLib;
  }
  function initCalendar() {
    $$(".qh-events--calendar").forEach(function (node) {
      var host = node.querySelector(".qh-cal-host");
      if (!host) {
        host = el("div", "qh-cal-host");
        var empty = node.querySelector(".qh-empty");
        if (empty) empty.replaceWith(host);
        else (node.querySelector(".qh-container") || node).appendChild(host);
      }
      var m = /^(\d{4})-(\d{2})$/.exec(node.getAttribute("data-month") || "");
      var now = new Date();
      var cursor = m ? { y: Number(m[1]), m: Number(m[2]) } : { y: now.getFullYear(), m: now.getMonth() + 1 };
      function draw() {
        busy(host, true);
        var monthStr = cursor.y + "-" + String(cursor.m).padStart(2, "0");
        node.setAttribute("data-month", monthStr);
        Promise.all([loadCalLib(), api("/events?month=" + monthStr)]).then(function (r) {
          var events = (r[1].ok && r[1].data.events) || [];
          r[0].render(host, events, function (ev) { openEventSignup(ev); }, {
            year: cursor.y, month: cursor.m,
            onMonthChange: function (y, mo) { cursor = { y: y, m: mo }; draw(); },
          });
        }).catch(function () {
          host.replaceChildren(el("p", "qh-empty", "The calendar couldn't load. Please refresh to try again."));
        }).then(function () { busy(host, false); });
      }
      draw();
    });
  }
  // ---- Module: lightbox (.qh-gallery a[data-lightbox]) -----------------------
  var lightbox = null;
  function ensureLightbox() {
    if (lightbox) return lightbox;
    var d = document.createElement("dialog");
    d.className = "qh-lightbox";
    d.setAttribute("aria-label", "Image viewer");
    var close = button("qh-dialog__close qh-lightbox__close qh-btn qh-btn--ghost", "×", "Close");
    var prev = button("qh-lightbox__prev qh-btn qh-btn--ghost", "‹", "Previous image");
    var next = button("qh-lightbox__next qh-btn qh-btn--ghost", "›", "Next image");
    var fig = el("figure", "qh-lightbox__figure"), img = el("img"), cap = el("figcaption", "qh-lightbox__caption");
    fig.append(img, cap);
    d.append(close, prev, fig, next);
    var state = { items: [], index: 0 };
    function show(i) {
      var n = state.items.length;
      state.index = ((i % n) + n) % n;
      var a = state.items[state.index], inner = a.querySelector("img");
      var figcap = a.closest("figure") && a.closest("figure").querySelector("figcaption");
      img.src = a.href;
      img.alt = a.getAttribute("data-alt") || (inner && inner.alt) || "";
      cap.textContent = a.getAttribute("data-caption") || (figcap ? figcap.textContent.trim() : "");
      cap.hidden = !cap.textContent;
      prev.hidden = next.hidden = n < 2;
    }
    close.addEventListener("click", function () { closeModal(d); });
    prev.addEventListener("click", function () { show(state.index - 1); });
    next.addEventListener("click", function () { show(state.index + 1); });
    d.addEventListener("click", function (e) { if (e.target === d || e.target === fig) closeModal(d); });
    d.addEventListener("close", function () { img.removeAttribute("src"); });
    wireDialog(d, function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); show(state.index - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); show(state.index + 1); }
    });
    lightbox = {
      open: function (items, index, opener) { state.items = items; show(index); openModal(d, opener); close.focus(); },
    };
    return lightbox;
  }
  function initLightbox() {
    $$(".qh-gallery").forEach(function (g) {
      var links = $$("a[data-lightbox]", g);
      links.forEach(function (a, i) { a.addEventListener("click", function (e) { e.preventDefault(); ensureLightbox().open(links, i, a); }); });
    });
  }
  // ---- Module: volunteer ([data-volunteer="eventId"], .qh-cta[id^="volunteer-"]) ----
  // A button/link (or the event page's volunteer cta section) opens the sign-up
  // dialog; any other [data-volunteer] element becomes the inline slot list.
  var volunteer = null;
  function loadSlots(eventId) {
    return api("/events/" + encodeURIComponent(eventId) + "/volunteers").then(function (r) { return (r.ok && r.data.slots) || []; }, function () { return []; });
  }
  function ensureVolunteer() {
    if (volunteer) return volunteer;
    var dlg = makeDialog("qh-dialog--volunteer", "Volunteer sign-up"), form = el("form", "qh-form");
    var slots = fieldset("Choose a slot");
    var name = textInput("text", "name", "Your name"), phone = textInput("tel", "phone", "Phone (optional)");
    var email = textInput("email", "email", "you@example.com", true);
    var submit = el("button", "qh-btn qh-btn--primary", "Sign up");
    submit.type = "submit";
    form.append(slots, labelled("Your name", name), labelled("Email", email), labelled("Phone (optional)", phone), submit);
    form.addEventListener("submit", submitVolunteer);
    dlg.body.appendChild(form);
    volunteer = { dlg: dlg, slots: slots, name: name, email: email, phone: phone, submit: submit, eventId: null, lists: {} };
    return volunteer;
  }
  function openVolunteer(eventId, slotList, preselectId, opener) {
    var v = ensureVolunteer();
    v.eventId = eventId;
    $$("label", v.slots).forEach(function (l) { l.remove(); });
    slotList.filter(function (st) { return st.taken < st.needed; }).forEach(function (st, i) {
      var r = el("input"); r.type = "radio"; r.name = "slot_id"; r.value = st.id; r.required = true;
      r.checked = preselectId ? st.id === preselectId : i === 0;
      var l = el("label", "qh-form__slot");
      l.append(r, document.createTextNode(" " + st.title + " (" + st.taken + " of " + st.needed + " filled)"));
      v.slots.appendChild(l);
    });
    v.dlg.open(opener);
  }
  function submitVolunteer(e) {
    e.preventDefault();
    var v = volunteer;
    var email = v.email.value.trim();
    var slot = v.slots.querySelector("input:checked");
    if (!email) { v.dlg.fail("Email is required."); return; }
    if (!slot) { v.dlg.fail("Choose a slot."); return; }
    v.submit.disabled = true;
    postJson("/events/" + encodeURIComponent(v.eventId) + "/volunteer", {
      slot_id: slot.value, name: v.name.value.trim(), email: email, phone: v.phone.value.trim() || undefined,
    }).then(function (res) {
      if (!res.ok) throw fail(res, "Sign-up failed");
      v.dlg.close();
      toast("ok", "Thank you! You're signed up for " + res.data.slot + ".");
      if (v.lists[v.eventId]) renderSlotList(v.lists[v.eventId], v.eventId);
    }).catch(function (err) { v.dlg.fail(errMsg(err)); }).then(function () { v.submit.disabled = false; });
  }
  function renderSlotList(node, eventId) {
    ensureVolunteer().lists[eventId] = node;
    loadSlots(eventId).then(function (slots) {
      node.replaceChildren();
      node.hidden = !slots.length;
      if (!slots.length) return;
      node.appendChild(el("h2", "qh-s__heading", "Volunteer sign-up"));
      slots.forEach(function (st) {
        var card = el("article", "qh-event qh-volunteer__slot"), actions = el("div", "qh-event__actions");
        var who = (st.volunteers || []).length ? " · " + st.volunteers.join(", ") : "";
        card.appendChild(el("h3", "qh-event__title", st.title));
        if (st.description) card.appendChild(el("p", "qh-event__meta", st.description));
        card.append(el("p", "qh-event__meta", st.taken + " of " + st.needed + " filled" + who), actions);
        var b = st.taken >= st.needed ? el("span", "qh-badge", "Full") : button("qh-btn qh-btn--primary", "Sign up");
        b.addEventListener("click", function () { if (st.taken < st.needed) openVolunteer(eventId, slots, st.id, b); });
        actions.appendChild(b);
        node.appendChild(card);
      });
    });
  }
  function initVolunteer() {
    $$('[data-volunteer], .qh-cta[id^="volunteer-"]').forEach(function (hook) {
      var eventId = hook.getAttribute("data-volunteer") || hook.id.replace(/^volunteer-/, "");
      var node = hook.matches("a,button") ? hook : hook.classList.contains("qh-cta") ? hook.querySelector("a,button") : null;
      if (!eventId) return;
      if (!node) { renderSlotList(hook, eventId); return; }
      node.addEventListener("click", function (e) {
        e.preventDefault();
        busy(node, true);
        loadSlots(eventId).then(function (slots) {
          busy(node, false);
          if (!slots.length) { toast("err", "No volunteer slots are open for this event."); return; }
          openVolunteer(eventId, slots, null, node);
        });
      });
    });
  }
  // ---- Module: directory search ([data-directory-filter="listId"]) ----------
  // Plain text filter over the public member directory's cards; the count line updates.
  function initDirectorySearch() {
    $$("[data-directory-filter]").forEach(function (input) {
      var list = document.getElementById(input.getAttribute("data-directory-filter"));
      if (!list) return;
      var items = $$(".qh-directory__member", list), count = document.querySelector("[data-directory-count]");
      input.addEventListener("input", function () {
        var q = input.value.trim().toLowerCase(), shown = 0;
        items.forEach(function (it) { var hit = !q || it.textContent.toLowerCase().indexOf(q) >= 0; it.hidden = !hit; if (hit) shown++; });
        if (count) count.textContent = shown + (shown === 1 ? " member" : " members");
      });
    });
  }
  // ---- Checkout return flags (?joined=1 etc., same as guild.html) ------------
  // ---- Newsletter signup (form[data-newsletter] from the newsletter_signup section) ----
  function initNewsletter() {
    $$("form[data-newsletter]").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var email = form.querySelector('input[name="email"]'), name = form.querySelector('input[name="name"]');
        var btn = form.querySelector('button[type="submit"]');
        var value = email ? email.value.trim() : "";
        if (!value) { if (email) email.focus(); return; }
        busy(form, true); if (btn) btn.disabled = true;
        postJson("/newsletter", { email: value, name: name ? name.value.trim() : "" }).then(function (r) {
          busy(form, false);
          if (!r.ok) throw fail(r, "We couldn't save your address. Please try again.");
          form.replaceChildren(el("p", "qh-newsletter__done", r.data.message || "Thanks — you're on the list."));
        }).catch(function (err) { busy(form, false); if (btn) btn.disabled = false; toastErr(err); });
      });
    });
  }
  function initReturnFlags() {
    var qs = new URLSearchParams(location.search);
    if (qs.get("registered")) toast("ok", "You're registered! Check your email for confirmation.");
    if (qs.get("joined")) toast("ok", "Welcome! Your membership is active — check your email.");
    if (qs.get("donated")) toast("ok", "Thank you for your donation!");
    if (qs.get("purchased")) toast("ok", "Thank you for your purchase! Check your email for a receipt.");
    if (qs.get("cancelled")) toast("err", "Checkout was cancelled. You have not been charged.");
  }
  // ---- Legacy hydration (business renderer's .qh-block-* placeholders) -------
  function initLegacyBlocks() {
    function hydrateList(cls, path, key, fallbackLimit, line) {
      $$(cls).forEach(function (node) {
        api(path).then(function (r) {
          if (!r.ok || !r.data[key]) return;
          r.data[key].slice(0, Number(node.getAttribute("data-limit")) || fallbackLimit).forEach(function (item) {
            var card = el("div", "card"), text = line(item);
            card.appendChild(el("h3", "", item.title || item.name));
            if (text) card.appendChild(el("p", "", text));
            node.appendChild(card);
          });
        });
      });
    }
    hydrateList(".qh-block-events", "/events", "events", 5, function (ev) { return ev.start_at ? new Date(ev.start_at).toLocaleString() : ""; });
    hydrateList(".qh-block-store", "/products", "products", 6, function (p) { return money(p.price_cents); });
    $$(".qh-block-contact-form").forEach(function (node) {
      var formSlug = node.getAttribute("data-form-slug"), form = el("form", "card");
      var name = textInput("text", "name", "Your name", true), email = textInput("email", "email", "Your email", true);
      var msg = el("textarea"); msg.name = "message"; msg.placeholder = "How can I help?"; msg.rows = 5;
      var btn = el("button", "btn", node.getAttribute("data-submit-label") || "Send");
      btn.type = "submit";
      form.append(name, email, msg, btn);
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        btn.disabled = true;
        postJson("/forms/" + encodeURIComponent(formSlug), { name: name.value, email: email.value, message: msg.value })
          .then(function (r) { node.replaceChildren(el("p", "", r.ok ? "Thanks — I'll be in touch." : "Something went wrong.")); })
          .catch(function () { // network-level failure: re-enable so the form isn't dead
            btn.disabled = false;
            node.replaceChildren(el("p", "", "We couldn't send this — check your connection and try again."));
          });
      });
      node.appendChild(form);
    });
    $$(".qh-block-project-intake").forEach(initProjectIntake);
  }
  function initProjectIntake(node) {
    var projectType = node.getAttribute("data-project-type") || "longarm", tshirt = projectType === "tshirt_quilt";
    var form = el("form", "card");
    var name = textInput("text", "name", "Your name", true), email = textInput("email", "email", "Your email", true);
    var phone = textInput("text", "phone", "Phone (optional)");
    form.append(el("h3", "", node.getAttribute("data-heading") || "Request a quote"), name, email, phone);
    function num(placeholder, max) {
      var i = textInput("number", "", placeholder); i.min = "1"; i.max = String(max); return i;
    }
    var width = num("Quilt width (inches)", 200), height = num("Quilt height (inches)", 200);
    var blocks = num("How many T-shirt blocks?", 500), level = el("select");
    [["edge_to_edge", "Edge to edge"], ["custom", "Custom quilting"]].forEach(function (pair) {
      var o = el("option", "", pair[1]); o.value = pair[0]; level.appendChild(o);
    });
    if (tshirt) form.appendChild(blocks); else form.append(width, height, level);
    var addons = {};
    [["batting", "Batting"], ["thread", "Thread"], ["binding", "Binding"],
     ["backingPrep", "Backing preparation"], ["rush", "Rush turnaround"]].forEach(function (pair) {
      var wrap = el("label"), cb = el("input"); cb.type = "checkbox";
      addons[pair[0]] = cb;
      wrap.append(cb, document.createTextNode(" " + pair[1]));
      form.appendChild(wrap);
    });
    // Photo bounds mirror the server (MAX_FILES=5, 10MB each) so the customer hears it before sending.
    var MAX_PHOTOS = 5, MAX_PHOTO_BYTES = 10 * 1024 * 1024;
    var photoLabel = el("label"), photoInput = el("input"), photoError = el("p", "muted", "");
    photoInput.type = "file"; photoInput.multiple = true;
    photoInput.accept = "image/png,image/jpeg,image/gif,image/webp,image/avif";
    photoLabel.append(photoInput, document.createTextNode(" Photos (optional)"));
    form.append(photoLabel, el("p", "muted", "Up to " + MAX_PHOTOS + " photos, 10MB each." +
      (tshirt ? " A photo of the shirts really helps." : "")), photoError);
    function validatePhotos(files) {
      if (files.length > MAX_PHOTOS) return "Please choose at most " + MAX_PHOTOS + " photos.";
      for (var i = 0; i < files.length; i++) {
        if (files[i].size > MAX_PHOTO_BYTES) return "Each photo must be under 10MB (\"" + files[i].name + "\" is larger).";
      }
      return null;
    }
    photoInput.addEventListener("change", function () { photoError.textContent = validatePhotos(photoInput.files) || ""; });
    var btn = el("button", "btn", node.getAttribute("data-submit-label") || "Get my estimate"), out = el("div", "muted");
    btn.type = "submit";
    form.append(btn, out);
    var PHOTO_FAIL = " but the photos didn't attach. Please contact us directly to send them, and mention your reference number.";
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var photoErr = validatePhotos(photoInput.files);
      if (photoErr) { photoError.textContent = photoErr; return; }
      // Snapshot the Files: the upload needs the reference from the intake response, and `node` is emptied below.
      var selectedPhotos = Array.prototype.slice.call(photoInput.files);
      btn.disabled = true;
      var intake = {
        widthIn: Number(width.value) || undefined, heightIn: Number(height.value) || undefined,
        blockCount: Number(blocks.value) || undefined, serviceLevel: level.value,
      };
      Object.keys(addons).forEach(function (k) { intake[k] = addons[k].checked; });
      postJson("/projects/intake", {
        project_type: projectType, customer_name: name.value, customer_email: email.value,
        customer_phone: phone.value, intake: intake,
      }).then(function (res) {
        btn.disabled = false;
        if (!res.ok) { out.textContent = res.data.error || "Something went wrong."; return; }
        var ref = res.data.reference, bp = res.data.ballpark;
        node.replaceChildren(el("h3", "", "Thanks — we have your request."), el("p", "", "Your reference is " + ref + "."));
        // Fail closed: a price shows only when suppressed === false AND total_cents is a finite number.
        if (bp && bp.suppressed === false && typeof bp.total_cents === "number" && Number.isFinite(bp.total_cents)) {
          node.append(el("p", "", "Estimated ballpark: " + money(bp.total_cents)),
            el("p", "muted", "This is an estimate only. We'll review the details and send your final quote."));
        }
        if (!selectedPhotos.length) return;
        // The intake already succeeded; a photo failure is its own line, never "your submission failed".
        var status = el("p", "muted", "Uploading " + selectedPhotos.length + (selectedPhotos.length === 1 ? " photo" : " photos") + "...");
        node.appendChild(status);
        var photoForm = new FormData();
        selectedPhotos.forEach(function (f) { photoForm.append("photos", f); });
        var failMsg = "We have your request (reference " + ref + "),";
        api("/projects/" + encodeURIComponent(ref) + "/photos", { method: "POST", body: photoForm }).then(function (up) {
          status.textContent = up.ok && up.data.ok ? "Photos attached — thanks!" : failMsg + PHOTO_FAIL;
        }).catch(function () { status.textContent = failMsg + PHOTO_FAIL; });
      }).catch(function () {
        btn.disabled = false;
        out.textContent = "We couldn't send this — check your connection and try again.";
      });
    });
    node.appendChild(form);
  }
  // ---- Boot ------------------------------------------------------------------
  function boot() {
    readContext();
    initNav();
    initJoin();
    initRegister();
    initCart();
    initDonate();
    initCalendar();
    initLightbox();
    initVolunteer();
    initNewsletter();
    initDirectorySearch();
    initReturnFlags();
    initLegacyBlocks();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
