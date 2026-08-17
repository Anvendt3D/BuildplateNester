import { Footprint, footprintArea, footprintBounds, footprintsOverlap, pointInFootprint, simplifyFootprint, transformFootprint, translateFootprint } from "./footprint";

export type OutlinePrecision = "precise" | "standard" | "fast";
export type SearchPreset = "quick" | "balanced" | "best";
export type NestingStart = "corner" | "center";
export type OptimizationObjective = "quantity" | "compact" | "travel" | "balanced" | "grouped";
export type Placement = { id: string; partId: string; copy: number; x: number; y: number; rotation: number; footprint: Footprint; colliding: boolean; nested: boolean; locked?: boolean; plateId?: string };
export type NestPart = { id: string; quantity: number; copies?: number[]; footprint: Footprint; priority: number; minQuantity: number };
export type UnplacedItem = { partId: string; copy: number };
export type NestRequest = {
  parts: NestPart[]; width: number; depth: number; clearance: number; autoRotate: boolean;
  rotationStep: number; nestingStart: NestingStart; outlinePrecision: OutlinePrecision; objective: OptimizationObjective;
  edgeMargin?: number; fixed?: Placement[]; preset?: SearchPreset; attempts?: number[]; attemptCount?: number; maxRuntimeMs?: number;
};
export type NestResult = { placed: Placement[]; unplaced: UnplacedItem[]; cancelled: boolean; candidateChecks: number };
export type LayoutOption = NestResult & { id: string; label: string; score: number; utilization: number; envelopeUtilization: number; occupiedArea: number; travelDistance: number; groupedDistance: number; requiredPlaced: number };
export type NestBatchResult = { best: LayoutOption; layouts: LayoutOption[]; cancelled: boolean; candidateChecks: number };
export type NestProgress = { placed: Placement[]; processed: number; total: number; candidateChecks: number; attempt: number; attempts: number };
export type GridFillRequest = { part: NestPart; copies: number[]; width: number; depth: number; clearance: number; edgeMargin?: number; fixed?: Placement[] };

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Variant = { rotation: number; searchFootprint: Footprint; exactFootprint: Footprint; bounds: Bounds; key: string };
type InternalPlacement = { placement: Placement; searchWorld: Footprint; exactWorld: Footprint; bounds: Bounds; variantKey: string };
type Instance = { part: NestPart; copy: number; required: boolean };
type Control = { shouldCancel?: () => boolean; onProgress?: (progress: NestProgress) => void };

export const OUTLINE_TOLERANCES: Record<OutlinePrecision, number> = { precise: 0.05, standard: 0.2, fast: 0.5 };
const SEARCH_ATTEMPTS = 4;

function shiftedBounds(bounds: Bounds, x: number, y: number): Bounds {
  return { minX: bounds.minX + x, minY: bounds.minY + y, maxX: bounds.maxX + x, maxY: bounds.maxY + y };
}
function boundsMayOverlap(a: Bounds, b: Bounds, clearance: number) {
  return !(a.maxX + clearance <= b.minX || b.maxX + clearance <= a.minX || a.maxY + clearance <= b.minY || b.maxY + clearance <= a.minY);
}

// A regular grid is both exact and dramatically faster than a full heuristic
// search for repeated parts. It provides a guaranteed baseline fill before the
// more expensive search explores irregular gaps around existing placements.
export function fillRepeatedPartGrid(request: GridFillRequest): Placement[] {
  const { part, copies, width, depth, clearance } = request, edgeMargin = request.edgeMargin ?? 0;
  const footprint = part.footprint, partBounds = footprintBounds(footprint);
  const partWidth = partBounds.maxX - partBounds.minX, partDepth = partBounds.maxY - partBounds.minY;
  if (partWidth <= 0 || partDepth <= 0) return [];
  const stepX = partWidth + clearance, stepY = partDepth + clearance;
  const occupied = (request.fixed ?? []).map((placement) => ({ placement, world: translateFootprint(placement.footprint, placement.x, placement.y), bounds: footprintBounds(translateFootprint(placement.footprint, placement.x, placement.y)) }));
  const added: Placement[] = [];
  let copyIndex = 0;
  for (let y = edgeMargin - partBounds.minY; y + partBounds.maxY <= depth - edgeMargin + 1e-6 && copyIndex < copies.length; y += stepY) {
    for (let x = edgeMargin - partBounds.minX; x + partBounds.maxX <= width - edgeMargin + 1e-6 && copyIndex < copies.length; x += stepX) {
      const world = translateFootprint(footprint, x, y), candidateBounds = footprintBounds(world);
      const blocked = occupied.some((other) => boundsMayOverlap(candidateBounds, other.bounds, clearance) && footprintsOverlap(world, other.world, clearance));
      if (blocked) continue;
      const placement: Placement = { id: `${part.id}-${copies[copyIndex]}`, partId: part.id, copy: copies[copyIndex], x, y, rotation: 0, footprint, colliding: false, nested: true };
      added.push(placement); occupied.push({ placement, world, bounds: candidateBounds }); copyIndex++;
    }
  }
  return added;
}
function footprintSignature(footprint: Footprint, precision: number) {
  const snap = (value: number) => Math.round(value / precision);
  const ringKey = (ring: { x: number; y: number }[]) => {
    const tokens = ring.map((point) => `${snap(point.x)},${snap(point.y)}`); let start = 0;
    for (let index = 1; index < tokens.length; index++) if (tokens[index] < tokens[start]) start = index;
    const forward = tokens.map((_, index) => tokens[(start + index) % tokens.length]).join(";");
    const reverse = tokens.map((_, index) => tokens[(start - index + tokens.length) % tokens.length]).join(";");
    return forward < reverse ? forward : reverse;
  };
  return footprint.flatMap((polygon) => polygon.map(ringKey)).sort().join("|");
}

