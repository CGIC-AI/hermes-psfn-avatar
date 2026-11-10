/**
 * Built-in articulated 3D Persephone Holo-Rig (pure Three.js, zero external assets).
 *
 * Exposes the exact same humanoid bone hierarchy (`getBoneNode`), `expressionManager`,
 * and ear/tail accessory pivots as a loaded VRM 1.0 model, so all 42 baked ARDY
 * motion clips, 27 mood expression envelopes, and speech lip-sync work immediately
 * out of the box before the user even uploads a `.vrm` or `.glb` file.
 */

import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { ExpressionAdapter } from './companion-player.ts';
import { disposeAvatarScenes } from './load-avatar.ts';

export interface HoloAvatarHandle {
  readonly scene: Group;
  readonly getBoneNode: (name: string) => Object3D | null;
  readonly expressionManager: ExpressionAdapter;
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

const POSITIVE_MOODS: Readonly<Record<string, number>> = {
  happy: 1,
  joy: 1,
  amusement: 1,
  excitement: 1,
  love: 1,
  admiration: 0.8,
  gratitude: 0.85,
  optimism: 0.75,
  pride: 0.8,
  approval: 0.65,
  caring: 0.75,
  relief: 0.6,
};

const NEGATIVE_MOODS: Readonly<Record<string, number>> = {
  sad: 1,
  sadness: 1,
  grief: 1,
  disappointment: 0.85,
  remorse: 0.8,
  fear: 0.75,
  nervousness: 0.65,
};

const ANGRY_MOODS: Readonly<Record<string, number>> = {
  angry: 1,
  anger: 1,
  annoyance: 0.85,
  disapproval: 0.75,
  disgust: 0.8,
};

const SURPRISED_MOODS: Readonly<Record<string, number>> = {
  surprised: 1,
  surprise: 1,
  realization: 0.85,
  curiosity: 0.65,
  confusion: 0.55,
};

const BLUSH_MOODS: Readonly<Record<string, number>> = {
  love: 1,
  embarrassment: 1,
  desire: 0.85,
  joy: 0.55,
  gratitude: 0.5,
  caring: 0.5,
};

export function createHoloAvatar(): HoloAvatarHandle {
  const root = new Group();
  root.name = 'PersephoneHoloRig';

  const bones = new Map<string, Object3D>();
  function makeBone(name: string, parent: Object3D, x: number, y: number, z: number): Object3D {
    const node = new Object3D();
    node.name = name;
    node.position.set(x, y, z);
    parent.add(node);
    bones.set(name, node);
    return node;
  }

  // Materials — stylized cel/cyberpunk porcelain + obsidian + glowing cyan/rose accents
  const bodyMat = new MeshStandardMaterial({
    color: new Color(0x1b2234),
    roughness: 0.35,
    metalness: 0.25,
  });
  const skinMat = new MeshStandardMaterial({
    color: new Color(0xf4e8e1),
    roughness: 0.45,
    metalness: 0.05,
  });
  const hairMat = new MeshStandardMaterial({
    color: new Color(0x281e3d),
    roughness: 0.4,
    metalness: 0.2,
    emissive: new Color(0x160d29),
    emissiveIntensity: 0.35,
  });
  const trimMat = new MeshStandardMaterial({
    color: new Color(0x5eead4),
    emissive: new Color(0x2dd4bf),
    emissiveIntensity: 0.75,
    roughness: 0.2,
    metalness: 0.5,
  });
  const eyeMat = new MeshStandardMaterial({
    color: new Color(0x38bdf8),
    emissive: new Color(0x38bdf8),
    emissiveIntensity: 1.15,
    roughness: 0.15,
  });
  const mouthMat = new MeshStandardMaterial({
    color: new Color(0xf472b6),
    emissive: new Color(0xec4899),
    emissiveIntensity: 0.85,
    roughness: 0.25,
  });
  const blushMat = new MeshStandardMaterial({
    color: new Color(0xfb7185),
    emissive: new Color(0xf43f5e),
    emissiveIntensity: 0.9,
    transparent: true,
    opacity: 0,
  });

  // ── Skeleton (matches VRM 1.0 & ARDY Core-27 T-pose at hips y = 0.94m, facing +Z) ──
  const hips = makeBone('hips', root, 0, 0.94, 0);
  const spine = makeBone('spine', hips, 0, 0.11, 0);
  const chest = makeBone('chest', spine, 0, 0.13, 0);
  const upperChest = makeBone('upperChest', chest, 0, 0.12, 0);
  const neck = makeBone('neck', upperChest, 0, 0.11, 0);
  const head = makeBone('head', neck, 0, 0.07, 0);

  // Left arm (+X in facing-+Z space)
  const leftShoulder = makeBone('leftShoulder', upperChest, 0.05, 0.06, 0);
  const leftUpperArm = makeBone('leftUpperArm', leftShoulder, 0.09, 0, 0);
  const leftLowerArm = makeBone('leftLowerArm', leftUpperArm, 0.23, 0, 0);
  const leftHand = makeBone('leftHand', leftLowerArm, 0.21, 0, 0);
  makeBone('leftThumbMetacarpal', leftHand, 0.03, -0.01, 0.03);

  // Right arm (-X in facing-+Z space)
  const rightShoulder = makeBone('rightShoulder', upperChest, -0.05, 0.06, 0);
  const rightUpperArm = makeBone('rightUpperArm', rightShoulder, -0.09, 0, 0);
  const rightLowerArm = makeBone('rightLowerArm', rightUpperArm, -0.23, 0, 0);
  const rightHand = makeBone('rightHand', rightLowerArm, -0.21, 0, 0);
  makeBone('rightThumbMetacarpal', rightHand, -0.03, -0.01, 0.03);

  // Legs
  const leftUpperLeg = makeBone('leftUpperLeg', hips, 0.09, -0.04, 0);
  const leftLowerLeg = makeBone('leftLowerLeg', leftUpperLeg, 0, -0.42, 0);
  const leftFoot = makeBone('leftFoot', leftLowerLeg, 0, -0.41, 0.03);
  makeBone('leftToes', leftFoot, 0, -0.03, 0.08);

  const rightUpperLeg = makeBone('rightUpperLeg', hips, -0.09, -0.04, 0);
  const rightLowerLeg = makeBone('rightLowerLeg', rightUpperLeg, 0, -0.42, 0);
  const rightFoot = makeBone('rightFoot', rightLowerLeg, 0, -0.41, 0.03);
  makeBone('rightToes', rightFoot, 0, -0.03, 0.08);

  // ── Torso & Pelvis Meshes ──
  const pelvisMesh = new Mesh(new CapsuleGeometry(0.11, 0.07, 8, 16), bodyMat);
  pelvisMesh.position.set(0, 0.02, 0);
  hips.add(pelvisMesh);

  const waistMesh = new Mesh(new CylinderGeometry(0.105, 0.095, 0.16, 16), bodyMat);
  waistMesh.position.set(0, 0.06, 0);
  spine.add(waistMesh);

  const chestMesh = new Mesh(new CapsuleGeometry(0.125, 0.14, 10, 20), bodyMat);
  chestMesh.position.set(0, 0.08, 0.01);
  chest.add(chestMesh);

  // Glowing core emblem on chest
  const coreGem = new Mesh(new TorusGeometry(0.036, 0.007, 12, 24), trimMat);
  coreGem.position.set(0, 0.04, 0.122);
  upperChest.add(coreGem);

  const collarRing = new Mesh(new TorusGeometry(0.075, 0.008, 10, 24), trimMat);
  collarRing.rotation.x = Math.PI / 2;
  collarRing.position.set(0, 0.08, 0);
  upperChest.add(collarRing);

  const neckMesh = new Mesh(new CylinderGeometry(0.042, 0.048, 0.09, 14), skinMat);
  neckMesh.position.set(0, 0.035, 0);
  neck.add(neckMesh);

  // ── Head, Hair, Face, Cyber-Ears & Halo ──
  const headSphere = new Mesh(new SphereGeometry(0.125, 24, 24), skinMat);
  headSphere.scale.set(0.95, 1.06, 0.96);
  headSphere.position.set(0, 0.11, 0);
  head.add(headSphere);

  // Back hair shell + side locks
  const hairCap = new Mesh(new SphereGeometry(0.134, 24, 20), hairMat);
  hairCap.scale.set(0.98, 1.06, 1.0);
  hairCap.position.set(0, 0.125, -0.012);
  head.add(hairCap);

  const leftSideLock = new Mesh(new CapsuleGeometry(0.026, 0.16, 6, 12), hairMat);
  leftSideLock.position.set(0.105, 0.03, 0.055);
  leftSideLock.rotation.z = 0.12;
  head.add(leftSideLock);

  const rightSideLock = new Mesh(new CapsuleGeometry(0.026, 0.16, 6, 12), hairMat);
  rightSideLock.position.set(-0.105, 0.03, 0.055);
  rightSideLock.rotation.z = -0.12;
  head.add(rightSideLock);

  // Visor band across forehead
  const headband = new Mesh(new TorusGeometry(0.124, 0.008, 10, 28, Math.PI), trimMat);
  headband.rotation.x = Math.PI / 2;
  headband.rotation.z = -Math.PI / 2;
  headband.position.set(0, 0.175, 0.01);
  head.add(headband);

  // Expressive Eyes (+Z face)
  const leftEye = new Mesh(new CapsuleGeometry(0.016, 0.016, 8, 12), eyeMat);
  leftEye.position.set(0.044, 0.11, 0.112);
  head.add(leftEye);

  const rightEye = new Mesh(new CapsuleGeometry(0.016, 0.016, 8, 12), eyeMat);
  rightEye.position.set(-0.044, 0.11, 0.112);
  head.add(rightEye);

  // Brows
  const browGeo = new BoxGeometry(0.036, 0.006, 0.008);
  const leftBrow = new Mesh(browGeo, trimMat);
  leftBrow.position.set(0.044, 0.145, 0.114);
  head.add(leftBrow);

  const rightBrow = new Mesh(browGeo, trimMat);
  rightBrow.position.set(-0.044, 0.145, 0.114);
  head.add(rightBrow);

  // Blush cheeks
  const cheekGeo = new SphereGeometry(0.018, 12, 12);
  const leftBlush = new Mesh(cheekGeo, blushMat);
  leftBlush.scale.set(1.3, 0.65, 0.3);
  leftBlush.position.set(0.064, 0.082, 0.105);
  head.add(leftBlush);

  const rightBlush = new Mesh(cheekGeo, blushMat);
  rightBlush.scale.set(1.3, 0.65, 0.3);
  rightBlush.position.set(-0.064, 0.082, 0.105);
  head.add(rightBlush);

  // Mouth (scales with `aa` lip-sync and mood)
  const mouthMesh = new Mesh(new CapsuleGeometry(0.008, 0.022, 8, 12), mouthMat);
  mouthMesh.rotation.z = Math.PI / 2;
  mouthMesh.position.set(0, 0.058, 0.113);
  head.add(mouthMesh);

  // Articulated Companion Ears (react to 27 moods like companion-motion.js!)
  const leftEarPivot = new Object3D();
  leftEarPivot.position.set(0.082, 0.22, 0.0);
  head.add(leftEarPivot);
  const leftEarCone = new Mesh(new ConeGeometry(0.036, 0.11, 12), hairMat);
  leftEarCone.position.set(0, 0.05, 0);
  leftEarPivot.add(leftEarCone);
  const leftEarInner = new Mesh(new ConeGeometry(0.018, 0.08, 10), trimMat);
  leftEarInner.position.set(0, 0.048, 0.012);
  leftEarPivot.add(leftEarInner);

  const rightEarPivot = new Object3D();
  rightEarPivot.position.set(-0.082, 0.22, 0.0);
  head.add(rightEarPivot);
  const rightEarCone = new Mesh(new ConeGeometry(0.036, 0.11, 12), hairMat);
  rightEarCone.position.set(0, 0.05, 0);
  rightEarPivot.add(rightEarCone);
  const rightEarInner = new Mesh(new ConeGeometry(0.018, 0.08, 10), trimMat);
  rightEarInner.position.set(0, 0.048, 0.012);
  rightEarPivot.add(rightEarInner);

  // Floating Holo-Halo
  const haloRing = new Mesh(new TorusGeometry(0.095, 0.005, 10, 32), trimMat);
  haloRing.rotation.x = Math.PI / 2 - 0.18;
  haloRing.position.set(0, 0.31, -0.01);
  head.add(haloRing);

  // Articulated Tail on Hips
  const tailPivot = new Object3D();
  tailPivot.position.set(0, 0.02, -0.1);
  hips.add(tailPivot);
  const tailSeg = new Mesh(new CapsuleGeometry(0.018, 0.26, 8, 12), hairMat);
  tailSeg.rotation.x = -0.9;
  tailSeg.position.set(0, -0.06, -0.12);
  tailPivot.add(tailSeg);

  // ── Limb Segments (aligned along +X for Left, -X for Right in T-pose) ──
  function addHorizontalLimb(parent: Object3D, dir: 1 | -1, length: number, r: number, mat: MeshStandardMaterial) {
    const mesh = new Mesh(new CapsuleGeometry(r, Math.max(0.02, length - r * 2), 8, 14), mat);
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set((dir * length) / 2, 0, 0);
    parent.add(mesh);
  }
  addHorizontalLimb(leftUpperArm, 1, 0.22, 0.038, bodyMat);
  addHorizontalLimb(leftLowerArm, 1, 0.20, 0.032, skinMat);
  addHorizontalLimb(rightUpperArm, -1, 0.22, 0.038, bodyMat);
  addHorizontalLimb(rightLowerArm, -1, 0.20, 0.032, skinMat);

  const handGeo = new SphereGeometry(0.036, 12, 12);
  const lHandMesh = new Mesh(handGeo, skinMat);
  lHandMesh.position.set(0.025, 0, 0);
  leftHand.add(lHandMesh);
  const rHandMesh = new Mesh(handGeo, skinMat);
  rHandMesh.position.set(-0.025, 0, 0);
  rightHand.add(rHandMesh);

  function addVerticalLimb(parent: Object3D, length: number, r: number, mat: MeshStandardMaterial) {
    const mesh = new Mesh(new CapsuleGeometry(r, Math.max(0.04, length - r * 2), 8, 14), mat);
    mesh.position.set(0, -length / 2, 0);
    parent.add(mesh);
  }
  addVerticalLimb(leftUpperLeg, 0.41, 0.056, bodyMat);
  addVerticalLimb(leftLowerLeg, 0.40, 0.044, bodyMat);
  addVerticalLimb(rightUpperLeg, 0.41, 0.056, bodyMat);
  addVerticalLimb(rightLowerLeg, 0.40, 0.044, bodyMat);

  root.updateMatrixWorld(true);

  // ── Expression state ──
  const expressions = new Map<string, number>();
  const expressionManager: ExpressionAdapter = {
    getValue(name: string): number {
      return expressions.get(name.toLowerCase()) ?? 0;
    },
    setValue(name: string, value: number): void {
      const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      expressions.set(name.toLowerCase(), clamped);
    },
    resetValues(): void {
      expressions.clear();
    },
  };

  return {
    scene: root,
    getBoneNode(name: string): Object3D | null {
      return bones.get(name) ?? null;
    },
    expressionManager,
    update(dt: number, elapsed: number): void {
      void dt;
      const blink = expressions.get('blink') ?? 0;
      const aa = expressions.get('aa') ?? 0;

      let posWeight = 0;
      let negWeight = 0;
      let angryWeight = 0;
      let surprisedWeight = 0;
      let blushWeight = 0;

      for (const [k, w] of expressions) {
        if (!w) continue;
        if (POSITIVE_MOODS[k]) posWeight = Math.max(posWeight, w * POSITIVE_MOODS[k]!);
        if (NEGATIVE_MOODS[k]) negWeight = Math.max(negWeight, w * NEGATIVE_MOODS[k]!);
        if (ANGRY_MOODS[k]) angryWeight = Math.max(angryWeight, w * ANGRY_MOODS[k]!);
        if (SURPRISED_MOODS[k]) surprisedWeight = Math.max(surprisedWeight, w * SURPRISED_MOODS[k]!);
        if (BLUSH_MOODS[k]) blushWeight = Math.max(blushWeight, w * BLUSH_MOODS[k]!);
      }

      // Eye vertical scale (blink + happy squint + surprised wide)
      const eyeOpen = Math.max(0.08, (1 - blink * 0.92) * (1 - posWeight * 0.35 + surprisedWeight * 0.28));
      leftEye.scale.set(1 + posWeight * 0.15, eyeOpen, 1);
      rightEye.scale.set(1 + posWeight * 0.15, eyeOpen, 1);

      // Brow angles
      const browTilt = posWeight * 0.18 - negWeight * 0.28 + angryWeight * 0.38;
      const browLift = surprisedWeight * 0.012 + posWeight * 0.006 - angryWeight * 0.008;
      leftBrow.rotation.z = -browTilt;
      rightBrow.rotation.z = browTilt;
      leftBrow.position.y = 0.145 + browLift;
      rightBrow.position.y = 0.145 + browLift;

      // Mouth lip-sync (`aa`) + smile width
      const mouthOpenY = 1 + aa * 2.6 + surprisedWeight * 0.8;
      const mouthWidthX = 1 + posWeight * 0.35 - surprisedWeight * 0.25;
      mouthMesh.scale.set(mouthOpenY, mouthWidthX, 1);

      // Cheek blush opacity
      blushMat.opacity = MathUtils.clamp(blushWeight * 0.72, 0, 0.75);

      // Ear pivots + tail sway (driven by mood weights + gentle idle sine)
      const earPerk = posWeight * 0.22 + surprisedWeight * 0.28 - negWeight * 0.42 - angryWeight * 0.32;
      const earFlutter = Math.sin(elapsed * 2.4) * 0.04;
      leftEarPivot.rotation.z = -0.22 + earPerk + earFlutter;
      rightEarPivot.rotation.z = 0.22 - earPerk - earFlutter;
      leftEarPivot.rotation.x = negWeight * -0.25 + surprisedWeight * 0.15;
      rightEarPivot.rotation.x = negWeight * -0.25 + surprisedWeight * 0.15;

      const tailSpeed = 1.8 + posWeight * 3.2 + angryWeight * 2.5;
      const tailAmp = 0.18 + posWeight * 0.28;
      tailPivot.rotation.y = Math.sin(elapsed * tailSpeed) * tailAmp;
      tailPivot.rotation.x = posWeight * 0.25 - negWeight * 0.3;

      // Halo gentle hover & spin
      haloRing.position.y = 0.31 + Math.sin(elapsed * 2.0) * 0.008;
      haloRing.rotation.z = elapsed * 0.6;
    },
    dispose(): void {
      disposeAvatarScenes([root]);
    },
  };
}
