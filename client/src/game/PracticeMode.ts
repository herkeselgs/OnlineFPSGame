import { MapDefinition } from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { CombatSystem } from "../combat/CombatSystem";
import { Target } from "../combat/Target";
import { InputManager } from "../engine/InputManager";
import { PlayerController } from "../engine/PlayerController";
import { Hud } from "../ui/Hud";

const DUMMY_SPOTS = [
  { x: -10, y: 0.85, z: -10 },
  { x: 10, y: 0.85, z: 10 },
  { x: 0, y: 0.85, z: -9 },
];

/** Offline single-player mode from milestones 1-2 (movement + local combat
 * against practice dummies) — wrapped up so it can be started/stopped
 * cleanly alongside the multiplayer flow rather than being the only mode. */
export class PracticeMode {
  readonly player: PlayerController;
  readonly combat: CombatSystem;
  private targets: Target[] = [];

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    input: InputManager,
    private hud: Hud,
    map: MapDefinition,
    mapMeshes: THREE.Mesh[]
  ) {
    this.player = new PlayerController(map.spawns[0], map.blocks, input, map.ladders);
    this.combat = new CombatSystem(scene, camera, input, {
      onHit(killed, headshot) {
        hud.flashHitmarker(killed, headshot);
        if (killed) hud.pushFeed(headshot ? "You eliminated Dummy (headshot)" : "You eliminated Dummy");
      },
    });
    this.combat.setRaycastables([...mapMeshes]);

    for (const spot of DUMMY_SPOTS) {
      const target = new Target(scene, spot);
      this.targets.push(target);
      this.combat.addTarget(target);
    }

    soundEngine.startAmbient();
  }

  update(frameDt: number): void {
    this.player.update(frameDt);
    const eye = this.player.getEyePosition();
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.x = this.player.pitch;
    this.camera.rotation.y = this.player.yaw;
    this.camera.rotation.z = 0;
    this.combat.update(frameDt);
    this.hud.update(frameDt * 1000);
    const w = this.combat.weapon;
    this.hud.updateWeapon(w.current.name, w.currentAmmo, w.current.magazineSize, w.isReloading);
  }

  getShakeOffset(): { yaw: number; pitch: number; roll: number } {
    return this.combat.getShakeOffset();
  }

  dispose(): void {
    soundEngine.stopAmbient();
    for (const t of this.targets) t.dispose(this.scene);
    this.targets = [];
    this.combat.dispose();
  }
}
