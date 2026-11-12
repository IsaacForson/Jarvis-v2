import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export type OrbState = 'loading' | 'asleep' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error';

// Colour (r, g, b), spin in turns per second, and brightness for each state.
const LOOK: Record<OrbState, { rgb: [number, number, number]; spin: number; glow: number }> = {
  loading: { rgb: [90, 215, 255], spin: 0.05, glow: 0.35 },
  asleep: { rgb: [60, 120, 170], spin: 0.03, glow: 0.3 },
  idle: { rgb: [90, 215, 255], spin: 0.08, glow: 0.6 },
  listening: { rgb: [170, 255, 235], spin: 0.12, glow: 0.8 },
  thinking: { rgb: [150, 170, 255], spin: 0.6, glow: 0.7 },
  speaking: { rgb: [90, 215, 255], spin: 0.2, glow: 0.9 },
  muted: { rgb: [140, 150, 160], spin: 0.02, glow: 0.3 },
  error: { rgb: [255, 90, 80], spin: 0.02, glow: 0.6 },
};
const ACTIVE_FPS = 60;
const RESTING_FPS = 30;
const FRIDAY_RGB: [number, number, number] = [255, 130, 190];
const RINGS = [
  { tilt: [1.25, 0.0, 0.35], radius: 1.7, speed: 1 },
  { tilt: [1.0, 0.9, -0.9], radius: 1.84, speed: -0.7 },
  { tilt: [1.45, -0.6, 1.5], radius: 1.98, speed: 0.5 },
] as const;

// Three.js's stock bloom pass paints the background black, which a see-through window cannot have.
// This is the same idea kept transparent: blur a small copy of the picture, add it back as glow, and
// make each pixel only as opaque as it is bright.
const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const BLUR = `
  uniform sampler2D map; uniform vec2 step; varying vec2 vUv;
  void main() {
    vec4 sum = texture2D(map, vUv) * 0.2270270270;
    sum += (texture2D(map, vUv + step * 1.3846153846) + texture2D(map, vUv - step * 1.3846153846)) * 0.3162162162;
    sum += (texture2D(map, vUv + step * 3.2307692308) + texture2D(map, vUv - step * 3.2307692308)) * 0.0702702703;
    gl_FragColor = sum;
  }`;
const COMPOSITE = `
  uniform sampler2D sharp; uniform sampler2D glow; uniform float strength; varying vec2 vUv;
  void main() {
    vec3 rgb = texture2D(sharp, vUv).rgb + texture2D(glow, vUv).rgb * strength;
    gl_FragColor = vec4(rgb, clamp(max(rgb.r, max(rgb.g, rgb.b)), 0.0, 1.0));
  }`;

export type OrbInput = { state: OrbState; level: number; friday: boolean };

/**
 * Draws the hologram orb: a glowing core inside two wireframe shells, a dust cloud and three orbiting
 * rings. `level` (0 to 1) is how loud the voice is right now. Returns a reader for the recent frame rate.
 */
