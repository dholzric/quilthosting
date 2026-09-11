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
