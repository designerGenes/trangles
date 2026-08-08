/* Shared, DOM-free radar geometry so pointer input stays easy to verify. */
(function (root) {
  function projectAxis(point, center, axisAngle, radius, maxValue) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return ((dx * Math.cos(axisAngle)) + (dy * Math.sin(axisAngle))) / radius * maxValue;
  }

  function quantizeAxis(value, maxValue) {
    return Math.round(Math.min(maxValue, Math.max(0, value)) * 2) / 2;
  }

  const api = { projectAxis, quantizeAxis };
  if (typeof module !== "undefined") module.exports = api;
  root.Radar = api;
})(typeof window === "undefined" ? globalThis : window);
