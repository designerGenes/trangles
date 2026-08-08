"use strict";

const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const Radar = require("../static/radar.js");

const output = resolve(process.argv[2] || "./radar-screenshots");
const width = 760;
const height = 580;
const center = { x: width / 2, y: 285 };
const radius = 180;
const max = 8;

mkdirSync(output, { recursive: true });

for (let count = 2; count <= 12; count++) {
  const axes = Array.from({ length: count }, (_, index) => `Aspect ${index + 1}`);
  const labels = [];
  const ticks = [];
  const point = (index, value) => {
    const angle = Radar.axisAngle(index, count);
    const scale = (value - 1) / (max - 1);
    return {
      x: center.x + Math.cos(angle) * radius * scale,
      y: center.y + Math.sin(angle) * radius * scale,
    };
  };
  const polygon = (values) => values.map((value, index) => {
    const p = point(index, value);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(" ");
  const ringMarkup = [0.2, 0.4, 0.6, 0.8, 1].map((fraction) =>
    `<polygon class="ring${fraction === 1 ? " outer" : ""}" points="${polygon(axes.map(() => 1 + (max - 1) * fraction))}"/>`).join("");
  const axisMarkup = axes.map((axis, index) => {
    const angle = Radar.axisAngle(index, count);
    const outer = point(index, max);
    const label = Radar.labelPosition(outer.x, outer.y, angle);
    const tickPoint = point(index, 1 + (max - 1) * 0.9);
    const tick = Radar.tickPosition(tickPoint.x, tickPoint.y, angle);
    labels.push({ ...label, text: axis });
    ticks.push({ ...tick, text: String(max) });
    return `<line class="axis" x1="${center.x}" y1="${center.y}" x2="${outer.x}" y2="${outer.y}"/>` +
      `<text class="tick" x="${tick.x}" y="${tick.y}" text-anchor="${tick.anchor}">${max}</text>` +
      `<text class="label" x="${label.x}" y="${label.y}" text-anchor="${label.anchor}">${axis}</text>`;
  }).join("");
  assertNoTextCollisions(count, labels, ticks);
  const values = axes.map(() => 3);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#fbfcfa"/>
    <text x="32" y="42" class="heading">${count} aspects</text>
    <style>
      .ring { fill:none;stroke:#e2e7e0;stroke-width:2 } .outer { stroke:#c9d1c8 }
      .axis { stroke:#a7b4aa;stroke-width:1.5 } .shape { fill:#1e2b2f1a;stroke:#1e2b2f;stroke-width:4;stroke-linejoin:round }
      .label { font:600 16px sans-serif;letter-spacing:1px;fill:#1e2b2f } .tick { font:600 14px monospace;fill:#5c6b6c }
      .heading { font:600 16px sans-serif;letter-spacing:2px;fill:#5c6b6c }
    </style>${ringMarkup}${axisMarkup}<polygon class="shape" points="${polygon(values)}"/>
  </svg>`;
  const svgPath = join(output, `radar-${String(count).padStart(2, "0")}-aspects.svg`);
  const pngPath = join(output, `radar-${String(count).padStart(2, "0")}-aspects.png`);
  writeFileSync(svgPath, svg);
  execFileSync("rsvg-convert", ["-o", pngPath, svgPath]);
}

function assertNoTextCollisions(count, labels, ticks) {
  const boxes = [...labels.map((label) => textBox(label, 16)), ...ticks.map((tick) => textBox(tick, 14))];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i], boxes[j])) {
        throw new Error(`${count} aspects: ${boxes[i].text} overlaps ${boxes[j].text}`);
      }
    }
  }
}

function textBox(position, fontSize) {
  const width = position.text.length * fontSize * 0.62;
  const left = position.anchor === "end" ? position.x - width : position.anchor === "middle" ? position.x - width / 2 : position.x;
  return { text: position.text, left, right: left + width, top: position.y - fontSize, bottom: position.y + 3 };
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
