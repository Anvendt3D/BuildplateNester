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
const { create3mf } = await import(pathToFileURL(bundle).href);

test.after(() => rmSync(temporary, { recursive: true, force: true }));

const mesh = { positions: [0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, 5, 20, 0, 5, 0, 20, 5], indices: [0, 1, 2, 3, 4, 5] };
const parts = [{ id: "part", name: "fixture.stl", meshes: [mesh], orientation: [0, 0, 0, 1] }];
const plates = [{ id: "plate-1", name: "First plate" }, { id: "plate-2", name: "Second plate" }, { id: "plate-3", name: "Third plate" }];
const placements = plates.map((plate, index) => ({ id: `part-${index + 1}`, partId: "part", copy: index + 1, x: 10 + index * 5, y: 20 + index * 5, rotation: index * 45, footprint: [], colliding: false, nested: true, plateId: plate.id }));

test("exports a structurally complete native multi-plate 3MF", async () => {
  const blob = create3mf(parts, placements, plates, true), files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(blob.type, "model/3mf");
  assert.deepEqual(Object.keys(files).sort(), ["3D/3dmodel.model", "Metadata/model_settings.config", "Metadata/project_settings.config", "[Content_Types].xml", "_rels/.rels"]);
  const model = strFromU8(files["3D/3dmodel.model"]), settings = strFromU8(files["Metadata/model_settings.config"]);
  assert.equal((model.match(/<object id=/g) ?? []).length, 3);
  assert.equal((model.match(/<item objectid=/g) ?? []).length, 3);
  assert.equal((settings.match(/<plate>/g) ?? []).length, 3);
  assert.equal((settings.match(/<model_instance>/g) ?? []).length, 3);
  for (const [index, plate] of plates.entries()) {
    assert.match(settings, new RegExp(`plater_name" value="${plate.name}"`));
    assert.match(settings, new RegExp(`object_id" value="${index + 1}"`));
  }
});

test("rejects corrupt triangle buffers before downloading", () => {
  const corrupt = [{ ...parts[0], meshes: [{ positions: mesh.positions, indices: [0, 1, 99] }] }];
  assert.throws(() => create3mf(corrupt, placements.slice(0, 1), plates.slice(0, 1), false), /invalid triangle index buffer/);
});
