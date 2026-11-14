// Hand control: the webcam watches for a hand, MediaPipe finds its landmarks, and Gestures turns
// them into grab, drag and release. The camera is on only while hand control is on.
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { type Gesture, Gestures } from './gestures.ts';

export type HandStatus = 'off' | 'starting' | 'watching' | 'seen' | 'holding' | 'error';
/** About 20 looks a second: smooth enough to drag, light on the processor. A timer, not animation frames, so it keeps going when the window is hidden. */
const EVERY_MS = 50;

export function handControl(onGesture: (gesture: Gesture) => void, onStatus: (status: HandStatus, detail?: string) => void) {
  let landmarker: HandLandmarker | undefined;
  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gestures = new Gestures();
  let holding = false;
  /** What was asked for last; starting takes a second or two, and it can be switched off meanwhile. */
  let wanted = false;

  const load = async () => {
    const files = await FilesetResolver.forVisionTasks('../node_modules/@mediapipe/tasks-vision/wasm');
    const options = (delegate: 'GPU' | 'CPU') => ({ baseOptions: { modelAssetPath: '../models/hand_landmarker.task', delegate }, runningMode: 'VIDEO' as const, numHands: 1 });
    return HandLandmarker.createFromOptions(files, options('GPU')).catch(() => HandLandmarker.createFromOptions(files, options('CPU')));
  };

  const look = () => {
    if (!video || !landmarker) return;
    if (video.readyState >= 2) {
      const now = performance.now();
      const hand = landmarker.detectForVideo(video, now).landmarks[0];
      for (const gesture of gestures.update(hand)) {
        if (gesture.type === 'grab') holding = true;
        if (gesture.type === 'release') holding = false;
        onGesture(gesture);
      }
      onStatus(holding ? 'holding' : hand ? 'seen' : 'watching');
    }
    timer = setTimeout(look, EVERY_MS);
  };

  const stop = () => {
    wanted = false;
    clearTimeout(timer);
    timer = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video = undefined;
    if (holding) onGesture({ type: 'release' });
    holding = false;
    onStatus('off');
  };

  const start = async () => {
    if (wanted) return;
    wanted = true;
    onStatus('starting');
    try {
      const [camera, model] = await Promise.all([navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } }), landmarker ?? load()]);
      landmarker = model;
      // Switched off while the camera was opening: close it again, or it would stay on unseen.
      if (!wanted) return camera.getTracks().forEach((track) => track.stop());
      stream = camera;
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      gestures = new Gestures();
      look();
    } catch (error) {
      stop();
      onStatus('error', error instanceof Error ? error.message : String(error));
    }
  };

  return { start, stop };
}
