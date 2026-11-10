import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

test('42 baked ARDY motion clips and clips.json manifest are valid', () => {
  const clipsDir = path.join(ROOT, 'clips');
  const manifest = JSON.parse(fs.readFileSync(path.join(clipsDir, 'clips.json'), 'utf8'));
  assert.equal(Array.isArray(manifest), true);
  assert.equal(manifest.length, 42);

  for (const entry of manifest) {
    const filename = path.basename(entry.url);
    const clipPath = path.join(clipsDir, filename);
    assert.equal(fs.existsSync(clipPath), true, `Missing clip file ${filename}`);
    const clip = JSON.parse(fs.readFileSync(clipPath, 'utf8'));
    assert.equal(Array.isArray(clip.bones), true);
    assert.equal(clip.bones.length, 27);
    assert.equal(clip.frames >= 2, true);
    assert.equal(clip.fps > 0, true);
    assert.equal(clip.globalQuat.length, clip.frames);
    assert.equal(clip.rootPos.length, clip.frames);
  }
});

test('3D Holo-Rig, VrmClipPlayer, CompanionPlayer mood envelopes, and emotion mapping execute end-to-end', async () => {
  // Bundle the TS engine modules in memory and import them as a data URL
  const bundled = await build({
    stdin: {
      contents: `
        export * from './src/engine/emotion-mapping.ts';
        export * from './src/engine/interactions.ts';
        export * from './src/engine/holo-avatar.ts';
        export * from './src/engine/vrm-clip-player.ts';
        export * from './src/engine/companion-player.ts';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  const code = bundled.outputFiles[0].text;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

  // 1. Emotion mapping (VAD + discrete GoEmotions override)
  assert.equal(mod.vadQuadrantBase({ valence: 0.8, arousal: 0.75, dominance: 0.2 }), 'excited');
  assert.equal(mod.vadQuadrantBase({ valence: -0.6, arousal: 0.65, dominance: -0.5 }), 'anxious');
  assert.equal(
    mod.emotionalBaseFromSnapshot({
      vector: { valence: 0.1, arousal: 0.1, dominance: 0 },
      discrete: [{ label: 'curiosity', score: 0.82 }],
    }),
    'curious',
  );

  // 2. Touch gesture classifier
  const g = mod.classifyAvatarGesture(
    { durationMs: 120, deltaX: 2, deltaY: 3, sinceLastTapMs: 900 },
    ['tap', 'drag'],
  );
  assert.equal(g, 'tap');
  assert.deepEqual(mod.mapAvatarInteraction('head', g, 120), {
    kind: 'headpat',
    region: 'head',
    durationMs: 120,
  });

  // 3. Holo-Rig + VrmClipPlayer + CompanionPlayer on real baked ARDY clips
  const holo = mod.createHoloAvatar();
  const head = holo.getBoneNode('head');
  const leftUpperArm = holo.getBoneNode('leftUpperArm');
  assert.ok(head);
  assert.ok(leftUpperArm);
  const restArmQuat = leftUpperArm.quaternion.clone();

  const clipsDir = path.join(ROOT, 'clips');
  const manifest = JSON.parse(fs.readFileSync(path.join(clipsDir, 'clips.json'), 'utf8'));
  const fetchClip = async (url) => {
    const file = path.basename(url);
    return JSON.parse(fs.readFileSync(path.join(clipsDir, file), 'utf8'));
  };

  const audio = { speechTime: null, speechLevel: 0 };
  const clipPlayer = new mod.VrmClipPlayer(
    (name) => holo.getBoneNode(name),
    holo.getBoneNode('hips').position,
    fetchClip,
  );
  const companion = new mod.CompanionPlayer(clipPlayer, holo.expressionManager, audio);
  await companion.init(manifest, true);
  await companion.select('Idle');
  companion.update(0.25, { enabled: true });
  holo.update(0.25, 0.25);

  // Verify T-pose arm rotated into relaxed idle stance
  assert.equal(leftUpperArm.quaternion.equals(restArmQuat), false);

  // Preview Joy mood clip and verify facial expression envelope rises
  await companion.preview('./clips/Joy_Mood_01.json', false);
  companion.update(0.35, { enabled: true });
  holo.update(0.35, 0.6);
  assert.equal(holo.expressionManager.getValue('joy') > 0.5, true);

  // Simulate speaking and verify `aa` lip-sync weight rises
  audio.speechTime = 0.2;
  audio.speechLevel = 0.85;
  companion.update(0.1, { enabled: true });
  assert.equal(holo.expressionManager.getValue('aa') > 0.3, true);

  companion.dispose();
  holo.dispose();
});

test('desktop/plugin.js and dashboard/dist/index.js bundles exist and stay under 1MB', () => {
  const desktopBundle = path.join(ROOT, 'desktop', 'plugin.js');
  const dashboardBundle = path.join(ROOT, 'dashboard', 'dist', 'index.js');
  assert.equal(fs.existsSync(desktopBundle), true);
  assert.equal(fs.existsSync(dashboardBundle), true);

  const desktopSizeKb = fs.statSync(desktopBundle).size / 1024;
  const dashboardSizeKb = fs.statSync(dashboardBundle).size / 1024;
  assert.equal(desktopSizeKb < 1024, true, `desktop/plugin.js is ${desktopSizeKb}KB`);
  assert.equal(dashboardSizeKb < 1024, true, `dashboard/dist/index.js is ${dashboardSizeKb}KB`);
});
