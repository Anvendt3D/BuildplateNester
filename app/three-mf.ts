import { strFromU8, strToU8, zipSync } from "fflate";
import { QuaternionTuple, rotateVector, vec3 } from "./geometry3d";
import type { ModelMesh } from "./orientation-viewer";
import type { Placement } from "./nest-engine";

type ExportPart = { id: string; name: string; meshes: ModelMesh[]; orientation: QuaternionTuple };
export type ExportPlate = { id: string; name: string; locked?: boolean };

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

function consistentlyOrientedIndices(mesh: ModelMesh, name: string) {
  const indices = validateMesh(mesh, name).slice();
  type EdgeUse = { triangle: number; direction: 1 | -1 };
  const edges = new Map<string, EdgeUse[]>(), adjacency = Array.from({ length: indices.length / 3 }, () => [] as { triangle: number; flip: boolean }[]);
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const offset = triangle * 3;
    for (const [left, right] of [[indices[offset], indices[offset + 1]], [indices[offset + 1], indices[offset + 2]], [indices[offset + 2], indices[offset]]]) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`, direction = (left < right ? 1 : -1) as 1 | -1;
      const uses = edges.get(key) ?? []; uses.push({ triangle, direction }); edges.set(key, uses);
    }
  }
  for (const uses of edges.values()) {
    if (uses.length !== 2) continue;
    const [first, second] = uses;
    // If both triangles traverse a shared edge in the same direction, exactly
    // one must be flipped. Otherwise their existing winding already agrees.
    const flip = first.direction === second.direction;
    adjacency[first.triangle].push({ triangle: second.triangle, flip });
    adjacency[second.triangle].push({ triangle: first.triangle, flip });
  }
  const flips = new Array<boolean | undefined>(indices.length / 3), components: number[][] = [];
  for (let start = 0; start < flips.length; start++) {
    if (flips[start] !== undefined) continue;
    const component: number[] = [], queue = [start]; flips[start] = false;
    while (queue.length) {
      const triangle = queue.pop()!; component.push(triangle);
      for (const neighbor of adjacency[triangle]) {
        const wanted = flips[triangle]! !== neighbor.flip;
        if (flips[neighbor.triangle] === undefined) { flips[neighbor.triangle] = wanted; queue.push(neighbor.triangle); }
        else if (flips[neighbor.triangle] !== wanted) throw new Error(`${name} has inconsistent winding that cannot be repaired safely.`);
      }
    }
    components.push(component);
  }
  const flipTriangle = (triangle: number) => { const offset = triangle * 3 + 1, value = indices[offset]; indices[offset] = indices[offset + 1]; indices[offset + 1] = value; };
  for (let triangle = 0; triangle < flips.length; triangle++) if (flips[triangle]) flipTriangle(triangle);
  for (const component of components) {
    let volume = 0;
    for (const triangle of component) {
      const offset = triangle * 3, a = indices[offset] * 3, b = indices[offset + 1] * 3, c = indices[offset + 2] * 3;
      volume += mesh.positions[a] * (mesh.positions[b + 1] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c + 1])
        - mesh.positions[a + 1] * (mesh.positions[b] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c])
        + mesh.positions[a + 2] * (mesh.positions[b] * mesh.positions[c + 1] - mesh.positions[b + 1] * mesh.positions[c]);
    }
    if (volume < 0) for (const triangle of component) flipTriangle(triangle);
  }
  return indices;
}

function numberXml(value: number) {
  if (!Number.isFinite(value)) throw new Error("3MF export contains a non-finite transformed vertex.");
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function filesFor3mf(parts: ExportPart[], placements: Placement[], bedDepth: number) {
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
      const indices = consistentlyOrientedIndices(mesh, part.name);
      for (const point of points) {
        const localX = point.x - minX, localY = point.y - minY;
        const x = placement.x + localX * cosine - localY * sine - rotatedMinX;
        const y = placement.y + localX * sine + localY * cosine - rotatedMinY;
        // The planner's SVG plate uses Y down; 3MF uses a conventional physical
        // Y-up build plane. Convert once here so an asymmetric part and its
        // position match the plate preview in the slicer.
        vertices.push(`<vertex x="${numberXml(x)}" y="${numberXml(bedDepth - y)}" z="${numberXml(point.z - minZ)}"/>`);
      }
      // Reflecting Y changes handedness, so reverse the winding to retain the
      // same outward-facing printable surface.
      for (let index = 0; index + 2 < indices.length; index += 3) triangles.push(`<triangle v1="${vertexOffset + indices[index]}" v2="${vertexOffset + indices[index + 2]}" v3="${vertexOffset + indices[index + 1]}"/>`);
      vertexOffset += points.length;
    });
    const displayName = `${part.name} #${placement.copy}`;
    objects.push(`<object id="${objectId}" name="${xml(displayName)}" type="model"><mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh></object>`);
    items.push(`<item objectid="${objectId}"/>`);
    objectId++;
  }
  if (!objects.length) throw new Error("Import a STEP or STL model before creating a slicer project.");

  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Title">PrintNest plate layout</metadata><metadata name="Application">PrintNest</metadata><resources>${objects.join("")}</resources><build>${items.join("")}</build></model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const files: Record<string, Uint8Array> = { "[Content_Types].xml": strToU8(contentTypes), "_rels/.rels": strToU8(relationships), "3D/3dmodel.model": strToU8(model) };
  validatePackage(files, objects.length);
  return files;
}

