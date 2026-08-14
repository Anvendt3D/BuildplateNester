"use client";

import { ChangeEvent, DragEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import OrientationViewer, { ModelMesh } from "./orientation-viewer";
import { QuaternionTuple, eulerFromQuaternion, multiplyQuaternion, normalize3, quaternionFromEuler, quaternionFromUnitVectors, rotateVector, vec3 } from "./geometry3d";
import { Footprint, footprintArea, footprintBounds, footprintFromRing, footprintPath, footprintsOverlap, silhouetteFromMeshes, transformFootprint, translateFootprint } from "./footprint";
import { LayoutOption, NestBatchResult, NestProgress, NestRequest, NestingStart, OptimizationObjective, OutlinePrecision, Placement, SearchPreset } from "./nest-engine";
import { loadLocalProject, saveLocalProject } from "./project-storage";
import { create3mf, createPrusaPlateArchive } from "./three-mf";
import { parseStl } from "./stl";

type Part = {
  id: string; name: string; quantity: number; height: number; footprint: Footprint;
  color: string; source: "STEP" | "STL" | "DEMO"; meshes: ModelMesh[]; orientation: QuaternionTuple; priority: number; minQuantity: number;
};
type Plate = { id: string; name: string; locked: boolean };
type ProjectPlacement = Placement & { plateId: string; locked?: boolean };
type LayoutSnapshot = { parts: Part[]; placements: ProjectPlacement[]; plates: Plate[]; activePlateId: string; message: string };
type StoredProject = { parts: Part[]; placements: ProjectPlacement[]; plates?: Plate[]; activePlateId?: string; printerId: string; bedWidth: number; bedDepth: number; bedHeight: number; clearance: number; autoRotate: boolean; rotationEffort: RotationEffort; searchPreset?: SearchPreset; uiMode?: "simple" | "advanced"; nestingStart: NestingStart; outlinePrecision: OutlinePrecision; objective: OptimizationObjective; preferredSlicer?: SlicerTarget; maxPlates?: number; keepSetsTogether?: boolean };
type Printer = { id: string; brand: string; name: string; width: number; depth: number; height: number };
type RotationEffort = "fast" | "balanced" | "detailed" | "maximum";
type SlicerTarget = "prusa" | "orca" | "bambu";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const withBasePath = (path: string) => `${BASE_PATH}${path}`;

declare global {
  interface Window {
    occtimportjs?: () => Promise<{
      ReadStepFile: (data: Uint8Array, params: Record<string, unknown>) => {
        success: boolean;
        meshes: Array<{ color?: number[]; attributes: { position: { array: number[] } }; index?: { array: number[] } }>;
      };
    }>;
  }
}

const COLORS = ["#ff7a1a", "#2f80ed", "#25a66a", "#9b51e0", "#d94c61", "#00a6a6"];
const IDENTITY: QuaternionTuple = [0, 0, 0, 1];
const GRID = 10;
const EDGE_MARGIN = 2;
const ROTATION_EFFORTS: Record<RotationEffort, { label: string; step: number; orientations: number }> = {
  fast: { label: "Fast", step: 90, orientations: 4 },
  balanced: { label: "Balanced", step: 45, orientations: 8 },
  detailed: { label: "Detailed", step: 15, orientations: 24 },
  maximum: { label: "Maximum", step: 5, orientations: 72 },
};
const PRINTERS: Printer[] = [
  { id: "bambu-a1-mini", brand: "Bambu Lab", name: "A1 mini", width: 180, depth: 180, height: 180 },
  { id: "bambu-a1", brand: "Bambu Lab", name: "A1", width: 256, depth: 256, height: 256 },
  { id: "bambu-p1", brand: "Bambu Lab", name: "P1P / P1S", width: 256, depth: 256, height: 256 },
  { id: "bambu-x1", brand: "Bambu Lab", name: "X1 / X1C / X1E", width: 256, depth: 256, height: 256 },
  { id: "bambu-h2s", brand: "Bambu Lab", name: "H2S", width: 340, depth: 320, height: 340 },
  { id: "bambu-h2d", brand: "Bambu Lab", name: "H2D — single nozzle", width: 325, depth: 320, height: 325 },
  { id: "bambu-h2d-dual", brand: "Bambu Lab", name: "H2D — dual nozzle", width: 300, depth: 320, height: 325 },
  { id: "bambu-a2l", brand: "Bambu Lab", name: "A2L", width: 330, depth: 320, height: 325 },
  { id: "prusa-mini", brand: "Prusa", name: "MINI+", width: 180, depth: 180, height: 180 },
  { id: "prusa-mk4s", brand: "Prusa", name: "MK4S", width: 250, depth: 210, height: 220 },
  { id: "prusa-core-one", brand: "Prusa", name: "CORE One / One+", width: 250, depth: 220, height: 270 },
  { id: "prusa-core-one-l", brand: "Prusa", name: "CORE One L", width: 300, depth: 300, height: 330 },
  { id: "prusa-xl", brand: "Prusa", name: "XL", width: 360, depth: 360, height: 360 },
  { id: "creality-ender3-v3", brand: "Creality", name: "Ender-3 V3 / SE / KE", width: 220, depth: 220, height: 250 },
  { id: "creality-ender3-v3-plus", brand: "Creality", name: "Ender-3 V3 Plus", width: 300, depth: 300, height: 330 },
  { id: "creality-k1c", brand: "Creality", name: "K1 / K1C", width: 220, depth: 220, height: 250 },
  { id: "creality-k1-max", brand: "Creality", name: "K1 Max", width: 300, depth: 300, height: 300 },
  { id: "creality-k2-plus", brand: "Creality", name: "K2 Plus", width: 350, depth: 350, height: 350 },
  { id: "elegoo-neptune4", brand: "Elegoo", name: "Neptune 4 / 4 Pro", width: 225, depth: 225, height: 265 },
  { id: "elegoo-neptune4-plus", brand: "Elegoo", name: "Neptune 4 Plus", width: 320, depth: 320, height: 385 },
  { id: "elegoo-neptune4-max", brand: "Elegoo", name: "Neptune 4 Max", width: 420, depth: 420, height: 480 },
  { id: "elegoo-centauri", brand: "Elegoo", name: "Centauri Carbon", width: 256, depth: 256, height: 256 },
  { id: "anycubic-kobra3", brand: "Anycubic", name: "Kobra 3 / Kobra S1", width: 250, depth: 250, height: 260 },
  { id: "anycubic-kobra3-max", brand: "Anycubic", name: "Kobra 3 Max", width: 420, depth: 420, height: 500 },
  { id: "qidi-q1", brand: "QIDI", name: "Q1 Pro", width: 245, depth: 245, height: 240 },
  { id: "qidi-plus4", brand: "QIDI", name: "Plus4", width: 305, depth: 305, height: 280 },
  { id: "qidi-max3", brand: "QIDI", name: "X-Max 3", width: 325, depth: 325, height: 315 },
  { id: "flashforge-a5m", brand: "FlashForge", name: "Adventurer 5M / Pro", width: 220, depth: 220, height: 220 },
  { id: "sovol-sv06", brand: "Sovol", name: "SV06", width: 220, depth: 220, height: 250 },
  { id: "sovol-sv08", brand: "Sovol", name: "SV08", width: 350, depth: 350, height: 345 },
  { id: "voron-250", brand: "Voron", name: "Voron 2.4 — 250", width: 250, depth: 250, height: 250 },
  { id: "voron-300", brand: "Voron", name: "Voron 2.4 — 300", width: 300, depth: 300, height: 300 },
  { id: "voron-350", brand: "Voron", name: "Voron 2.4 — 350", width: 350, depth: 350, height: 350 },
];

function HelpTip({ label, children }: { label: string; children: string }) {
  return <details className="help-tip"><summary aria-label={`Help: ${label}`} title={`Help: ${label}`}>?</summary><div role="note">{children}</div></details>;
}

function bounds(footprint: Footprint) { return footprintBounds(footprint); }
function translated(p: Placement) { return translateFootprint(p.footprint, p.x, p.y); }
function markCollisions(placements: Placement[], width: number, depth: number, clearance: number) {
  return placements.map((placement, index) => {
    const footprint = translated(placement), b = bounds(footprint);
    const outside = b.minX < EDGE_MARGIN || b.minY < EDGE_MARGIN || b.maxX > width - EDGE_MARGIN || b.maxY > depth - EDGE_MARGIN;
    const overlap = placements.some((other, otherIndex) => otherIndex !== index && footprintsOverlap(footprint, translated(other), clearance));
    return { ...placement, colliding: outside || overlap };
  });
}
function stageInstances(parts: Part[], current: ProjectPlacement[], activePlateId: string, width: number, depth: number, clearance: number) {
  const wanted = new Set(parts.flatMap((part) => Array.from({ length: part.quantity }, (_, copy) => `${part.id}-${copy + 1}`)));
  const kept = current.filter((p) => wanted.has(p.id));
  const existingIds = new Set(kept.map((p) => p.id));
  const active = kept.filter((p) => p.plateId === activePlateId), added: ProjectPlacement[] = [];
  for (const part of parts) for (let copy = 1; copy <= part.quantity; copy++) {
    const id = `${part.id}-${copy}`; if (existingIds.has(id)) continue;
    const b = bounds(part.footprint), partWidth = b.maxX - b.minX, partDepth = b.maxY - b.minY;
    let found: { x: number; y: number } | null = null;
    for (let y = EDGE_MARGIN; !found && y + partDepth <= depth - EDGE_MARGIN + 1e-6; y += Math.max(2, clearance)) for (let x = EDGE_MARGIN; x + partWidth <= width - EDGE_MARGIN + 1e-6; x += Math.max(2, clearance)) {
      const world = translateFootprint(part.footprint, x, y);
      if (![...active, ...added].some((placement) => footprintsOverlap(world, translated(placement), clearance))) { found = { x, y }; break; }
    }
    if (found) added.push({ id, partId: part.id, copy, x: found.x, y: found.y, rotation: 0, footprint: part.footprint, colliding: false, nested: false, plateId: activePlateId, locked: false });
  }
  return [...kept.filter((p) => p.plateId !== activePlateId), ...markCollisions([...active, ...added], width, depth, clearance).map((p) => ({ ...p, plateId: activePlateId } as ProjectPlacement))];
}

async function stageInstancesAsync(parts: Part[], current: ProjectPlacement[], activePlateId: string, width: number, depth: number, clearance: number, shouldCancel: () => boolean) {
  const wanted = new Set(parts.flatMap((part) => Array.from({ length: part.quantity }, (_, copy) => `${part.id}-${copy + 1}`)));
  const kept = current.filter((placement) => wanted.has(placement.id)), existingIds = new Set(kept.map((placement) => placement.id));
  const active = kept.filter((placement) => placement.plateId === activePlateId), added: ProjectPlacement[] = [];
  let checks = 0, cancelled = false;
  for (const part of parts) {
    const b = bounds(part.footprint), partWidth = b.maxX - b.minX, partDepth = b.maxY - b.minY, gridStep = Math.max(2, clearance);
    const columns = Math.max(1, Math.floor((width - EDGE_MARGIN * 2 - partWidth) / gridStep) + 1);
    const rows = Math.max(1, Math.floor((depth - EDGE_MARGIN * 2 - partDepth) / gridStep) + 1);
    let scanIndex = 0;
    for (let copy = 1; copy <= part.quantity; copy++) {
      const id = `${part.id}-${copy}`; if (existingIds.has(id)) continue;
      let found: { x: number; y: number } | null = null;
      for (; scanIndex < columns * rows; scanIndex++) {
        if (++checks % 350 === 0) { await new Promise<void>((resolve) => setTimeout(resolve, 0)); if (shouldCancel()) { cancelled = true; break; } }
        const x = EDGE_MARGIN + (scanIndex % columns) * gridStep, y = EDGE_MARGIN + Math.floor(scanIndex / columns) * gridStep;
        const world = translateFootprint(part.footprint, x, y);
        if (![...active, ...added].some((placement) => footprintsOverlap(world, translated(placement), clearance))) { found = { x, y }; scanIndex++; break; }
      }
      if (cancelled) break;
      if (found) added.push({ id, partId: part.id, copy, x: found.x, y: found.y, rotation: 0, footprint: part.footprint, colliding: false, nested: false, plateId: activePlateId, locked: false });
      else break;
    }
    if (cancelled) break;
  }
  const placements = [...kept.filter((placement) => placement.plateId !== activePlateId), ...markCollisions([...active, ...added], width, depth, clearance).map((placement) => ({ ...placement, plateId: activePlateId } as ProjectPlacement))];
  return { placements, cancelled };
}

function markAllCollisions(placements: ProjectPlacement[], plates: Plate[], width: number, depth: number, clearance: number) {
  return plates.flatMap((plate) => markCollisions(placements.filter((placement) => placement.plateId === plate.id), width, depth, clearance).map((placement) => ({ ...placement, plateId: plate.id } as ProjectPlacement)));
}

function loadOcctScript() {
  if (window.occtimportjs) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-occt="true"]');
    if (existing) { existing.addEventListener("load", () => resolve(), { once: true }); existing.addEventListener("error", () => reject(new Error("Could not load the STEP engine.")), { once: true }); return; }
    const script = document.createElement("script"); script.src = withBasePath("/occt/occt-import-js.js"); script.dataset.occt = "true"; script.onload = () => resolve(); script.onerror = () => reject(new Error("Could not load the STEP engine.")); document.head.appendChild(script);
  });
}

