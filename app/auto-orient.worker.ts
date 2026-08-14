/// <reference lib="webworker" />
import { findAutoOrientation } from "./auto-orient";
import { silhouetteFromMeshes } from "./footprint";
import { rotateVector, vec3 } from "./geometry3d";
import type { ModelMesh } from "./orientation-viewer";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<{ meshes: ModelMesh[] }>) => {
  try {
    const result = findAutoOrientation(event.data.meshes);
    let minZ = Infinity, maxZ = -Infinity;
    for (const mesh of event.data.meshes) for (let index = 0; index < mesh.positions.length; index += 3) {
      const point = rotateVector(vec3(mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2]), result.orientation);
      minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
    }
    const footprint = silhouetteFromMeshes(event.data.meshes, result.orientation);
    self.postMessage({ type: "result", result: { ...result, footprint, height: maxZ - minZ } });
  }
  catch (error) { self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Automatic orientation failed." }); }
};
