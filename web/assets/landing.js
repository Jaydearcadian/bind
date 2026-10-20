/*
 * The landing page's behaviour (ADR 0054): the header shadow, the phone menu, the entrance, the how-it-works story and the
 * who-it-is-for switcher. Everything here is progressive: without it, the page shows its finished state and every link works.
 * All content is example data written into this file; nothing is fetched.
 */
(function () {
  "use strict";
  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Entrance: start once the display face is ready (or after 700 ms), so the headline does not reflow mid-animation.
  function ready() {
    requestAnimationFrame(function () { root.classList.add("is-ready"); });
  }
  var started = false;
  function start() { if (!started) { started = true; ready(); } }

  // First visit of a session (boot.js decides): the ring draws, the bead seats, then the page appears (ADR 0055).
  var INTRO_MS = 1320;
  if (root.classList.contains("is-intro")) {
    var intro = document.createElement("div");
    intro.className = "intro";
    intro.setAttribute("aria-hidden", "true");
    intro.innerHTML =
      '<div><svg viewBox="0 0 64 64"><path class="ring" pathLength="100" d="M32 12A20 20 0 1 1 32 52A20 20 0 1 1 32 12"/>' +
      '<circle class="clasp" cx="42" cy="14.68" r="6.4"/></svg><p class="intro-word">BIND</p></div>';
    document.body.insertBefore(intro, document.body.firstChild);
    try { window.sessionStorage.setItem("bind-intro-seen", "1"); } catch (e) { /* the intro may play again; harmless */ }
    setTimeout(function () {
      root.classList.remove("is-intro");
      intro.classList.add("is-done");
      start();
      setTimeout(function () { intro.remove(); }, 500);
    }, INTRO_MS);
  } else {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(start, start);
    setTimeout(start, 700);
  }

  // Header: the glass pill tightens once the page scrolls, and the logo's bead travels round the ring with the page.
  var header = document.querySelector(".site-header");
  var orbit = Array.prototype.slice.call(document.querySelectorAll(".site-header .orbit"));
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var y = window.scrollY;
      if (header) header.classList.toggle("is-compact", y > 24);
      if (!reduceMotion.matches && orbit.length) {
        var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        var angle = Math.min(1, y / max) * 360;
        orbit.forEach(function (el) { el.setAttribute("transform", "rotate(" + angle.toFixed(1) + " 32 32)"); });
      }
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Sections ease into place the first time they come into view. Groups stagger by 60 ms.
  var REVEAL = [
    [".problem .eyebrow", ".problem .section-title"], [".problem-list li"],
    [".how > .wrap > .eyebrow", ".how .section-title"],
    [".who .eyebrow", ".who .section-title", ".who .section-lede"], [".tabs", ".day"],
    [".trust .eyebrow", ".trust .section-title"], [".promise"],
    [".integrations .eyebrow", ".integrations .section-title"], [".int-list li"], [".integrations .section-note"],
    [".builders-grid > div", ".code-card"], [".pricing-row > *"], [".faq-grid > div:first-child", ".faq-list details"],
    [".final"],
  ];
  if ("IntersectionObserver" in window && !reduceMotion.matches) {
    var revealIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        revealIo.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    REVEAL.forEach(function (group) {
      var els = [];
      group.forEach(function (sel) { els = els.concat(Array.prototype.slice.call(document.querySelectorAll(sel))); });
      els.forEach(function (el, i) {
        el.classList.add("reveal");
        el.style.setProperty("--reveal-delay", Math.min(i, 6) * 60 + "ms");
        revealIo.observe(el);
      });
    });
  }

  // Phone menu.
  var toggle = document.querySelector(".menu-toggle");
  var list = document.getElementById("nav-list");
  if (toggle && list) {
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      list.classList.toggle("is-open", open);
    });
    list.addEventListener("click", function (e) {
      if (e.target instanceof HTMLAnchorElement) {
        toggle.setAttribute("aria-expanded", "false");
        list.classList.remove("is-open");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && list.classList.contains("is-open")) {
        toggle.setAttribute("aria-expanded", "false");
        list.classList.remove("is-open");
        toggle.focus();
      }
    });
  }

  // How it works: the pinned picture follows the step in view. On narrow screens each step gets its own copy of its picture.
  var stage = document.querySelector(".stage");
  var steps = Array.prototype.slice.call(document.querySelectorAll(".step"));
  if (stage && steps.length) {
    steps.forEach(function (step) {
      var clone = stage.cloneNode(true);
      clone.classList.add("stage-clone");
      clone.setAttribute("data-step", step.getAttribute("data-step"));
      step.appendChild(clone);
    });
    function setStep(n) {
      stage.setAttribute("data-step", n);
      steps.forEach(function (s) { s.classList.toggle("is-active", s.getAttribute("data-step") === n); });
    }
    setStep("1");
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) setStep(entry.target.getAttribute("data-step"));
        });
      }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });
      steps.forEach(function (s) { io.observe(s); });
    } else {
      setStep("3");
    }
  }

  // Who it is for: example days. Labelled as examples on the page; they describe what an agent could do, not a connector list.
  var DAYS = {
    studio: {
      title: "A studio, on a Tuesday",
      line: "Bookings, supplies and client follow-ups, handled in the background. You see what needs you.",
      rows: [
        ["pending", "Reorder paper stock, $184", "Waiting for you · over your limit", "Operations"],
        ["approved", "Booked Thursday 3 pm with a new client", "Done · within your limits", "Customers"],
        ["held", "Draft follow-up to last week's clients", "Held for your review", "Customers"],
      ],
    },
    clinic: {
      title: "A clinic, at the start of the day",
      line: "Supplies and reminders kept moving. Anything that touches a patient or a commitment waits for a person.",
      rows: [
        ["pending", "Restock gloves and wipes, $96", "Waiting for you · over your limit", "Operations"],
        ["held", "Draft reminders for tomorrow's appointments", "Held for the front desk", "Customers"],
        ["approved", "Filed a supplier invoice as a draft", "Done · you confirmed it", "Operations"],
      ],
    },
    shop: {
      title: "A shop, mid-morning",
      line: "Stock, orders and customer questions in one place, inside limits you control.",
      rows: [
        ["pending", "Reorder 40 units of a low item, $320", "Waiting for you · over your limit", "Operations"],
        ["approved", "Answered a question about delivery times", "Done", "Customers"],
        ["refused", "Discount beyond your rule", "Declined by your limits", "Customers"],
      ],
    },
    food: {
      title: "A kitchen, before service",
      line: "Supplies, customer orders and menu ideas, with stock in view.",
      rows: [
        ["pending", "Reorder flour, $240", "Waiting for you · over your limit", "Operations"],
        ["held", "Order for 30 needs your decision", "Held for the owner", "Customers"],
        ["approved", "Menu idea drafted from this week's feedback", "Suggestion only", "Content"],
      ],
    },
    social: {
      title: "A social media manager, between clients",
      line: "Comments and feedback gathered, replies and ideas drafted, and nothing goes out without a yes.",
      rows: [
        ["held", "Draft replies to this week's comments", "Held for your review", "Content"],
        ["approved", "Summary of client feedback", "Ready to read", "Content"],
        ["pending", "Ideas for Friday's posts", "Waiting for you to pick one", "Content"],
      ],
    },
  };

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var day = document.getElementById("day");
  function mark(state) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "bind-mark mini");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("data-state", reduceMotion.matches ? state : "idle");
    svg.innerHTML = '<path class="ring" d="M32 12A20 20 0 1 1 32 52A20 20 0 1 1 32 12"/><circle class="clasp" cx="42" cy="14.68" r="6.4"/>';
    return svg;
  }
  function show(key, focus) {
    var d = DAYS[key];
    if (!d || !day) return;
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-day") === key;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      if (on) {
        day.setAttribute("aria-labelledby", t.id);
        if (focus) t.focus();
      }
    });
    day.querySelector(".day-title").textContent = d.title;
    day.querySelector(".day-line").textContent = d.line;
    var ul = day.querySelector(".day-rows");
    ul.textContent = "";
    var marks = [];
    d.rows.forEach(function (r) {
      var li = document.createElement("li");
      li.className = "row";
      var m = mark(r[0]);
      marks.push([m, r[0]]);
      var text = document.createElement("span");
      text.className = "row-text";
      var b = document.createElement("b");
      b.textContent = r[1];
      var small = document.createElement("small");
      small.textContent = r[2];
      text.appendChild(b);
      text.appendChild(small);
      var who = document.createElement("span");
      who.className = "row-who";
      who.textContent = r[3];
      li.appendChild(m);
      li.appendChild(text);
      li.appendChild(who);
      ul.appendChild(li);
    });
    day.classList.remove("is-changing");
    void day.offsetWidth;
    day.classList.add("is-changing");
    // The beads move out to their state after the rows are in.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { marks.forEach(function (p) { p[0].setAttribute("data-state", p[1]); }); });
    });
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { show(tab.getAttribute("data-day"), false); });
    tab.addEventListener("keydown", function (e) {
      var next = null;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      if (next === null) return;
      e.preventDefault();
      show(tabs[next].getAttribute("data-day"), true);
    });
  });
})();
