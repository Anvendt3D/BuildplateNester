import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const temporary = mkdtempSync(join(tmpdir(), "printnest-footprint-test-"));
const bundle = join(temporary, "footprint.mjs");
const source = fileURLToPath(new URL("../app/footprint.ts", import.meta.url));
buildSync({ entryPoints: [source], bundle: true, platform: "node", format: "esm", outfile: bundle });
const { displayFootprint, footprintArea, pointInFootprint, silhouetteFromMeshes } = await import(pathToFileURL(bundle).href);

test.after(() => rmSync(temporary, { recursive: true, force: true }));

test("uses the complete projected shell when imported triangles have mixed winding", () => {
  const mesh = {
    positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
    // The second triangle is deliberately wound in the opposite direction.
    // Its visible area must still be part of the draggable plate footprint.
    indices: [0, 1, 2, 0, 3, 2],
  };
  const footprint = silhouetteFromMeshes([mesh], [0, 0, 0, 1]);
  assert.equal(footprintArea(footprint), 100);
  assert.equal(pointInFootprint({ x: 2, y: 8 }, footprint), true);
});

test("cleans dense mesh edges into a readable top-down outline", () => {
  const segments = 96, positions = [0, 0, 0], indices = [];
  for (let index = 0; index < segments; index++) {
    const angle = index / segments * Math.PI * 2, radius = 40 + Math.sin(index * 7) * .08;
    positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
  }
  for (let index = 0; index < segments; index++) indices.push(0, index + 1, (index + 1) % segments + 1);
  const footprint = displayFootprint(silhouetteFromMeshes([{ positions, indices }], [0, 0, 0, 1]));
  assert.ok(footprint[0][0].length < segments / 2, "the display outline should not expose every tessellation edge");
});
