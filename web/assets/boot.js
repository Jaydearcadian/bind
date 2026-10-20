// Runs before the page paints: marks that scripts run, so the entrance motion can start from its first frame (ADR 0054).
document.documentElement.classList.replace("no-js", "js");
