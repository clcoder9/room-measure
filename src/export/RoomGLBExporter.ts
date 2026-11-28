import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RoomExportData, SurfaceTextureEntry } from '../measurement/RoomManager';

const WALL_THICKNESS = 0.12;
const DEFAULT_TILE_SIZE_M = 1.0;

interface WallOpeningSpan {
  id: string;
  type: 'door' | 'window';
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}

function sanitizeNodeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Room';
}

function signedAreaXZ(pts: { x: number; z: number }[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum * 0.5;
}

async function loadTextureFromEntry(entry: SurfaceTextureEntry): Promise<THREE.Texture> {
  const img = new Image();
  img.src = entry.dataUrl;
  if (typeof img.decode === 'function') {
    await img.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Failed to load texture for ${entry.surfaceKey}`));
    });
  }

  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = true;
  if (entry.mode === 'tile') {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  } else {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.needsUpdate = true;
  return tex;
}

function computeWallUVs(
  geo: THREE.BufferGeometry,
  wallLen: number,
  wallHeight: number,
  entry?: SurfaceTextureEntry
): void {
  const pos = geo.getAttribute('position');
  const norm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  if (!pos || !uv) return;

  const isStretch = entry?.mode === 'stretch';
  const tileSize = Math.max(0.1, entry?.tileSizeMeters ?? DEFAULT_TILE_SIZE_M);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = norm ? Math.abs(norm.getX(i)) : 0;
    const ny = norm ? Math.abs(norm.getY(i)) : 0;

    let uCoord = x;
    let vCoord = y;
    if (nx > 0.5) {
      uCoord = z + WALL_THICKNESS;
      vCoord = y;
    } else if (ny > 0.5) {
      uCoord = x;
      vCoord = z + WALL_THICKNESS;
    }

    if (isStretch) {
      uv.setXY(i, uCoord / Math.max(0.05, wallLen), vCoord / Math.max(0.05, wallHeight));
    } else {
      uv.setXY(i, uCoord / tileSize, vCoord / tileSize);
    }
  }
  uv.needsUpdate = true;
}

function computeFurnitureUVs(
  geo: THREE.BufferGeometry,
  w: number,
  h: number,
  d: number,
  entry?: SurfaceTextureEntry
): void {
  if (!entry || entry.mode !== 'tile') return;
  const pos = geo.getAttribute('position');
  const norm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  if (!pos || !norm || !uv) return;

  const tileSize = Math.max(0.1, entry.tileSizeMeters || DEFAULT_TILE_SIZE_M);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(norm.getX(i));
    const ny = Math.abs(norm.getY(i));
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (nx > 0.5) {
      uv.setXY(i, (u * d) / tileSize, (v * h) / tileSize);
    } else if (ny > 0.5) {
      uv.setXY(i, (u * w) / tileSize, (v * d) / tileSize);
    } else {
      uv.setXY(i, (u * w) / tileSize, (v * h) / tileSize);
    }
  }
  uv.needsUpdate = true;
}

export async function exportRoomToGLB(
  data: RoomExportData,
  roomName: string = 'Measured_Room'
): Promise<Blob> {
  if (!data.floorCoordinates || data.floorCoordinates.length < 3) {
    throw new Error('Need at least 3 floor corners to export a 3D room model.');
  }

  const disposables: {
    geometries: THREE.BufferGeometry[];
    materials: THREE.Material[];
    textures: THREE.Texture[];
  } = {
    geometries: [],
    materials: [],
    textures: []
  };

  try {
    const rawPts = data.floorCoordinates;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (const p of rawPts) {
      sumX += p.x;
      sumY += p.y;
      sumZ += p.z;
    }
    const cx = sumX / rawPts.length;
    const floorY = sumY / rawPts.length;
    const cz = sumZ / rawPts.length;

    const normPts = rawPts.map((p) => ({
      x: p.x - cx,
      z: p.z - cz
    }));

    const areaSigned = signedAreaXZ(normPts);
    const wasReversed = areaSigned < 0;
    const orderedPts = wasReversed ? normPts.slice().reverse() : normPts;
    const n = orderedPts.length;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of orderedPts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const spanX = Math.max(0.1, maxX - minX);
    const spanZ = Math.max(0.1, maxZ - minZ);

    const measuredCeilingH = data.metrics.ceilingHeightMeters;
    const hasExplicitCeiling = measuredCeilingH > 0.3;
    const wallHeight = hasExplicitCeiling ? measuredCeilingH : 2.5;

    const textureMap = new Map<string, SurfaceTextureEntry>();
    const loadedTextures = new Map<string, THREE.Texture>();
    if (Array.isArray(data.surfaceTextures)) {
      for (const entry of data.surfaceTextures) {
        textureMap.set(entry.surfaceKey, entry);
        try {
          const tex = await loadTextureFromEntry(entry);
          loadedTextures.set(entry.surfaceKey, tex);
          disposables.textures.push(tex);
        } catch (err) {
          console.warn('[GLB Export] Skipping unreadable texture:', entry.surfaceKey, err);
        }
      }
    }

    const root = new THREE.Group();
    root.name = sanitizeNodeName(roomName);
    root.userData = {
      appName: data.appName,
      unit: 'meters',
      arOrigin: { cx, floorY, cz },
      hasExplicitCeiling
    };

    const makeMaterial = (
      name: string,
      surfaceKey: string,
      fallbackColor: number,
      roughness: number,
      doubleSide = false
    ): THREE.MeshStandardMaterial => {
      const tex = loadedTextures.get(surfaceKey) ?? null;
      const mat = new THREE.MeshStandardMaterial({
        name,
        color: tex ? 0xffffff : fallbackColor,
        map: tex,
        roughness,
        metalness: 0.05,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide
      });
      disposables.materials.push(mat);
      return mat;
    };

    // 1. Floor mesh (y = 0, normal +Y)
    const floorShape = new THREE.Shape();
    floorShape.moveTo(orderedPts[0].x, -orderedPts[0].z);
    for (let i = 1; i < n; i++) {
      floorShape.lineTo(orderedPts[i].x, -orderedPts[i].z);
    }
    floorShape.closePath();

    const floorGeo = new THREE.ShapeGeometry(floorShape);
    floorGeo.rotateX(-Math.PI / 2);
    const floorPos = floorGeo.getAttribute('position');
    const floorUv = floorGeo.getAttribute('uv');
    const floorTexEntry = textureMap.get('floor');
    const floorTile = Math.max(0.1, floorTexEntry?.tileSizeMeters ?? DEFAULT_TILE_SIZE_M);
    for (let i = 0; i < floorPos.count; i++) {
      const x = floorPos.getX(i);
      const z = floorPos.getZ(i);
      if (floorTexEntry?.mode === 'stretch') {
        floorUv.setXY(i, (x - minX) / spanX, (z - minZ) / spanZ);
      } else {
        floorUv.setXY(i, (x - minX) / floorTile, (z - minZ) / floorTile);
      }
    }
    floorUv.needsUpdate = true;
    floorGeo.computeVertexNormals();
    disposables.geometries.push(floorGeo);

    const floorMesh = new THREE.Mesh(
      floorGeo,
      makeMaterial('Floor_Mat', 'floor', 0x334155, 0.85, true)
    );
    floorMesh.name = 'Floor';
    root.add(floorMesh);

    // 2. Ceiling mesh (when explicit ceiling height is present)
    if (hasExplicitCeiling) {
      const ceilShape = new THREE.Shape();
      ceilShape.moveTo(orderedPts[0].x, orderedPts[0].z);
      for (let i = 1; i < n; i++) {
        ceilShape.lineTo(orderedPts[i].x, orderedPts[i].z);
      }
      ceilShape.closePath();

      const ceilGeo = new THREE.ShapeGeometry(ceilShape);
      ceilGeo.rotateX(Math.PI / 2);
      ceilGeo.translate(0, wallHeight, 0);
      const ceilPos = ceilGeo.getAttribute('position');
      const ceilUv = ceilGeo.getAttribute('uv');
      const ceilTexEntry = textureMap.get('ceiling');
      const ceilTile = Math.max(0.1, ceilTexEntry?.tileSizeMeters ?? DEFAULT_TILE_SIZE_M);
      for (let i = 0; i < ceilPos.count; i++) {
        const x = ceilPos.getX(i);
        const z = ceilPos.getZ(i);
        if (ceilTexEntry?.mode === 'stretch') {
          ceilUv.setXY(i, (x - minX) / spanX, (z - minZ) / spanZ);
        } else {
          ceilUv.setXY(i, (x - minX) / ceilTile, (z - minZ) / ceilTile);
        }
      }
      ceilUv.needsUpdate = true;
      ceilGeo.computeVertexNormals();
      disposables.geometries.push(ceilGeo);

      const ceilMesh = new THREE.Mesh(
        ceilGeo,
        makeMaterial('Ceiling_Mat', 'ceiling', 0xe2e8f0, 0.9, true)
      );
      ceilMesh.name = 'Ceiling';
      root.add(ceilMesh);
    }

    // 3. Walls with real door/window cutouts + Window Glass group
    const wallsGroup = new THREE.Group();
    wallsGroup.name = 'Walls';
    root.add(wallsGroup);

    const openingsGroup = new THREE.Group();
    openingsGroup.name = 'Openings';
    root.add(openingsGroup);

    const glassMat = new THREE.MeshStandardMaterial({
      name: 'Window_Glass_Mat',
      color: 0xbae6fd,
      transparent: true,
      opacity: 0.25,
      roughness: 0.1,
      metalness: 0.1,
      side: THREE.DoubleSide
    });
    disposables.materials.push(glassMat);

    let windowIdx = 0;

    for (let edgeIdx = 0; edgeIdx < n; edgeIdx++) {
      const p1 = orderedPts[edgeIdx];
      const p2 = orderedPts[(edgeIdx + 1) % n];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const wallLen = Math.hypot(dx, dz);
      if (wallLen < 0.05) continue;

      const origWallIdx = wasReversed ? (n - 2 - edgeIdx + n) % n : edgeIdx;
      const tx = dx / wallLen;
      const tz = dz / wallLen;
      const nx = -tz;
      const nz = tx;

      const wallBasis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(tx, 0, tz),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(nx, 0, nz)
      );
      wallBasis.setPosition(p1.x, 0, p1.z);

      // Gather positioned openings belonging to this original wall
      const rawOpenings = data.openings.filter(
        (o) => o.wallIndex === origWallIdx && o.offsetAlongWallMeters !== undefined
      );
      const spans: WallOpeningSpan[] = [];
      for (const op of rawOpenings) {
        const rawOffset = op.offsetAlongWallMeters!;
        const sStart = wasReversed ? wallLen - rawOffset - op.widthMeters : rawOffset;
        const s0 = Math.max(0.03, Math.min(wallLen - 0.03, sStart));
        const s1 = Math.max(0.03, Math.min(wallLen - 0.03, sStart + op.widthMeters));
        const sill = Math.max(0, op.sillHeightMeters ?? 0);
        const y0 = sill <= 0.05 ? 0 : Math.min(wallHeight - 0.18, sill);
        const y1 = Math.min(wallHeight - 0.03, y0 + op.heightMeters);
        if (s1 - s0 < 0.15 || y1 - y0 < 0.15) continue;
        spans.push({ id: op.id, type: op.type, s0, s1, y0, y1 });
      }

      // Separate floor-touching door cutouts from elevated window cutouts
      const doors = spans
        .filter((s) => s.y0 === 0)
        .sort((a, b) => a.s0 - b.s0);

      const mergedDoors: { s0: number; s1: number; y1: number }[] = [];
      for (const d of doors) {
        const prev = mergedDoors[mergedDoors.length - 1];
        if (prev && d.s0 <= prev.s1 + 0.02) {
          prev.s1 = Math.max(prev.s1, d.s1);
          prev.y1 = Math.max(prev.y1, d.y1);
        } else {
          mergedDoors.push({ s0: d.s0, s1: d.s1, y1: d.y1 });
        }
      }

      const wallShape = new THREE.Shape();
      wallShape.moveTo(0, 0);
      for (const d of mergedDoors) {
        wallShape.lineTo(d.s0, 0);
        wallShape.lineTo(d.s0, d.y1);
        wallShape.lineTo(d.s1, d.y1);
        wallShape.lineTo(d.s1, 0);
      }
      wallShape.lineTo(wallLen, 0);
      wallShape.lineTo(wallLen, wallHeight);
      wallShape.lineTo(0, wallHeight);
      wallShape.closePath();

      const acceptedWindows: WallOpeningSpan[] = [];
      const candidateWindows = spans
        .filter((s) => s.y0 > 0)
        .sort((a, b) => a.s0 - b.s0);

      for (const w of candidateWindows) {
        const overlapsDoor = mergedDoors.some(
          (d) => w.s0 < d.s1 + 0.02 && w.s1 > d.s0 - 0.02 && w.y0 < d.y1 + 0.02
        );
        const overlapsPrevWin = acceptedWindows.some(
          (aw) =>
            w.s0 < aw.s1 + 0.02 &&
            w.s1 > aw.s0 - 0.02 &&
            w.y0 < aw.y1 + 0.02 &&
            w.y1 > aw.y0 - 0.02
        );
        if (overlapsDoor || overlapsPrevWin) continue;

        acceptedWindows.push(w);
        const hole = new THREE.Path();
        hole.moveTo(w.s0, w.y0);
        hole.lineTo(w.s1, w.y0);
        hole.lineTo(w.s1, w.y1);
        hole.lineTo(w.s0, w.y1);
        hole.closePath();
        wallShape.holes.push(hole);

        // Add translucent glass pane inside window cutout
        windowIdx++;
        const winW = w.s1 - w.s0;
        const winH = w.y1 - w.y0;
        const glassGeo = new THREE.PlaneGeometry(winW, winH);
        glassGeo.translate((w.s0 + w.s1) * 0.5, (w.y0 + w.y1) * 0.5, -WALL_THICKNESS * 0.5);
        glassGeo.applyMatrix4(wallBasis);
        disposables.geometries.push(glassGeo);

        const glassMesh = new THREE.Mesh(glassGeo, glassMat);
        glassMesh.name = `Window_${windowIdx}_Glass`;
        openingsGroup.add(glassMesh);
      }

      const wallGeo = new THREE.ExtrudeGeometry(wallShape, {
        depth: WALL_THICKNESS,
        bevelEnabled: false
      });
      wallGeo.translate(0, 0, -WALL_THICKNESS);

      const wallKey = `wall:${origWallIdx}`;
      computeWallUVs(wallGeo, wallLen, wallHeight, textureMap.get(wallKey));
      wallGeo.applyMatrix4(wallBasis);
      wallGeo.computeVertexNormals();
      disposables.geometries.push(wallGeo);

      const wallMesh = new THREE.Mesh(
        wallGeo,
        makeMaterial(`Wall_${origWallIdx + 1}_Mat`, wallKey, 0xcbd5e1, 0.85, false)
      );
      wallMesh.name = `Wall_${origWallIdx + 1}`;
      wallsGroup.add(wallMesh);
    }

    // 4. Furniture boxes
    if (data.furniture && data.furniture.length > 0) {
      const furnGroup = new THREE.Group();
      furnGroup.name = 'Furniture';
      root.add(furnGroup);

      data.furniture.forEach((f, idx) => {
        const boxGeo = new THREE.BoxGeometry(f.widthMeters, f.heightMeters, f.depthMeters);
        const furnKey = `furniture:${f.id}`;
        computeFurnitureUVs(
          boxGeo,
          f.widthMeters,
          f.heightMeters,
          f.depthMeters,
          textureMap.get(furnKey)
        );
        disposables.geometries.push(boxGeo);

        const furnMat = makeMaterial(
          `Furniture_${idx + 1}_Mat`,
          furnKey,
          0x64748b,
          0.75,
          false
        );
        const furnMesh = new THREE.Mesh(boxGeo, furnMat);
        furnMesh.name = `Furniture_${idx + 1}_${sanitizeNodeName(f.label)}`;
        furnMesh.position.set(
          f.centerXZ[0] - cx,
          f.heightMeters * 0.5,
          f.centerXZ[1] - cz
        );
        furnMesh.rotation.y = -f.yawRad;
        furnGroup.add(furnMesh);
      });
    }

    const exporter = new GLTFExporter();
    const glb = await exporter.parseAsync(root, {
      binary: true,
      embedImages: true,
      maxTextureSize: 1024
    });

    if (glb instanceof ArrayBuffer) {
      return new Blob([glb], { type: 'model/gltf-binary' });
    }
    return new Blob([JSON.stringify(glb)], { type: 'model/gltf+json' });
  } finally {
    disposables.geometries.forEach((g) => g.dispose());
    disposables.materials.forEach((m) => m.dispose());
    disposables.textures.forEach((t) => t.dispose());
  }
}
