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
const { create3mf, createMultiPlate3mf } = await import(pathToFileURL(bundle).href);

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
  assert.match(strFromU8(files["[Content_Types].xml"]), /<Override PartName="\/3D\/3dmodel\.model" ContentType="application\/vnd\.ms-package\.3dmanufacturing-3dmodel\+xml"\/>/);
});

test("stores multiple plates in one Bambu Studio / OrcaSlicer project 3MF", async () => {
  const project = createMultiPlate3mf(parts, placements, plates), files = unzipSync(new Uint8Array(await project.arrayBuffer()));
  assert.equal(project.type, "model/3mf");
  assert.deepEqual(Object.keys(files).sort(), ["3D/3dmodel.model", "Metadata/model_settings.config", "Metadata/project_settings.config", "[Content_Types].xml", "_rels/.rels"]);
  const model = strFromU8(files["3D/3dmodel.model"]), settings = strFromU8(files["Metadata/model_settings.config"]);
  assert.match(model, /<metadata name="Application">BambuStudio-01\.10\.01\.50<\/metadata>/);
  assert.match(model, /<metadata name="BambuStudio:3mfVersion">1<\/metadata>/);
  assert.equal((settings.match(/<plate>/g) ?? []).length, 3);
  assert.equal((settings.match(/<model_instance>/g) ?? []).length, 3);
  assert.match(settings, /<metadata key="plater_name" value="Second plate"\/>/);
  assert.deepEqual(JSON.parse(strFromU8(files["Metadata/project_settings.config"])).filament_settings_id, ["Generic PLA"]);
});

test("rejects corrupt triangle buffers before downloading", () => {
  const corrupt = [{ ...parts[0], meshes: [{ positions: mesh.positions, indices: [0, 1, 99] }] }];
  assert.throws(() => create3mf(corrupt, placements.slice(0, 1)), /invalid triangle index buffer/);
});