class SpatialHash {
  private cells = new Map<string, Set<number>>();
  constructor(private cellSize: number) {}
  private keys(bounds: Bounds) {
    const keys: string[] = [];
    for (let y = Math.floor(bounds.minY / this.cellSize); y <= Math.floor(bounds.maxY / this.cellSize); y++)
      for (let x = Math.floor(bounds.minX / this.cellSize); x <= Math.floor(bounds.maxX / this.cellSize); x++) keys.push(`${x},${y}`);
    return keys;
  }
  insert(bounds: Bounds, index: number) { for (const key of this.keys(bounds)) { if (!this.cells.has(key)) this.cells.set(key, new Set()); this.cells.get(key)!.add(index); } }
  query(bounds: Bounds) { const result = new Set<number>(); for (const key of this.keys(bounds)) for (const index of this.cells.get(key) ?? []) result.add(index); return result; }
}

// A quantized no-fit map: once a relative pose is proven clear or blocked, all
// later search attempts reuse that exact polygon result.
class NoFitMap {
  private values = new Map<string, boolean>();
  test(a: string, b: string, dx: number, dy: number, clearance: number, calculate: () => boolean) {
    const key = `${a}|${b}|${Math.round(dx * 1000)},${Math.round(dy * 1000)}|${Math.round(clearance * 1000)}`;
    const cached = this.values.get(key); if (cached !== undefined) return cached;
    const value = calculate(); this.values.set(key, value); return value;
  }
}

// Workers stay alive between runs, so these expensive geometry and relative-pose
// calculations survive quantity edits, plate changes and repeated nesting.
const persistentNoFit = new NoFitMap();
const persistentVariants = new Map<string, Variant[]>();

function contactPoints(footprint: Footprint, limit = 20) {
  const vertices = footprint.flatMap((polygon) => polygon.flatMap((ring) => ring));
  const midpoints = footprint.flatMap((polygon) => polygon.flatMap((ring) => ring.map((point, index) => {
    const next = ring[(index + 1) % ring.length];
    return { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 };
  })));
  const points = [...vertices, ...midpoints];
  if (points.length <= limit) return points;
  return Array.from({ length: limit }, (_, index) => points[Math.floor(index * points.length / limit)]);
}

function orderedPositions(width: number, depth: number, step: number, variant: Variant, start: NestingStart, placed: InternalPlacement[], clearance: number, edgeMargin: number) {
  const candidates = new Map<string, { x: number; y: number }>();
  const add = (x: number, y: number) => {
    if (x < edgeMargin - 1e-6 || y < edgeMargin - 1e-6 || x + variant.bounds.maxX > width - edgeMargin + 1e-6 || y + variant.bounds.maxY > depth - edgeMargin + 1e-6) return;
    const point = { x: Math.max(edgeMargin, x), y: Math.max(edgeMargin, y) }; candidates.set(`${point.x.toFixed(3)},${point.y.toFixed(3)}`, point);
  };
  add(edgeMargin, edgeMargin);
  for (let y = edgeMargin; y <= depth - edgeMargin - variant.bounds.maxY; y += step) for (let x = edgeMargin; x <= width - edgeMargin - variant.bounds.maxX; x += step) add(x, y);
  const candidatePoints = contactPoints(variant.searchFootprint);
  for (const existing of placed) {
    add(existing.bounds.maxX + clearance, existing.bounds.minY);
    add(existing.bounds.minX - variant.bounds.maxX - clearance, existing.bounds.minY);
    add(existing.bounds.minX, existing.bounds.maxY + clearance);
    add(existing.bounds.minX, existing.bounds.minY - variant.bounds.maxY - clearance);
    const existingPoints = contactPoints(existing.searchWorld);
    for (const a of existingPoints) for (const b of candidatePoints) {
      add(a.x - b.x + clearance, a.y - b.y);
      add(a.x - b.x - clearance, a.y - b.y);
      add(a.x - b.x, a.y - b.y + clearance);
      add(a.x - b.x, a.y - b.y - clearance);
    }
  }
  const score = (position: { x: number; y: number }) => {
    const candidate = shiftedBounds(variant.bounds, position.x, position.y), cluster = [...placed.map((entry) => entry.bounds), candidate];
    const minX = Math.min(...cluster.map((entry) => entry.minX)), minY = Math.min(...cluster.map((entry) => entry.minY));
    const maxX = Math.max(...cluster.map((entry) => entry.maxX)), maxY = Math.max(...cluster.map((entry) => entry.maxY));
    const compactness = (maxX - minX) * (maxY - minY);
    const startBias = start === "corner"
      ? position.y * (width + 1) + position.x
      : Math.hypot(position.x + variant.bounds.maxX / 2 - width / 2, position.y + variant.bounds.maxY / 2 - depth / 2);
    return compactness * 1_000 + startBias;
  };
  return [...candidates.values()].sort((a, b) => score(a) - score(b));
}

