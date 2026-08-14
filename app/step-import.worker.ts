import { autoTessellation, estimateStepSize, importStep } from "meshstep";

// PrintNest needs a dependable planning mesh, not a presentation-quality CAD mesh.
// meshStep's defaults target a 0.01 mm chord tolerance on a 100 mm part, which
// is unnecessarily dense for footprinting and can make an assembly unwieldy.
function planningTessellation(diagonal: number | undefined) {
  const automatic = diagonal ? autoTessellation(diagonal) : { surfaceDeviation: 0.01, maxEdge: 1 };
  return {
    surfaceDeviation: Math.min(0.5, Math.max(0.02, automatic.surfaceDeviation * 5)),
    maxEdge: Math.min(8, Math.max(0.5, automatic.maxEdge * 2.5)),
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
