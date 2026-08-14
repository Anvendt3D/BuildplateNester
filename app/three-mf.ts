import { strFromU8, strToU8, zipSync } from "fflate";
import { QuaternionTuple, rotateVector, vec3 } from "./geometry3d";
import type { ModelMesh } from "./orientation-viewer";
import type { Placement } from "./nest-engine";

type ExportPart = { id: string; name: string; meshes: ModelMesh[]; orientation: QuaternionTuple };
export type ExportPlate = { id: string; name: string };

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validatePackage(files: Record<string, Uint8Array>, expectedObjects: number) {
  for (const path of ["[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"]) if (!files[path]?.length) throw new Error(`3MF validation failed: ${path} is missing.`);
  const model = strFromU8(files["3D/3dmodel.model"]), objectIds = [...model.matchAll(/<object id="(\d+)"/g)].map((match) => Number(match[1])), buildIds = [...model.matchAll(/<item objectid="(\d+)"/g)].map((match) => Number(match[1]));
  if (objectIds.length !== expectedObjects || buildIds.length !== expectedObjects) throw new Error("3MF validation failed: not every placed model was written to the build graph.");
  if (new Set(objectIds).size !== objectIds.length || buildIds.some((id) => !objectIds.includes(id))) throw new Error("3MF validation failed: the build graph contains an invalid object reference.");
  if ((model.match(/<vertices>/g) ?? []).length !== expectedObjects || (model.match(/<triangles>/g) ?? []).length !== expectedObjects) throw new Error("3MF validation failed: an exported object has no mesh payload.");
}

function validateMesh(mesh: ModelMesh, name: string) {
  if (!mesh.positions.length || mesh.positions.length % 3 || mesh.positions.some((value) => !Number.isFinite(value))) throw new Error(`${name} contains an invalid vertex buffer.`);
  const pointCount = mesh.positions.length / 3, indices = mesh.indices.length ? mesh.indices : Array.from({ length: pointCount }, (_, index) => index);
  if (!indices.length || indices.length % 3 || indices.some((value) => !Number.isInteger(value) || value < 0 || value >= pointCount)) throw new Error(`${name} contains an invalid triangle index buffer.`);
  const edges = new Map<string, number>();
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = [indices[index], indices[index + 1], indices[index + 2]];
    if (new Set(triangle).size !== 3) throw new Error(`${name} contains a degenerate triangle.`);
    const [a, b, c] = triangle.map((vertex) => ({ x: mesh.positions[vertex * 3], y: mesh.positions[vertex * 3 + 1], z: mesh.positions[vertex * 3 + 2] }));
    const areaTwice = Math.hypot((b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y), (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z), (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (!(areaTwice > 1e-10)) throw new Error(`${name} contains a zero-area triangle.`);
    for (const [left, right] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const invalidEdges = [...edges.values()].filter((count) => count !== 2).length;
  if (invalidEdges) throw new Error(`${name} is not a closed, manifold printable solid (${invalidEdges.toLocaleString()} invalid edges). Repair it before exporting.`);
  return indices;
}

function filesFor3mf(parts: ExportPart[], placements: Placement[]) {
  const partMap = new Map(parts.map((part) => [part.id, part]));
  if (placements.some((placement) => !partMap.get(placement.partId)?.meshes.length)) throw new Error("The example outlines do not contain exportable 3D meshes. Use imported STEP or STL parts for slicer handoff.");
  const objects: string[] = [], items: string[] = [];
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
      const indices = validateMesh(mesh, part.name);
      for (const point of points) {
        const localX = point.x - minX, localY = point.y - minY;
        vertices.push(`<vertex x="${(placement.x + localX * cosine - localY * sine - rotatedMinX).toFixed(5)}" y="${(placement.y + localX * sine + localY * cosine - rotatedMinY).toFixed(5)}" z="${(point.z - minZ).toFixed(5)}"/>`);
      }
      for (let index = 0; index + 2 < indices.length; index += 3) triangles.push(`<triangle v1="${vertexOffset + indices[index]}" v2="${vertexOffset + indices[index + 1]}" v3="${vertexOffset + indices[index + 2]}"/>`);
      vertexOffset += points.length;
    });
    const displayName = `${part.name} #${placement.copy}`;
    objects.push(`<object id="${objectId}" name="${xml(displayName)}" type="model"><mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${objectId}"/>`);
    objectId++;
  }
  if (!objects.length) throw new Error("Import a STEP or STL model before creating a slicer project.");

  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">PrintNest plate layout</metadata><metadata name="Application">PrintNest</metadata><resources>${objects.join("")}</resources><build>${items.join("")}</build></model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/><Default Extension="json" ContentType="application/json"/></Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const files: Record<string, Uint8Array> = { "[Content_Types].xml": strToU8(contentTypes), "_rels/.rels": strToU8(relationships), "3D/3dmodel.model": strToU8(model) };
  validatePackage(files, objects.length);
  return files;
}

export function create3mf(parts: ExportPart[], placements: Placement[]) {
  return new Blob([zipSync(filesFor3mf(parts, placements), { level: 6 })], { type: "model/3mf" });
}

export function createPlateArchive(parts: ExportPart[], placements: Placement[], plates: ExportPlate[]) {
  const files: Record<string, Uint8Array> = {};
  for (const [index, plate] of plates.entries()) {
    const platePlacements = placements.filter((placement) => (placement.plateId ?? plates[0]?.id) === plate.id);
    if (!platePlacements.length) continue;
    files[`plate-${String(index + 1).padStart(2, "0")}.3mf`] = zipSync(filesFor3mf(parts, platePlacements), { level: 6 });
  }
  if (!Object.keys(files).length) throw new Error("No placed models are available to export.");
  return new Blob([zipSync(files, { level: 6 })], { type: "application/zip" });
}
