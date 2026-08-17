"use client";

import { useEffect, useRef } from "react";
import { QuaternionTuple, rotateVector, vec3 } from "./geometry3d";
import type { ModelMesh } from "./orientation-viewer";

type Part = { id: string; color: string; meshes: ModelMesh[]; orientation: QuaternionTuple };
type Placement = { partId: string; x: number; y: number; rotation: number; colliding: boolean };
type Sprite = { canvas: HTMLCanvasElement; width: number; height: number };

// Dragging and live nesting redraw the plate repeatedly. Cache one solid,
// top-down image per part pose so ordinary redraws only blit an image instead
// of projecting every source triangle again.
const sprites = new Map<string, Sprite>();

function makeSprite(part: Part, rotation: number, color: string): Sprite | null {
  const key = `${part.id}|${part.orientation.join(",")}|${rotation}|${color}`;
  const cached = sprites.get(key); if (cached) return cached;
  const angle = rotation * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  const triangles: number[][] = []; let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const mesh of part.meshes) {
    const ids = mesh.indices.length ? mesh.indices : Array.from({ length: mesh.positions.length / 3 }, (_, index) => index);
    for (let index = 0; index + 2 < ids.length; index += 3) {
      const triangle: number[] = [];
      for (const id of [ids[index], ids[index + 1], ids[index + 2]]) {
        const offset = id * 3, point = rotateVector(vec3(mesh.positions[offset], mesh.positions[offset + 1], mesh.positions[offset + 2]), part.orientation);
        const x = point.x * cosine - point.y * sine, y = point.x * sine + point.y * cosine;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); triangle.push(x, y);
      }
      triangles.push(triangle);
    }
  }
  if (!triangles.length || !Number.isFinite(minX)) return null;
  const width = Math.max(.01, maxX - minX), height = Math.max(.01, maxY - minY), pixelsPerMm = Math.min(5, Math.max(2, 1600 / Math.max(width, height)));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(width * pixelsPerMm) + 4); canvas.height = Math.max(1, Math.ceil(height * pixelsPerMm) + 4);
  const context = canvas.getContext("2d"); if (!context) return null;
  context.scale(pixelsPerMm, pixelsPerMm); context.translate(2 / pixelsPerMm, 2 / pixelsPerMm); context.fillStyle = color;
  for (const triangle of triangles) { context.beginPath(); context.moveTo(triangle[0] - minX, triangle[1] - minY); context.lineTo(triangle[2] - minX, triangle[3] - minY); context.lineTo(triangle[4] - minX, triangle[5] - minY); context.closePath(); context.fill(); }
  const sprite = { canvas, width, height }; sprites.set(key, sprite); return sprite;
}

export default function PlateModelPreview({ width, depth, parts, placements }: { width: number; depth: number; parts: Part[]; placements: Placement[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current, host = canvas?.parentElement; if (!canvas || !host) return; let frame = 0;
    const draw = () => {
      const rect = host.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2), context = canvas.getContext("2d"); if (!context) return;
      canvas.width = Math.max(1, Math.round(rect.width * ratio)); canvas.height = Math.max(1, Math.round(rect.height * ratio)); context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, rect.width, rect.height);
      for (const placement of placements) {
        const part = parts.find((item) => item.id === placement.partId); if (!part?.meshes.length) continue;
        const sprite = makeSprite(part, placement.rotation, placement.colliding ? "#ff5f5f" : part.color); if (!sprite) continue;
        context.drawImage(sprite.canvas, placement.x / width * rect.width, placement.y / depth * rect.height, sprite.width / width * rect.width, sprite.height / depth * rect.height);
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
    const observer = new ResizeObserver(schedule); observer.observe(host); schedule(); return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [width, depth, parts, placements]);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 3 }} aria-hidden="true" />;
}
