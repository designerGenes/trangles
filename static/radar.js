/* Shared, DOM-free radar geometry so pointer input stays easy to verify. */
(function (root) {
  function projectAxis(point, center, axisAngle, radius, minValue, maxValue) {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return minValue + (((dx * Math.cos(axisAngle)) + (dy * Math.sin(axisAngle))) / radius * (maxValue - minValue));
  }

  function quantizeAxis(value, minValue, maxValue) {
    return Math.round(Math.min(maxValue, Math.max(minValue, value)));
  }

  function axisAngle(index, count) {
    if (count === 2) return index === 0 ? Math.PI : 0;
    return (-Math.PI / 2) + ((2 * Math.PI * index) / count);
  }

  function labelPosition(x, y, axisAngle) {
    const cos = Math.cos(axisAngle);
    const sin = Math.sin(axisAngle);
    if (cos < -0.15) return { x, y: y + (sin < 0 ? -8 : 20), anchor: "end" };
    if (cos > 0.15) return { x, y: y + (sin < 0 ? -8 : 20), anchor: "start" };
    return { x, y: y + (sin < 0 ? -28 : 36), anchor: "middle" };
  }

  function tickPosition(x, y, axisAngle) {
    return {
      x: x - Math.sin(axisAngle) * 9,
      y: y + Math.cos(axisAngle) * 9 + 3,
      anchor: -Math.sin(axisAngle) < -0.15 ? "end" : -Math.sin(axisAngle) > 0.15 ? "start" : "middle",
    };
  }

  const api = { projectAxis, quantizeAxis, axisAngle, labelPosition, tickPosition };
  if (typeof module !== "undefined") module.exports = api;
  root.Radar = api;
})(typeof window === "undefined" ? globalThis : window);