export function startOrb(canvas: HTMLCanvasElement, read: () => OrbInput): { framesPerSecond(): number } {
  THREE.ColorManagement.enabled = false; // colours below are plain screen values
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.setClearColor(0x000000, 0);
  const pixels = renderer.getDrawingBufferSize(new THREE.Vector2());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, pixels.x / pixels.y, 0.1, 20);
  camera.position.z = 6.4;

  const materials: (THREE.MeshBasicMaterial | THREE.LineBasicMaterial | THREE.PointsMaterial)[] = [];
  const glowing = <M extends (typeof materials)[number]>(material: M, opacity: number): M => {
    material.setValues({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity });
    materials.push(material);
    return material;
  };

  const core = new THREE.Mesh(new THREE.SphereGeometry(0.34, 32, 32), glowing(new THREE.MeshBasicMaterial(), 0.95));
  const shell = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 2)), glowing(new THREE.LineBasicMaterial(), 0.4));
  const cage = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.25, 1)), glowing(new THREE.LineBasicMaterial(), 0.16));
  const dustPoints = new Float32Array(450 * 3);
  for (let index = 0; index < dustPoints.length; index += 3) {
    const point = new THREE.Vector3().randomDirection().multiplyScalar(1.35 + Math.random() * 0.3);
    dustPoints.set([point.x, point.y, point.z], index);
  }
  const dust = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(dustPoints, 3)),
    glowing(new THREE.PointsMaterial({ size: 0.035 }), 0.8),
  );
  const rings = RINGS.map((ring) => {
    const group = new THREE.Group();
    group.rotation.set(ring.tilt[0], ring.tilt[1], ring.tilt[2]);
    const satellite = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), glowing(new THREE.MeshBasicMaterial(), 1));
    group.add(new THREE.Mesh(new THREE.TorusGeometry(ring.radius, 0.007, 6, 160), glowing(new THREE.MeshBasicMaterial(), 0.5)), satellite);
    return { group, satellite, ...ring };
  });
  scene.add(core, shell, cage, dust, ...rings.map((ring) => ring.group));

  const sharp = new THREE.WebGLRenderTarget(pixels.x, pixels.y, { samples: 4 });
  const blurA = new THREE.WebGLRenderTarget(pixels.x / 4, pixels.y / 4);
  const blurB = blurA.clone();
  const blur = new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader: BLUR, uniforms: { map: { value: null }, step: { value: new THREE.Vector2() } } });
  const composite = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: COMPOSITE,
    uniforms: { sharp: { value: sharp.texture }, glow: { value: blurB.texture }, strength: { value: 1 } },
  });
  const quad = new FullScreenQuad(blur);
  const blurPass = (from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget, x: number, y: number) => {
    blur.uniforms.map!.value = from.texture;
    blur.uniforms.step!.value.set(x / blurA.width, y / blurA.height);
    renderer.setRenderTarget(to);
    quad.render(renderer);
  };

  let angle = 0;
  let level = 0;
  let glow = LOOK.loading.glow;
  let rgb: number[] = LOOK.loading.rgb;
  let last = performance.now();
  let rate = 60;

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const { state, level: target, friday } = read();
    const look = LOOK[state];
    // The orb is on screen all day, so it draws no faster than it needs to: measured on an M2 Pro,
    // drawing every frame of a 120 Hz display cost half a processor core while doing nothing.
    const wanted = state === 'speaking' || state === 'listening' || state === 'thinking' ? ACTIVE_FPS : RESTING_FPS;
    if (now - last < 1000 / wanted - 2) return;
    const seconds = Math.min((now - last) / 1000, 0.1);
    last = now;
    rate += (1 / seconds - rate) * 0.05;
    // Friday keeps every state's motion and brightness but glows rose instead of blue.
    const hue = friday && state !== 'muted' && state !== 'error' ? FRIDAY_RGB : look.rgb;
    // Ease towards the target so changes of state and volume glide instead of jumping.
    level += (target - level) * Math.min(1, seconds * 14);
    glow += (look.glow - glow) * Math.min(1, seconds * 6);
    rgb = rgb.map((value, index) => value + (hue[index]! - value) * Math.min(1, seconds * 6));
    angle += seconds * look.spin * Math.PI * 2;
    const breath = 0.5 + 0.5 * Math.sin(now / (state === 'thinking' ? 250 : 1400));

    for (const material of materials) material.color.setRGB(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255);
    core.scale.setScalar(1 + 0.12 * breath + 1.1 * level);
    shell.scale.setScalar(1 + 0.02 * breath + 0.22 * level);
    shell.rotation.set(angle * 0.35, angle, 0);
    cage.scale.setScalar(1 + 0.3 * level);
    cage.rotation.set(-angle * 0.5, -angle * 0.3, angle * 0.2);
    dust.scale.setScalar(1 + 0.35 * level);
    dust.rotation.y = -angle * 0.4;
    for (const ring of rings) {
      const at = angle * 1.6 * ring.speed;
      ring.satellite.position.set(Math.cos(at) * ring.radius, Math.sin(at) * ring.radius, 0);
      ring.group.scale.setScalar(1 + 0.1 * level);
    }

    renderer.setRenderTarget(sharp);
    renderer.clear();
    renderer.render(scene, camera);
    quad.material = blur;
    blurPass(sharp, blurA, 1, 0);
    blurPass(blurA, blurB, 0, 1);
    blurPass(blurB, blurA, 2.5, 0); // a second, wider pass spreads the glow further
    blurPass(blurA, blurB, 0, 2.5);
    composite.uniforms.strength!.value = glow * (1.6 + 2.2 * level);
    quad.material = composite;
    renderer.setRenderTarget(null);
    renderer.clear();
    quad.render(renderer);
  };
  requestAnimationFrame(frame);
  return { framesPerSecond: () => rate };
}
