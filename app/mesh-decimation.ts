import type { ModelMesh } from "./orientation-viewer";

// This is deliberately a fixed, very coarse proxy. It is used only for the
// silhouette, face picking, and nesting workers—never for the printable 3MF.
export const NESTING_TRIANGLE_BUDGET = 1_500;

export function meshTriangleCount(mesh: ModelMesh) {
  return Math.floor((mesh.indices.length || mesh.positions.length / 3) / 3);
}

// The nester needs a silhouette and an orientation preview, not a production
// mesh. Uniformly sampling triangles keeps imports and workers responsive while
// preserving coverage across the source mesh's triangle stream.
export function coarsenMeshForNesting(mesh: ModelMesh, triangleBudget = NESTING_TRIANGLE_BUDGET): ModelMesh {
  const sourceIndices = mesh.indices.length ? mesh.indices : Array.from({ length: mesh.positions.length / 3 }, (_, index) => index);
  const triangleCount = Math.floor(sourceIndices.length / 3);
  if (triangleCount <= triangleBudget) return mesh;
  const positions: number[] = [], indices: number[] = [];
  for (let outputTriangle = 0; outputTriangle < triangleBudget; outputTriangle++) {
    const sourceTriangle = Math.min(triangleCount - 1, Math.floor(outputTriangle * triangleCount / triangleBudget));
    for (let corner = 0; corner < 3; corner++) {
      const sourceIndex = sourceIndices[sourceTriangle * 3 + corner];
      positions.push(mesh.positions[sourceIndex * 3], mesh.positions[sourceIndex * 3 + 1], mesh.positions[sourceIndex * 3 + 2]);
      indices.push(indices.length);
    }
  }
  return { positions, indices };
}
