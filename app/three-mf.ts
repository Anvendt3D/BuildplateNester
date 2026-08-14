import { strFromU8, strToU8, zipSync } from "fflate";
import { QuaternionTuple, rotateVector, vec3 } from "./geometry3d";
import type { ModelMesh } from "./orientation-viewer";
import type { Placement } from "./nest-engine";

type ExportPart = { id: string; name: string; meshes: ModelMesh[]; orientation: QuaternionTuple };
export type ExportPlate = { id: string; name: string };

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validatePackage(files: Record<string, Uint8Array>, expectedObjects: number, expectedPlates: number, nativeMultiPlate: boolean) {
  for (const path of ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]) if (!files[path]?.length) throw new Error(`3MF validation failed: ${path} is missing.`);
  const model = strFromU8(files["3D/3dmodel.model"]), objectIds = [...model.matchAll(/<object id="(\d+)"/g)].map((match) => Number(match[1])), buildIds = [...model.matchAll(/<item objectid="(\d+)"/g)].map((match) => Number(match[1]));
  if (objectIds.length !== expectedObjects || buildIds.length !== expectedObjects) throw new Error("3MF validation failed: not every placed model was written to the build graph.");
  if (new Set(objectIds).size !== objectIds.length || buildIds.some((id) => !objectIds.includes(id))) throw new Error("3MF validation failed: the build graph contains an invalid object reference.");
  if ((model.match(/<vertices>/g) ?? []).length !== expectedObjects || (model.match(/<triangles>/g) ?? []).length !== expectedObjects) throw new Error("3MF validation failed: an exported object has no mesh payload.");
  if (nativeMultiPlate) {
    for (const path of ["Metadata/model_settings.config", "Metadata/project_settings.config"]) if (!files[path]?.length) throw new Error(`Multi-plate 3MF validation failed: ${path} is missing.`);
    const settings = strFromU8(files["Metadata/model_settings.config"]), plateCount = (settings.match(/<plate>/g) ?? []).length;
    const assignedIds = [...settings.matchAll(/<model_instance><metadata key="object_id" value="(\d+)"/g)].map((match) => Number(match[1]));
    if (plateCount !== expectedPlates) throw new Error("Multi-plate 3MF validation failed: the plate table is incomplete.");
    if (assignedIds.length !== expectedObjects || new Set(assignedIds).size !== expectedObjects || assignedIds.some((id) => !objectIds.includes(id))) throw new Error("Multi-plate 3MF validation failed: every model must be assigned to exactly one plate.");
  }
}

