import { autoTessellation, estimateStepSize, importStep } from "meshstep";

// PrintNest needs a dependable planning mesh, not a presentation-quality CAD mesh.
// Keep the chord tolerance close enough to preserve the printed silhouette, while
// allowing substantially larger interior triangles on planar and gentle surfaces.
function planningTessellation(diagonal: number | undefined) {
  const automatic = diagonal ? autoTessellation(diagonal) : { surfaceDeviation: 0.01, maxEdge: 1 };
  return {
    surfaceDeviation: Math.min(0.08, Math.max(0.01, automatic.surfaceDeviation * 2)),
    maxEdge: Math.min(12, Math.max(1, automatic.maxEdge * 4)),
    normalDeviation: 20,
  };
}

self.onmessage = ({ data }: MessageEvent<{ text: string }>) => {
  try {
    const estimate = estimateStepSize(data.text);
    const result = importStep(data.text, { ...planningTessellation(estimate?.diag), vertexNormals: true });
    const { positions, indices } = result.mesh;
    if (!positions.length || !indices.length) throw new Error("The file contains no printable STEP mesh.");
    self.postMessage({ ok: true, positions, indices, diagnostics: result.diagnostics, triangleCount: indices.length / 3 }, [positions.buffer, indices.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "STEP import failed." });
  }
};
