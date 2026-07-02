import * as THREE from "three";

const MUZZLE_FLASH_DURATION_MS = 55;
const TRACER_DURATION_MS = 90;
const TRACER_RADIUS = 0.015;

/**
 * Small bright sprite parented to the camera so it moves/rotates with it for
 * free, positioned roughly where a gun muzzle would sit. No real weapon
 * viewmodel yet (that's a polish-pass item) — this alone reads fine as
 * fire feedback.
 */
export class MuzzleFlashEffect {
  private sprite: THREE.Sprite;
  private remainingMs = 0;

  constructor(private camera: THREE.Camera) {
    const material = new THREE.SpriteMaterial({
      color: 0xfff2b0,
      transparent: true,
      opacity: 1,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.sprite = new THREE.Sprite(material);
    this.sprite.scale.set(0.18, 0.18, 0.18);
    this.sprite.position.set(0.22, -0.16, -0.5);
    this.sprite.visible = false;
    this.sprite.renderOrder = 999;
    camera.add(this.sprite);
  }

  trigger(): void {
    this.remainingMs = MUZZLE_FLASH_DURATION_MS;
    this.sprite.visible = true;
    this.sprite.material.opacity = 1;
    this.sprite.material.rotation = Math.random() * Math.PI;
  }

  update(dtMs: number): void {
    if (this.remainingMs <= 0) return;
    this.remainingMs -= dtMs;
    if (this.remainingMs <= 0) {
      this.sprite.visible = false;
      return;
    }
    this.sprite.material.opacity = this.remainingMs / MUZZLE_FLASH_DURATION_MS;
  }
}

interface ActiveTracer {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  remainingMs: number;
}

/**
 * Thin cylinder tracers (not THREE.Line — line width is ignored on most
 * browsers/ANGLE backends, so a stretched cylinder is what actually reads
 * as a visible tracer) that fade out and self-remove.
 */
export class TracerPool {
  private geometry = new THREE.CylinderGeometry(TRACER_RADIUS, TRACER_RADIUS, 1, 6, 1, true);
  private active: ActiveTracer[] = [];
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private scene: THREE.Scene) {}

  spawn(from: THREE.Vector3, to: THREE.Vector3): void {
    const dir = new THREE.Vector3().subVectors(to, from);
    const length = dir.length();
    if (length < 1e-4) return;
    dir.normalize();

    const material = new THREE.MeshBasicMaterial({
      color: 0xfff6c8,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.scale.set(1, length, 1);
    mesh.position.copy(from).addScaledVector(dir, length / 2);
    mesh.quaternion.setFromUnitVectors(this.up, dir);
    this.scene.add(mesh);

    this.active.push({ mesh, material, remainingMs: TRACER_DURATION_MS });
  }

  update(dtMs: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const t = this.active[i];
      t.remainingMs -= dtMs;
      if (t.remainingMs <= 0) {
        this.scene.remove(t.mesh);
        t.material.dispose();
        this.active.splice(i, 1);
        continue;
      }
      t.material.opacity = 0.9 * (t.remainingMs / TRACER_DURATION_MS);
    }
  }
}

/**
 * Trauma-based screen shake plus a directional recoil kick, combined into
 * one offset so the caller (main.ts) just adds a single {yaw,pitch,roll} to
 * the camera each frame:
 *  - trauma: random jitter that decays over time, scaled by trauma^2 so
 *    small amounts are barely noticeable but stacking hits (e.g. rapid SMG
 *    fire) ramp up quickly — capped low per the "subtle, not nauseating"
 *    requirement.
 *  - kick: a directional "gun pushes the view up" impulse per shot that
 *    springs back down afterward. Separate from trauma because it needs to
 *    read as an intentional recoil pattern, not random noise — this is what
 *    actually gives weapons a sense of weight when fired.
 */
export class ScreenShake {
  private trauma = 0;
  private kickPitch = 0;
  offsetYaw = 0;
  offsetPitch = 0;
  offsetRoll = 0;

  private readonly decayPerSecond = 3.2;
  private readonly kickRecoverPerSecond = 14;
  private readonly maxYaw = 0.012;
  private readonly maxPitch = 0.01;
  private readonly maxRoll = 0.008;

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Positive amount kicks the view UP (negative pitch), matching real
   * recoil — it springs back down over the next few frames. */
  addKick(amount: number): void {
    this.kickPitch -= amount;
  }

  update(dt: number): void {
    if (this.trauma <= 0) {
      this.offsetYaw = this.offsetRoll = 0;
    } else {
      this.trauma = Math.max(0, this.trauma - this.decayPerSecond * dt);
      const shake = this.trauma * this.trauma;
      this.offsetYaw = this.maxYaw * shake * (Math.random() * 2 - 1);
      this.offsetRoll = this.maxRoll * shake * (Math.random() * 2 - 1);
    }

    const shakePitch = this.trauma > 0 ? this.maxPitch * this.trauma * this.trauma * (Math.random() * 2 - 1) : 0;
    this.kickPitch += (0 - this.kickPitch) * Math.min(1, this.kickRecoverPerSecond * dt);
    this.offsetPitch = shakePitch + this.kickPitch;
  }
}
