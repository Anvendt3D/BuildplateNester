"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { QuaternionTuple } from "./geometry3d";

export type ModelMesh = { positions: number[]; indices: number[]; color?: number[] };

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
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.setClearColor(0x111114, 1);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x111114);
    const ambient = new THREE.HemisphereLight(0xf1efff, 0x262638, 2.1); scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.4, -1.8, 2.6); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9b8dff, .8); fill.position.set(-1.6, 1.2, .6); scene.add(fill);
    // Mirror the stlTexturizer ground treatment: only a grid beneath the model.
    // A filled plane was competing with both the grid and the part's bottom face.
    const grid = new THREE.GridHelper(200, 40, 0x555568, 0x2a2a35);
    grid.rotation.x = Math.PI / 2;
    (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach((material) => { material.depthWrite = false; });
    scene.add(grid);
    const model = new THREE.Group(); model.quaternion.set(orientation[0], orientation[1], orientation[2], orientation[3]); scene.add(model);
    const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
    for (const source of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(source.positions, 3));
      const vertexCount = source.positions.length / 3;
      if (source.indices.length && source.indices.every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount)) geometry.setIndex(source.indices);
      geometry.computeVertexNormals(); geometry.computeBoundingSphere(); geometries.push(geometry);
      const values = source.color?.length === 3 ? source.color : [255, 122, 26], color = Math.max(...values) <= 1 ? new THREE.Color(values[0], values[1], values[2]) : new THREE.Color(values[0] / 255, values[1] / 255, values[2] / 255);
      const material = new THREE.MeshStandardMaterial({ color, roughness: .58, metalness: .04, flatShading: true, side: THREE.DoubleSide }); materials.push(material); model.add(new THREE.Mesh(geometry, material));
    }
    model.updateMatrixWorld(true); const rawBox = new THREE.Box3().setFromObject(model), size = rawBox.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1), groundGap = Math.max(.01, extent * .001);
    model.position.set(-rawBox.getCenter(new THREE.Vector3()).x, -rawBox.getCenter(new THREE.Vector3()).y, -rawBox.min.z + groundGap); model.updateMatrixWorld(true);
    const gridSize = Math.max(20, extent * 2.1); grid.scale.set(gridSize / 200, gridSize / 200, 1); grid.position.z = -groundGap;
    // Orthographic Z-up view and a tight clipping range match stlTexturizer.
    // The former 0.1–100000 perspective depth range made tiny ground offsets
    // indistinguishable to the depth buffer while manipulating the model.
    const camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, -extent * 20, extent * 20); camera.up.set(0, 0, 1);
    camera.position.set(extent * 3.2, -extent * 3.7, extent * 2.8);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 0, Math.max(0, size.z * .28)); controls.enableDamping = true; controls.dampingFactor = .08; controls.screenSpacePanning = true; controls.minDistance = extent * .18; controls.maxDistance = extent * 12; controls.minPolarAngle = .04; controls.maxPolarAngle = Math.PI - .04; controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY; controls.mouseButtons.RIGHT = THREE.MOUSE.PAN; controls.update();
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(); let down = { x: 0, y: 0 }, moved = false, frame = 0;
    const resize = () => { const width = Math.max(320, parent.clientWidth), height = Math.max(300, parent.clientHeight), halfHeight = extent * 1.18, halfWidth = halfHeight * width / height; renderer.setSize(width, height, false); camera.left = -halfWidth; camera.right = halfWidth; camera.top = halfHeight; camera.bottom = -halfHeight; camera.updateProjectionMatrix(); };
    const pick = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(model.children, true)[0]; if (!hit?.face) return; const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize(); callbackRef.current([normal.x, normal.y, normal.z]); };
    const onDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; moved = false; };
    const onMove = (event: PointerEvent) => { if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) moved = true; };
    const onUp = (event: PointerEvent) => { if (!moved && event.button === 0) pick(event); };
    const render = () => { controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(render); };
    const observer = new ResizeObserver(resize); observer.observe(parent); resize(); render(); canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove); canvas.addEventListener("pointerup", onUp);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove); canvas.removeEventListener("pointerup", onUp); controls.dispose(); geometries.forEach((geometry) => geometry.dispose()); materials.forEach((material) => material.dispose()); renderer.dispose(); };
  }, [meshes, orientation]);

  return <div className="orientation-canvas"><canvas ref={canvasRef} aria-label="Interactive 3D orientation preview: left-drag orbits, right-drag pans, scroll zooms, click a face to place it down" /></div>;
}
