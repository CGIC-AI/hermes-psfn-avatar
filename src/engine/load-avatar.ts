/**
 * VRM 0.x / 1.0 and GLB loader + resource disposal.
 * Ported from psfn-framework companion-ui/src/lib/avatar/{local-model,resources,load-avatar}.ts.
 * Meshopt WASM decoder is omitted so the bundle contains zero WebAssembly binaries (Catalog Rule 17).
 */

import {
  BufferAttribute,
  BufferGeometry,
  Line,
  LoadingManager,
  Material,
  Mesh,
  Points,
  ShaderMaterial,
  Skeleton,
  SkinnedMesh,
  Texture,
  type Object3D,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const LOCAL_MODEL_BYTES = 128 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const EMBEDDED_RESOURCE =
  /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp|avif));base64,[a-zA-Z0-9+/]*={0,2}$/;

const MODEL_EXTENSIONS: Readonly<Record<string, true>> = {
  VRM: true,
  VRMC_vrm: true,
  VRMC_springBone: true,
  VRMC_node_constraint: true,
  VRMC_materials_mtoon: true,
  VRMC_materials_hdr_emissiveMultiplier: true,
  KHR_lights_punctual: true,
  KHR_materials_anisotropy: true,
  KHR_materials_clearcoat: true,
  KHR_materials_dispersion: true,
  KHR_materials_emissive_strength: true,
  KHR_materials_ior: true,
  KHR_materials_iridescence: true,
  KHR_materials_sheen: true,
  KHR_materials_specular: true,
  KHR_materials_unlit: true,
  KHR_materials_transmission: true,
  KHR_materials_volume: true,
  KHR_mesh_quantization: true,
  KHR_texture_transform: true,
  EXT_materials_bump: true,
  EXT_mesh_gpu_instancing: true,
  EXT_texture_avif: true,
  EXT_texture_webp: true,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class LocalAvatarError extends Error {
  override name = 'LocalAvatarError';
}

export function validateLocalAvatarFile(file: { name: string; size: number }): void {
  if (!/\.(?:vrm|glb)$/i.test(file.name)) {
    throw new LocalAvatarError('Choose a .vrm or .glb model with its textures embedded.');
  }
  if (file.size === 0 || file.size > LOCAL_MODEL_BYTES) {
    throw new LocalAvatarError('Choose a non-empty model smaller than 128 MB.');
  }
}

export function inspectLocalAvatar(data: ArrayBuffer): { hasVrm: boolean } {
  const view = new DataView(data);
  if (
    data.byteLength < 20 ||
    data.byteLength > LOCAL_MODEL_BYTES ||
    view.getUint32(0, true) !== GLB_MAGIC ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== data.byteLength
  ) {
    throw new LocalAvatarError('This file is not a valid binary VRM or GLB model.');
  }
  let document: unknown;
  let offset = 12;
  let hasBinary = false;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) {
      throw new LocalAvatarError('The model contains a truncated chunk.');
    }
    const length = view.getUint32(offset, true);
    const kind = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (length % 4 !== 0 || end > data.byteLength) {
      throw new LocalAvatarError('The model contains a damaged chunk.');
    }
    if (offset === 12 && kind !== JSON_CHUNK) {
      throw new LocalAvatarError('The model is missing its description.');
    }
    if (kind === JSON_CHUNK) {
      if (document !== undefined) {
        throw new LocalAvatarError('The model contains duplicate descriptions.');
      }
      try {
        document = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data, offset + 8, length)),
        );
      } catch {
        throw new LocalAvatarError('The model description is not valid JSON.');
      }
    } else if (kind === BIN_CHUNK) {
      if (hasBinary) {
        throw new LocalAvatarError('The model contains duplicate binary data.');
      }
      hasBinary = true;
    }
    offset = end;
  }
  if (!isRecord(document) || !isRecord(document.asset) || document.asset.version !== '2.0') {
    throw new LocalAvatarError('This player supports glTF 2.0 models only.');
  }

  const pending: unknown[] = [document];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
    } else if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'uri' && (typeof child !== 'string' || !EMBEDDED_RESOURCE.test(child))) {
          throw new LocalAvatarError(
            'This model references external files. Export a VRM or GLB with embedded textures and buffers.',
          );
        }
        if (typeof child === 'object' && child !== null) pending.push(child);
      }
    }
  }
  const required = document.extensionsRequired;
  if (
    required !== undefined &&
    (!Array.isArray(required) || required.some((value) => typeof value !== 'string'))
  ) {
    throw new LocalAvatarError('The model has an invalid extension list.');
  }
  if (
    Array.isArray(required) &&
    required.some((value) => value === 'KHR_draco_mesh_compression' || value === 'KHR_texture_basisu')
  ) {
    throw new LocalAvatarError(
      'Re-export this model without Draco geometry or KTX2 textures to use it here.',
    );
  }
  if (Array.isArray(required) && required.some((value) => !MODEL_EXTENSIONS[value])) {
    throw new LocalAvatarError(
      'This model requires an unsupported extension. Try a standard VRM or GLB export.',
    );
  }
  return {
    hasVrm:
      isRecord(document.extensions) &&
      ('VRM' in document.extensions || 'VRMC_vrm' in document.extensions),
  };
}