export function create3mf(parts: ExportPart[], placements: Placement[], bedDepth = 256) {
  return new Blob([zipSync(filesFor3mf(parts, placements, bedDepth), { level: 6 })], { type: "model/3mf" });
}

export function createMultiPlate3mf(parts: ExportPart[], placements: Placement[], plates: ExportPlate[], bedDepth = 256) {
  const includedPlates = plates.filter((plate) => placements.some((placement) => (placement.plateId ?? plates[0]?.id) === plate.id));
  const includedPlacements = placements.filter((placement) => includedPlates.some((plate) => plate.id === (placement.plateId ?? includedPlates[0]?.id)));
  if (!includedPlates.length || !includedPlacements.length) throw new Error("No placed models are available to export.");

  const files = filesFor3mf(parts, includedPlacements, bedDepth);
  const plateMembership = new Map<string, number>();
  includedPlacements.forEach((placement, index) => plateMembership.set(placement.id, index + 1));
  const plateXml = includedPlates.map((plate, index) => {
    const instances = includedPlacements
      .filter((placement) => (placement.plateId ?? includedPlates[0]?.id) === plate.id)
      .map((placement) => {
        const objectId = plateMembership.get(placement.id);
        return `<model_instance><metadata key="object_id" value="${objectId}"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="${objectId}"/></model_instance>`;
      }).join("");
    return `<plate><metadata key="plater_id" value="${index + 1}"/><metadata key="plater_name" value="${xml(plate.name)}"/><metadata key="locked" value="${Boolean(plate.locked)}"/>${instances}</plate>`;
  }).join("");
  const objectXml = includedPlacements.map((placement, index) => {
    const part = parts.find((candidate) => candidate.id === placement.partId);
    return `<object id="${index + 1}"><metadata key="name" value="${xml(`${part?.name ?? "Part"} #${placement.copy}`)}"/></object>`;
  }).join("");
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?><config>${objectXml}${plateXml}</config>`;
  const model = strFromU8(files["3D/3dmodel.model"]).replace(
    '<metadata name="Application">PrintNest</metadata>',
    '<metadata name="Application">BambuStudio-01.10.01.50</metadata><metadata name="BambuStudio:3mfVersion">1</metadata>',
  );
  files["3D/3dmodel.model"] = strToU8(model);
  files["Metadata/model_settings.config"] = strToU8(modelSettings);
  files["Metadata/project_settings.config"] = strToU8(JSON.stringify({ from: "PrintNest", version: "1", filament_settings_id: ["Generic PLA"], printer_settings_id: "" }));
  validatePackage(files, includedPlacements.length);
  if ((modelSettings.match(/<plate>/g) ?? []).length !== includedPlates.length || (modelSettings.match(/<model_instance>/g) ?? []).length !== includedPlacements.length) throw new Error("3MF validation failed: plate membership metadata is incomplete.");
  return new Blob([zipSync(files, { level: 6 })], { type: "model/3mf" });
}
