// Runs before the page paints (ADR 0054, 0055): marks that scripts run, and asks for the intro on the first visit of a session.
(function () {
  var root = document.documentElement;
  root.classList.replace("no-js", "js");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var seen = false;
  try {
    seen = window.sessionStorage.getItem("bind-intro-seen") === "1";
  } catch (e) {
    seen = true; // No storage: skip the intro rather than replay it on every page.
  }
  if (!reduce && !seen) root.classList.add("is-intro");
})();
