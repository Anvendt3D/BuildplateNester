import { QuaternionTuple, Vec3, cross3, dot3, length3, normalize3, quaternionFromUnitVectors, scale3, sub3, vec3 } from "./geometry3d";
import type { ModelMesh } from "./orientation-viewer";

export type AutoOrientResult = {
  orientation: QuaternionTuple;
  candidates: number;
  sampledTriangles: number;
  contactArea: number;
  overhangCost: number;
};

type Face = { a: Vec3; b: Vec3; c: Vec3; normal: Vec3; area: number };
type DirectionGroup = { normal: Vec3; area: number; largestFace: number };

const SUPPLEMENTAL_DIRECTIONS: Vec3[] = [
  vec3(0, 0, -1), vec3(0, 0, 1), vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0),
  vec3(1, 0, 1), vec3(-1, 0, 1), vec3(0, 1, 1), vec3(0, -1, 1),
  vec3(1, 0, -1), vec3(-1, 0, -1), vec3(0, 1, -1), vec3(0, -1, -1),
  vec3(1, 1, 0), vec3(-1, 1, 0), vec3(-1, -1, 0), vec3(1, -1, 0),
].map(normalize3);

function quantizedNormalKey(normal: Vec3) {
  // OrcaSlicer groups normals on a 0.001 grid before retaining the dominant
  // directions. Rounding is symmetric around zero and avoids a linear search.
  return `${Math.round(normal.x * 1000)},${Math.round(normal.y * 1000)},${Math.round(normal.z * 1000)}`;
}

function sampledFaces(meshes: ModelMesh[], maxFaces = 80_000) {
  const triangleCounts = meshes.map((mesh) => (mesh.indices.length || mesh.positions.length / 3) / 3);
  const totalTriangles = triangleCounts.reduce((sum, count) => sum + count, 0);
  const sampleRatio = Math.min(1, maxFaces / Math.max(1, totalTriangles)), sampleThreshold = sampleRatio * 0x1_0000_0000;
  const faces: Face[] = [], groups = new Map<string, DirectionGroup>();
  let globalTriangle = 0;
  for (const mesh of meshes) {
    const indices = mesh.indices.length ? mesh.indices : null;
    const count = indices ? indices.length / 3 : mesh.positions.length / 9;
    for (let triangle = 0; triangle < count; triangle++, globalTriangle++) {
      if (sampleRatio < 1 && (Math.imul(globalTriangle + 1, 0x9e3779b1) >>> 0) >= sampleThreshold) continue;
      const index = (corner: number) => indices ? indices[triangle * 3 + corner] : triangle * 3 + corner;
      const point = (corner: number) => { const i = index(corner) * 3; return vec3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]); };
      const a = point(0), b = point(1), c = point(2), cross = cross3(sub3(b, a), sub3(c, a)), area = length3(cross) / 2;
      if (area < 1e-6) continue;
      const normal = normalize3(cross), weightedArea = area / sampleRatio, key = quantizedNormalKey(normal), group = groups.get(key);
      faces.push({ a, b, c, normal, area: weightedArea });
      if (group) { group.area += weightedArea; if (weightedArea > group.largestFace) { group.normal = normal; group.largestFace = weightedArea; } }
      else groups.set(key, { normal, area: weightedArea, largestFace: weightedArea });
    }
  }
  return { faces, groups, totalTriangles };
}

function uniqueDirections(groups: Map<string, DirectionGroup>) {
  const dominant = [...groups.values()].sort((a, b) => b.area - a.area).slice(0, 12).map((group) => group.normal);
  const directions: Vec3[] = [];
  for (const normal of [...dominant, ...SUPPLEMENTAL_DIRECTIONS]) {
    if (!directions.some((candidate) => dot3(candidate, normal) > 0.99999)) directions.push(normal);
  }
  return directions;
}

function scoreDirection(faces: Face[], bedFaceNormal: Vec3) {
  // Mapping the chosen face normal to -Z means transformed Z is the dot
  // product against the opposite normal. This avoids rotating every vertex.
  const upAxis = scale3(bedFaceNormal, -1);
  const reference = Math.abs(upAxis.z) < 0.9 ? vec3(0, 0, 1) : vec3(0, 1, 0);
  const axisX = normalize3(cross3(reference, upAxis)), axisY = normalize3(cross3(upAxis, axisX));
  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const face of faces) for (const point of [face.a, face.b, face.c]) {
    const x = dot3(point, axisX), y = dot3(point, axisY), z = dot3(point, upAxis);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const firstLayer = 0.22;
  let contactArea = 0, overhangCost = 0, lowAngleArea = 0;
  for (const face of faces) {
    const za = dot3(face.a, upAxis), zb = dot3(face.b, upAxis), zc = dot3(face.c, upAxis);
    const faceMaxZ = Math.max(za, zb, zc), faceMeanZ = (za + zb + zc) / 3, normalZ = dot3(face.normal, upAxis);
    const onBed = faceMaxZ < minZ + firstLayer;
    if (onBed) contactArea += face.area * Math.max(0.2, Math.abs(normalZ));
    else if (normalZ < -0.5) overhangCost += face.area * (faceMeanZ - minZ) * (-0.5 - normalZ);
    const absNormalZ = Math.abs(normalZ);
    if (!onBed && absNormalZ > 0.9703 && absNormalZ < 0.999) lowAngleArea += face.area;
  }
  const height = maxZ - minZ, projectedArea = Math.max(1, (maxX - minX) * (maxY - minY));
  const stabilityPenalty = height / Math.max(1, Math.sqrt(contactArea));
  const tinyBasePenalty = contactArea < 0.1 ? 100 : 0;
  // Browser adaptation of OrcaSlicer's feature cost: support volume is the
  // leading term, while first-layer contact and compact height reward stable
  // orientations. No polygon union is needed during candidate evaluation.
  const cost = overhangCost / Math.max(25, contactArea * 1.2) + lowAngleArea * 0.01 + stabilityPenalty * 0.16 + projectedArea * 0.000002 + tinyBasePenalty;
  return { cost, contactArea, overhangCost };
}

export function findAutoOrientation(meshes: ModelMesh[]): AutoOrientResult {
  const { faces, groups, totalTriangles } = sampledFaces(meshes);
  if (!faces.length) return { orientation: [0, 0, 0, 1], candidates: 0, sampledTriangles: 0, contactArea: 0, overhangCost: 0 };
  const directions = uniqueDirections(groups);
  let bestNormal = directions[0], best = scoreDirection(faces, bestNormal);
  for (const direction of directions.slice(1)) {
    const score = scoreDirection(faces, direction);
    if (score.cost < best.cost) { best = score; bestNormal = direction; }
  }
  return {
    orientation: quaternionFromUnitVectors(bestNormal, vec3(0, 0, -1)),
    candidates: directions.length,
    sampledTriangles: faces.length,
    contactArea: best.contactArea,
    overhangCost: best.overhangCost,
  };
}