// Candidate locations for the second item in a repeated-shape motif. Unlike
// the full plate scan, this only explores contact relationships around the
// first item. It works for convex, crescent, holed and deeply concave outlines;
// a side-by-side motif remains a candidate when interlocking is not beneficial.
function motifPositions(width: number, depth: number, variant: Variant, first: InternalPlacement, clearance: number, edgeMargin: number) {
  const candidates = new Map<string, { x: number; y: number }>();
  const add = (x: number, y: number) => {
    if (x < edgeMargin - 1e-6 || y < edgeMargin - 1e-6 || x + variant.bounds.maxX > width - edgeMargin + 1e-6 || y + variant.bounds.maxY > depth - edgeMargin + 1e-6) return;
    candidates.set(`${x.toFixed(3)},${y.toFixed(3)}`, { x, y });
  };
  add(first.bounds.maxX + clearance, first.bounds.minY);
  add(first.bounds.minX - variant.bounds.maxX - clearance, first.bounds.minY);
  add(first.bounds.minX, first.bounds.maxY + clearance);
  add(first.bounds.minX, first.bounds.minY - variant.bounds.maxY - clearance);
  const firstPoints = contactPoints(first.searchWorld, 20), secondPoints = contactPoints(variant.searchFootprint, 20);
  for (const a of firstPoints) for (const b of secondPoints) {
    add(a.x - b.x + clearance, a.y - b.y); add(a.x - b.x - clearance, a.y - b.y);
    add(a.x - b.x, a.y - b.y + clearance); add(a.x - b.x, a.y - b.y - clearance);
  }
  const pairScore = (position: { x: number; y: number }) => {
    const second = shiftedBounds(variant.bounds, position.x, position.y);
    const minX = Math.min(first.bounds.minX, second.minX), minY = Math.min(first.bounds.minY, second.minY);
    const maxX = Math.max(first.bounds.maxX, second.maxX), maxY = Math.max(first.bounds.maxY, second.maxY);
    return (maxX - minX) * (maxY - minY) * 1_000 + (maxX - minX) + (maxY - minY);
  };
  return [...candidates.values()].sort((a, b) => pairScore(a) - pairScore(b));
}

function orderInstances(parts: NestPart[], attempt: number): Instance[] {
  const instances = parts.flatMap((part) => (part.copies ?? Array.from({ length: part.quantity }, (_, copy) => copy + 1)).map((copy, index) => ({ part, copy, required: index < Math.min(part.quantity, part.minQuantity) })));
  const wobble = (item: Instance) => { let hash = attempt * 7919 + item.copy * 97; for (const char of item.part.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return hash; };
  return instances.sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    if (a.part.priority !== b.part.priority) return b.part.priority - a.part.priority;
    const areaDelta = footprintArea(b.part.footprint) - footprintArea(a.part.footprint);
    if (attempt === 1) return -areaDelta || wobble(a) - wobble(b);
    if (attempt === 2) return wobble(a) - wobble(b);
    if (attempt === 3) return Math.abs(areaDelta) > 1 ? areaDelta : wobble(a) - wobble(b);
    return areaDelta;
  });
}

function layoutMetrics(result: NestResult, request: NestRequest) {
  const worldBounds = result.placed.map((placement) => footprintBounds(translateFootprint(placement.footprint, placement.x, placement.y)));
  const occupiedArea = worldBounds.length ? (Math.max(...worldBounds.map((b) => b.maxX)) - Math.min(...worldBounds.map((b) => b.minX))) * (Math.max(...worldBounds.map((b) => b.maxY)) - Math.min(...worldBounds.map((b) => b.minY))) : 0;
  const centers = worldBounds.map((b) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }));
  const travelDistance = centers.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - centers[index].x, point.y - centers[index].y), 0);
  let groupedDistance = 0, requiredPlaced = 0, priorityWeight = 0;
  for (const part of request.parts) {
    const matches = result.placed.map((placement, index) => ({ placement, center: centers[index] })).filter(({ placement }) => placement.partId === part.id);
    requiredPlaced += Math.min(matches.length, part.minQuantity); priorityWeight += matches.length * part.priority;
    if (matches.length) { const cx = matches.reduce((sum, item) => sum + item.center.x, 0) / matches.length, cy = matches.reduce((sum, item) => sum + item.center.y, 0) / matches.length; groupedDistance += matches.reduce((sum, item) => sum + Math.hypot(item.center.x - cx, item.center.y - cy), 0); }
  }
  const partArea = result.placed.reduce((sum, placement) => sum + footprintArea(placement.footprint), 0);
  const utilization = partArea / Math.max(1, request.width * request.depth) * 100;
  const envelopeUtilization = partArea / Math.max(1, occupiedArea) * 100;
  const common = requiredPlaced * 1e10 + priorityWeight * 1e7 + result.placed.length * 1e5;
  const scores: Record<OptimizationObjective, number> = {
    quantity: common - result.unplaced.length * 1e3 + envelopeUtilization * 20 - occupiedArea * 2,
    compact: common + envelopeUtilization * 1_000 - occupiedArea * 100 - travelDistance,
    travel: common + envelopeUtilization * 10 - travelDistance * 20 - occupiedArea * 2,
    balanced: common + envelopeUtilization * 300 - occupiedArea * 30 - travelDistance * 3 - groupedDistance,
    grouped: common + envelopeUtilization * 10 - groupedDistance * 20 - occupiedArea * 2,
  };
  return { score: scores[request.objective], utilization, envelopeUtilization, occupiedArea, travelDistance, groupedDistance, requiredPlaced };
}

