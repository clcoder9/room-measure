import * as THREE from 'three';

export class Reticle extends THREE.Object3D {
  private outerRing: THREE.Mesh;
  private innerDot: THREE.Mesh;
  private pulseRing: THREE.Mesh;
  private normalIndicator: THREE.Line;
  private ringMaterial: THREE.MeshBasicMaterial;
  private pulseMaterial: THREE.MeshBasicMaterial;
  private normalMaterial: THREE.LineBasicMaterial;
  private pulseTime: number = 0;
  private isSnapped: boolean = false;

  constructor() {
    super();
    this.name = 'XRReticle';
    this.matrixAutoUpdate = false;
    this.visible = false;

    // Outer Ring: high-visibility neon cyan with subtle glow
    const ringGeometry = new THREE.RingGeometry(0.11, 0.13, 48);
    ringGeometry.rotateX(-Math.PI / 2); // Lay flat on plane by default
    this.ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x00f2fe,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthTest: false
    });
    this.outerRing = new THREE.Mesh(ringGeometry, this.ringMaterial);
    this.outerRing.renderOrder = 999;
    this.add(this.outerRing);

    // Inner pulsing ring
    const pulseGeometry = new THREE.RingGeometry(0.04, 0.05, 32);
    pulseGeometry.rotateX(-Math.PI / 2);
    this.pulseMaterial = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthTest: false
    });
    this.pulseRing = new THREE.Mesh(pulseGeometry, this.pulseMaterial);
    this.pulseRing.renderOrder = 999;
    this.add(this.pulseRing);

    // Center pinpoint dot
    const dotGeometry = new THREE.CircleGeometry(0.012, 24);
    dotGeometry.rotateX(-Math.PI / 2);
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      depthTest: false
    });
    this.innerDot = new THREE.Mesh(dotGeometry, dotMaterial);
    this.innerDot.renderOrder = 1000;
    this.add(this.innerDot);

    // Surface normal indicator ray (perpendicular to surface)
    const normalGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0.08, 0)
    ]);
    this.normalMaterial = new THREE.LineBasicMaterial({
      color: 0x00f2fe,
      transparent: true,
      opacity: 0.8,
      depthTest: false
    });
    this.normalIndicator = new THREE.Line(normalGeo, this.normalMaterial);
    this.normalIndicator.renderOrder = 999;
    this.add(this.normalIndicator);
  }

  /**
   * Update reticle transform directly from WebXR pose matrix.
   */
  public updateFromMatrix(rawMatrix: Float32Array | number[]): void {
    this.matrix.fromArray(rawMatrix);
    this.matrix.decompose(this.position, this.quaternion, this.scale);
    this.visible = true;
  }

  /**
   * Explicitly sets reticle world position (used in Desktop Simulator and wall-ray fallback).
   */
  public setWorldPose(pos: THREE.Vector3, normal?: THREE.Vector3): void {
    this.position.copy(pos);
    if (normal) {
      this.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().normalize());
    } else {
      this.quaternion.identity();
    }
    this.scale.set(1, 1, 1);
    this.updateMatrix();
    this.visible = true;
  }

  /**
   * Highlights the reticle in emerald green when snapped to corner #1 or 90° orthogonal.
   */
  public setSnapped(snapped: boolean): void {
    if (this.isSnapped === snapped) return;
    this.isSnapped = snapped;
    if (snapped) {
      this.ringMaterial.color.setHex(0x10b981);
      this.pulseMaterial.color.setHex(0x34d399);
      this.normalMaterial.color.setHex(0x10b981);
    } else {
      this.ringMaterial.color.setHex(0x00f2fe);
      this.pulseMaterial.color.setHex(0x38bdf8);
      this.normalMaterial.color.setHex(0x00f2fe);
    }
  }

  /**
   * Animated pulsing effect to give tactile visual feedback that tracking is active.
   */
  public updateAnimation(deltaTime: number): void {
    if (!this.visible) return;

    this.pulseTime += deltaTime * 3.5;
    const baseScale = this.isSnapped ? 1.15 : 1.0;
    const pulseScale = baseScale + Math.sin(this.pulseTime) * 0.18;
    const pulseOpacity = 0.4 + (Math.sin(this.pulseTime) + 1) * 0.25;

    this.pulseRing.scale.set(pulseScale, pulseScale, pulseScale);
    this.pulseMaterial.opacity = pulseOpacity;
  }

  /**
   * Returns current world position of the reticle center.
   */
  public getWorldPositionTarget(): THREE.Vector3 {
    const pos = new THREE.Vector3();
    this.getWorldPosition(pos);
    return pos;
  }

  /**
   * Returns current surface normal vector based on orientation.
   */
  public getSurfaceNormal(): THREE.Vector3 {
    const normal = new THREE.Vector3(0, 1, 0);
    normal.applyQuaternion(this.quaternion);
    return normal.normalize();
  }
}
