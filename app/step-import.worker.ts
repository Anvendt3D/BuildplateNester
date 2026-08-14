import { autoTessellation, estimateStepSize, importStep } from "meshstep";

self.onmessage = ({ data }: MessageEvent<{ text: string }>) => {
  try {
    const estimate = estimateStepSize(data.text);
    const result = importStep(data.text, {
      ...(estimate ? autoTessellation(estimate.diag) : {}),
      vertexNormals: true,
    });
    const { positions, indices } = result.mesh;
    if (!positions.length || !indices.length) throw new Error("The file contains no printable STEP mesh.");
    self.postMessage({ ok: true, positions, indices }, [positions.buffer, indices.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, message: error instanceof Error ? error.message : "STEP import failed." });
  }
};
