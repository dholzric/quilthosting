/* Motion for signature compositions. Content is visible without this file. */
(function () {
  "use strict";
  if (!document.body.dataset.qhComposition || document.body.dataset.qhComposition === "classic" ||
      !window.matchMedia || !Element.prototype.animate) return;
  var preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (preference.matches) return;
  var active = new Set(), observer;
  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function enter(node, delay, image) {
    if (preference.matches || node.contains(document.activeElement)) return;
    var frames = image
      ? [{ clipPath: "inset(9% 0 9% 0)", opacity: 0.5 }, { clipPath: "inset(0% 0 0% 0)", opacity: 1 }]
      : [{ transform: "translateY(24px)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }];
    var animation = node.animate(frames, { duration: image ? 1100 : 750, delay: delay,
      easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" });
    active.add(animation);
    animation.onfinish = animation.oncancel = function () { active.delete(animation); };
  }
  all(".qh-main > .qh-hero:first-child .qh-hero__body > *").forEach(function (node, i) { enter(node, i * 95, false); });
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        if (entry.target.matches(".qh-feature")) {
          var siblings = Array.prototype.slice.call(entry.target.parentElement.children);
          enter(entry.target, Math.min(siblings.indexOf(entry.target), 3) * 85, false);
        } else enter(entry.target, 0, entry.target.matches("figure,.qh-hero__media"));
      });
    }, { threshold: 0.08 });
    all(".qh-main .qh-feature, .qh-main .qh-image figure, .qh-main > .qh-hero:first-child .qh-hero__media, .qh-main > .qh-rich > h2")
      .forEach(function (node) { observer.observe(node); });
  }
  function stop() { active.forEach(function (animation) { animation.cancel(); }); if (observer) observer.disconnect(); }
  if (preference.addEventListener) preference.addEventListener("change", function () { if (preference.matches) stop(); });
  document.addEventListener("focusin", function (event) {
    active.forEach(function (animation) { if (animation.effect.target.contains(event.target)) animation.cancel(); });
  });
  window.addEventListener("pagehide", stop, { once: true });
})();

/* A single useful interaction gives each showcase composition its own identity. */
(function () {
  "use strict";
  var body = document.body;
  var composition = body.dataset.qhComposition;
  var hero = document.querySelector(".qh-main > .qh-hero:first-child");
  if (!hero || !["biennial", "review", "social", "noir", "fieldstone", "heirloom"].includes(composition)) return;
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function button(label) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "qh-xp__button";
    b.textContent = label;
    return b;
  }
  function experience(name, label) {
    var node = document.createElement("aside");
    node.className = "qh-xp";
    node.setAttribute("data-qh-experience", name);
    node.setAttribute("aria-label", label);
    hero.appendChild(node);
    return node;
  }
  function toggleControl(node, label, className, onLabel) {
    var b = button(label);
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", function () {
      var on = body.classList.toggle(className);
      b.setAttribute("aria-pressed", String(on));
      b.textContent = on ? onLabel : label;
    });
    node.appendChild(b);
  }

  if (composition === "biennial") {
    var rail = experience("exhibition-index", "Exhibition page index");
    var sections = Array.prototype.slice.call(document.querySelectorAll(".qh-main > .qh-s"));
    sections.forEach(function (section, i) {
      var b = button(String(i + 1).padStart(2, "0"));
      b.setAttribute("aria-label", "Go to section " + (i + 1));
      b.addEventListener("click", function () { section.scrollIntoView({ behavior: reduced ? "auto" : "smooth" }); });
      b.addEventListener("keydown", function (event) {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        var next = (i + (event.key === "ArrowDown" ? 1 : -1) + sections.length) % sections.length;
        rail.querySelectorAll("button")[next].focus();
      });
      rail.appendChild(b);
    });
  }

  if (composition === "review") {
    var note = experience("editors-note", "Current issue editor's note");
    var open = button("Editor’s note ↗");
    var panel = document.createElement("div");
    panel.className = "qh-xp__panel";
    panel.id = "qh-editors-note";
    panel.hidden = true;
    panel.innerHTML = "<p class=\"qh-xp__kicker\">From the editors / No. 12</p><p>We made this issue for the second look: the moment familiar cloth becomes an argument, a record, or a new way to gather.</p>";
    open.setAttribute("aria-expanded", "false");
    open.setAttribute("aria-controls", panel.id);
    open.addEventListener("click", function () { panel.hidden = !panel.hidden; open.setAttribute("aria-expanded", String(!panel.hidden)); });
    note.appendChild(open); note.appendChild(panel);
  }

  if (composition === "social") {
    var table = experience("shuffle-table", "Collage arrangement");
    var shuffle = button("Shuffle the table ↻");
    shuffle.addEventListener("click", function () {
      var cards = document.querySelectorAll(".qh-main > .qh-s:not(:first-child)");
      cards.forEach(function (card, i) { card.style.setProperty("--qh-shuffle", (((i * 7 + Date.now()) % 9) - 4) + "deg"); });
      body.classList.toggle("qh-social-shuffled");
    });
    table.appendChild(shuffle);
  }

  if (composition === "noir") toggleControl(experience("light-study", "Artwork lighting"), "Raise the light", "qh-noir-lit", "Lower the light");
  if (composition === "fieldstone") toggleControl(experience("daylight", "Retreat atmosphere"), "Evening light", "qh-fieldstone-evening", "Morning light");

  if (composition === "heirloom") {
    var record = experience("provenance", "Collection provenance");
    var reveal = button("Open collection record");
    var details = document.createElement("div");
    details.className = "qh-xp__panel"; details.id = "qh-provenance"; details.hidden = true;
    details.innerHTML = "<p class=\"qh-xp__kicker\">Collection record / HH-027</p><dl><div><dt>Material</dt><dd>Cotton, linen, wool batting</dd></div><div><dt>Method</dt><dd>Hand pieced and hand quilted</dd></div><div><dt>Record</dt><dd>Illustrative sample for replacement</dd></div></dl>";
    reveal.setAttribute("aria-expanded", "false"); reveal.setAttribute("aria-controls", details.id);
    reveal.addEventListener("click", function () { details.hidden = !details.hidden; reveal.setAttribute("aria-expanded", String(!details.hidden)); });
    record.appendChild(reveal); record.appendChild(details);
  }
})();
