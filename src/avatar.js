import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

export class AvatarStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.vrm = null;
    this.mouthLevel = 0;      // 0..1 target set from voice.js during TTS playback
    this._mouthCurrent = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    this.camera.position.set(0, 1.35, 2.4);

    const key = new THREE.DirectionalLight(0x9fb0ff, 1.1);
    key.position.set(1, 2, 2);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff5fa8, 0.5);
    rim.position.set(-2, 1.5, -2);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0x404060, 0.9));

    this._resize();
    window.addEventListener('resize', () => this._resize());

    this._animate();
  }

  _resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async loadVRM(url) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);

    if (this.vrm) this.scene.remove(this.vrm.scene);
    this.vrm = vrm;
    this.scene.add(vrm.scene);
    vrm.scene.rotation.y = Math.PI; // VRM models face +Z by convention; face the camera
    return vrm;
  }

  setSpeaking(level) {
    // level: 0..1, call continuously while TTS audio plays
    this.mouthLevel = level;
  }

  setExpression(name, weight = 1) {
    if (!this.vrm?.expressionManager) return;
    this.vrm.expressionManager.setValue(name, weight);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    const dt = this.clock.getDelta();
    const t = this.clock.getElapsedTime();

    if (this.vrm) {
      // idle breathing / sway
      const head = this.vrm.humanoid?.getNormalizedBoneNode('head');
      if (head) {
        head.rotation.y = Math.sin(t * 0.6) * 0.05;
        head.rotation.x = Math.sin(t * 0.9) * 0.02;
      }
      const chest = this.vrm.humanoid?.getNormalizedBoneNode('chest');
      if (chest) chest.rotation.x = Math.sin(t * 0.5) * 0.01;

      // lip sync toward target mouth level (VRM standard expression "aa")
      this._mouthCurrent += (this.mouthLevel - this._mouthCurrent) * 0.4;
      if (this.vrm.expressionManager) {
        this.vrm.expressionManager.setValue('aa', this._mouthCurrent);
        this.vrm.expressionManager.update();
      }

      // blink
      const blink = Math.max(0, Math.sin(t * 0.7) > 0.985 ? 1 : 0);
      this.setExpression('blink', blink);

      this.vrm.update(dt);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
