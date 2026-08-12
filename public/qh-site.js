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
    var blocks = el("input"); blocks.type = "number"; blocks.min = "1"; blocks.max = "500";
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

    // Photos: offered for every project type, not just T-shirt quilts — a
    // photo of a quilt top is just as useful for a longarm job. These mirror
    // the server's bounds (src/routes/public.ts:309-310, MAX_FILES=5,
    // MAX_BYTES=10MB) so the customer finds out before anything is sent,
    // the same way the width/height/block-count inputs above mirror their
    // server-side caps.
    var MAX_PHOTOS = 5;
    var MAX_PHOTO_BYTES = 10 * 1024 * 1024;
    var photoLabel = el("label");
    var photoInput = document.createElement("input");
    photoInput.type = "file";
    photoInput.multiple = true;
    photoInput.accept = "image/png,image/jpeg,image/gif,image/webp,image/avif";
    photoLabel.appendChild(photoInput);
    photoLabel.appendChild(document.createTextNode(" Photos (optional)"));
    form.appendChild(photoLabel);
    var photoHint = el("p", "muted",
      "Up to " + MAX_PHOTOS + " photos, 10MB each." +
      (projectType === "tshirt_quilt" ? " A photo of the shirts really helps." : ""));
    form.appendChild(photoHint);
    var photoError = el("p", "muted", "");
    form.appendChild(photoError);

    function validatePhotoSelection(files) {
      if (files.length > MAX_PHOTOS) {
        return "Please choose at most " + MAX_PHOTOS + " photos.";
      }
      for (var i = 0; i < files.length; i++) {
        if (files[i].size > MAX_PHOTO_BYTES) {
          return "Each photo must be under 10MB (\"" + files[i].name + "\" is larger).";
        }
      }
      return null;
    }
    photoInput.addEventListener("change", function () {
      photoError.textContent = validatePhotoSelection(photoInput.files) || "";
    });

    var btn = el("button", "btn", node.getAttribute("data-submit-label") || "Get my estimate");
    btn.type = "submit";
    form.appendChild(btn);
    var out = el("div", "muted");
    form.appendChild(out);

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      // Checked before any request is sent — same reasoning as the server's
      // own gate, just earlier: a customer who's over the cap should learn
      // now, not after the intake has already been recorded.
      var photoValidationError = validatePhotoSelection(photoInput.files);
      if (photoValidationError) {
        photoError.textContent = photoValidationError;
        return;
      }
      // Snapshot the File objects now. The intake needs to succeed first —
      // it returns the project reference the upload endpoint requires — so
      // the upload can't fire until after that response comes back. Holding
      // the File objects (not the <input> itself) means the upload still
      // works even though `node` gets emptied out by replaceChildren below.
      var selectedPhotos = Array.prototype.slice.call(photoInput.files);
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
          // Fail CLOSED: show a price only when the response positively
          // proves it is showable (suppressed === false AND total_cents is
          // a finite number). Anything else — suppressed true, suppressed
          // missing, total_cents missing/null/NaN, a malformed or tampered
          // body, a future refactor of the route — renders no price at all.
          // A guard that only works while the server keeps its current
          // shape is not a guard; this must be impossible to fool into
          // fabricating a price.
          if (
            res.j.ballpark &&
            res.j.ballpark.suppressed === false &&
            typeof res.j.ballpark.total_cents === "number" &&
            Number.isFinite(res.j.ballpark.total_cents)
          ) {
            node.appendChild(el("p", "",
              "Estimated ballpark: $" + (res.j.ballpark.total_cents / 100).toFixed(2)));
            node.appendChild(el("p", "muted",
              "This is an estimate only. We'll review the details and send your final quote."));
          }
          // The intake has already succeeded and the shop already has this
          // request — that must never be walked back by anything below.
          // A photo upload failure is reported as its own, separate line;
          // it must never read as "your submission failed" (it didn't).
          if (selectedPhotos.length) {
            var uploadStatus = el("p", "muted",
              "Uploading " + selectedPhotos.length +
              (selectedPhotos.length === 1 ? " photo" : " photos") + "...");
            node.appendChild(uploadStatus);
            var photoForm = new FormData();
            selectedPhotos.forEach(function (f) { photoForm.append("photos", f); });
            fetch(
              "/public/" + encodeURIComponent(slug) + "/projects/" +
                encodeURIComponent(res.j.reference) + "/photos",
              { method: "POST", body: photoForm }
            ).then(function (r) {
              return r.json().catch(function () { return null; }).then(function (j) {
                return { ok: r.ok, j: j };
              });
            }).then(function (uploadRes) {
              if (uploadRes.ok && uploadRes.j && uploadRes.j.ok) {
                uploadStatus.textContent = "Photos attached — thanks!";
              } else {
                uploadStatus.textContent =
                  "We have your request (reference " + res.j.reference + "), but the " +
                  "photos didn't attach. Please contact us directly to send them, and " +
                  "mention your reference number.";
              }
            }).catch(function () {
              uploadStatus.textContent =
                "We have your request (reference " + res.j.reference + "), but the " +
                "photos didn't attach. Please contact us directly to send them, and " +
                "mention your reference number.";
            });
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
