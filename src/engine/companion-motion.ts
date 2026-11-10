/**
 * VRM expressions bind face morphs; optional psfn.companion-motion/1 application
 * data drives ear/tail accessory pivots while leaving standard VRMs loadable.
 * Ported from /home/vega/Projects/psfn/avatar-demo/companion-motion.js.
 */

import { Object3D, Quaternion } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { VRM } from '@pixiv/three-vrm';
import { isRecord } from './load-avatar.ts';

const ALIASES: Readonly<Record<string, string>> = {
  happy: 'joy',
  angry: 'anger',
  sad: 'sadness',
  relaxed: 'relief',
  surprised: 'surprise',
};

export interface CompanionMotionHandle {
  readonly moodNames: readonly string[];
  readonly controlledBones: readonly string[];
  update(dt: number): void;
}

export async function createCompanionMotion(gltf: GLTF): Promise<CompanionMotionHandle | null> {
  const parserObj = 'parser' in gltf && isRecord(gltf.parser) ? gltf.parser : null;
  const jsonObj = parserObj && isRecord(parserObj.json) ? parserObj.json : null;
  const extras = jsonObj && isRecord(jsonObj.extras) ? jsonObj.extras : null;
  const data = extras && isRecord(extras.psfnCompanion) ? extras.psfnCompanion : null;
  const getDep =
    parserObj && typeof parserObj.getDependency === 'function'
      ? (parserObj.getDependency.bind(parserObj) as (type: string, index: number) => Promise<Object3D>)
      : null;
  if (!data) return null;
  if (data.schema !== 'psfn.companion-motion/1') {
    throw new Error('Unsupported companion motion data');
  }
  const vrm = gltf.userData?.vrm as VRM | undefined;
  if (!vrm || !isRecord(data.bones) || !isRecord(data.poses)) return null;

  const controls: Array<{
    name: string;
    bone: Object3D;
    pivot: Object3D;
    rest: Quaternion;
    inverseRest: Quaternion;
    poses: Map<string, Quaternion>;
  }> = [];
  const wrappers = new Map<Object3D, Object3D>();

  for (const [name, rawItem] of Object.entries(data.bones)) {
    if (
      !isRecord(rawItem) ||
      typeof rawItem.node !== 'number' ||
      !Number.isInteger(rawItem.node) ||
      !Array.isArray(rawItem.rest) ||
      rawItem.rest.length !== 4 ||
      !getDep
    ) {
      throw new Error(`Invalid accessory bone: ${name}`);
    }
    const bone = await getDep('node', rawItem.node);
    const rest = new Quaternion().fromArray(rawItem.rest as number[]).normalize();
    const poses = new Map<string, Quaternion>();
    for (const [mood, rawPose] of Object.entries(data.poses)) {
      const q = isRecord(rawPose) ? rawPose[name] : null;
      if (!Array.isArray(q) || q.length !== 4 || !q.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new Error(`Invalid accessory pose: ${mood}/${name}`);
      }
      poses.set(mood, new Quaternion().fromArray(q as number[]).normalize());
    }
    const pivot = new Object3D();
    pivot.name = `Expression pivot — ${name}`;
    pivot.position.copy(bone.position);
    bone.parent?.add(pivot);
    pivot.add(bone);
    bone.position.set(0, 0, 0);
    bone.updateMatrix();
    wrappers.set(bone, pivot);
    controls.push({
      name,
      bone,
      pivot,
      rest,
      inverseRest: rest.clone().invert(),
      poses,
    });
  }

  const springs = vrm.springBoneManager;
  if (springs) {
    for (const joint of [...springs.joints]) {
      const wrapped = wrappers.get(joint.child);
      if (wrapped) joint.child = wrapped;
      springs.deleteJoint(joint);
      springs.addJoint(joint);
    }
    vrm.scene.updateMatrixWorld(true);
    springs.setInitState();
  }

  const target = new Quaternion();
  const mix = new Quaternion();
  const moodNames = Object.keys(data.poses);

  return {
    moodNames,
    controlledBones: controls.map((c) => c.name),
    update(dt: number) {
      const weights = new Map<string, number>();
      for (const mood of moodNames) {
        const raw = vrm.expressionManager?.getValue(mood) ?? 0;
        weights.set(mood, Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0);
      }
      for (const [alias, mood] of Object.entries(ALIASES)) {
        const raw = vrm.expressionManager?.getValue(alias) ?? 0;
        const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
        weights.set(mood, Math.max(weights.get(mood) ?? 0, clamped));
      }
      let sum = 0;
      for (const w of weights.values()) sum += w;
      const scale = 1 / Math.max(1, sum);
      const neutralWeight = Math.max(0, 1 - sum);

      for (const c of controls) {
        mix.set(
          c.rest.x * neutralWeight,
          c.rest.y * neutralWeight,
          c.rest.z * neutralWeight,
          c.rest.w * neutralWeight,
        );
        for (const [mood, w] of weights) {
          if (!w) continue;
          const q = c.poses.get(mood);
          if (!q) continue;
          const k = w * scale * (q.dot(c.rest) < 0 ? -1 : 1);
          mix.x += q.x * k;
          mix.y += q.y * k;
          mix.z += q.z * k;
          mix.w += q.w * k;
        }
        target.copy(mix).normalize().multiply(c.inverseRest);
        c.pivot.quaternion.slerp(target, dt > 0 ? 1 - Math.exp(-dt / 0.12) : 1);
        c.pivot.updateMatrix();
      }
    },
  };
}
