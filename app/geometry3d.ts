export type Vec3 = { x: number; y: number; z: number };
export type QuaternionTuple = [number, number, number, number];

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale3 = (a: Vec3, scalar: number): Vec3 => ({ x: a.x * scalar, y: a.y * scalar, z: a.z * scalar });
export const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
export const length3 = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
export const normalize3 = (a: Vec3): Vec3 => { const length = length3(a) || 1; return scale3(a, 1 / length); };
export const lerp3 = (a: Vec3, b: Vec3, amount: number): Vec3 => normalize3({ x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount, z: a.z + (b.z - a.z) * amount });

export function normalizeQuaternion(q: QuaternionTuple): QuaternionTuple {
  const length = Math.hypot(...q) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

export function multiplyQuaternion(a: QuaternionTuple, b: QuaternionTuple): QuaternionTuple {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return normalizeQuaternion([
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

export function rotateVector(v: Vec3, q: QuaternionTuple): Vec3 {
  const [qx, qy, qz, qw] = q;
  const ix = qw * v.x + qy * v.z - qz * v.y;
  const iy = qw * v.y + qz * v.x - qx * v.z;
  const iz = qw * v.z + qx * v.y - qy * v.x;
  const iw = -qx * v.x - qy * v.y - qz * v.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

export function quaternionFromUnitVectors(fromValue: Vec3, toValue: Vec3): QuaternionTuple {
  const from = normalize3(fromValue), to = normalize3(toValue);
  let r = dot3(from, to) + 1;
  let x: number, y: number, z: number;
  if (r < 1e-7) {
    r = 0;
    if (Math.abs(from.x) > Math.abs(from.z)) { x = -from.y; y = from.x; z = 0; }
    else { x = 0; y = -from.z; z = from.y; }
  } else {
    const cross = cross3(from, to); x = cross.x; y = cross.y; z = cross.z;
  }
  return normalizeQuaternion([x, y, z, r]);
}

export function quaternionFromEuler(x: number, y: number, z: number): QuaternionTuple {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return normalizeQuaternion([
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]);
}

export function eulerFromQuaternion(q: QuaternionTuple): Vec3 {
  const [x, y, z, w] = normalizeQuaternion(q);
  const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
  const m23 = 2 * (y * z - x * w), m33 = 1 - 2 * (x * x + y * y);
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)));
  if (Math.abs(m13) < 0.9999999) return { x: Math.atan2(-m23, m33), y: ey, z: Math.atan2(-m12, m11) };
  return { x: Math.atan2(2 * (x * y + z * w), 1 - 2 * (y * y + z * z)), y: ey, z: 0 };
}

export function bounds3(points: Vec3[]) {
  const min = vec3(Infinity, Infinity, Infinity), max = vec3(-Infinity, -Infinity, -Infinity);
  for (const p of points) { min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z); max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z); }
  return { min, max, size: sub3(max, min), center: scale3(add3(min, max), 0.5) };
}