export function localAvatarResourceUrl(url: string): string {
  if (url.startsWith('blob:') || EMBEDDED_RESOURCE.test(url)) return url;
  throw new LocalAvatarError('The model attempted to load an external resource.');
}

export function disposeAvatarScenes(roots: readonly Object3D[]): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<Skeleton>();
  for (const root of roots) {
    root.traverse((object) => {
      if (object instanceof Mesh || object instanceof Line || object instanceof Points) {
        geometries.add(object.geometry);
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) {
          if (material) materials.add(material);
        }
      }
      if (object instanceof SkinnedMesh && object.skeleton) {
        skeletons.add(object.skeleton);
      }
    });
    root.removeFromParent();
  }
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof Texture) textures.add(value);
    }
    if (material instanceof ShaderMaterial) {
      for (const uniform of Object.values(material.uniforms)) {
        if (uniform?.value instanceof Texture) textures.add(uniform.value);
      }
    }
    material.dispose();
  }
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    const image: unknown = texture.source?.data;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
      images.add(image);
    }
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

export async function loadAvatarFromArrayBuffer(
  data: ArrayBuffer,
  signal?: AbortSignal,
): Promise<{ gltf: GLTF; vrm: VRM | null }> {
  signal?.throwIfAborted();
  const { hasVrm } = inspectLocalAvatar(data);
  const blobs = new Set<string>();
  const manager = new LoadingManager();
  let failedResource = false;
  manager.onError = () => {
    failedResource = true;
  };
  manager.setURLModifier((url) => {
    const safeUrl = localAvatarResourceUrl(url);
    if (safeUrl.startsWith('blob:')) blobs.add(safeUrl);
    return safeUrl;
  });
  const loader = new GLTFLoader(manager);
  let gltf: GLTF | undefined;
  loader.register(() => ({
    name: 'LocalAvatarResources',
    afterRoot(result) {
      gltf = result;
      return null;
    },
  }));
  loader.register((parser) => new VRMLoaderPlugin(parser));
  try {
    gltf = await loader.parseAsync(data, '');
    signal?.throwIfAborted();
    if (failedResource) {
      throw new LocalAvatarError(
        'A model texture or buffer could not be decoded. Try re-exporting the model.',
      );
    }
    const vrm = gltf.userData.vrm instanceof VRM ? gltf.userData.vrm : null;
    if (hasVrm && !vrm) {
      throw new LocalAvatarError('The VRM is missing a supported humanoid or model description.');
    }
    if (vrm) {
      VRMUtils.rotateVRM0(vrm);
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      // combineSkeletons rewrites skinIndex in place; glTF stores it as 8-bit when a
      // primitive touches <256 joints, which overflows once the merged skeleton is larger.
      vrm.scene.traverse((object) => {
        if (!(object instanceof SkinnedMesh)) return;
        const skinIndex = object.geometry.getAttribute('skinIndex');
        if (skinIndex instanceof BufferAttribute && skinIndex.array instanceof Uint8Array) {
          object.geometry.setAttribute(
            'skinIndex',
            new BufferAttribute(new Uint16Array(skinIndex.array), skinIndex.itemSize),
          );
        }
      });
      VRMUtils.combineSkeletons(vrm.scene);
      if (gltf.animations.length === 0) VRMUtils.combineMorphs(vrm);
      vrm.scene.traverse((object) => {
        object.frustumCulled = false;
      });
    }
    return { gltf, vrm };
  } catch (error) {
    if (gltf) disposeAvatarScenes(gltf.scenes);
    throw error;
  } finally {
    for (const url of blobs) URL.revokeObjectURL(url);
  }
}
