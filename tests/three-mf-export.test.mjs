import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { buildSync } from "esbuild";

const temporary = mkdtempSync(join(tmpdir(), "printnest-3mf-test-"));
const bundle = join(temporary, "three-mf.mjs");
const source = fileURLToPath(new URL("../app/three-mf.ts", import.meta.url));
buildSync({ entryPoints: [source], bundle: true, platform: "node", format: "esm", outfile: bundle });
const { create3mf, createPlateArchive } = await import(pathToFileURL(bundle).href);

test.after(() => rmSync(temporary, { recursive: true, force: true }));

const mesh = { positions: [0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, 20], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3] };
const parts = [{ id: "part", name: "fixture.stl", meshes: [mesh], orientation: [0, 0, 0, 1] }];
const plates = [{ id: "plate-1", name: "First plate" }, { id: "plate-2", name: "Second plate" }, { id: "plate-3", name: "Third plate" }];
const placements = plates.map((plate, index) => ({ id: `part-${index + 1}`, partId: "part", copy: index + 1, x: 10 + index * 5, y: 20 + index * 5, rotation: index * 45, footprint: [], colliding: false, nested: true, plateId: plate.id }));

test("exports a portable standards-only 3MF for a single plate", async () => {
  const blob = create3mf(parts, placements.slice(0, 1)), files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(blob.type, "model/3mf");
  assert.deepEqual(Object.keys(files).sort(), ["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
  const model = strFromU8(files["3D/3dmodel.model"]);
  assert.equal((model.match(/<object id=/g) ?? []).length, 1);
  assert.equal((model.match(/<item objectid=/g) ?? []).length, 1);
  assert.doesNotMatch(model, /BambuStudio|Metadata\//);
});

test("archives independent 3MF files for multiple plates", async () => {
  const archive = createPlateArchive(parts, placements, plates), files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ["plate-01.3mf", "plate-02.3mf", "plate-03.3mf"]);
  for (const content of Object.values(files)) assert.ok(unzipSync(content)["3D/3dmodel.model"]?.length);
});

test("rejects corrupt triangle buffers before downloading", () => {
  const corrupt = [{ ...parts[0], meshes: [{ positions: mesh.positions, indices: [0, 1, 99] }] }];
  assert.throws(() => create3mf(corrupt, placements.slice(0, 1)), /invalid triangle index buffer/);
});