async function nestAttempt(request: NestRequest, attempt: number, noFit: NoFitMap, control: Control, totalChecks: { value: number }): Promise<NestResult> {
  const { parts, width, depth, clearance, autoRotate, nestingStart, outlinePrecision } = request;
  const edgeMargin = request.edgeMargin ?? 0;
  const instances = orderInstances(parts, attempt), tolerance = OUTLINE_TOLERANCES[outlinePrecision];
  const selectedStep = Math.max(1, request.rotationStep ?? (request.preset === "quick" ? 90 : request.preset === "best" ? 5 : 15));
  // Honour the UI's rotation-effort setting. Presets decide how progressively
  // the search expands; the selected step decides the final angular detail.
  const rotationSchedule = !autoRotate ? [360]
    : request.preset === "quick" ? [selectedStep]
      : request.preset === "best" ? [...new Set([90, 45, 15, selectedStep])].sort((a, b) => b - a)
        : [...new Set([90, 45, selectedStep])].sort((a, b) => b - a);
  const deadline = request.maxRuntimeMs ? Date.now() + request.maxRuntimeMs : Infinity;
  const placed: InternalPlacement[] = [], unplaced: UnplacedItem[] = [], blockedPartIds = new Set<string>();
  const spatial = new SpatialHash(Math.max(24, clearance * 4)), fineStep = instances.length > 30 ? 4 : 2, coarseStep = Math.max(8, fineStep * 3);

  for (const fixed of request.fixed ?? []) {
    const exactWorld = translateFootprint(fixed.footprint, fixed.x, fixed.y), searchWorld = simplifyFootprint(exactWorld, tolerance), fixedBounds = footprintBounds(exactWorld);
    const entry: InternalPlacement = { placement: { ...fixed, colliding: false, nested: true, locked: true }, searchWorld, exactWorld, bounds: fixedBounds, variantKey: `fixed:${fixed.id}` };
    const index = placed.length; placed.push(entry); spatial.insert({ minX: fixedBounds.minX - clearance, minY: fixedBounds.minY - clearance, maxX: fixedBounds.maxX + clearance, maxY: fixedBounds.maxY + clearance }, index);
  }

  const variantsFor = (part: NestPart, step: number) => {
    const rawRotations = autoRotate ? Array.from({ length: Math.ceil(360 / step) }, (_, index) => index * step) : [0];
    const sourceKey = footprintSignature(part.footprint, 0.01);
    const cacheKey = `${sourceKey}|${tolerance}|${step}|${width}x${depth}|${edgeMargin}`;
    const cached = persistentVariants.get(cacheKey); if (cached) return cached;
    const simplified = simplifyFootprint(part.footprint, tolerance), variants: Variant[] = [], signatures = new Set<string>();
    for (const rotation of rawRotations) {
      const searchFootprint = transformFootprint(simplified, rotation), signature = footprintSignature(searchFootprint, Math.max(0.01, tolerance / 2));
      if (signatures.has(signature)) continue; signatures.add(signature);
      const exactFootprint = transformFootprint(part.footprint, rotation), bounds = footprintBounds(searchFootprint);
      if (bounds.maxX <= width - edgeMargin * 2 && bounds.maxY <= depth - edgeMargin * 2) variants.push({ rotation, searchFootprint, exactFootprint, bounds, key: `${part.id}:${rotation}:${signature}` });
    }
    persistentVariants.set(cacheKey, variants); return variants;
  };

  const tryVariantPositions = async (item: Instance, variant: Variant, positions: { x: number; y: number }[], maxResults: number, against: InternalPlacement[] = placed) => {
    const legal: InternalPlacement[] = [];
    for (const { x, y } of positions) {
      totalChecks.value++;
      if (totalChecks.value % 800 === 0) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); if (control.shouldCancel?.() || Date.now() >= deadline) return "cancelled" as const; }
      const candidateBounds = shiftedBounds(variant.bounds, x, y);
      const nearby = against === placed
        ? [...spatial.query({ minX: candidateBounds.minX - clearance, minY: candidateBounds.minY - clearance, maxX: candidateBounds.maxX + clearance, maxY: candidateBounds.maxY + clearance })].map((index) => placed[index])
        : against.filter((other) => boundsMayOverlap(candidateBounds, other.bounds, clearance));
      const searchWorld = translateFootprint(variant.searchFootprint, x, y); let overlaps = false;
      for (const other of nearby) {
        if (boundsMayOverlap(candidateBounds, other.bounds, clearance) && noFit.test(variant.key, other.variantKey, x - other.placement.x, y - other.placement.y, clearance, () => footprintsOverlap(searchWorld, other.searchWorld, clearance))) { overlaps = true; break; }
      }
      if (overlaps) continue;
      const exactWorld = translateFootprint(variant.exactFootprint, x, y), exactBounds = footprintBounds(exactWorld);
      for (const other of nearby) if (boundsMayOverlap(exactBounds, other.bounds, clearance) && footprintsOverlap(exactWorld, other.exactWorld, clearance)) { overlaps = true; break; }
      if (!overlaps) {
        legal.push({ placement: { id: `${item.part.id}-${item.copy}`, partId: item.part.id, copy: item.copy, x, y, rotation: variant.rotation, footprint: variant.exactFootprint, colliding: false, nested: true } as Placement, searchWorld, exactWorld, bounds: exactBounds, variantKey: variant.key });
        if (legal.length >= maxResults) break;
      }
    }
    return legal;
  };

  let clusterBounds: Bounds | null = placed.length ? placed.reduce<Bounds>((current, entry) => ({ minX: Math.min(current.minX, entry.bounds.minX), minY: Math.min(current.minY, entry.bounds.minY), maxX: Math.max(current.maxX, entry.bounds.maxX), maxY: Math.max(current.maxY, entry.bounds.maxY) }), { ...placed[0].bounds }) : null;
  // Rank a legal placement by the space the complete cluster would occupy.
  // This is deliberately based on the real polygon placement, not the part's
  // standalone bounding box: concave interlocks can therefore beat a valid but
  // wasteful side-by-side position.
  const clusterScore = (candidates: InternalPlacement[]) => {
    const candidateBounds = candidates.map((entry) => entry.bounds), seed = clusterBounds ?? candidateBounds[0];
    const minX = Math.min(seed.minX, ...candidateBounds.map((entry) => entry.minX)), minY = Math.min(seed.minY, ...candidateBounds.map((entry) => entry.minY));
    const maxX = Math.max(seed.maxX, ...candidateBounds.map((entry) => entry.maxX)), maxY = Math.max(seed.maxY, ...candidateBounds.map((entry) => entry.maxY));
    const occupiedArea = (maxX - minX) * (maxY - minY), occupiedPerimeter = (maxX - minX) + (maxY - minY);
    const centerDistance = Math.hypot((minX + maxX) / 2 - width / 2, (minY + maxY) / 2 - depth / 2);
    const startBias = nestingStart === "center" ? centerDistance : minY * (width + 1) + minX;
    return occupiedArea * 1_000 + occupiedPerimeter * 10 + startBias;
  };
  const placementScore = (candidate: InternalPlacement) => clusterScore([candidate]);
  const insertPlacement = (entry: InternalPlacement) => {
    const index = placed.length; placed.push(entry);
    clusterBounds = clusterBounds ? { minX: Math.min(clusterBounds.minX, entry.bounds.minX), minY: Math.min(clusterBounds.minY, entry.bounds.minY), maxX: Math.max(clusterBounds.maxX, entry.bounds.maxX), maxY: Math.max(clusterBounds.maxY, entry.bounds.maxY) } : { ...entry.bounds };
    spatial.insert({ minX: entry.bounds.minX - clearance, minY: entry.bounds.minY - clearance, maxX: entry.bounds.maxX + clearance, maxY: entry.bounds.maxY + clearance }, index);
  };

  // Detailed repeated outlines are a poor match for vertex-pair enumeration:
  // thousands of exact polygon checks can be spent proving almost-identical
  // poses. A 2 mm occupancy guide finds promising voids cheaply, while every
  // accepted pose is still verified against the original polygons and the
  // requested clearance. This is a guide only; it never relaxes geometry.
  const repeatedPartIds = new Set(instances.map((item) => item.part.id));
  const detailedRepeatedPart = instances.length >= 6 && repeatedPartIds.size === 1
    && instances[0].part.footprint.flat(2).length >= 60;
  if (autoRotate && detailedRepeatedPart) {
    const rasterResolution = 2;
    const gridWidth = Math.floor((width - edgeMargin * 2) / rasterResolution);
    const gridHeight = Math.floor((depth - edgeMargin * 2) / rasterResolution);
    const occupied = Array.from({ length: gridHeight }, () => 0n);
    const variants = variantsFor(instances[0].part, rotationSchedule.at(-1)!);
    const rasterVariants = variants.map((variant) => {
      const widthCells = Math.ceil(variant.bounds.maxX / rasterResolution), heightCells = Math.ceil(variant.bounds.maxY / rasterResolution);
      const rows = Array.from({ length: heightCells }, () => 0n);
      for (let y = 0; y < heightCells; y++) for (let x = 0; x < widthCells; x++) {
        if (pointInFootprint({ x: (x + 0.5) * rasterResolution, y: (y + 0.5) * rasterResolution }, variant.searchFootprint)) rows[y] |= 1n << BigInt(x);
      }
      return { variant, widthCells, heightCells, rows };
    });
    const markWorldFootprint = (footprint: Footprint) => {
      const bounds = footprintBounds(footprint);
      const minX = Math.max(0, Math.floor((bounds.minX - edgeMargin) / rasterResolution));
      const minY = Math.max(0, Math.floor((bounds.minY - edgeMargin) / rasterResolution));
      const maxX = Math.min(gridWidth - 1, Math.ceil((bounds.maxX - edgeMargin) / rasterResolution));
      const maxY = Math.min(gridHeight - 1, Math.ceil((bounds.maxY - edgeMargin) / rasterResolution));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const point = { x: edgeMargin + (x + 0.5) * rasterResolution, y: edgeMargin + (y + 0.5) * rasterResolution };
        if (pointInFootprint(point, footprint)) occupied[y] |= 1n << BigInt(x);
      }
    };
    for (const entry of placed) markWorldFootprint(entry.exactWorld);
    const rasterFits = (raster: typeof rasterVariants[number], x: number, y: number) => {
      if (x < 0 || y < 0 || x + raster.widthCells > gridWidth || y + raster.heightCells > gridHeight) return false;
      const shift = BigInt(x);
      return raster.rows.every((row, offset) => (occupied[y + offset] & (row << shift)) === 0n);
    };
    const markRaster = (raster: typeof rasterVariants[number], x: number, y: number) => {
      const shift = BigInt(x);
      raster.rows.forEach((row, offset) => { occupied[y + offset] |= row << shift; });
    };
    const makeEntry = (item: Instance, raster: typeof rasterVariants[number], x: number, y: number) => {
      const worldX = edgeMargin + x * rasterResolution, worldY = edgeMargin + y * rasterResolution;
      const exactWorld = translateFootprint(raster.variant.exactFootprint, worldX, worldY), exactBounds = footprintBounds(exactWorld);
      // The raster is only a fast guide. Final acceptance remains an exact
      // contour test, but only against parts whose expanded bounds can meet.
      for (const index of spatial.query({ minX: exactBounds.minX - clearance, minY: exactBounds.minY - clearance, maxX: exactBounds.maxX + clearance, maxY: exactBounds.maxY + clearance })) {
        const other = placed[index];
        if (boundsMayOverlap(exactBounds, other.bounds, clearance) && footprintsOverlap(exactWorld, other.exactWorld, clearance)) return null;
      }
      return { placement: { id: `${item.part.id}-${item.copy}`, partId: item.part.id, copy: item.copy, x: worldX, y: worldY, rotation: raster.variant.rotation, footprint: raster.variant.exactFootprint, colliding: false, nested: true } as Placement, searchWorld: translateFootprint(raster.variant.searchFootprint, worldX, worldY), exactWorld, bounds: exactBounds, variantKey: raster.variant.key } as InternalPlacement;
    };
    const addRasterPlacement = (entry: InternalPlacement, raster: typeof rasterVariants[number], x: number, y: number) => { markRaster(raster, x, y); insertPlacement(entry); };
    let itemIndex = 0;

    // Different attempts begin with different poses. The offset seed avoids the
    // common local optimum where a tall concave part forms only one pair.
    if (!placed.length && instances.length && rasterVariants.length) {
      const seedAngles = [105, 15, 195, 285];
      const desired = seedAngles[attempt % seedAngles.length];
      const seed = rasterVariants.reduce((best, candidate) => Math.abs(candidate.variant.rotation - desired) < Math.abs(best.variant.rotation - desired) ? candidate : best, rasterVariants[0]);
      const seedX = nestingStart === "center" ? Math.max(0, Math.floor((gridWidth - seed.widthCells) / 2)) : 0;
      const seedY = nestingStart === "center" ? Math.max(0, Math.floor((gridHeight - seed.heightCells) / 2)) : 0;
      const entry = rasterFits(seed, seedX, seedY) && makeEntry(instances[0], seed, seedX, seedY);
      if (entry) { addRasterPlacement(entry, seed, seedX, seedY); itemIndex = 1; }
    }

    for (; itemIndex < instances.length; itemIndex++) {
      if (control.shouldCancel?.() || Date.now() >= deadline) return { placed: placed.map((entry) => entry.placement), unplaced: instances.slice(itemIndex).map((item) => ({ partId: item.part.id, copy: item.copy })), cancelled: true, candidateChecks: totalChecks.value };
      const item = instances[itemIndex];
      const candidates: { raster: typeof rasterVariants[number]; x: number; y: number; score: number }[] = [];
      const addCandidate = (raster: typeof rasterVariants[number], x: number, y: number) => {
        if (!rasterFits(raster, x, y)) return;
        totalChecks.value++;
        const candidateBounds = shiftedBounds(raster.variant.bounds, edgeMargin + x * rasterResolution, edgeMargin + y * rasterResolution);
        const cluster = clusterBounds ?? candidateBounds;
        const minX = Math.min(cluster.minX, candidateBounds.minX), minY = Math.min(cluster.minY, candidateBounds.minY);
        const maxX = Math.max(cluster.maxX, candidateBounds.maxX), maxY = Math.max(cluster.maxY, candidateBounds.maxY);
        const startBias = nestingStart === "center" ? Math.hypot((minX + maxX) / 2 - width / 2, (minY + maxY) / 2 - depth / 2) : y * gridWidth + x;
        const score = (maxX - minX) * (maxY - minY) * 1_000 + startBias;
        if (candidates.length < 80 || score < candidates.at(-1)!.score) {
          candidates.push({ raster, x, y, score }); candidates.sort((a, b) => a.score - b.score); if (candidates.length > 80) candidates.pop();
        }
      };
      const frontierPositions = (raster: typeof rasterVariants[number]) => {
        const positions = new Set<string>();
        const add = (x: number, y: number) => {
          if (x < 0 || y < 0 || x + raster.widthCells > gridWidth || y + raster.heightCells > gridHeight) return;
          positions.add(`${x},${y}`);
        };
        add(0, 0); add(gridWidth - raster.widthCells, 0); add(0, gridHeight - raster.heightCells);
        // Test the four sides and aligned corners of each existing item. This
        // follows the growing packing frontier rather than rescanning the
        // whole plate for every added instance.
        for (const entry of placed) {
          const minX = Math.round((entry.bounds.minX - edgeMargin) / rasterResolution), minY = Math.round((entry.bounds.minY - edgeMargin) / rasterResolution);
          const maxX = Math.round((entry.bounds.maxX - edgeMargin) / rasterResolution), maxY = Math.round((entry.bounds.maxY - edgeMargin) / rasterResolution);
          for (const x of [minX, maxX - raster.widthCells, minX - raster.widthCells, maxX]) for (const y of [minY, maxY - raster.heightCells, minY - raster.heightCells, maxY]) add(x, y);
          add(maxX, minY); add(minX - raster.widthCells, minY); add(minX, maxY); add(minX, minY - raster.heightCells);
        }
        return positions;
      };
      if (request.preset === "quick") {
        // Quick is deliberately responsive: follow the exposed packing
        // frontier and accept that it may miss a deeper concave interlock.
        for (const raster of rasterVariants) for (const position of frontierPositions(raster)) {
          const [x, y] = position.split(",").map(Number); addCandidate(raster, x, y);
        }
      } else {
        // Balanced and Best Fit must examine every raster pose. Restricting
        // these modes to frontier contacts made crescents and hook-shaped
        // parts stop at an apparently tidy but low-utilization arrangement.
        for (const raster of rasterVariants) for (let y = 0; y <= gridHeight - raster.heightCells; y++) {
          for (let x = 0; x <= gridWidth - raster.widthCells; x++) {
            totalChecks.value++;
            if (rasterFits(raster, x, y)) addCandidate(raster, x, y);
          }
          if (totalChecks.value % 20_000 < gridWidth) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); if (control.shouldCancel?.() || Date.now() >= deadline) break; }
        }
      }
      let accepted = false;
      for (const candidate of candidates) {
        const entry = makeEntry(item, candidate.raster, candidate.x, candidate.y);
        if (!entry) continue;
        addRasterPlacement(entry, candidate.raster, candidate.x, candidate.y); accepted = true; break;
      }
      if (!accepted) return { placed: placed.map((entry) => entry.placement), unplaced: instances.slice(itemIndex).map((rest) => ({ partId: rest.part.id, copy: rest.copy })), cancelled: Date.now() >= deadline, candidateChecks: totalChecks.value };
      control.onProgress?.({ placed: placed.map((entry) => entry.placement), processed: itemIndex + 1, total: instances.length, candidateChecks: totalChecks.value, attempt: attempt + 1, attempts: request.attemptCount ?? SEARCH_ATTEMPTS });
    }
    return { placed: placed.map((entry) => entry.placement), unplaced: [], cancelled: false, candidateChecks: totalChecks.value };
  }

  for (let itemIndex = 0; itemIndex < instances.length; itemIndex++) {
    const item = instances[itemIndex];
    if (control.shouldCancel?.()) return { placed: placed.map((entry) => entry.placement), unplaced: [...unplaced, ...instances.slice(itemIndex).map((rest) => ({ partId: rest.part.id, copy: rest.copy }))], cancelled: true, candidateChecks: totalChecks.value };
    if (blockedPartIds.has(item.part.id)) { unplaced.push({ partId: item.part.id, copy: item.copy }); continue; }
    let found: InternalPlacement | null | "cancelled" = null, paired: InternalPlacement | null = null;
    // Adaptive rotation: cheap orthogonal poses first. Finer angles are only
    // generated for an instance that still does not fit.
    for (const step of rotationSchedule) {
      const variants = variantsFor(item.part, step);
      const legalCandidates: InternalPlacement[] = [];
      const candidatesPerVariant = request.preset === "quick" ? 2 : request.preset === "best" ? 8 : 4;
      for (const variant of variants) {
        const candidates = await tryVariantPositions(item, variant, orderedPositions(width, depth, coarseStep, variant, nestingStart, placed, clearance, edgeMargin), candidatesPerVariant);
        if (candidates === "cancelled") { found = "cancelled"; break; }
        legalCandidates.push(...candidates);
      }
      if (found === "cancelled") break;
      if (!legalCandidates.length && step === rotationSchedule.at(-1)) for (const variant of variants) {
        const candidates = await tryVariantPositions(item, variant, orderedPositions(width, depth, fineStep, variant, nestingStart, placed, clearance, edgeMargin), candidatesPerVariant);
        if (candidates === "cancelled") { found = "cancelled"; break; }
        legalCandidates.push(...candidates);
      }
      if (found === "cancelled") break;
      if (legalCandidates.length) {
        const ranked = legalCandidates.sort((a, b) => placementScore(a) - placementScore(b));
        const next = instances[itemIndex + 1];
        // Repeated parts are evaluated as a compact two-piece motif regardless
        // of whether a concavity classifier happens to recognise the outline.
        // The motif can interlock or remain side-by-side, whichever produces
        // the smaller legal envelope, and the same logic is repeated for every
        // following pair instead of stopping after the first two pieces.
        if (next?.part.id === item.part.id) {
          const lookaheadLimit = request.preset === "quick" ? 2 : request.preset === "best" ? 6 : 4;
          let bestPair: { first: InternalPlacement; second: InternalPlacement; score: number } | null = null;
          for (const first of ranked.slice(0, lookaheadLimit)) {
            const temporary = [...placed, first];
            for (const secondVariant of variants) {
              const seconds = await tryVariantPositions(next, secondVariant, motifPositions(width, depth, secondVariant, first, clearance, edgeMargin), 1, temporary);
              if (seconds === "cancelled") { found = "cancelled"; break; }
              for (const second of seconds) {
                const score = clusterScore([first, second]);
                if (!bestPair || score < bestPair.score) bestPair = { first, second, score };
              }
            }
            if (found === "cancelled") break;
          }
          if (found === "cancelled") break;
          if (bestPair) { found = bestPair.first; paired = bestPair.second; }
        }
        if (!found) found = ranked[0];
        break;
      }
    }
    if (found === "cancelled") return { placed: placed.map((entry) => entry.placement), unplaced: [...unplaced, ...instances.slice(itemIndex).map((rest) => ({ partId: rest.part.id, copy: rest.copy }))], cancelled: true, candidateChecks: totalChecks.value };
    if (found) { insertPlacement(found); if (paired) { insertPlacement(paired); itemIndex++; } }
    else { unplaced.push({ partId: item.part.id, copy: item.copy }); blockedPartIds.add(item.part.id); }
    control.onProgress?.({ placed: placed.map((entry) => entry.placement), processed: itemIndex + 1, total: instances.length, candidateChecks: totalChecks.value, attempt: attempt + 1, attempts: request.attemptCount ?? SEARCH_ATTEMPTS });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { placed: placed.map((entry) => entry.placement), unplaced, cancelled: false, candidateChecks: totalChecks.value };
}

