// Before first paint: marks that scripts run (ADR 0054) and applies the appearance chosen in Settings on this device (ADR 0067).
document.documentElement.classList.replace("no-js", "js");
try {
  var theme = window.localStorage.getItem("bind-theme");
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
} catch (e) {
  // No storage: follow the device.
}
