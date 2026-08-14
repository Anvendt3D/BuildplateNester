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
  const triangles: RawTriangle[] = [], projectedPoints: Point[] = [];
  for (const mesh of meshes) {
    const indices = mesh.indices.length ? mesh.indices : Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const triangle = [indices[i], indices[i + 1], indices[i + 2]].map((index) => {
        const point = rotateVector(vec3(mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]), orientation);
        projectedPoints.push({ x: point.x, y: point.y }); return [point.x, point.y] as [number, number];
      }) as RawTriangle;
      const twiceArea = Math.abs((triangle[1][0] - triangle[0][0]) * (triangle[2][1] - triangle[0][1]) - (triangle[1][1] - triangle[0][1]) * (triangle[2][0] - triangle[0][0]));
      if (twiceArea > EPS) triangles.push(triangle);
    }
  }
  if (!triangles.length) return [];

  // CAD tessellations often contain almost-identical edges. Retry on progressively
  // coarser sub-millimetre grids before using a guaranteed non-throwing fallback.
  for (const precision of [0.0001, 0.001, 0.01, 0.05, 0.1]) {
    try {
      const result = unionTriangles(triangles, precision);
      if (result.length) return result;
    } catch {
      // Retry with a slightly coarser grid; this removes near-coincident sliver edges.
    }
  }
  return normalizeFootprint(footprintFromRing(convexHull(projectedPoints)));
}

export function normalizeFootprint(footprint: Footprint): Footprint {
  if (!footprint.length) return footprint;
  const b = footprintBounds(footprint);
  return footprint.map((polygon) => polygon.map((ring) => ring.map((p) => ({ x: p.x - b.minX, y: p.y - b.minY }))));
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