function filesFor3mf(parts: ExportPart[], placements: Placement[], plates: ExportPlate[], nativeMultiPlate: boolean) {
  const partMap = new Map(parts.map((part) => [part.id, part]));
  if (placements.some((placement) => !partMap.get(placement.partId)?.meshes.length)) throw new Error("The example outlines do not contain exportable 3D meshes. Use imported STEP or STL parts for slicer handoff.");
  const objects: string[] = [], items: string[] = [], objectSettings: string[] = [];
  const plateInstances = new Map(plates.map((plate) => [plate.id, [] as { objectId: number; identifyId: number }[]]));
  let objectId = 1;

  for (const placement of placements) {
    const part = partMap.get(placement.partId);
    if (!part?.meshes.length) continue;
    const oriented = part.meshes.map((mesh) => mesh.positions.reduce<{ x: number; y: number; z: number }[]>((points, _, index) => {
      if (index % 3 === 0) points.push(rotateVector(vec3(mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2]), part.orientation));
      return points;
    }, []));
    const allPoints = oriented.flat();
    const minX = Math.min(...allPoints.map((point) => point.x)), minY = Math.min(...allPoints.map((point) => point.y)), minZ = Math.min(...allPoints.map((point) => point.z));
    const angle = placement.rotation * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    const rotatedPoints = allPoints.map((point) => { const x = point.x - minX, y = point.y - minY; return { x: x * cosine - y * sine, y: x * sine + y * cosine }; });
    const rotatedMinX = Math.min(...rotatedPoints.map((point) => point.x)), rotatedMinY = Math.min(...rotatedPoints.map((point) => point.y));
    const vertices: string[] = [], triangles: string[] = [];
    let vertexOffset = 0;
    part.meshes.forEach((mesh, meshIndex) => {
      const points = oriented[meshIndex];
      if (!mesh.positions.length || mesh.positions.length % 3 || mesh.positions.some((value) => !Number.isFinite(value))) throw new Error(`${part.name} contains an invalid vertex buffer.`);
      for (const point of points) {
        const localX = point.x - minX, localY = point.y - minY;
        vertices.push(`<vertex x="${(placement.x + localX * cosine - localY * sine - rotatedMinX).toFixed(5)}" y="${(placement.y + localX * sine + localY * cosine - rotatedMinY).toFixed(5)}" z="${(point.z - minZ).toFixed(5)}"/>`);
      }
      const indices = mesh.indices.length ? mesh.indices : Array.from({ length: points.length }, (_, index) => index);
      if (!indices.length || indices.length % 3 || indices.some((value) => !Number.isInteger(value) || value < 0 || value >= points.length)) throw new Error(`${part.name} contains an invalid triangle index buffer.`);
      for (let index = 0; index + 2 < indices.length; index += 3) triangles.push(`<triangle v1="${vertexOffset + indices[index]}" v2="${vertexOffset + indices[index + 1]}" v3="${vertexOffset + indices[index + 2]}"/>`);
      vertexOffset += points.length;
    });
    const displayName = `${part.name} #${placement.copy}`;
    objects.push(`<object id="${objectId}" name="${xml(displayName)}" type="model"><mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${objectId}"/>`);
    objectSettings.push(`<object id="${objectId}"><metadata key="name" value="${xml(displayName)}"/><metadata key="extruder" value="1"/><part id="${objectId}" subtype="normal_part"><metadata key="name" value="${xml(displayName)}"/><metadata key="matrix" value="1 0 0 0 1 0 0 0 1 0 0 0"/><metadata key="source_file" value="${xml(part.name)}"/></part></object>`);
    const plateId = placement.plateId ?? plates[0]?.id;
    if (plateId && plateInstances.has(plateId)) plateInstances.get(plateId)!.push({ objectId, identifyId: objectId });
    objectId++;
  }
  if (!objects.length) throw new Error("Import a STEP or STL model before creating a slicer project.");

  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"><metadata name="Title">PrintNest multi-plate layout</metadata><metadata name="Application">PrintNest</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><resources>${objects.join("")}</resources><build>${items.join("")}</build></model>`;
  const plateSettings = nativeMultiPlate ? plates.map((plate, index) => `<plate><metadata key="plater_id" value="${index + 1}"/><metadata key="plater_name" value="${xml(plate.name)}"/><metadata key="index" value="${index + 1}"/>${(plateInstances.get(plate.id) ?? []).map((instance) => `<model_instance><metadata key="object_id" value="${instance.objectId}"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="${instance.identifyId}"/></model_instance>`).join("")}</plate>`).join("") : "";
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?><config>${objectSettings.join("")}${plateSettings}</config>`;
  const projectSettings = JSON.stringify({ printer_settings_id: "", print_settings_id: "", filament_settings_id: [""] }, null, 2);
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/><Default Extension="json" ContentType="application/json"/></Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const files: Record<string, Uint8Array> = { "[Content_Types].xml": strToU8(contentTypes), "_rels/.rels": strToU8(relationships), "3D/3dmodel.model": strToU8(model) };
  if (nativeMultiPlate) { files["Metadata/model_settings.config"] = strToU8(modelSettings); files["Metadata/project_settings.config"] = strToU8(projectSettings); }
  validatePackage(files, objects.length, nativeMultiPlate ? plates.length : 0, nativeMultiPlate);
  return files;
}

export function create3mf(parts: ExportPart[], placements: Placement[], plates: ExportPlate[] = [{ id: "plate-1", name: "Plate 1" }], nativeMultiPlate = plates.length > 1) {
  return new Blob([zipSync(filesFor3mf(parts, placements, plates, nativeMultiPlate), { level: 6 })], { type: "model/3mf" });
}

export function createPrusaPlateArchive(parts: ExportPart[], placements: Placement[], plates: ExportPlate[]) {
  const files: Record<string, Uint8Array> = {};
  for (const [index, plate] of plates.entries()) {
    const platePlacements = placements.filter((placement) => (placement.plateId ?? plates[0]?.id) === plate.id);
    if (!platePlacements.length) continue;
    files[`plate-${String(index + 1).padStart(2, "0")}.3mf`] = zipSync(filesFor3mf(parts, platePlacements, [plate], false), { level: 6 });
  }
  if (!Object.keys(files).length) throw new Error("No placed models are available to export.");
  return new Blob([zipSync(files, { level: 6 })], { type: "application/zip" });
}
