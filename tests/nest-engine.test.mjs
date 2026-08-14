import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import polygonClipping from "polygon-clipping";

const temporary = mkdtempSync(join(tmpdir(), "printnest-engine-test-"));
const bundle = join(temporary, "nest-engine.mjs");
const source = fileURLToPath(new URL("../app/nest-engine.ts", import.meta.url));
buildSync({ entryPoints: [source], bundle: true, platform: "node", format: "esm", outfile: bundle });
const { nestParts } = await import(pathToFileURL(bundle).href);
test.after(() => rmSync(temporary, { recursive: true, force: true }));

test("fills beyond one pair for crescent-shaped repeated parts", async () => {
  const circle = (cx, cy, radius, count = 24) => Array.from({ length: count }, (_, index) => [cx + Math.cos(index / count * Math.PI * 2) * radius, cy + Math.sin(index / count * Math.PI * 2) * radius]);
  const difference = polygonClipping.difference([[circle(30, 30, 30)]], [[circle(43, 30, 25)]]);
  const footprint = difference.map((polygon) => polygon.map((ring) => ring.slice(0, -1).map(([x, y]) => ({ x, y }))));
  const result = await nestParts({ parts: [{ id: "crescent", quantity: 8, footprint, priority: 1, minQuantity: 0 }], width: 325, depth: 320, clearance: 2, autoRotate: true, rotationStep: 15, nestingStart: "corner", outlinePrecision: "standard", objective: "compact", edgeMargin: 2, preset: "balanced", attempts: [0], attemptCount: 1, maxRuntimeMs: 18_000 });
  assert.equal(result.best.placed.length, 8);
  assert.equal(result.cancelled, false);
});

test("raster-guided search fills ten detailed concave outlines", async () => {
  const circle = (cx, cy, radius, count = 48) => Array.from({ length: count }, (_, index) => [cx + Math.cos(index / count * Math.PI * 2) * radius, cy + Math.sin(index / count * Math.PI * 2) * radius]);
  const difference = polygonClipping.difference([[circle(30, 30, 30)]], [[circle(43, 30, 25)]]);
  const footprint = difference.map((polygon) => polygon.map((ring) => ring.slice(0, -1).map(([x, y]) => ({ x, y }))));
  const result = await nestParts({ parts: [{ id: "detailed-crescent", quantity: 10, footprint, priority: 1, minQuantity: 0 }], width: 325, depth: 320, clearance: 2, autoRotate: true, rotationStep: 15, nestingStart: "corner", outlinePrecision: "standard", objective: "compact", edgeMargin: 2, preset: "balanced", attempts: [0], attemptCount: 1, maxRuntimeMs: 10_000 });
  assert.equal(result.best.placed.length, 10);
  assert.equal(result.best.unplaced.length, 0);
  assert.equal(result.cancelled, false);
});
