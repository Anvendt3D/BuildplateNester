import polygonClipping from "polygon-clipping";
import { QuaternionTuple, rotateVector, vec3 } from "./geometry3d";
import type { ModelMesh } from "./orientation-viewer";

export type Point = { x: number; y: number };
export type Ring = Point[];
export type Footprint = Ring[][];

type PcRing = number[][];
type PcPolygon = PcRing[];
type PcMultiPolygon = PcPolygon[];
type RawTriangle = [[number, number], [number, number], [number, number]];

const EPS = 1e-7;
// A build-plate layout needs a stable manufacturing outline, not the raw CAD
// tessellation. Preserve a fine projection grid for placement accuracy, then
// smooth the rendered contour at a print-planning scale.
const PLATE_OUTLINE_GRID_MM = 0.2;
const PLATE_OUTLINE_TOLERANCE_MM = 0.5;

function fromPc(value: PcMultiPolygon): Footprint {
  return value.map((polygon) => polygon.map((ring) => {
    const points = ring.map(([x, y]) => ({ x, y }));
    if (points.length > 1 && Math.abs(points[0].x - points.at(-1)!.x) < EPS && Math.abs(points[0].y - points.at(-1)!.y) < EPS) points.pop();
    return points;
  }).filter((ring) => ring.length >= 3)).filter((polygon) => polygon.length);
}

export function footprintFromRing(ring: Ring): Footprint { return [[ring]]; }

