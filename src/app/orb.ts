export type OrbState = 'loading' | 'asleep' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error';

// Colour (r, g, b), ring spin in turns per second, and resting brightness for each state.
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
const FRIDAY_RGB: [number, number, number] = [255, 130, 190];
const RINGS = [
  { tilt: 0.35, squash: 0.32, radius: 0.36, speed: 1 },
  { tilt: -0.9, squash: 0.45, radius: 0.41, speed: -0.7 },
  { tilt: 1.5, squash: 0.25, radius: 0.46, speed: 0.5 },
];

/** Draws the orb: a glowing core with three orbiting rings. `level` (0 to 1) is how loud the voice is right now. */
export function startOrb(canvas: HTMLCanvasElement, read: () => { state: OrbState; level: number; friday: boolean }): void {
  const context = canvas.getContext('2d')!;
  const scale = window.devicePixelRatio;
  const size = canvas.clientWidth;
  canvas.width = canvas.height = size * scale;
  context.scale(scale, scale);

  let angle = 0;
  let level = 0;
  let rgb = LOOK.loading.rgb;
  let last = performance.now();

  const frame = (now: number) => {
    const seconds = Math.min((now - last) / 1000, 0.1);
    last = now;
    const { state, level: target, friday } = read();
    const look = LOOK[state];
    // Friday keeps every state's motion and brightness but glows rose instead of blue.
    const hue = friday && state !== 'muted' && state !== 'error' ? FRIDAY_RGB : look.rgb;
    // Ease towards the target so changes of state and volume glide instead of jumping.
    level += (target - level) * Math.min(1, seconds * 14);
    rgb = rgb.map((value, index) => value + (hue[index]! - value) * Math.min(1, seconds * 6)) as typeof rgb;
    angle += seconds * look.spin * Math.PI * 2;
    const colour = (alpha: number) => `rgba(${rgb.map(Math.round).join(',')},${alpha})`;
    const breath = 0.5 + 0.5 * Math.sin(now / (state === 'thinking' ? 250 : 1400));
    const centre = size / 2;
    const core = size * (0.13 + 0.02 * breath + 0.1 * level);

    context.clearRect(0, 0, size, size);
    context.globalCompositeOperation = 'lighter';

    const halo = context.createRadialGradient(centre, centre, 0, centre, centre, core * 2.6);
    halo.addColorStop(0, colour(0.55 * look.glow + 0.3 * level));
    halo.addColorStop(0.4, colour(0.18 * look.glow));
    halo.addColorStop(1, colour(0));
    context.fillStyle = halo;
    context.fillRect(0, 0, size, size);

    const ball = context.createRadialGradient(centre, centre, 0, centre, centre, core);
    ball.addColorStop(0, `rgba(255,255,255,${0.9 * look.glow})`);
    ball.addColorStop(0.5, colour(0.8 * look.glow));
    ball.addColorStop(1, colour(0));
    context.fillStyle = ball;
    context.beginPath();
    context.arc(centre, centre, core, 0, Math.PI * 2);
    context.fill();

    for (const ring of RINGS) {
      const radius = size * ring.radius * (1 + 0.12 * level);
      context.save();
      context.translate(centre, centre);
      context.rotate(ring.tilt);
      context.strokeStyle = colour(0.35 * look.glow);
      context.lineWidth = 1;
      context.beginPath();
      context.ellipse(0, 0, radius, radius * ring.squash, 0, 0, Math.PI * 2);
      context.stroke();
      // The satellite travelling round the ring.
      const at = angle * ring.speed;
      context.fillStyle = colour(0.95);
      context.shadowColor = colour(1);
      context.shadowBlur = 8;
      context.beginPath();
      context.arc(Math.cos(at) * radius, Math.sin(at) * radius * ring.squash, 2.2, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
