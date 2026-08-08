"use strict";

const assert = require("node:assert/strict");
const { projectAxis, quantizeAxis } = require("./radar.js");

assert.equal(projectAxis({ x: 100, y: 50 }, { x: 50, y: 50 }, 0, 100, 10), 5);
assert.equal(projectAxis({ x: 50, y: 0 }, { x: 50, y: 50 }, -Math.PI / 2, 100, 10), 5);
assert.equal(quantizeAxis(-2, 10), 0);
assert.equal(quantizeAxis(12, 10), 10);
assert.equal(quantizeAxis(4.26, 10), 4.5);

console.log("radar geometry tests passed");
