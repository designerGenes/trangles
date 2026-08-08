/* Shared, DOM-free radar geometry so pointer input stays easy to verify. */
(function (root) {
  function projectAxis(point, center, axisAngle, radius, minValue, maxValue) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return minValue + (((dx * Math.cos(axisAngle)) + (dy * Math.sin(axisAngle))) / radius * (maxValue - minValue));
  }

  function quantizeAxis(value, minValue, maxValue) {
    return Math.round(Math.min(maxValue, Math.max(minValue, value)) * 2) / 2;
  }

  const api = { projectAxis, quantizeAxis };
  if (typeof module !== "undefined") module.exports = api;
  root.Radar = api;
})(typeof window === "undefined" ? globalThis : window);