function convexHull(points: Point[]): Ring {
  const unique = Array.from(new Map(points.map((p) => [`${p.x},${p.y}`, p])).values()).sort((a, b) => a.x - b.x || a.y - b.y);
  if (unique.length < 3) return unique;
  const turn = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [], upper: Point[] = [];
  for (const point of unique) { while (lower.length >= 2 && turn(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop(); lower.push(point); }
  for (const point of [...unique].reverse()) { while (upper.length >= 2 && turn(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop(); upper.push(point); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function unionTriangles(raw: RawTriangle[], precision: number): Footprint {
  const snap = (value: number) => Math.round(value / precision) * precision;
  const seen = new Set<string>(), triangles: PcPolygon[] = [];
  for (const rawTriangle of raw) {
    const triangle = rawTriangle.map(([x, y]) => [snap(x), snap(y)]);
    const twiceArea = Math.abs((triangle[1][0] - triangle[0][0]) * (triangle[2][1] - triangle[0][1]) - (triangle[1][1] - triangle[0][1]) * (triangle[2][0] - triangle[0][0]));
    if (twiceArea <= precision * precision) continue;
    const key = triangle.map(([x, y]) => `${x},${y}`).sort().join("|");
    if (seen.has(key)) continue; seen.add(key);
    triangles.push([[...triangle, triangle[0]]]);
  }
  if (!triangles.length) return [];

  let merged: PcMultiPolygon = [];
  for (let i = 0; i < triangles.length; i += 80) {
    const batch = polygonClipping.union(...triangles.slice(i, i + 80)) as PcMultiPolygon;
    merged = merged.length ? polygonClipping.union(merged, batch) as PcMultiPolygon : batch;
  }
  return normalizeFootprint(fromPc(merged));
}

export function silhouetteFromMeshes(meshes: ModelMesh[], orientation: QuaternionTuple): Footprint {
  const upwardTriangles: RawTriangle[] = [], allTriangles: RawTriangle[] = [], projectedPoints: Point[] = [];
  for (const mesh of meshes) {
    const indices = mesh.indices.length ? mesh.indices : Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const points = [indices[i], indices[i + 1], indices[i + 2]].map((index) => {
        const point = rotateVector(vec3(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]), orientation);
        projectedPoints.push({ x: point.x, y: point.y }); return point;
      });
      const triangle = points.map((point) => [point.x, point.y]) as RawTriangle;
      const twiceArea = Math.abs((triangle[1][0] - triangle[0][0]) * (triangle[2][1] - triangle[0][1]) - (triangle[1][1] - triangle[0][1]) * (triangle[2][0] - triangle[0][0]));
      if (twiceArea > EPS) {
        allTriangles.push(triangle);
        const normalZ = (points[1].x - points[0].x) * (points[2].y - points[0].y) - (points[1].y - points[0].y) * (points[2].x - points[0].x);
        if (normalZ > EPS) upwardTriangles.push(triangle);
      }
    }
  }
  if (!allTriangles.length) return [];

  // The projection must cover every face of the solid. Some imported STEP and
  // STL meshes have mixed triangle winding, so using only upward-facing facets
  // can leave isolated triangles on the plate and make only those triangles
  // draggable. Try the complete projected shell first; the upward-facing skin
  // remains a cheaper fallback for pathological meshes.
  for (const source of [allTriangles, upwardTriangles]) {
    if (!source.length) continue;
    for (const precision of [PLATE_OUTLINE_GRID_MM, 0.5, 1]) {
      try {
        const result = unionTriangles(source, precision);
        if (result.length) return result;
      } catch {
        // Retry with a slightly coarser grid; this removes near-coincident sliver edges.
      }
    }
  }
  return normalizeFootprint(footprintFromRing(convexHull(projectedPoints)));
}

export function normalizeFootprint(footprint: Footprint): Footprint {
  if (!footprint.length) return footprint;
  const b = footprintBounds(footprint);
  return footprint.map((polygon) => polygon.map((ring) => ring.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }))));
}

function distanceToSegment(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function simplifyOpenRing(points: Ring, tolerance: number): Ring {
  if (points.length <= 2) return points;
  let furthestIndex = -1, furthestDistance = tolerance;
  for (let index = 1; index < points.length - 1; index++) {
    const distance = distanceToSegment(points[index], points[0], points.at(-1)!);
    if (distance > furthestDistance) { furthestDistance = distance; furthestIndex = index; }
  }
  if (furthestIndex < 0) return [points[0], points.at(-1)!];
  return [...simplifyOpenRing(points.slice(0, furthestIndex + 1), tolerance).slice(0, -1), ...simplifyOpenRing(points.slice(furthestIndex), tolerance)];
}

function smoothRing(ring: Ring, tolerance: number): Ring {
  if (tolerance <= 0 || ring.length <= 4) return ring.map((point) => ({ ...point }));
  // First remove duplicate micro-steps, then simplify both arcs between two
  // opposite points. Treating a ring as two open paths avoids the seam and
  // preserves concave contours and interior holes.
  const deNoised = ring.reduce<Ring>((kept, point) => !kept.length || Math.hypot(point.x - kept.at(-1)!.x, point.y - kept.at(-1)!.y) >= tolerance * .25 ? [...kept, point] : kept, []);
  if (deNoised.length < 4) return ring.map((point) => ({ ...point }));
  let split = 1, greatestDistance = -1;
  for (let index = 1; index < deNoised.length; index++) {
    const distance = Math.hypot(deNoised[index].x - deNoised[0].x, deNoised[index].y - deNoised[0].y);
    if (distance > greatestDistance) { greatestDistance = distance; split = index; }
  }
  const firstArc = simplifyOpenRing(deNoised.slice(0, split + 1), tolerance);
  const secondArc = simplifyOpenRing([...deNoised.slice(split), deNoised[0]], tolerance);
  const simplified = [...firstArc.slice(0, -1), ...secondArc.slice(0, -1)];
  return (simplified.length >= 3 ? simplified : ring).map((point) => ({ ...point }));
}

function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (tolerance <= 0 || ring.length <= 4) return ring.map((point) => ({ ...point }));
  const kept: Ring = [ring[0]];
  for (let index = 1; index < ring.length; index++) {
    const point = ring[index], previous = kept.at(-1)!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= tolerance) kept.push(point);
  }
  if (kept.length > 3 && Math.hypot(kept[0].x - kept.at(-1)!.x, kept[0].y - kept.at(-1)!.y) < tolerance) kept.pop();
  return (kept.length >= 3 ? kept : ring).map((point) => ({ ...point }));
}