function updateGeometry(part: Part, orientation: QuaternionTuple): Part {
  if (!part.meshes.length) return { ...part, orientation };
  let minZ = Infinity, maxZ = -Infinity;
  for (const mesh of part.meshes) for (let i = 0; i < mesh.positions.length; i += 3) {
    const vector = rotateVector(vec3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]), orientation);
    minZ = Math.min(minZ, vector.z); maxZ = Math.max(maxZ, vector.z);
  }
  return { ...part, orientation, footprint: silhouetteFromMeshes(part.meshes, orientation), height: maxZ - minZ };
}

const demoParts: Part[] = [
  { id: "mount", name: "Sensor mount.step", quantity: 3, priority: 1, minQuantity: 0, height: 18, color: COLORS[0], source: "DEMO", meshes: [], orientation: IDENTITY, footprint: footprintFromRing([{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 64, y: 23 }, { x: 48, y: 39 }, { x: 0, y: 39 }]) },
  { id: "bracket", name: "C bracket.step", quantity: 4, priority: 1, minQuantity: 0, height: 12, color: COLORS[1], source: "DEMO", meshes: [], orientation: IDENTITY, footprint: footprintFromRing([{ x: 0, y: 0 }, { x: 46, y: 0 }, { x: 46, y: 12 }, { x: 14, y: 12 }, { x: 14, y: 42 }, { x: 46, y: 42 }, { x: 46, y: 54 }, { x: 0, y: 54 }]) },
  { id: "spacer", name: "Flanged spacer.step", quantity: 2, priority: 1, minQuantity: 0, height: 11, color: COLORS[2], source: "DEMO", meshes: [], orientation: IDENTITY, footprint: footprintFromRing(Array.from({ length: 24 }, (_, i) => ({ x: 26 + Math.cos(i / 24 * Math.PI * 2) * 26, y: 26 + Math.sin(i / 24 * Math.PI * 2) * 26 }))) },
];