export async function nestParts(request: NestRequest, control: Control = {}): Promise<NestBatchResult> {
  const noFit = persistentNoFit, totalChecks = { value: 0 }, layouts: LayoutOption[] = [];
  const attempts = request.attempts ?? Array.from({ length: request.attemptCount ?? SEARCH_ATTEMPTS }, (_, index) => index);
  let previousSignature = "", previousScore = -Infinity;
  for (const attempt of attempts) {
    const result = await nestAttempt(request, attempt, noFit, control, totalChecks), metrics = layoutMetrics(result, request);
    layouts.push({ ...result, ...metrics, id: `layout-${attempt + 1}`, label: `Layout ${attempt + 1}` });
    const signature = result.placed.map((p) => `${p.id}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.rotation}`).sort().join("|");
    const perfect = result.unplaced.length === 0;
    const stalled = signature === previousSignature || Math.abs(metrics.score - previousScore) < 0.001;
    if (result.cancelled || perfect || stalled) break;
    previousSignature = signature; previousScore = metrics.score;
  }
  layouts.sort((a, b) => b.score - a.score);
  const unique = layouts.filter((layout, index, all) => all.findIndex((candidate) => candidate.placed.map((p) => `${p.id}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.rotation}`).sort().join("|") === layout.placed.map((p) => `${p.id}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.rotation}`).sort().join("|")) === index).slice(0, 3);
  const best = unique[0] ?? layouts[0];
  return { best, layouts: unique, cancelled: layouts.some((layout) => layout.cancelled), candidateChecks: totalChecks.value };
}
