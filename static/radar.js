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

  // Tick numbers sit ON their own axis, inset radially from the ring they
  // name. The offset used to be perpendicular to the axis, which broke
  // mirror symmetry: reflected axes (e.g. left and right on a 4-aspect
  // chart) got their numbers on opposite sides of the axis line and at
  // different heights, so a symmetric chart carried askew labels. A radial
  // inset mirrors correctly by construction, keeps every number on the axis
  // it describes, and never lands inside the polygon.
  const TICK_INSET = 12;
  const TICK_BASELINE = 3.5; // half the 9px tick font's cap height

  function tickPosition(x, y, axisAngle) {
    return {
      x: x - (Math.cos(axisAngle) * TICK_INSET),
      y: y - (Math.sin(axisAngle) * TICK_INSET) + TICK_BASELINE,
      anchor: "middle",
    };
  }

  const api = { projectAxis, quantizeAxis, axisAngle, labelPosition, tickPosition };
  if (typeof module !== "undefined") module.exports = api;
  root.Radar = api;
})(typeof window === "undefined" ? globalThis : window);