export function simplifyFootprint(footprint: Footprint, tolerance: number): Footprint {
  return footprint.map((polygon) => polygon.map((ring) => simplifyRing(ring, tolerance)).filter((ring) => ring.length >= 3)).filter((polygon) => polygon.length);
}

function ringArea(ring: Ring) {
  return Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
}

export function displayFootprint(footprint: Footprint): Footprint {
  // Projected mesh unions can contain pinhole-sized islands and holes along
  // tessellation seams. They are neither printable features nor useful drag
  // targets, so the plate view deliberately omits them.
  const minimumFeatureArea = 1;
  return footprint.map((polygon) => {
    const outer = smoothRing(polygon[0], PLATE_OUTLINE_TOLERANCE_MM);
    if (ringArea(outer) < minimumFeatureArea) return [];
    return [outer, ...polygon.slice(1).filter((ring) => ringArea(ring) >= minimumFeatureArea).map((ring) => smoothRing(ring, PLATE_OUTLINE_TOLERANCE_MM))];
  }).filter((polygon) => polygon.length);
}

export function transformFootprint(footprint: Footprint, degrees: number, dx = 0, dy = 0): Footprint {
  const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const rotated = footprint.map((polygon) => polygon.map((ring) => ring.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }))));
  const b = footprintBounds(rotated);
  return rotated.map((polygon) => polygon.map((ring) => ring.map((p) => ({ x: p.x - b.minX + dx, y: p.y - b.minY + dy }))));
}

export function translateFootprint(footprint: Footprint, x: number, y: number): Footprint {
  return footprint.map((polygon) => polygon.map((ring) => ring.map((p) => ({ x: p.x + x, y: p.y + y }))));
}

export function footprintBounds(footprint: Footprint) {
  const points = footprint.flat(2);
  if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX: Math.min(...points.map((p) => p.x)), minY: Math.min(...points.map((p) => p.y)), maxX: Math.max(...points.map((p) => p.x)), maxY: Math.max(...points.map((p) => p.y)) };
}

function signedRingArea(ring: Ring) {
  return ring.reduce((sum, p, i) => sum + p.x * ring[(i + 1) % ring.length].y - ring[(i + 1) % ring.length].x * p.y, 0) / 2;
}

export function footprintArea(footprint: Footprint) {
  return footprint.reduce((sum, polygon) => sum + polygon.reduce((polygonArea, ring, ringIndex) => polygonArea + (ringIndex ? -1 : 1) * Math.abs(signedRingArea(ring)), 0), 0);
}

function pointInRing(point: Point, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInFootprint(point: Point, footprint: Footprint) {
  return footprint.some((polygon) => pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole)));
}

function orientation(a: Point, b: Point, c: Point) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function onSegment(a: Point, b: Point, p: Point) { return Math.abs(orientation(a, b, p)) < EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS; }
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d), o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function pointSegmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function edges(footprint: Footprint) {
  return footprint.flatMap((polygon) => polygon.flatMap((ring) => ring.map((point, i) => [point, ring[(i + 1) % ring.length]] as [Point, Point])));
}

export function footprintsOverlap(a: Footprint, b: Footprint, clearance: number) {
  const ab = footprintBounds(a), bb = footprintBounds(b);
  if (ab.maxX + clearance <= bb.minX || bb.maxX + clearance <= ab.minX || ab.maxY + clearance <= bb.minY || bb.maxY + clearance <= ab.minY) return false;
  const aEdges = edges(a), bEdges = edges(b);
  for (const [a1, a2] of aEdges) for (const [b1, b2] of bEdges) if (segmentDistance(a1, a2, b1, b2) < Math.max(EPS, clearance)) return true;
  // Boundary-free overlap: one solid region is fully inside another solid region.
  for (const polygon of a) if (pointInFootprint(polygon[0][0], b)) return true;
  for (const polygon of b) if (pointInFootprint(polygon[0][0], a)) return true;
  return false;
}

export function footprintPath(footprint: Footprint) {
  return footprint.flatMap((polygon) => polygon.map((ring) => ring.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(" ") + " Z")).join(" ");
}
