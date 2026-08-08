"use strict";

const assert = require("node:assert/strict");
const { projectAxis, quantizeAxis, axisAngle, tickPosition } = require("./radar.js");

assert.equal(projectAxis({ x: 100, y: 50 }, { x: 50, y: 50 }, 0, 100, 0, 10), 5);
assert.equal(projectAxis({ x: 50, y: 0 }, { x: 50, y: 50 }, -Math.PI / 2, 100, 2, 12), 7);
assert.equal(quantizeAxis(-2, 0, 10), 0);
assert.equal(quantizeAxis(12, 0, 10), 10);
assert.equal(quantizeAxis(4.26, 0, 10), 4);
assert.equal(quantizeAxis(4.7, 0, 10), 5);

/* Tick numbers must be placed identically on every axis. A chart that is
   geometrically symmetric has to carry symmetric labels: mirrored axes get
   mirrored label positions, and every label stays on its own axis. */
const CX = 180, CY = 180, R = 132;
const tickFor = (index, count) => {
  const angle = axisAngle(index, count);
  return tickPosition(CX + (Math.cos(angle) * R), CY + (Math.sin(angle) * R), angle);
};
const close = (a, b) => Math.abs(a - b) < 1e-9;
// A horizontal axis has no radial y component, so whatever y offset survives
// there is the font's baseline nudge — read it rather than hardcoding it.
const baseline = tickPosition(CX + R, CY, 0).y - CY;

for (const count of [3, 4, 5, 6, 7, 8]) {
  for (let i = 0; i < count; i++) {
    const angle = axisAngle(i, count);
    const tick = tickFor(i, count);

    // On its own axis: the label offset is purely radial, so the label, the
    // ring point and the centre stay collinear.
    const cross = ((tick.x - CX) * Math.sin(angle)) - ((tick.y - baseline - CY) * Math.cos(angle));
    assert.ok(close(cross, 0), `count=${count} axis=${i} tick drifted off its axis`);

    // Inside the outer ring, never past it.
    const radius = Math.hypot(tick.x - CX, tick.y - baseline - CY);
    assert.ok(radius < R && radius > R - 26, `count=${count} axis=${i} tick left the outer band`);
  }

  // Mirror symmetry about the vertical: axis i and the axis reflected onto it
  // must sit at mirrored x and identical y.
  for (let i = 1; i < count; i++) {
    const a = tickFor(i, count);
    const b = tickFor(count - i, count);
    assert.ok(close(a.x - CX, -(b.x - CX)), `count=${count} axes ${i}/${count - i} tick x not mirrored`);
    assert.ok(close(a.y, b.y), `count=${count} axes ${i}/${count - i} tick y not mirrored`);
  }
}

console.log("radar geometry tests passed");