export default function Home() {
  const [parts, setParts] = useState<Part[]>([]), [allPlacements, setAllPlacements] = useState<ProjectPlacement[]>([]);
  const [plates, setPlates] = useState<Plate[]>([{ id: "plate-1", name: "Plate 1", locked: false }]), [activePlateId, setActivePlateId] = useState("plate-1");
  const [bedWidth, setBedWidth] = useState(256), [bedDepth, setBedDepth] = useState(256), [bedHeight, setBedHeight] = useState(256);
  const [printerId, setPrinterId] = useState("bambu-p1"), [clearance, setClearance] = useState(2), [autoRotate, setAutoRotate] = useState(true), [rotationEffort, setRotationEffort] = useState<RotationEffort>("balanced"), [nestingStart, setNestingStart] = useState<NestingStart>("corner"), [outlinePrecision, setOutlinePrecision] = useState<OutlinePrecision>("standard");
  const [searchPreset, setSearchPreset] = useState<SearchPreset>("balanced"), [uiMode, setUiMode] = useState<"simple" | "advanced">("simple"), [primaryNestAction, setPrimaryNestAction] = useState<"smart" | "current" | "all" | "add">("smart");
  const [objective, setObjective] = useState<OptimizationObjective>("balanced"), [layoutOptions, setLayoutOptions] = useState<LayoutOption[]>([]), [history, setHistory] = useState<LayoutSnapshot[]>([]);
  const [storageReady, setStorageReady] = useState(false), [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [isImporting, setIsImporting] = useState(false), [message, setMessage] = useState("Add STEP files or load the example set."), [orientingId, setOrientingId] = useState<string | null>(null), [orientationDraft, setOrientationDraft] = useState<Part | null>(null);
  const [preferredSlicer, setPreferredSlicer] = useState<SlicerTarget>("orca"), [selectedPartId, setSelectedPartId] = useState<string | null>(null), [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null), [selectedPlacementIds, setSelectedPlacementIds] = useState<string[]>([]), [manualRotationStep, setManualRotationStep] = useState(15), [showUnplaced, setShowUnplaced] = useState(false);
  const [maxPlates, setMaxPlates] = useState(10), [keepSetsTogether, setKeepSetsTogether] = useState(false), [batchSets, setBatchSets] = useState(1), [fillMode, setFillMode] = useState<"remaining" | "repack" | "existing" | "batch">("remaining");
  const [workingLabel, setWorkingLabel] = useState<string | null>(null);
  const [nestingMode, setNestingMode] = useState<"layout" | "fill" | null>(null), [cancellableTask, setCancellableTask] = useState<"instances" | "orientation" | null>(null), [stopRequested, setStopRequested] = useState(false);
  const [nestProgress, setNestProgress] = useState({ placed: 0, processed: 0, total: 0, candidateChecks: 0, attempt: 1, attempts: 4 });
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), workerPoolRef = useRef<Worker[]>([]), activeWorkersRef = useRef<Worker[]>([]), autoOrientWorkerRef = useRef<Worker | null>(null), autoOrientRejectRef = useRef<((reason?: unknown) => void) | null>(null), localTaskCancelRef = useRef(false), dragPayloadRef = useRef<{ type: "placements" | "part"; ids?: string[]; partId?: string } | null>(null), orientingPart = orientationDraft;
  const activePlate = plates.find((plate) => plate.id === activePlateId) ?? plates[0];
  const placements = allPlacements.filter((placement) => placement.plateId === activePlateId);
  const setPlacements = (update: Placement[] | ((current: Placement[]) => Placement[])) => setAllPlacements((current) => {
    const active = current.filter((placement) => placement.plateId === activePlateId), next = typeof update === "function" ? update(active) : update;
    return [...current.filter((placement) => placement.plateId !== activePlateId), ...next.map((placement) => ({ ...placement, plateId: activePlateId } as ProjectPlacement))];
  });
  const isWorking = Boolean(workingLabel), scale = Math.min(860 / bedWidth, 620 / bedDepth), collisionCount = placements.filter((p) => p.colliding).length;
  const utilization = useMemo(() => bedWidth * bedDepth ? Math.min(100, placements.reduce((sum, p) => sum + footprintArea(p.footprint), 0) / (bedWidth * bedDepth) * 100) : 0, [placements, bedWidth, bedDepth]);
  const selectedPlacement = placements.find((placement) => placement.id === selectedPlacementId) ?? null;
  const unplacedByPart = useMemo(() => parts.map((part) => ({ part, count: Math.max(0, part.quantity - allPlacements.filter((placement) => placement.partId === part.id).length) })).filter((item) => item.count > 0), [parts, allPlacements]);
  const unplacedCount = unplacedByPart.reduce((sum, item) => sum + item.count, 0);
  const setUnplacedCount = (_value: number) => undefined;
  const totalCollisionCount = allPlacements.filter((placement) => placement.colliding).length;
  const requestedCount = parts.reduce((sum, part) => sum + part.quantity, 0), usedPlateCount = plates.filter((plate) => allPlacements.some((placement) => placement.plateId === plate.id)).length;
  const averageUtilization = usedPlateCount ? allPlacements.reduce((sum, placement) => sum + footprintArea(placement.footprint), 0) / Math.max(1, usedPlateCount * bedWidth * bedDepth) * 100 : 0;
  const geometryPoints = parts.reduce((sum, part) => sum + part.footprint.reduce((polygonSum, polygon) => polygonSum + polygon.reduce((ringSum, ring) => ringSum + ring.length, 0), 0), 0);
  const estimatedSeconds = Math.max(1, Math.round((requestedCount + 1) * Math.max(1, geometryPoints / Math.max(1, parts.length * 35)) * (searchPreset === "quick" ? .18 : searchPreset === "best" ? 1.8 : .65)));
  const estimateLabel = estimatedSeconds < 8 ? "a few seconds" : estimatedSeconds < 55 ? `about ${Math.ceil(estimatedSeconds / 5) * 5} seconds` : `about ${Math.ceil(estimatedSeconds / 60)} minute${Math.ceil(estimatedSeconds / 60) === 1 ? "" : "s"}`;

  useEffect(() => {
    let active = true;
    loadLocalProject<StoredProject>().then((project) => {
      if (!active || !project?.parts?.length) return;
      const restoredParts = project.parts.map((part) => ({ ...part, priority: part.priority ?? 1, minQuantity: Math.min(part.quantity, part.minQuantity ?? 0) }));
      const restoredPlates = project.plates?.length ? project.plates : [{ id: "plate-1", name: "Plate 1", locked: false }];
      const restoredActive = restoredPlates.some((plate) => plate.id === project.activePlateId) ? project.activePlateId! : restoredPlates[0].id;
      const restoredWidth = project.bedWidth ?? 256, restoredDepth = project.bedDepth ?? 256, restoredClearance = project.clearance ?? 2;
      const migratedPlacements = (project.placements ?? []).map((placement) => ({ ...placement, plateId: placement.plateId ?? restoredPlates[0].id, locked: placement.locked ?? false } as ProjectPlacement));
      setParts(restoredParts); setPlates(restoredPlates); setActivePlateId(restoredActive); setAllPlacements(markAllCollisions(migratedPlacements, restoredPlates, restoredWidth, restoredDepth, restoredClearance)); setPrinterId(project.printerId ?? "custom");
      setBedWidth(project.bedWidth ?? 256); setBedDepth(project.bedDepth ?? 256); setBedHeight(project.bedHeight ?? 256); setClearance(project.clearance ?? 2);
      setAutoRotate(project.autoRotate ?? true); setRotationEffort(project.rotationEffort ?? "balanced"); setSearchPreset(project.searchPreset ?? "balanced"); setUiMode(project.uiMode ?? "simple"); setNestingStart(project.nestingStart ?? "corner"); setOutlinePrecision(project.outlinePrecision ?? "standard"); setObjective(project.objective ?? "balanced"); setPreferredSlicer(project.preferredSlicer ?? "orca"); setMaxPlates(project.maxPlates ?? 10); setKeepSetsTogether(project.keepSetsTogether ?? false);
      setMessage("Restored your locally saved project.");
    }).catch(() => setSaveStatus("error")).finally(() => active && setStorageReady(true));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      saveLocalProject({ parts, placements: allPlacements, plates, activePlateId, printerId, bedWidth, bedDepth, bedHeight, clearance, autoRotate, rotationEffort, searchPreset, uiMode, nestingStart, outlinePrecision, objective, preferredSlicer, maxPlates, keepSetsTogether } satisfies StoredProject)
        .then(() => setSaveStatus("saved")).catch(() => setSaveStatus("error"));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [storageReady, parts, allPlacements, plates, activePlateId, printerId, bedWidth, bedDepth, bedHeight, clearance, autoRotate, rotationEffort, searchPreset, uiMode, nestingStart, outlinePrecision, objective, preferredSlicer, maxPlates, keepSetsTogether]);

  useEffect(() => () => { workerPoolRef.current.forEach((worker) => worker.terminate()); autoOrientWorkerRef.current?.terminate(); }, []);

  function rememberLayout() { setHistory((current) => [...current.slice(-19), { parts, placements: allPlacements, plates, activePlateId, message }]); }
  function undoLayout() {
    const snapshot = history.at(-1); if (!snapshot) return;
    setParts(snapshot.parts); setAllPlacements(snapshot.placements); setPlates(snapshot.plates); setActivePlateId(snapshot.activePlateId); setMessage(`Undid last layout change. ${snapshot.message}`); setHistory((current) => current.slice(0, -1)); setLayoutOptions([]);
  }

  function waitForPaint() { return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, 50)))); }

  function runInWorker(eligible: Array<Part & { copies?: number[] }>, effort = rotationEffort, fixed: Placement[] = [], onProgress?: (placements: Placement[]) => void, options: { singlePass?: boolean; maxRuntimeMs?: number } = {}) {
    const attempts = options.singlePass ? [0] : searchPreset === "quick" ? [0] : searchPreset === "best" ? [0, 1, 2, 3] : [0, 1, 2];
    const maxRuntimeMs = options.maxRuntimeMs ?? (searchPreset === "quick" ? 5_000 : searchPreset === "best" ? 45_000 : 18_000);
    const request: NestRequest = { parts: eligible.map((part) => ({ id: part.id, quantity: part.copies?.length ?? part.quantity, copies: part.copies, footprint: part.footprint, priority: part.priority, minQuantity: Math.min(part.minQuantity, part.copies?.length ?? part.quantity) })), width: bedWidth, depth: bedDepth, clearance, edgeMargin: EDGE_MARGIN, fixed, autoRotate, rotationStep: ROTATION_EFFORTS[effort].step, nestingStart, outlinePrecision, objective, preset: searchPreset, attemptCount: attempts.length, maxRuntimeMs };
    while (workerPoolRef.current.length < attempts.length) workerPoolRef.current.push(new Worker(new URL("./nest.worker.ts", import.meta.url), { type: "module" }));
    const workers = workerPoolRef.current.slice(0, attempts.length); activeWorkersRef.current = workers;
    const progressByPass = new Map<number, NestProgress>(), completionSignatures = new Set<string>(); let bestProgress: Placement[] = fixed, finished = false;
    const jobs = attempts.map((attempt, index) => new Promise<NestBatchResult>((resolve, reject) => {
      const worker = workers[index], jobId = `${Date.now()}-${Math.random()}-${attempt}`;
      worker.onmessage = (event: MessageEvent<{ type: "progress"; progress: NestProgress; jobId?: string } | { type: "result"; result: NestBatchResult; jobId?: string } | { type: "error"; message: string; jobId?: string }>) => {
        if (event.data.jobId !== jobId) return;
        if (event.data.type === "progress") {
          progressByPass.set(attempt, event.data.progress); if (event.data.progress.placed.length >= bestProgress.length) { bestProgress = event.data.progress.placed; (onProgress ?? ((next) => setPlacements(next)))(bestProgress); }
          const progress = [...progressByPass.values()], processed = progress.reduce((sum, item) => sum + item.processed, 0), total = eligible.reduce((sum, part) => sum + (part.copies?.length ?? part.quantity), 0) * attempts.length;
          setNestProgress({ placed: bestProgress.length, processed, total, candidateChecks: progress.reduce((sum, item) => sum + item.candidateChecks, 0), attempt: progressByPass.size, attempts: attempts.length });
        }
        if (event.data.type === "result") {
          const signature = event.data.result.best?.placed.map((p) => `${p.id}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.rotation}`).sort().join("|") ?? "";
          const stalled = completionSignatures.has(signature); completionSignatures.add(signature);
          if (stalled) workers.forEach((other) => { if (other !== worker) other.postMessage({ type: "cancel" }); });
          resolve(event.data.result);
        }
        if (event.data.type === "error") reject(new Error(event.data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || "Background nesting failed."));
      worker.postMessage({ type: "start", request: { ...request, attempts: [attempt] }, jobId });
    }));
    return Promise.all(jobs).then((batches) => {
      finished = true; activeWorkersRef.current = [];
      const layouts = batches.flatMap((batch) => batch.layouts).sort((a, b) => b.score - a.score).filter((layout, index, all) => all.findIndex((other) => other.placed.map((p) => `${p.id}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.rotation}`).sort().join("|") === layout.placed.map((p) => `${p.id}:${p.x.toFixed(2)},${p.y.toFixed(2)},${p.rotation}`).sort().join("|")) === index).slice(0, 3);
      return { best: layouts[0], layouts, cancelled: batches.some((batch) => batch.cancelled), candidateChecks: batches.reduce((sum, batch) => sum + batch.candidateChecks, 0) };
    }).finally(() => { if (!finished) activeWorkersRef.current = []; });
  }

  async function runNest(nextParts = parts, effort = rotationEffort) {
    if (activePlate?.locked) { setMessage(`${activePlate.name} is locked. Unlock it before nesting.`); return; }
    rememberLayout(); setLayoutOptions([]);
    setStopRequested(false); setNestingMode("layout"); setWorkingLabel("Finding the best layout…"); await waitForPaint();
    try {
      const occupiedElsewhere = new Set(allPlacements.filter((placement) => placement.plateId !== activePlateId).map((placement) => placement.id));
      const fixed = placements.filter((placement) => placement.locked);
      const fixedIds = new Set(fixed.map((placement) => placement.id));
      const requested = nextParts.map((part) => ({ ...part, copies: Array.from({ length: part.quantity }, (_, index) => index + 1).filter((copy) => !occupiedElsewhere.has(`${part.id}-${copy}`) && !fixedIds.has(`${part.id}-${copy}`)) }));
      const tooTall = requested.reduce((sum, part) => sum + (part.height > bedHeight ? part.copies.length : 0), 0), eligible = requested.filter((part) => part.height <= bedHeight && part.copies.length);
      setNestProgress({ placed: fixed.length, processed: 0, total: eligible.reduce((sum, part) => sum + part.copies.length, 0), candidateChecks: 0, attempt: 1, attempts: 4 });
      const batch = await runInWorker(eligible, effort, fixed), result = batch.best, totalUnplaced = result.unplaced.length + tooTall;
      setPlacements(result.placed); setUnplacedCount(totalUnplaced); setLayoutOptions(batch.layouts);
      setMessage(batch.cancelled ? `Stopped nesting. Kept the best completed layout with ${result.placed.length} placed part${result.placed.length === 1 ? "" : "s"}.` : totalUnplaced ? `${totalUnplaced} part${totalUnplaced === 1 ? "" : "s"} could not fit. ${batch.layouts.length} alternatives are ready to compare.` : `Nested ${result.placed.length} parts. ${batch.layouts.length} alternatives are ready to compare.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Nesting failed."); }
    finally { activeWorkersRef.current = []; setNestingMode(null); setStopRequested(false); setWorkingLabel(null); }
  }

  function applyPrinter(id: string) {
    rememberLayout(); setLayoutOptions([]);
    setPrinterId(id); const printer = PRINTERS.find((item) => item.id === id); if (!printer) return;
    setBedWidth(printer.width); setBedDepth(printer.depth); setBedHeight(printer.height);
    setAllPlacements((current) => markAllCollisions(current, plates, printer.width, printer.depth, clearance)); setMessage(`${printer.brand} ${printer.name} profile selected. Every plate keeps a 2 mm safety border.`);
  }
  function applySearchPreset(preset: SearchPreset) {
    setSearchPreset(preset);
    if (preset === "quick") { setRotationEffort("fast"); setOutlinePrecision("fast"); }
    if (preset === "balanced") { setRotationEffort("balanced"); setOutlinePrecision("standard"); }
    if (preset === "best") { setRotationEffort("maximum"); setOutlinePrecision("precise"); }
    setMessage(`${preset === "quick" ? "Quick" : preset === "best" ? "Best fit" : "Balanced"} search selected. Rotation automatically becomes more detailed only when a part does not fit.`);
  }
  function runPrimaryNest() {
    if (primaryNestAction === "current") { runNest(); return; }
    if (primaryNestAction === "all") { distributeAcrossPlates(parts, false, false); return; }
    if (primaryNestAction === "add") { distributeAcrossPlates(parts, true, false); return; }
    if (unplacedCount > 0 || plates.length > 1) distributeAcrossPlates(parts, true, false); else runNest();
  }
  function setCustomBed(axis: "width" | "depth" | "height", value: number) {
    const safe = Math.max(20, value); setPrinterId("custom");
    if (axis === "width") { setBedWidth(safe); setAllPlacements((current) => markAllCollisions(current, plates, safe, bedDepth, clearance)); }
    if (axis === "depth") { setBedDepth(safe); setAllPlacements((current) => markAllCollisions(current, plates, bedWidth, safe, clearance)); }
    if (axis === "height") setBedHeight(safe);
  }

  async function importFiles(files: FileList | File[]) {
    const selected = Array.from(files).filter((file) => /\.(stp|step|stl)$/i.test(file.name));
    if (!selected.length) { setMessage("Choose one or more .stp, .step, or .stl files."); return; }
    setIsImporting(true); setWorkingLabel("Preparing the local geometry engine…"); setMessage("Preparing the local geometry engine…"); await waitForPaint();
    try {
      const hasStep = selected.some((file) => /\.(stp|step)$/i.test(file.name));
      if (hasStep) await loadOcctScript();
      const occt = hasStep ? await window.occtimportjs!() : null, imported: Part[] = [];
      for (const file of selected) {
        setWorkingLabel(`Reading ${file.name}…`); setMessage(`Reading ${file.name}…`); await waitForPaint();
        const buffer = await file.arrayBuffer(); let meshes: ModelMesh[], source: "STEP" | "STL";
        if (/\.stl$/i.test(file.name)) { meshes = [parseStl(buffer)]; source = "STL"; }
        else {
          const result = occt!.ReadStepFile(new Uint8Array(buffer), { linearUnit: "millimeter", linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.001, angularDeflection: 0.5 });
          if (!result.success || !result.meshes.length) throw new Error(`${file.name} could not be triangulated.`);
          meshes = result.meshes.map((mesh) => ({ positions: [...mesh.attributes.position.array], indices: mesh.index?.array ? [...mesh.index.array] : [], color: mesh.color })); source = "STEP";
        }
        const base: Part = { id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, quantity: 1, priority: 1, minQuantity: 0, height: 0, footprint: [], color: COLORS[(parts.length + imported.length) % COLORS.length], source, meshes, orientation: IDENTITY };
        imported.push(updateGeometry(base, IDENTITY));
      }
      const next = [...parts, ...imported]; setParts(next); setAllPlacements((current) => stageInstances(next, current, activePlateId, bedWidth, bedDepth, clearance));
      setMessage(`Loaded ${imported.length} model${imported.length === 1 ? "" : "s"}. Instances that fit are staged on ${activePlate?.name ?? "the active plate"}; overflow is visible as unassigned.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Model import failed."); }
    finally { setIsImporting(false); setWorkingLabel(null); if (fileInput.current) fileInput.current.value = ""; }
  }

  function commitOrientation(id: string, changed: Part, note: string) {
    rememberLayout(); setLayoutOptions([]);
    setParts((current) => current.map((part) => part.id === id ? changed : part));
    setAllPlacements((current) => markAllCollisions(current.map((placement) => placement.partId === id ? { ...placement, footprint: transformFootprint(changed.footprint, placement.rotation), nested: false } : placement), plates, bedWidth, bedDepth, clearance));
    setUnplacedCount(0); setMessage(note);
  }

  function openOrientation(id: string) {
    const source = parts.find((part) => part.id === id); if (!source?.meshes.length) return;
    setOrientingId(id); setOrientationDraft(source); setSelectedPartId(id); setSelectedPlacementId(null);
  }
  function closeOrientation() { setOrientingId(null); setOrientationDraft(null); }
  function applyOrientation() {
    if (!orientingPart || !orientingId) return;
    commitOrientation(orientingId, orientingPart, `Applied the new orientation to ${orientingPart.name}.`); closeOrientation();
  }

  async function orientPart(id: string, orientation: QuaternionTuple, note: string) {
    const source = orientationDraft?.id === id ? orientationDraft : parts.find((part) => part.id === id); if (!source) return;
    setWorkingLabel(`Updating ${source.name} orientation…`); await waitForPaint();
    try { setOrientationDraft(updateGeometry(source, orientation)); setMessage(note); }
    finally { setWorkingLabel(null); }
  }

  async function autoOrientCurrent() {
    if (!orientingPart) return;
    const source = orientingPart;
    setStopRequested(false); setCancellableTask("orientation"); setWorkingLabel(`Evaluating print orientations for ${source.name}…`); await waitForPaint();
    try {
      autoOrientWorkerRef.current?.terminate();
      const worker = new Worker(new URL("./auto-orient.worker.ts", import.meta.url), { type: "module" }); autoOrientWorkerRef.current = worker;
      const result = await new Promise<{ orientation: QuaternionTuple; candidates: number; sampledTriangles: number; footprint: Footprint; height: number }>((resolve, reject) => {
        autoOrientRejectRef.current = reject;
        worker.onmessage = (event: MessageEvent<{ type: "result"; result: { orientation: QuaternionTuple; candidates: number; sampledTriangles: number; footprint: Footprint; height: number } } | { type: "error"; message: string }>) => event.data.type === "result" ? resolve(event.data.result) : reject(new Error(event.data.message));
        worker.onerror = (event) => reject(new Error(event.message || "Automatic orientation failed."));
        worker.postMessage({ meshes: source.meshes });
      });
      setOrientationDraft({ ...source, orientation: result.orientation, footprint: result.footprint, height: result.height });
      setMessage(`Previewing the recommended print orientation for ${source.name}. Compared ${result.candidates} Orca-style candidates using ${result.sampledTriangles.toLocaleString()} sampled triangles.`);
    } catch (error) { setMessage(error instanceof Error && error.message === "cancelled" ? `Cancelled automatic orientation for ${source.name}.` : error instanceof Error ? error.message : "Automatic orientation failed."); }
    finally { autoOrientWorkerRef.current?.terminate(); autoOrientWorkerRef.current = null; autoOrientRejectRef.current = null; setCancellableTask(null); setStopRequested(false); setWorkingLabel(null); }
  }

  async function changeQuantity(id: string, quantity: number) {
    rememberLayout();
    const safe = Math.max(1, Math.min(500, quantity || 1));
    const next = parts.map((part) => part.id === id ? { ...part, quantity: safe, minQuantity: Math.min(part.minQuantity, safe) } : part);
    setParts(next); localTaskCancelRef.current = false; setStopRequested(false); setCancellableTask("instances"); setWorkingLabel("Adding instances to the plate…"); await waitForPaint();
    try {
      const staged = await stageInstancesAsync(next, allPlacements, activePlateId, bedWidth, bedDepth, clearance, () => localTaskCancelRef.current);
      setAllPlacements(staged.placements); setUnplacedCount(0);
      setMessage(staged.cancelled ? `Stopped adding instances. Copies already staged on ${activePlate?.name ?? "the active plate"} were kept.` : `Quantity updated. Copies that fit are staged on ${activePlate?.name ?? "the active plate"}; remaining copies are unassigned.`);
    } finally { setCancellableTask(null); setStopRequested(false); setWorkingLabel(null); }
  }

  async function fillPlate(partId: string) {
    const target = parts.find((part) => part.id === partId); if (!target) return;
    if (activePlate?.locked && fillMode !== "existing" && fillMode !== "batch") { setMessage(`${activePlate.name} is locked. Choose another plate or unlock it.`); return; }
    rememberLayout(); setLayoutOptions([]); localTaskCancelRef.current = false;
    setStopRequested(false); setNestingMode("fill"); setWorkingLabel(`Filling the plate with ${target.name}…`); await waitForPaint();
    try {
      const targetBounds = bounds(target.footprint), boxArea = Math.max(1, targetBounds.maxX * targetBounds.maxY), shapeArea = Math.max(1, footprintArea(target.footprint));
      const usableArea = Math.max(1, (bedWidth - EDGE_MARGIN * 2) * (bedDepth - EDGE_MARGIN * 2));
      const shapeEfficiency = Math.max(.42, Math.min(.92, shapeArea / boxArea * .92));
      let low = 1, high = 500, capacityEstimate = 1;
      while (low <= high) { const mid = Math.floor((low + high) / 2); if (mid * shapeArea <= usableArea * shapeEfficiency) { capacityEstimate = mid; low = mid + 1; } else high = mid - 1; }
      const perPlateEstimate = Math.max(1, capacityEstimate + Math.ceil(Math.sqrt(capacityEstimate)));
      if (fillMode === "batch") {
        await distributeBatch(partId, Math.max(target.quantity, batchSets), true);
        return;
      }
      if (fillMode === "existing") {
        const fitted = await fillAcrossExistingPlates(target, Math.min(500, target.quantity + perPlateEstimate * plates.length));
        setParts((current) => current.map((part) => part.id === partId ? { ...part, quantity: fitted, minQuantity: Math.min(part.minQuantity, fitted) } : part));
        setMessage(`Filled available space across ${plates.length} plate${plates.length === 1 ? "" : "s"}. ${fitted} copies of ${target.name} are placed.`);
        return;
      }
      if (fillMode === "remaining") {
        const occupiedElsewhere = new Set(allPlacements.filter((placement) => placement.plateId !== activePlateId).map((placement) => placement.id));
        const existingIds = new Set(allPlacements.map((placement) => placement.id));
        let available = Array.from({ length: 500 }, (_, index) => index + 1).filter((copy) => !existingIds.has(`${partId}-${copy}`) && !occupiedElsewhere.has(`${partId}-${copy}`));
        let working: Placement[] = [...placements], stopped = false;
        let waveSize = 8;
        while (available.length && !localTaskCancelRef.current) {
          const wave = available.slice(0, waveSize), beforeIds = new Set(working.map((placement) => placement.id));
          setNestProgress({ placed: working.length, processed: 0, total: wave.length, candidateChecks: 0, attempt: 1, attempts: 1 });
          const batch = await runInWorker([{ ...target, quantity: wave.length, copies: wave, minQuantity: 0 }], rotationEffort, working, undefined, { singlePass: true, maxRuntimeMs: searchPreset === "quick" ? 6_000 : 18_000 });
          const next = batch.best.placed, addedIds = new Set(next.filter((placement) => !beforeIds.has(placement.id)).map((placement) => placement.id));
          working = next; available = available.filter((copy) => !addedIds.has(`${partId}-${copy}`));
          if (localTaskCancelRef.current) { stopped = true; break; }
          if (batch.cancelled) { if (!addedIds.size) break; waveSize = Math.max(2, Math.min(waveSize - 2, addedIds.size)); continue; }
          if (addedIds.size < wave.length) break;
        }
        const activeResult = working.map((placement) => ({ ...placement, plateId: activePlateId } as ProjectPlacement));
        setPlacements(activeResult);
        const fittedProject = allPlacements.filter((placement) => placement.plateId !== activePlateId && placement.partId === partId).length + activeResult.filter((placement) => placement.partId === partId).length;
        setParts((current) => current.map((part) => part.id === partId ? { ...part, quantity: Math.max(1, fittedProject), minQuantity: Math.min(part.minQuantity, Math.max(1, fittedProject)) } : part));
        setMessage(stopped ? `Stopped filling and kept every completed wave. ${fittedProject} copies of ${target.name} remain placed.` : `Filled the remaining usable space on ${activePlate?.name} without moving existing parts.`);
        return;
      }
      const occupiedElsewhere = new Set(allPlacements.filter((placement) => placement.plateId !== activePlateId).map((placement) => placement.id));
      const currentIds = new Set(placements.map((placement) => placement.id));
      const placedGlobalIds = new Set(allPlacements.map((placement) => placement.id));
      const estimated = Math.min(500, Math.max(target.quantity, target.quantity + perPlateEstimate));
      const fixed = fillMode === "remaining" ? placements : placements.filter((placement) => placement.locked);
      const fixedIds = new Set(fixed.map((placement) => placement.id));
      const requested = parts.map((part) => {
        const limit = part.id === partId ? estimated : part.quantity;
        const copies = Array.from({ length: limit }, (_, index) => index + 1).filter((copy) => {
          const id = `${part.id}-${copy}`;
          if (occupiedElsewhere.has(id) || fixedIds.has(id)) return false;
          return fillMode === "repack" ? currentIds.has(id) || part.id === partId : part.id === partId && !placedGlobalIds.has(id);
        });
        return { ...part, quantity: copies.length, copies };
      }).filter((part) => part.copies.length && part.height <= bedHeight);
      setNestProgress({ placed: fixed.length, processed: 0, total: requested.reduce((sum, part) => sum + part.copies.length, 0), candidateChecks: 0, attempt: 1, attempts: 4 });
      const batch = await runInWorker(requested, rotationEffort, fixed), result = batch.best;
      const activeResult = result.placed.map((placement) => ({ ...placement, plateId: activePlateId } as ProjectPlacement));
      setPlacements(activeResult);
      const fittedProject = allPlacements.filter((placement) => placement.plateId !== activePlateId && placement.partId === partId).length + activeResult.filter((placement) => placement.partId === partId).length;
      const safeFittedProject = Math.max(1, fittedProject);
      setParts((current) => current.map((part) => part.id === partId ? { ...part, quantity: safeFittedProject, minQuantity: Math.min(part.minQuantity, safeFittedProject) } : part));
      setMessage(batch.cancelled ? `Stopped filling and kept the best completed result.` : fillMode === "remaining" ? `Filled unused space on ${activePlate?.name} without moving existing parts.` : `Repacked ${activePlate?.name} for more copies of ${target.name}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Plate filling failed."); }
    finally { activeWorkersRef.current = []; localTaskCancelRef.current = false; setNestingMode(null); setStopRequested(false); setWorkingLabel(null); }
  }
  async function fillAcrossExistingPlates(target: Part, requestedTotal: number) {
    let working = [...allPlacements], available = Array.from({ length: requestedTotal }, (_, index) => index + 1).filter((copy) => !working.some((placement) => placement.id === `${target.id}-${copy}`));
    for (const plate of plates) {
      if (!available.length || plate.locked || target.height > bedHeight) continue;
      const fixed = working.filter((placement) => placement.plateId === plate.id);
      const batch = await runInWorker([{ ...target, quantity: available.length, copies: available, minQuantity: 0 }], rotationEffort, fixed, () => undefined), result = batch.best;
      const next = result.placed.map((placement) => ({ ...placement, plateId: plate.id } as ProjectPlacement));
      working = [...working.filter((placement) => placement.plateId !== plate.id), ...next];
      const placedIds = new Set(next.map((placement) => placement.id)); available = available.filter((copy) => !placedIds.has(`${target.id}-${copy}`));
      if (batch.cancelled) break;
    }
    setAllPlacements(markAllCollisions(working, plates, bedWidth, bedDepth, clearance));
    return working.filter((placement) => placement.partId === target.id).length;
  }

  async function distributeBatch(partId: string, requestedTotal: number, allowCreate: boolean) {
    const target = parts.find((part) => part.id === partId); if (!target) return;
    const updated = parts.map((part) => part.id === partId ? { ...part, quantity: Math.min(500, requestedTotal) } : part);
    setParts(updated); await distributeAcrossPlates(updated, allowCreate, false);
  }

  async function distributeAcrossPlates(targetParts: Part[], allowCreate: boolean, consolidate: boolean) {
    rememberLayout(); setLayoutOptions([]); setStopRequested(false); setNestingMode("layout"); setWorkingLabel(consolidate ? "Consolidating plates…" : "Nesting across plates…"); await waitForPaint();
    try {
      let workingPlates = [...plates], working = [...allPlacements];
      const preserved = working.filter((placement) => workingPlates.find((plate) => plate.id === placement.plateId)?.locked || placement.locked);
      const preservedIds = new Set(preserved.map((placement) => placement.id));
      const pool = new Map<string, number[]>();
      for (const part of targetParts) pool.set(part.id, Array.from({ length: part.quantity }, (_, index) => index + 1).filter((copy) => !preservedIds.has(`${part.id}-${copy}`)));
      working = preserved;
      let index = 0;
      while ([...pool.values()].some((copies) => copies.length)) {
        let plate = workingPlates[index++];
        if (!plate) {
          if (!allowCreate || workingPlates.length >= maxPlates) break;
          plate = { id: `plate-${Date.now()}-${workingPlates.length + 1}`, name: `Plate ${workingPlates.length + 1}`, locked: false }; workingPlates.push(plate);
        }
        if (plate.locked) continue;
        const fixed = preserved.filter((placement) => placement.plateId === plate.id);
        const requested = targetParts.map((part) => { const copies = pool.get(part.id) ?? []; return { ...part, quantity: copies.length, copies, minQuantity: keepSetsTogether && copies.length ? 1 : Math.min(part.minQuantity, copies.length) }; }).filter((part) => part.copies.length && part.height <= bedHeight);
        if (!requested.length) break;
        setNestProgress({ placed: fixed.length, processed: 0, total: requested.reduce((sum, part) => sum + part.copies.length, 0), candidateChecks: 0, attempt: 1, attempts: 4 });
        const batch = await runInWorker(requested, rotationEffort, fixed, (progress) => { if (plate.id === activePlateId) setPlacements(progress); }), result = batch.best;
        const next = result.placed.map((placement) => ({ ...placement, plateId: plate.id } as ProjectPlacement));
        working = [...working.filter((placement) => placement.plateId !== plate.id), ...next];
        const placedIds = new Set(next.map((placement) => placement.id));
        for (const [id, copies] of pool) pool.set(id, copies.filter((copy) => !placedIds.has(`${id}-${copy}`)));
        if (batch.cancelled || next.length === fixed.length) break;
      }
      if (consolidate) {
        const used = new Set(working.map((placement) => placement.plateId));
        workingPlates = workingPlates.filter((plate, plateIndex) => plateIndex === 0 || plate.locked || used.has(plate.id));
      }
      setPlates(workingPlates); setAllPlacements(markAllCollisions(working, workingPlates, bedWidth, bedDepth, clearance));
      if (!workingPlates.some((plate) => plate.id === activePlateId)) setActivePlateId(workingPlates[0].id);
      const remaining = targetParts.reduce((sum, part) => sum + (pool.get(part.id)?.length ?? 0), 0);
      setMessage(remaining ? `${remaining} requested instance${remaining === 1 ? "" : "s"} remain unassigned after using ${workingPlates.length} plate${workingPlates.length === 1 ? "" : "s"}.` : `${consolidate ? "Consolidated" : "Nested"} every requested instance across ${workingPlates.length} plate${workingPlates.length === 1 ? "" : "s"}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Multi-plate nesting failed."); }
    finally { activeWorkersRef.current = []; setNestingMode(null); setStopRequested(false); setWorkingLabel(null); }
  }

  function addPlate(select = true) {
    rememberLayout(); const plate: Plate = { id: `plate-${Date.now()}`, name: `Plate ${plates.length + 1}`, locked: false };
    setPlates((current) => [...current, plate]); if (select) setActivePlateId(plate.id); setSelectedPlacementId(null); setMessage(`${plate.name} added.`); return plate;
  }
  function duplicateActivePlate() {
    if (!activePlate) return; rememberLayout(); const plate: Plate = { id: `plate-${Date.now()}`, name: `${activePlate.name} copy`, locked: false };
    const source = placements, increments = new Map<string, number>();
    const copies = source.map((placement) => { const part = parts.find((item) => item.id === placement.partId)!; const copy = part.quantity + (increments.get(part.id) ?? 0) + 1; increments.set(part.id, (increments.get(part.id) ?? 0) + 1); return { ...placement, id: `${part.id}-${copy}`, copy, plateId: plate.id, locked: false } as ProjectPlacement; });
    setParts((current) => current.map((part) => ({ ...part, quantity: Math.min(500, part.quantity + (increments.get(part.id) ?? 0)) })));
    setPlates((current) => [...current, plate]); setAllPlacements((current) => [...current, ...copies]); setActivePlateId(plate.id); setSelectedPlacementId(null); setMessage(`Duplicated ${activePlate.name} with ${copies.length} new project copies.`);
  }
  function clearActivePlate() {
    if (!activePlate || activePlate.locked) { setMessage("Unlock the active plate before clearing it."); return; }
    rememberLayout(); setAllPlacements((current) => current.filter((placement) => placement.plateId !== activePlateId)); setSelectedPlacementId(null); setMessage(`${activePlate.name} cleared. Its requested instances are now unassigned.`);
  }
  function deleteActivePlate() {
    if (!activePlate || plates.length === 1) { setMessage("A project must keep at least one plate."); return; }
    if (activePlate.locked) { setMessage("Unlock the active plate before deleting it."); return; }
    rememberLayout(); const remaining = plates.filter((plate) => plate.id !== activePlateId); setPlates(remaining); setAllPlacements((current) => current.filter((placement) => placement.plateId !== activePlateId)); setActivePlateId(remaining[0].id); setSelectedPlacementId(null); setMessage(`${activePlate.name} removed. Its instances are now unassigned.`);
  }
  function removeEmptyPlates() {
    rememberLayout(); const used = new Set(allPlacements.map((placement) => placement.plateId)), remaining = plates.filter((plate, index) => index === 0 || plate.locked || used.has(plate.id));
    setPlates(remaining); if (!remaining.some((plate) => plate.id === activePlateId)) setActivePlateId(remaining[0].id); setMessage(`Removed ${plates.length - remaining.length} empty plate${plates.length - remaining.length === 1 ? "" : "s"}.`);
  }
  function togglePlateLock() { if (!activePlate) return; rememberLayout(); setPlates((current) => current.map((plate) => plate.id === activePlateId ? { ...plate, locked: !plate.locked } : plate)); setMessage(`${activePlate.name} ${activePlate.locked ? "unlocked" : "locked"}.`); }
  function renameActivePlate(name: string) { setPlates((current) => current.map((plate) => plate.id === activePlateId ? { ...plate, name: name.slice(0, 40) || plate.name } : plate)); }
  function updatePartRule(id: string, field: "priority" | "minQuantity", value: number) {
    rememberLayout();
    setParts((current) => current.map((part) => part.id === id ? { ...part, [field]: field === "priority" ? Math.max(1, Math.min(3, value)) : Math.max(0, Math.min(part.quantity, value)) } : part));
    setLayoutOptions([]); setMessage(field === "priority" ? "Part priority updated for the next nest." : "Minimum required quantity updated for the next nest.");
  }
  function applyLayoutOption(layout: LayoutOption) {
    rememberLayout(); setPlacements(layout.placed); setUnplacedCount(layout.unplaced.length); setMessage(`Applied ${layout.label}: ${layout.placed.length} placed, ${layout.utilization.toFixed(1)}% material utilization.`);
  }
  function stopNesting() { localTaskCancelRef.current = true; activeWorkersRef.current.forEach((worker) => worker.postMessage({ type: "cancel" })); setStopRequested(true); setWorkingLabel("Stopping after the current placement check…"); }
  function cancelCurrentTask() {
    setStopRequested(true);
    if (cancellableTask === "orientation") {
      setWorkingLabel("Cancelling automatic orientation…");
      autoOrientWorkerRef.current?.terminate();
      autoOrientRejectRef.current?.(new Error("cancelled"));
    } else {
      localTaskCancelRef.current = true;
      setWorkingLabel("Stopping instance placement…");
    }
  }
  function laySelectedFace(normal: [number, number, number]) {
    if (!orientingPart) return;
    const delta = quaternionFromUnitVectors(normalize3(vec3(...normal)), vec3(0, 0, -1));
    orientPart(orientingPart.id, multiplyQuaternion(delta, orientingPart.orientation), `Laid ${orientingPart.name} on the selected face.`);
  }
  function setEuler(axis: "x" | "y" | "z", value: number) {
    if (!orientingPart) return; const euler = eulerFromQuaternion(orientingPart.orientation); euler[axis] = value * Math.PI / 180;
    orientPart(orientingPart.id, quaternionFromEuler(euler.x, euler.y, euler.z), `Applied manual orientation to ${orientingPart.name}.`);
  }
  function currentEuler(axis: "x" | "y" | "z") { if (!orientingPart) return 0; return Math.round(eulerFromQuaternion(orientingPart.orientation)[axis] * 180 / Math.PI); }

  function rotateSelectedPlacement(delta: number) {
    if (!selectedPlacement) return; const part = parts.find((item) => item.id === selectedPlacement.partId); if (!part) return;
    if (selectedPlacement.locked || activePlate?.locked) { setMessage("Unlock the selected instance and plate before rotating it."); return; }
    rememberLayout(); const rotation = (selectedPlacement.rotation + delta + 360) % 360;
    setPlacements((current) => markCollisions(current.map((placement) => placement.id === selectedPlacement.id ? { ...placement, rotation, footprint: transformFootprint(part.footprint, rotation), nested: false } : placement), bedWidth, bedDepth, clearance));
    setLayoutOptions([]); setMessage(`Rotated ${part.name} instance ${selectedPlacement.copy} by ${delta > 0 ? "+" : ""}${delta}°.`);
  }
  function centerSelectedPlacement() {
    if (!selectedPlacement) return; if (selectedPlacement.locked || activePlate?.locked) { setMessage("Unlock the selected instance and plate before moving it."); return; } rememberLayout(); const b = bounds(selectedPlacement.footprint);
    setPlacements((current) => markCollisions(current.map((placement) => placement.id === selectedPlacement.id ? { ...placement, x: (bedWidth - b.maxX) / 2, y: (bedDepth - b.maxY) / 2, nested: false } : placement), bedWidth, bedDepth, clearance));
    setLayoutOptions([]); setMessage("Centered the selected instance on the build plate.");
  }
  function deleteSelectedPlacement() {
    if (!selectedPlacement) return; if (selectedPlacement.locked || activePlate?.locked) { setMessage("Unlock the selected instance and plate before deleting it."); return; } const part = parts.find((item) => item.id === selectedPlacement.partId); if (!part) return; rememberLayout();
    if (part.quantity <= 1) {
      setParts((current) => current.filter((item) => item.id !== part.id)); setAllPlacements((current) => current.filter((placement) => placement.partId !== part.id)); setSelectedPartId(null);
    } else {
      setParts((current) => current.map((item) => item.id === part.id ? { ...item, quantity: item.quantity - 1, minQuantity: Math.min(item.minQuantity, item.quantity - 1) } : item));
      setAllPlacements((current) => current.filter((placement) => placement.id !== selectedPlacement.id).map((placement) => placement.partId === part.id && placement.copy > selectedPlacement.copy ? { ...placement, copy: placement.copy - 1, id: `${part.id}-${placement.copy - 1}` } : placement));
    }
    setSelectedPlacementId(null); setUnplacedCount(0); setLayoutOptions([]); setMessage(`Removed one instance of ${part.name}.`);
  }
  function reduceQuantitiesToFitted() {
    rememberLayout(); let remaining = 0;
    setParts((current) => current.map((part) => { const fitted = allPlacements.filter((placement) => placement.partId === part.id).length; if (!fitted) { remaining++; return { ...part, quantity: 1, minQuantity: Math.min(part.minQuantity, 1) }; } return { ...part, quantity: fitted, minQuantity: Math.min(part.minQuantity, fitted) }; }));
    setUnplacedCount(remaining); setShowUnplaced(remaining > 0); setMessage(remaining ? `${remaining} part type still has no fitting instance.` : "Quantities reduced to the number of fitted instances.");
  }
  function tryHigherEffort() {
    const next: SearchPreset = searchPreset === "quick" ? "balanced" : "best";
    if (next === searchPreset) { setMessage("Best fit is already selected."); return; }
    applySearchPreset(next); window.setTimeout(() => runNest(parts, next === "best" ? "maximum" : "balanced"), 0);
  }

  function toggleSelectedLock() {
    if (!selectedPlacement) return; rememberLayout(); setAllPlacements((current) => current.map((placement) => placement.id === selectedPlacement.id ? { ...placement, locked: !placement.locked } : placement)); setMessage(`${selectedPlacement.locked ? "Unlocked" : "Locked"} the selected instance.`);
  }
  function moveSelectedToPlate(plateId: string) {
    if (!selectedPlacement || plateId === activePlateId) return; const target = plates.find((plate) => plate.id === plateId); if (!target || target.locked || selectedPlacement.locked || activePlate?.locked) { setMessage("Unlock the source, instance and destination plate before moving it."); return; }
    rememberLayout(); const b = bounds(selectedPlacement.footprint), moved = { ...selectedPlacement, plateId, x: Math.max(EDGE_MARGIN, Math.min(selectedPlacement.x, bedWidth - EDGE_MARGIN - b.maxX)), y: Math.max(EDGE_MARGIN, Math.min(selectedPlacement.y, bedDepth - EDGE_MARGIN - b.maxY)), nested: false };
    setAllPlacements((current) => markAllCollisions(current.map((placement) => placement.id === selectedPlacement.id ? moved : placement), plates, bedWidth, bedDepth, clearance)); setActivePlateId(plateId); setSelectedPlacementId(selectedPlacement.id); setMessage(`Moved the selected instance to ${target.name}.`);
  }
  function copySelectedToPlate(plateId: string) {
    if (!selectedPlacement) return; const part = parts.find((item) => item.id === selectedPlacement.partId), target = plates.find((plate) => plate.id === plateId); if (!part || !target || target.locked || part.quantity >= 500) { setMessage("The selected instance cannot be copied to that plate."); return; }
    rememberLayout(); const copy = part.quantity + 1, duplicate = { ...selectedPlacement, id: `${part.id}-${copy}`, copy, plateId, locked: false, nested: false } as ProjectPlacement;
    setParts((current) => current.map((item) => item.id === part.id ? { ...item, quantity: copy } : item)); setAllPlacements((current) => markAllCollisions([...current, duplicate], plates, bedWidth, bedDepth, clearance)); setActivePlateId(plateId); setSelectedPlacementId(duplicate.id); setMessage(`Copied the selected instance to ${target.name}.`);
  }

  function moveSelectedBatchToPlate(plateId: string, ids = selectedPlacementIds.length ? selectedPlacementIds : selectedPlacementId ? [selectedPlacementId] : []) {
    const target = plates.find((plate) => plate.id === plateId); if (!target || target.locked || !ids.length) { setMessage("Choose an unlocked destination plate first."); return; }
    const movable = new Set(ids.filter((id) => !allPlacements.find((placement) => placement.id === id)?.locked)); if (!movable.size) { setMessage("The selected instances are locked."); return; }
    rememberLayout();
    const moved = allPlacements.map((placement) => { if (!movable.has(placement.id)) return placement; const b = bounds(placement.footprint); return { ...placement, plateId, x: Math.max(EDGE_MARGIN, Math.min(placement.x, bedWidth - EDGE_MARGIN - b.maxX)), y: Math.max(EDGE_MARGIN, Math.min(placement.y, bedDepth - EDGE_MARGIN - b.maxY)), nested: false }; });
    setAllPlacements(markAllCollisions(moved, plates, bedWidth, bedDepth, clearance)); setActivePlateId(plateId); setSelectedPlacementIds([...movable]); setSelectedPlacementId([...movable][0] ?? null); setMessage(`Moved ${movable.size} selected instance${movable.size === 1 ? "" : "s"} to ${target.name}.`);
  }
  function stagePartOnPlate(partId: string, plateId: string) {
    const part = parts.find((item) => item.id === partId), target = plates.find((plate) => plate.id === plateId); if (!part || !target || target.locked) return;
    const used = new Set(allPlacements.filter((placement) => placement.partId === partId).map((placement) => placement.copy));
    const copy = Array.from({ length: part.quantity }, (_, index) => index + 1).find((number) => !used.has(number)); if (!copy) { setMessage(`Every requested ${part.name} instance is already placed.`); return; }
    const existing = allPlacements.filter((placement) => placement.plateId === plateId), b = bounds(part.footprint), partWidth = b.maxX - b.minX, partDepth = b.maxY - b.minY; let position: { x: number; y: number } | null = null;
    for (let y = EDGE_MARGIN; !position && y + partDepth <= bedDepth - EDGE_MARGIN; y += Math.max(2, clearance)) for (let x = EDGE_MARGIN; x + partWidth <= bedWidth - EDGE_MARGIN; x += Math.max(2, clearance)) if (!existing.some((placement) => footprintsOverlap(translateFootprint(part.footprint, x, y), translated(placement), clearance))) { position = { x, y }; break; }
    if (!position) { setMessage(`${part.name} remains unassigned because it does not fit safely on ${target.name}.`); return; }
    rememberLayout(); const placement: ProjectPlacement = { id: `${part.id}-${copy}`, partId: part.id, copy, x: position.x, y: position.y, rotation: 0, footprint: part.footprint, colliding: false, nested: false, plateId, locked: false };
    setAllPlacements((current) => markAllCollisions([...current, placement], plates, bedWidth, bedDepth, clearance)); setActivePlateId(plateId); setSelectedPlacementId(placement.id); setSelectedPlacementIds([placement.id]); setMessage(`Placed ${part.name} #${copy} on ${target.name}.`);
  }
  function dropOnPlate(plateId: string) {
    const payload = dragPayloadRef.current; dragPayloadRef.current = null; if (!payload) return;
    if (payload.type === "placements") moveSelectedBatchToPlate(plateId, payload.ids);
    else if (payload.partId) stagePartOnPlate(payload.partId, plateId);
  }
  function toggleBatchLock() {
    const ids = new Set(selectedPlacementIds); if (!ids.size) return; rememberLayout(); const shouldLock = selectedPlacementIds.some((id) => !allPlacements.find((placement) => placement.id === id)?.locked);
    setAllPlacements((current) => current.map((placement) => ids.has(placement.id) ? { ...placement, locked: shouldLock } : placement)); setMessage(`${shouldLock ? "Locked" : "Unlocked"} ${ids.size} selected instances.`);
  }
  function clearSelectedFromPlates() {
    const ids = new Set(selectedPlacementIds); if (!ids.size) return; rememberLayout(); setAllPlacements((current) => current.filter((placement) => !ids.has(placement.id) || placement.locked)); setSelectedPlacementIds([]); setSelectedPlacementId(null); setMessage(`${ids.size} selected instances moved to Unassigned.`);
  }

  function onPlatePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (!dragging || activePlate?.locked || selectedPlacement?.locked) return; const rect = event.currentTarget.getBoundingClientRect(), dx = (event.clientX - dragging.startX) / rect.width * bedWidth, dy = (event.clientY - dragging.startY) / rect.height * bedDepth;
    setPlacements((current) => markCollisions(current.map((p) => p.id === dragging.id ? { ...p, x: dragging.originX + dx, y: dragging.originY + dy } : p), bedWidth, bedDepth, clearance));
  }
  function exportPlan() {
    const printer = PRINTERS.find((p) => p.id === printerId);
    const data = { units: "mm", printer: printer ? `${printer.brand} ${printer.name}` : "Custom", bed: { width: bedWidth, depth: bedDepth, height: bedHeight, fixedEdgeSafety: EDGE_MARGIN }, clearance, nestingStart, outlinePrecision, objective, searchPreset, searchPipeline: "adaptive-rotation, parallel-passes, coarse-to-fine, persistent-geometry-cache, early-stop", finalVerification: "original outline", rotationEffort: autoRotate ? { level: rotationEffort, stepDegrees: ROTATION_EFFORTS[rotationEffort].step } : { level: "off", stepDegrees: 0 }, parts: parts.map((p) => ({ name: p.name, requestedQuantity: p.quantity, priority: p.priority, minimumQuantity: p.minQuantity, orientationQuaternion: p.orientation, orientedHeight: +p.height.toFixed(3) })), plates: plates.map((plate) => ({ ...plate, placements: allPlacements.filter((p) => p.plateId === plate.id).map((p) => ({ part: parts.find((part) => part.id === p.partId)?.name, copy: p.copy, x: +p.x.toFixed(3), y: +p.y.toFixed(3), rotation: p.rotation, locked: Boolean(p.locked), collision: p.colliding })) })) };
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); link.download = "printnest-layout.json"; link.click(); URL.revokeObjectURL(link.href);
  }
  function download3mf(target: SlicerTarget = preferredSlicer) {
    try {
      const exportPlates = plates.filter((plate) => allPlacements.some((placement) => placement.plateId === plate.id));
      const blob = target === "prusa" && exportPlates.length > 1 ? createPrusaPlateArchive(parts, allPlacements, exportPlates) : create3mf(parts, allPlacements, exportPlates, exportPlates.length > 1);
      const url = URL.createObjectURL(blob), download = document.createElement("a"); download.href = url; download.download = target === "prusa" && exportPlates.length > 1 ? "printnest-prusa-plates.zip" : "printnest-multiplate.3mf"; download.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 20_000);
      setMessage(target === "prusa" && exportPlates.length > 1 ? "Downloaded one Prusa-compatible 3MF per plate in a local ZIP." : `Downloaded ${exportPlates.length > 1 ? "a native multi-plate" : "the active"} 3MF project.`); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "The 3MF could not be prepared."); return false; }
  }
  const brands = [...new Set(PRINTERS.map((p) => p.brand))];
  return <main className="app-shell" aria-busy={isWorking}>
    <header className="topbar"><div className="brand"><span className="brand-mark">PN</span><span>PrintNest</span><span className="beta">BETA</span></div><div className="privacy-note"><span className={`status-dot ${saveStatus === "error" ? "storage-error" : ""}`} /> {saveStatus === "saving" ? "Saving project locally…" : saveStatus === "error" ? "Local save unavailable" : "Project saved on this device"}</div><div className="topbar-actions"><a className="button secondary source-download" href={withBasePath("/printnest-complete-source.zip")} download>Download source</a><button className="button secondary" onClick={undoLayout} disabled={!history.length || isWorking}>Undo</button><button className="button secondary" onClick={exportPlan} disabled={!allPlacements.length || isWorking}>Export project</button></div></header>
    <section className="workspace">
      <aside className="sidebar left-sidebar">
        <div className="panel-heading"><div><span className="eyebrow">INPUT</span><h1>Parts</h1></div><span className="count-badge">{parts.length}</span></div>
        <div className={`drop-zone ${isImporting ? "is-loading" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); if (!isWorking) importFiles(e.dataTransfer.files); }} onClick={() => !isWorking && fileInput.current?.click()}>
          <input ref={fileInput} type="file" accept=".stp,.step,.stl" multiple hidden disabled={isWorking} onChange={(e: ChangeEvent<HTMLInputElement>) => e.target.files && importFiles(e.target.files)} /><div className="upload-icon">＋</div><strong>{isImporting ? "Processing model…" : "Drop STEP or STL files"}</strong><span>or click to browse</span>
        </div>
        {!parts.length && <button className="text-button" disabled={isWorking} onClick={() => { rememberLayout(); setParts(demoParts); setAllPlacements(stageInstances(demoParts, [], activePlateId, bedWidth, bedDepth, clearance)); setMessage("Example parts loaded on the active plate with overflow kept unassigned."); }}>Load example parts</button>}
        <div className="part-list">{parts.map((part) => { const b = bounds(part.footprint), affected = showUnplaced && unplacedByPart.some((item) => item.part.id === part.id), placedTotal = allPlacements.filter((placement) => placement.partId === part.id).length, unassigned = Math.max(0, part.quantity - placedTotal); return <article className={`part-card ${selectedPartId === part.id ? "selected" : ""} ${affected ? "has-unplaced" : ""}`} key={part.id} onClick={() => { setSelectedPartId(part.id); setSelectedPlacementId(null); setSelectedPlacementIds([]); }}>
          <span className="part-swatch" style={{ background: part.color }} /><button className="part-copy" onClick={() => { setSelectedPartId(part.id); setSelectedPlacementId(null); }}><strong title={part.name}>{part.name}</strong><span>{b.maxX.toFixed(1)} × {b.maxY.toFixed(1)} × {part.height.toFixed(1)} mm</span></button>
          <div className="quantity-stepper" aria-label={`Quantity controls for ${part.name}`}><button aria-label={`Decrease quantity for ${part.name}`} disabled={isWorking || part.quantity <= 1} onClick={() => changeQuantity(part.id, part.quantity - 1)}>−</button><input aria-label={`Quantity for ${part.name}`} type="number" min="1" max="500" value={part.quantity} disabled={isWorking} onChange={(e) => changeQuantity(part.id, Number(e.target.value))} /><button aria-label={`Increase quantity for ${part.name}`} disabled={isWorking || part.quantity >= 500} onClick={() => changeQuantity(part.id, part.quantity + 1)}>＋</button></div>
          <div className="part-placement-summary"><span>{placedTotal} placed</span><span>{unassigned} unassigned</span>{unassigned > 0 && <button type="button" className="part-drag-handle" draggable onDragStart={(event) => { event.stopPropagation(); dragPayloadRef.current = { type: "part", partId: part.id }; }} onClick={(event) => event.stopPropagation()} aria-label={`Drag an unassigned ${part.name} to a plate`} title="Drag an unassigned copy to a plate">⠿</button>}</div>
          <div className="part-actions"><button className="fill-action" aria-label={`Fill plate with ${part.name}`} title="Use the selected Fill mode" disabled={isWorking} onClick={() => fillPlate(part.id)}>Fill</button>{part.meshes.length > 0 && <button aria-label={`Orient ${part.name}`} title="Preview and change the 3D print orientation" disabled={isWorking} onClick={() => openOrientation(part.id)}>Orient</button>}<button aria-label={`Remove ${part.name}`} title="Remove this part and all its instances from every plate" disabled={isWorking} onClick={() => { rememberLayout(); setParts((current) => current.filter((p) => p.id !== part.id)); setAllPlacements((current) => current.filter((p) => p.partId !== part.id)); if (orientingId === part.id) closeOrientation(); if (selectedPartId === part.id) setSelectedPartId(null); }}>Remove</button></div>
          <details className="part-advanced" onClick={(event) => event.stopPropagation()}><summary aria-label={`Advanced planning for ${part.name}`}>Advanced planning <span aria-hidden="true">＋</span></summary><div className="part-rules"><label><span>PRIORITY</span><select aria-label={`Priority for ${part.name}`} value={part.priority} disabled={isWorking} onChange={(event) => updatePartRule(part.id, "priority", Number(event.target.value))}><option value="1">Standard</option><option value="2">High</option><option value="3">Critical</option></select></label><label><span>MINIMUM</span><input aria-label={`Minimum quantity for ${part.name}`} type="number" min="0" max={part.quantity} value={part.minQuantity} disabled={isWorking} onChange={(event) => updatePartRule(part.id, "minQuantity", Number(event.target.value))} /></label></div><p>Priority controls which parts are placed first. Minimum reserves the requested number before optional copies.</p></details>
        </article>; })}</div>
      </aside>

      <section className="plate-stage">
        <nav className="plate-tabs" aria-label="Project plates">{plates.map((plate, index) => { const platePlacements = allPlacements.filter((placement) => placement.plateId === plate.id), plateUtilization = platePlacements.reduce((sum, placement) => sum + footprintArea(placement.footprint), 0) / Math.max(1, bedWidth * bedDepth) * 100; return <button key={plate.id} className={plate.id === activePlateId ? "active" : ""} onDragOver={(event) => { if (!plate.locked) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); dropOnPlate(plate.id); }} onClick={() => { setActivePlateId(plate.id); setSelectedPlacementId(null); setSelectedPlacementIds([]); setLayoutOptions([]); }}><svg viewBox={`0 0 ${bedWidth} ${bedDepth}`} aria-hidden="true"><rect width={bedWidth} height={bedDepth} />{platePlacements.map((placement) => <path key={placement.id} d={footprintPath(translated(placement))} />)}</svg><span><b>{plate.locked ? "🔒 " : ""}{plate.name}</b><small>{platePlacements.length} parts · {plateUtilization.toFixed(0)}%</small></span><em>{index + 1}</em></button>; })}<button className="add-plate-tab" aria-label="Add plate" onClick={() => addPlate()}>＋</button></nav>
        <div className="plate-admin"><input aria-label="Active plate name" value={activePlate?.name ?? ""} disabled={isWorking} onChange={(event) => renameActivePlate(event.target.value)} /><button onClick={togglePlateLock}>{activePlate?.locked ? "Unlock plate" : "Lock plate"}</button><button onClick={duplicateActivePlate}>Duplicate</button><button onClick={clearActivePlate}>Clear</button><button onClick={deleteActivePlate} disabled={plates.length === 1}>Delete</button></div>
        <div className="stage-toolbar"><div><span className="eyebrow">BUILD PLATE · 2 MM EDGE SAFETY</span><strong>{bedWidth} × {bedDepth} × {bedHeight} mm</strong></div>{selectedPlacement ? <div className="placement-tools" aria-label="Selected instance controls"><span>{selectedPlacementIds.length > 1 ? `${selectedPlacementIds.length} instances selected` : `${parts.find((part) => part.id === selectedPlacement.partId)?.name} #${selectedPlacement.copy}`}</span>{selectedPlacementIds.length > 1 ? <><button onClick={toggleBatchLock}>Lock / unlock</button><button draggable onDragStart={() => { dragPayloadRef.current = { type: "placements", ids: selectedPlacementIds }; }}>Drag to plate</button><select aria-label="Move selected instances to plate" value="" onChange={(event) => moveSelectedBatchToPlate(event.target.value)}><option value="">Move to…</option>{plates.filter((plate) => plate.id !== activePlateId).map((plate) => <option key={plate.id} value={plate.id}>{plate.name}</option>)}</select><button className="delete" onClick={clearSelectedFromPlates}>Unassign</button></> : <><button onClick={toggleSelectedLock}>{selectedPlacement.locked ? "Unlock" : "Lock"}</button><button draggable onDragStart={() => { dragPayloadRef.current = { type: "placements", ids: [selectedPlacement.id] }; }}>Drag to plate</button><select aria-label="Manual rotation step" value={manualRotationStep} onChange={(event) => setManualRotationStep(Number(event.target.value))}><option value="5">5°</option><option value="15">15°</option><option value="45">45°</option></select><button aria-label="Rotate selected instance left" onClick={() => rotateSelectedPlacement(-manualRotationStep)}>↶</button><button aria-label="Rotate selected instance right" onClick={() => rotateSelectedPlacement(manualRotationStep)}>↷</button><button onClick={centerSelectedPlacement}>Centre</button><select aria-label="Move selected instance to plate" value="" onChange={(event) => moveSelectedToPlate(event.target.value)}><option value="">Move to…</option>{plates.filter((plate) => plate.id !== activePlateId).map((plate) => <option key={plate.id} value={plate.id}>{plate.name}</option>)}</select><select aria-label="Copy selected instance to plate" value="" onChange={(event) => copySelectedToPlate(event.target.value)}><option value="">Copy to…</option>{plates.map((plate) => <option key={plate.id} value={plate.id}>{plate.name}</option>)}</select><button className="delete" onClick={deleteSelectedPlacement}>Delete</button></>}</div> : <div className="legend"><span><i className="legend-dot placed" />Placed</span><span><i className="legend-dot collision" />Collision</span><span><i className="legend-border" />2 mm edge</span></div>}</div>
        <div className="plate-wrap"><div className="plate-frame" style={{ aspectRatio: `${bedWidth}/${bedDepth}` }}><div className="dimension top"><span>{bedWidth} mm</span></div><div className="dimension side"><span>{bedDepth} mm</span></div>
          <svg className={`build-plate ${activePlate?.locked ? "is-locked" : ""}`} viewBox={`0 0 ${bedWidth} ${bedDepth}`} style={{ aspectRatio: `${bedWidth}/${bedDepth}` }} onPointerMove={onPlatePointerMove} onPointerUp={() => setDragging(null)} onPointerLeave={() => setDragging(null)} aria-label="Top-down build plate nesting preview">
            <defs><pattern id="minorGrid" width={GRID} height={GRID} patternUnits="userSpaceOnUse"><path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} fill="none" stroke="#dfe3e0" strokeWidth="0.45" /></pattern><pattern id="majorGrid" width={GRID * 5} height={GRID * 5} patternUnits="userSpaceOnUse"><rect width={GRID * 5} height={GRID * 5} fill="url(#minorGrid)" /><path d={`M ${GRID * 5} 0 L 0 0 0 ${GRID * 5}`} fill="none" stroke="#c6ccc8" strokeWidth="0.75" /></pattern></defs><rect width={bedWidth} height={bedDepth} fill="url(#majorGrid)" />
            <rect className="edge-safety" x={EDGE_MARGIN} y={EDGE_MARGIN} width={Math.max(0, bedWidth - EDGE_MARGIN * 2)} height={Math.max(0, bedDepth - EDGE_MARGIN * 2)} />
            {placements.map((placement) => { const part = parts.find((p) => p.id === placement.partId)!, footprint = translated(placement), b = bounds(footprint), selected = selectedPlacementIds.includes(placement.id) || selectedPlacementId === placement.id || (!selectedPlacementId && !selectedPlacementIds.length && selectedPartId === placement.partId); return <g key={placement.id} className={`plate-part ${placement.nested ? "is-nested" : "is-staged"} ${placement.locked ? "is-locked" : ""} ${selected ? "is-selected" : ""}`} onPointerDown={(event) => { const nextIds = event.shiftKey ? (selectedPlacementIds.includes(placement.id) ? selectedPlacementIds.filter((id) => id !== placement.id) : [...selectedPlacementIds, placement.id]) : selectedPlacementIds.includes(placement.id) ? selectedPlacementIds : [placement.id]; setSelectedPlacementIds(nextIds); setSelectedPartId(placement.partId); setSelectedPlacementId(nextIds[0] ?? placement.id); if (event.shiftKey || placement.locked || activePlate?.locked) return; rememberLayout(); event.currentTarget.setPointerCapture(event.pointerId); setDragging({ id: placement.id, startX: event.clientX, startY: event.clientY, originX: placement.x, originY: placement.y }); }}><path d={footprintPath(footprint)} fillRule="evenodd" fill={placement.colliding ? "#ed3d4d" : part.color} fillOpacity={placement.nested ? "0.86" : "0.62"} stroke={selected ? "#ff681f" : placement.colliding ? "#9f1524" : placement.locked ? "#142019" : "#132019"} strokeDasharray={placement.nested ? undefined : `${4 / scale} ${3 / scale}`} strokeWidth={(selected ? 3 : placement.locked ? 2 : 1) / scale} vectorEffect="non-scaling-stroke" /><text x={(b.minX + b.maxX) / 2} y={(b.minY + b.maxY) / 2} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(4, 11 / scale)}>{placement.locked ? "🔒" : placement.copy}</text></g>; })}
            {!placements.length && <text x={bedWidth / 2} y={bedDepth / 2} textAnchor="middle" className="empty-plate-text">{unplacedCount ? "Choose Nest current to place unassigned parts" : "Drop a STEP or STL file to begin"}</text>}
          </svg>
        </div></div><div className={`status-strip ${collisionCount ? "has-error" : ""}`}><span>{message}</span><span>{collisionCount ? `${collisionCount} collision${collisionCount === 1 ? "" : "s"}` : placements.length ? "No collisions" : "Waiting for parts"}</span></div>
      </section>

      <aside className="sidebar controls-sidebar">
        <div className="panel-heading"><div><span className="eyebrow">SETUP</span><h2>Nesting</h2></div></div>
        <details className="workflow-help"><summary>How to use PrintNest <span>＋</span></summary><ol><li>Import STEP or STL files. They stage on the active plate; overflow remains unassigned.</li><li>Orient models, select the printer, and manage plates from the tabs above the build area.</li><li>Lock completed plates or exact placements before further nesting.</li><li>Use <b>Nest current</b>, <b>Nest all</b>, production sets, or consolidation as needed.</li><li>OrcaSlicer and Bambu Studio receive one native multi-plate 3MF. Prusa receives numbered plate files in a ZIP.</li></ol><p>Everything stays local. Every operation enforces the fixed 2 mm bed-edge safety boundary.</p></details>
        <div className="mode-switch" role="group" aria-label="Interface detail"><button className={uiMode === "simple" ? "active" : ""} onClick={() => setUiMode("simple")}>Simple</button><button className={uiMode === "advanced" ? "active" : ""} onClick={() => setUiMode("advanced")}>Advanced</button></div>
        <div className="control-group"><div className="label-with-help"><label htmlFor="printer">Printer profile</label><HelpTip label="printer profile">Sets the nominal width, depth and height automatically. Choosing or editing a dimension switches to a custom build volume.</HelpTip></div><select id="printer" className="printer-select" value={printerId} onChange={(e) => applyPrinter(e.target.value)}><option value="custom">Custom build volume</option>{brands.map((brand) => <optgroup key={brand} label={brand}>{PRINTERS.filter((p) => p.brand === brand).map((p) => <option key={p.id} value={p.id}>{p.name} — {p.width}×{p.depth}×{p.height}</option>)}</optgroup>)}</select><p className="field-note">Nominal build volume; slicer exclusion zones may reduce usable area.</p></div>
        {uiMode === "advanced" && <div className="control-group"><div className="label-with-help"><label>Build volume</label><HelpTip label="build volume">W and D are the nominal machine dimensions. PrintNest reserves 2 mm on every edge, reducing usable width and depth by 4 mm. H rejects over-height parts.</HelpTip></div><div className="three-inputs"><span><small>W</small><input aria-label="Build width" type="number" value={bedWidth} onChange={(e) => setCustomBed("width", Number(e.target.value))} /></span><span><small>D</small><input aria-label="Build depth" type="number" value={bedDepth} onChange={(e) => setCustomBed("depth", Number(e.target.value))} /></span><span><small>H</small><input aria-label="Build height" type="number" value={bedHeight} onChange={(e) => setCustomBed("height", Number(e.target.value))} /></span></div><p className="field-note">Usable nesting area: {bedWidth - EDGE_MARGIN * 2} × {bedDepth - EDGE_MARGIN * 2} mm after the fixed edge safety.</p></div>}
        <div className="control-group"><div className="label-with-help"><label htmlFor="clearance">Part clearance</label><HelpTip label="part clearance">Minimum edge-to-edge gap between models. This is separate from the fixed 2 mm plate-edge safety.</HelpTip></div><div className="range-row"><input id="clearance" type="range" min="0" max="15" step="0.5" value={clearance} onChange={(e) => { const value = Number(e.target.value); setClearance(value); setAllPlacements((current) => markAllCollisions(current, plates, bedWidth, bedDepth, value)); }} /><output>{clearance.toFixed(1)} mm</output></div></div>
        <div className="control-group search-presets"><div className="label-with-help"><label>Search quality</label><HelpTip label="search quality">Every repeated shape is evaluated as a compact two-part motif. The motif may interlock or sit side-by-side, whichever leaves the smaller legal envelope. Higher quality checks more rotations and motif candidates.</HelpTip></div><div>{(["quick", "balanced", "best"] as SearchPreset[]).map((preset) => <button key={preset} className={searchPreset === preset ? "active" : ""} onClick={() => applySearchPreset(preset)}>{preset === "best" ? "Best fit" : preset[0].toUpperCase() + preset.slice(1)}</button>)}</div><p className="field-note">Estimated search time: {estimateLabel}. Parallel passes use available processor cores.</p></div>
        {uiMode === "advanced" && <><div className="control-group"><div className="label-with-help"><label htmlFor="outline-precision">Outline precision</label><HelpTip label="outline precision">Changes only the simplified outline used while searching. Every accepted position is checked again with the full original outline.</HelpTip></div><select id="outline-precision" className="printer-select" value={outlinePrecision} disabled={isWorking} onChange={(event) => setOutlinePrecision(event.target.value as OutlinePrecision)}><option value="precise">Precise — 0.05 mm</option><option value="standard">Standard — 0.20 mm</option><option value="fast">Fast — 0.50 mm</option></select><p className="field-note">Controls the search outline only. Every placement is verified against the original detailed outline.</p></div>
        <div className="control-group"><div className="label-with-help"><label htmlFor="nesting-start">Nesting start</label><HelpTip label="nesting start">Corner builds compact rows from the upper-left. Center-out grows a cluster radially around the plate centre.</HelpTip></div><select id="nesting-start" className="printer-select" value={nestingStart} disabled={isWorking} onChange={(event) => setNestingStart(event.target.value as NestingStart)}><option value="corner">Corner — upper-left rows</option><option value="center">Center-out — circular expansion</option></select><p className="field-note">Choose whether the packed cluster grows from a corner or radially from the plate centre.</p></div>
        <div className="control-group"><div className="label-with-help"><label htmlFor="optimization-objective">Optimize for</label><HelpTip label="optimization objective">Ranks the generated layouts. Best envelope utilization maximizes real part area inside the smallest bounding box around the complete nest.</HelpTip></div><select id="optimization-objective" className="printer-select" value={objective} disabled={isWorking} onChange={(event) => setObjective(event.target.value as OptimizationObjective)}><option value="balanced">Balanced result</option><option value="quantity">Most parts</option><option value="compact">Best envelope utilization</option><option value="travel">Shortest travel path</option><option value="grouped">Keep matching parts together</option></select><p className="field-note">Minimum quantities and higher-priority parts are always considered first.</p></div>
        <div className="control-group switch-row"><div><div className="label-with-help"><label htmlFor="rotation">Automatic XY rotation</label><HelpTip label="automatic XY rotation">Rotates the already-oriented part around the vertical Z axis. It does not change which 3D face rests on the plate.</HelpTip></div><p>Tests the selected angle step after part orientation.</p></div><button id="rotation" role="switch" aria-checked={autoRotate} className={`switch ${autoRotate ? "on" : ""}`} onClick={() => setAutoRotate((value) => !value)}><span /></button></div>
        <div className="control-group"><div className="label-with-help"><label htmlFor="rotation-effort">Rotation effort</label><HelpTip label="rotation effort">Fast tests 4 directions; Maximum tests 72. More angles can improve nesting but multiply the number of candidate checks.</HelpTip></div><select id="rotation-effort" className="printer-select" value={rotationEffort} disabled={!autoRotate || isWorking} onChange={(event) => setRotationEffort(event.target.value as RotationEffort)}>{(Object.entries(ROTATION_EFFORTS) as [RotationEffort, typeof ROTATION_EFFORTS[RotationEffort]][]).map(([id, option]) => <option key={id} value={id}>{option.label} — every {option.step}° ({option.orientations} angles)</option>)}</select><p className="field-note">Smaller angle steps can find tighter layouts, but take longer.</p></div>
        <section className="multi-plate-controls" aria-label="Multi-plate controls"><div className="label-with-help"><div><strong>Multi-plate planning</strong><span>{plates.length} plate{plates.length === 1 ? "" : "s"} · {unplacedCount} unassigned</span></div><HelpTip label="multi-plate planning">Nest current leaves other plates untouched. Nest all redistributes unlocked items. Add plates may create more plates up to the chosen limit. Consolidate minimizes used plates.</HelpTip></div><div className="batch-options"><label><span>MAX PLATES</span><input aria-label="Maximum plates" type="number" min="1" max="50" value={maxPlates} onChange={(event) => setMaxPlates(Math.max(1, Math.min(50, Number(event.target.value))))} /></label><label><span>COMPLETE SETS</span><input aria-label="Complete production sets" type="number" min="1" max="500" value={batchSets} onChange={(event) => setBatchSets(Math.max(1, Math.min(500, Number(event.target.value))))} /></label></div><label className="check-option"><input type="checkbox" checked={keepSetsTogether} onChange={(event) => setKeepSetsTogether(event.target.checked)} /> Prioritize one of every part per plate</label><div className="plate-action-grid"><button onClick={() => runNest()} disabled={!parts.length || isWorking || activePlate?.locked}>Nest current</button><button onClick={() => distributeAcrossPlates(parts, false, false)} disabled={!parts.length || isWorking}>Nest all</button><button onClick={() => distributeAcrossPlates(parts, true, false)} disabled={!parts.length || isWorking}>Nest all + add plates</button><button onClick={() => distributeAcrossPlates(parts, false, true)} disabled={!parts.length || isWorking}>Consolidate</button><button onClick={() => { const batch = parts.map((part) => ({ ...part, quantity: batchSets, minQuantity: keepSetsTogether ? Math.min(1, batchSets) : Math.min(part.minQuantity, batchSets) })); setParts(batch); distributeAcrossPlates(batch, true, false); }} disabled={!parts.length || isWorking}>Make {batchSets} complete set{batchSets === 1 ? "" : "s"}</button><button onClick={removeEmptyPlates} disabled={plates.length === 1 || isWorking}>Remove empty plates</button></div></section></>}
        <div className="control-group"><div className="label-with-help"><label htmlFor="fill-mode">Fill behaviour</label><HelpTip label="fill behaviour">Remaining space never moves existing items. Repack may move unlocked items. Existing plates fills all current plates. Production batch creates the selected copy target across plates.</HelpTip></div><select id="fill-mode" className="printer-select" value={fillMode} onChange={(event) => setFillMode(event.target.value as typeof fillMode)}><option value="remaining">Fill active plate — keep existing positions</option><option value="repack">Repack active plate for maximum copies</option><option value="existing">Fill all existing plates</option><option value="batch">Production batch — use Complete sets target</option></select></div>
        <button className="button orient-button" disabled={isWorking || !parts.some((p) => p.meshes.length)} onClick={() => openOrientation((selectedPartId && parts.find((part) => part.id === selectedPartId)?.meshes.length ? selectedPartId : parts.find((p) => p.meshes.length)?.id) ?? "")}>Orient {selectedPartId && parts.find((part) => part.id === selectedPartId)?.meshes.length ? "selected part" : "3D parts"}</button>
        <div className="primary-nest"><select aria-label="Nest project action" value={primaryNestAction} onChange={(event) => setPrimaryNestAction(event.target.value as typeof primaryNestAction)}><option value="smart">Smart — choose automatically</option><option value="current">Current plate only</option><option value="all">All existing plates</option><option value="add">All plates + add overflow</option></select><button className="button primary nest-button" disabled={!parts.length || isImporting || isWorking || (primaryNestAction === "current" && activePlate?.locked)} onClick={runPrimaryNest}><span>Nest project</span><b>→</b></button></div>
        {layoutOptions.length > 0 && <section className="layout-options" aria-label="Layout alternatives"><div className="layout-options-heading"><strong>Compare layouts</strong><span>{layoutOptions.length} found</span></div>{layoutOptions.map((layout, index) => <button key={layout.id} className={index === 0 ? "best" : ""} onClick={() => applyLayoutOption(layout)} disabled={isWorking}><span><b>{index === 0 ? "Best match" : layout.label}</b><small>{layout.placed.length} placed · {layout.unplaced.length} unplaced · {layout.envelopeUtilization.toFixed(0)}% envelope</small></span><em>{layout.utilization.toFixed(1)}%</em></button>)}</section>}
        <section className="slicer-handoff" aria-label="Export slicer project"><div className="label-with-help"><div><strong>Export slicer project</strong><span>{preferredSlicer === "prusa" && plates.length > 1 ? "Prusa receives one verified 3MF per plate in a ZIP." : "Orca and Bambu receive one verified native multi-plate 3MF."}</span></div><HelpTip label="local slicer export">The export is assembled and structurally validated in this browser before download. It contains the oriented triangle meshes, XY placements, plate names and object-to-plate assignments. Nothing is uploaded.</HelpTip></div><select aria-label="Target slicer" value={preferredSlicer} onChange={(event) => setPreferredSlicer(event.target.value as SlicerTarget)}><option value="orca">OrcaSlicer</option><option value="bambu">Bambu Studio</option><option value="prusa">PrusaSlicer</option></select><button className="button primary slicer-download" disabled={!allPlacements.length || isWorking} onClick={() => download3mf(preferredSlicer)}>{preferredSlicer === "prusa" && plates.length > 1 ? "Export verified plate ZIP" : "Export verified multi-plate 3MF"}</button><p>No desktop app is launched. Open the downloaded project in your slicer.</p></section>
        <section className={`result-summary ${unplacedCount ? "has-unassigned" : "complete"}`} aria-label="Project result summary"><strong>{allPlacements.length}/{requestedCount} placed across {usedPlateCount} plate{usedPlateCount === 1 ? "" : "s"}</strong><span>{unplacedCount} unassigned · {averageUtilization.toFixed(1)}% average utilization</span>{unplacedCount > 0 && <button onClick={() => distributeAcrossPlates(parts, true, false)}>Place remaining parts</button>}</section><div className="metrics"><div><span>ACTIVE PLATE</span><strong>{placements.length}</strong></div><div><span>UNASSIGNED</span><strong className={unplacedCount ? "warning" : ""}>{unplacedCount}</strong></div><div><span>UTILIZATION</span><strong>{utilization.toFixed(1)}%</strong></div><div><span>COLLISIONS</span><strong className={totalCollisionCount ? "danger" : ""}>{totalCollisionCount}</strong></div></div>
        {unplacedCount > 0 && <section className="unplaced-help" aria-label="Unassigned part actions"><strong>{unplacedCount} requested instance{unplacedCount === 1 ? "" : "s"} are unassigned</strong><ul>{unplacedByPart.map(({ part, count }) => <li key={part.id}><span>{part.name}</span><b>{count}</b></li>)}</ul><div><button onClick={() => { setShowUnplaced((value) => !value); setSelectedPlacementId(null); setSelectedPartId(unplacedByPart[0]?.part.id ?? null); }}>{showUnplaced ? "Clear highlight" : "Highlight affected"}</button><button onClick={() => distributeAcrossPlates(parts, false, false)}>Distribute to existing plates</button><button onClick={() => distributeAcrossPlates(parts, true, false)}>Add plates for overflow</button><button onClick={reduceQuantitiesToFitted}>Use fitted quantities</button><button onClick={tryHigherEffort} disabled={searchPreset === "best"}>Try higher effort</button></div></section>}
        <div className="tip"><strong>Repeated-shape motif nesting</strong><p>Every repeated outline is tested as a two-part motif. Crescent, convex, holed and deeply concave parts may interlock or remain side-by-side depending on which verified arrangement packs better. The motif is applied repeatedly across the plate.</p></div>
      </aside>
    </section>

    {orientingPart && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="orientation-title"><section className="orientation-modal">
      <header><div><span className="eyebrow">PART ORIENTATION · PREVIEW</span><h2 id="orientation-title">{orientingPart.name}</h2></div><button className="modal-close" aria-label="Cancel orientation" onClick={closeOrientation}>×</button></header>
      <div className="orientation-body"><div className="viewer-panel"><OrientationViewer meshes={orientingPart.meshes} orientation={orientingPart.orientation} onFaceSelected={laySelectedFace} /><div className="viewer-hint"><span>1</span> Click a flat face to place it on the bed · drag to orbit · scroll to zoom</div></div>
        <aside className="orientation-controls"><span className="eyebrow">ORCA-STYLE WORKFLOW</span><h3>Choose the print face</h3><p>Click any flat model face, compare recommended print orientations, or make exact rotations. The automatic search runs in the background and balances bed contact, overhangs, low-angle faces, and height.</p>
          <button className="button primary auto-orient" disabled={isWorking} onClick={autoOrientCurrent}>Recommended: auto orient</button>
          <div className="manual-rotation"><label>Exact rotation</label><div className="rotation-inputs">{(["x", "y", "z"] as const).map((axis) => <span key={axis}><small>{axis.toUpperCase()}</small><input aria-label={`${axis.toUpperCase()} rotation`} type="number" step="1" value={currentEuler(axis)} disabled={isWorking} onChange={(e) => setEuler(axis, Number(e.target.value))} /><i>°</i></span>)}</div><div className="orientation-presets six"><button disabled={isWorking} onClick={() => setEuler("x", currentEuler("x") - 90)}>X −90°</button><button disabled={isWorking} onClick={() => setEuler("x", currentEuler("x") + 90)}>X +90°</button><button disabled={isWorking} onClick={() => setEuler("y", currentEuler("y") - 90)}>Y −90°</button><button disabled={isWorking} onClick={() => setEuler("y", currentEuler("y") + 90)}>Y +90°</button><button disabled={isWorking} onClick={() => setEuler("z", currentEuler("z") - 90)}>Z −90°</button><button disabled={isWorking} onClick={() => setEuler("z", currentEuler("z") + 90)}>Z +90°</button></div><button className="orientation-reset" disabled={isWorking} onClick={() => orientPart(orientingPart.id, IDENTITY, `Reset ${orientingPart.name} orientation preview.`)}>Reset to imported orientation</button></div>
          <dl className="oriented-size"><div><dt>Footprint</dt><dd>{bounds(orientingPart.footprint).maxX.toFixed(1)} × {bounds(orientingPart.footprint).maxY.toFixed(1)} mm</dd></div><div><dt>Height</dt><dd className={orientingPart.height > bedHeight ? "danger" : ""}>{orientingPart.height.toFixed(1)} / {bedHeight} mm</dd></div></dl>
          <a className="orca-credit" href="https://github.com/OrcaSlicer/OrcaSlicer/wiki/prepare_object_manipulation#lay-on-face" target="_blank" rel="noreferrer">Face-alignment behavior follows OrcaSlicer’s Lay on Face workflow ↗</a>
        </aside></div>
      <footer><span>Apply updates every instance of this part. Cancel keeps the current plate unchanged.</span><div><button className="button cancel-orientation" onClick={closeOrientation}>Cancel</button><button className="button primary" onClick={applyOrientation}>Apply orientation</button></div></footer>
    </section></div>}
    {workingLabel && <div className={`working-overlay ${nestingMode ? "is-nesting" : ""}`} role="status" aria-live="assertive" aria-label={workingLabel}><div className="working-card"><div className="working-spinner" aria-hidden="true"><span /><span /><span /></div><strong>{workingLabel}</strong>{nestingMode ? <><p>Pass {nestProgress.attempt} of {nestProgress.attempts} · {nestProgress.placed} placed · {nestProgress.processed} of {nestProgress.total} parts · {nestProgress.candidateChecks.toLocaleString()} positions tested</p><div className="working-progress determinate" aria-hidden="true"><span style={{ width: `${((nestProgress.attempt - 1) + (nestProgress.total ? nestProgress.processed / nestProgress.total : 0)) / nestProgress.attempts * 100}%` }} /></div><button type="button" className="working-stop" disabled={stopRequested} onClick={stopNesting}>{stopRequested ? "Stopping…" : nestingMode === "fill" ? "Stop filling" : "Stop nesting"}</button></> : <><p>Complex models and dense plates can take a moment.</p><div className="working-progress" aria-hidden="true"><span /></div>{cancellableTask && <button type="button" className="working-stop" disabled={stopRequested} onClick={cancelCurrentTask}>{stopRequested ? "Cancelling…" : cancellableTask === "orientation" ? "Cancel orientation" : "Stop adding instances"}</button>}</>}</div></div>}
  </main>;
}
