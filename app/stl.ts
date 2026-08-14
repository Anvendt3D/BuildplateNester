import type { ModelMesh } from "./orientation-viewer";

function parseBinary(buffer: ArrayBuffer): ModelMesh {
  const view = new DataView(buffer), count = view.getUint32(80, true), positions: number[] = [], indices: number[] = [];
  for (let triangle = 0; triangle < count; triangle++) {
    const offset = 84 + triangle * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex++) {
      positions.push(view.getFloat32(offset + vertex * 12, true), view.getFloat32(offset + vertex * 12 + 4, true), view.getFloat32(offset + vertex * 12 + 8, true));
      indices.push(indices.length);
    }
  }
  return { positions, indices };
}

function parseAscii(text: string): ModelMesh {
  const positions: number[] = [], indices: number[] = [];
  for (const match of text.matchAll(/vertex\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)\s+([+\-\d.eE]+)/g)) {
    positions.push(Number(match[1]), Number(match[2]), Number(match[3])); indices.push(indices.length);
  }
  if (positions.length < 9 || positions.length % 9) throw new Error("STL contains no valid triangles.");
  return { positions, indices };
}

export function parseStl(buffer: ArrayBuffer): ModelMesh {
  if (buffer.byteLength >= 84) {
    const view = new DataView(buffer), triangleCount = view.getUint32(80, true);
    if (84 + triangleCount * 50 === buffer.byteLength) return parseBinary(buffer);
  }
  return parseAscii(new TextDecoder().decode(buffer));
}
