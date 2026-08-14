"use client";

import { useEffect, useRef } from "react";
import { QuaternionTuple, Vec3, bounds3, cross3, dot3, normalize3, quaternionFromEuler, rotateVector, sub3, vec3 } from "./geometry3d";

export type ModelMesh = { positions: number[]; indices: number[]; color?: number[] };
type DrawnFace = { points: Array<{ x: number; y: number }>; normal: Vec3; depth: number };

function pointInPolygon(point: { x: number; y: number }, polygon: Array<{ x: number; y: number }>) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export default function OrientationViewer({ meshes, orientation, onFaceSelected }: {
  meshes: ModelMesh[];
  orientation: QuaternionTuple;
  onFaceSelected: (worldNormal: [number, number, number]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const callbackRef = useRef(onFaceSelected);
  useEffect(() => { callbackRef.current = onFaceSelected; }, [onFaceSelected]);

  useEffect(() => {
    const canvas = canvasRef.current, parent = canvas?.parentElement;
    if (!canvas || !parent || !meshes.length) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let yaw = -0.7, pitch = 0.92, zoom = 1, dragDistance = 0;
    let start = { x: 0, y: 0 }, prior = { x: 0, y: 0 }, dragging = false;
    let faces: DrawnFace[] = [];

    const rawVertices: Vec3[] = [];
    for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i += 3) rawVertices.push(rotateVector(vec3(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]), orientation));
    const modelBox = bounds3(rawVertices), modelCenter = { ...modelBox.center };
    modelCenter.z = modelBox.min.z;

    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2), width = Math.max(320, parent.clientWidth), height = Math.max(300, parent.clientHeight);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height); context.fillStyle = "#f0f3f0"; context.fillRect(0, 0, width, height);
      const viewQ = quaternionFromEuler(pitch, 0, yaw);
      const transformed = rawVertices.map((v) => rotateVector(sub3(v, modelCenter), viewQ));
      const ext = bounds3(transformed), extSize = ext.size;
      const scale = Math.min(width * 0.72 / Math.max(1, extSize.x), height * 0.7 / Math.max(1, extSize.y)) * zoom;
      const center = ext.center;
      const project = (v: Vec3) => ({ x: width / 2 + (v.x - center.x) * scale, y: height / 2 - (v.y - center.y) * scale });

      context.strokeStyle = "#ccd3ce"; context.lineWidth = 1;
      const gridSize = Math.max(modelBox.size.x, modelBox.size.y, 20) * 1.8;
      for (let i = -5; i <= 5; i++) {
        for (const axis of [0, 1]) {
          const a = rotateVector(sub3(vec3(axis ? -gridSize : i * gridSize / 5, axis ? i * gridSize / 5 : -gridSize, 0), modelCenter), viewQ);
          const b = rotateVector(sub3(vec3(axis ? gridSize : i * gridSize / 5, axis ? i * gridSize / 5 : gridSize, 0), modelCenter), viewQ);
          const pa = project(a), pb = project(b); context.beginPath(); context.moveTo(pa.x, pa.y); context.lineTo(pb.x, pb.y); context.stroke();
        }
      }

      const triangles: Array<DrawnFace & { color: string; shade: number }> = [];
      let vertexOffset = 0;
      for (const mesh of meshes) {
        const indices = mesh.indices.length ? mesh.indices : Array.from({ length: mesh.positions.length / 3 }, (_, i) => i);
        const importedColor = mesh.color?.length === 3 ? mesh.color : null;
        const sourceColor = importedColor && importedColor.some((channel) => channel > 0.08) ? importedColor : [255, 122, 26];
        const base = Math.max(...sourceColor) <= 1 ? sourceColor.map((channel) => channel * 255) : sourceColor;
        for (let i = 0; i < indices.length; i += 3) {
          const localA = vec3(mesh.positions[indices[i] * 3], mesh.positions[indices[i] * 3 + 1], mesh.positions[indices[i] * 3 + 2]);
          const localB = vec3(mesh.positions[indices[i + 1] * 3], mesh.positions[indices[i + 1] * 3 + 1], mesh.positions[indices[i + 1] * 3 + 2]);
          const localC = vec3(mesh.positions[indices[i + 2] * 3], mesh.positions[indices[i + 2] * 3 + 1], mesh.positions[indices[i + 2] * 3 + 2]);
          const normal = rotateVector(normalize3(cross3(sub3(localB, localA), sub3(localC, localA))), orientation);
          const a = transformed[vertexOffset + indices[i]], b = transformed[vertexOffset + indices[i + 1]], c = transformed[vertexOffset + indices[i + 2]];
          const shade = 0.54 + Math.max(0, dot3(normal, normalize3(vec3(0.35, -0.55, 0.75)))) * 0.46;
          triangles.push({ points: [project(a), project(b), project(c)], normal, depth: (a.z + b.z + c.z) / 3, color: `rgb(${base.map((channel) => Math.round(channel * shade)).join(",")})`, shade });
        }
        vertexOffset += mesh.positions.length / 3;
      }
      triangles.sort((a, b) => a.depth - b.depth); faces = triangles;
      for (const face of triangles) {
        context.beginPath(); context.moveTo(face.points[0].x, face.points[0].y); context.lineTo(face.points[1].x, face.points[1].y); context.lineTo(face.points[2].x, face.points[2].y); context.closePath();
        context.fillStyle = face.color; context.fill(); context.strokeStyle = "rgba(20,32,25,.16)"; context.lineWidth = 0.6; context.stroke();
      }
    };

    const resizeObserver = new ResizeObserver(draw); resizeObserver.observe(parent); draw();
    const pointerDown = (event: globalThis.PointerEvent) => { dragging = true; dragDistance = 0; start = prior = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); };
    const pointerMove = (event: globalThis.PointerEvent) => { if (!dragging) return; const dx = event.clientX - prior.x, dy = event.clientY - prior.y; dragDistance += Math.hypot(dx, dy); yaw += dx * 0.008; pitch = Math.max(-1.45, Math.min(1.45, pitch + dy * 0.008)); prior = { x: event.clientX, y: event.clientY }; draw(); };
    const pointerUp = (event: globalThis.PointerEvent) => {
      dragging = false;
      if (dragDistance > 6 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const rect = canvas.getBoundingClientRect(), point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const face = [...faces].reverse().find((candidate) => pointInPolygon(point, candidate.points));
      if (face) callbackRef.current([face.normal.x, face.normal.y, face.normal.z]);
    };
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoom = Math.max(0.45, Math.min(3, zoom * (event.deltaY > 0 ? 0.9 : 1.1))); draw(); };
    canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove); canvas.addEventListener("pointerup", pointerUp); canvas.addEventListener("wheel", wheel, { passive: false });
    return () => { resizeObserver.disconnect(); canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointermove", pointerMove); canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("wheel", wheel); };
  }, [meshes, orientation]);

  return <div className="orientation-canvas"><canvas ref={canvasRef} aria-label="Interactive software-rendered 3D orientation preview" /></div>;
}
