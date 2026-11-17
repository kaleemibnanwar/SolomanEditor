/**
 * DEMO PROJECT — the first-launch welcome reel.
 *
 * A new user should open the editor onto something worth looking at AND worth
 * taking apart, so the demo is a real twenty-second film: five bundled
 * photographs (the same copyright-free images the Backgrounds tab offers) cut
 * into a sequence on the main layer, each moving with Ken Burns keyframes,
 * each seam carrying a different transition bond, titles and kickers on their
 * own rows, a grain / vignette / colour-wash finish, and an offline-rendered
 * music bed underneath. Every technique the editor teaches is already used
 * once, visibly, in this project.
 *
 * The photos are fetched from `public/backgrounds/` and imported as real
 * files, so the demo exports cleanly — no canvas taint, no dead URLs. If a
 * fetch ever fails the scene falls back to generated artwork, because boot
 * must never die on a missing asset.
 */
import {
  assetMetaPatch,
  createAssetsFromFiles,
  generateDemoAudio,
  generateDemoImage,
} from "@/lib/media";
import { DEFAULT_TEXT, createLayer, withNormalizedZ } from "@/lib/project";
import { applyBond } from "@/lib/bonds";
import { IMAGE_BACKGROUNDS } from "@/lib/library";
import { MAIN_TRACK_NAME, createTrack, normalizeTracks, withTrackOrder } from "@/lib/tracks";
import { uid } from "@/lib/time";
import { DEFAULT_SETTINGS, editor } from "@/store/editorStore";
import type { Asset, Keyframe, Layer, ProjectSettings, TextStyle, Transition } from "@/types/editor";

/** The canvas every scene aims at. */
const DEMO_SETTINGS: ProjectSettings = {
  ...DEFAULT_SETTINGS,
  name: "Welcome to Soloman",
  width: 1920,
  height: 1080,
  fps: 30,
  backgroundColor: "#05050a",
};

const W = DEMO_SETTINGS.width;
const H = DEMO_SETTINGS.height;
const TIMELINE_SECONDS = 20;

/**
 * A STABLE id, so rebuilding the demo replaces the demo rather than leaving
 * another one behind. Records are keyed by the project's own id, which means
 * the demo is one library entry however many times it is regenerated.
 */
export const DEMO_PROJECT_ID = "project-demo";

const key = (prop: Keyframe["prop"], time: number, value: number, easing: Keyframe["easing"]): Keyframe => ({
  id: uid("kf"),
  prop,
  time,
  value,
  easing,
});

const coverScale = (asset: Asset) =>
  Math.max(W / (asset.width || W), H / (asset.height || H));

/* ------------------------------------------------------------------ *
 * Media loading
 * ------------------------------------------------------------------ */

/** A bundled photograph, imported as a real file so exports stay untainted. */
async function loadPhoto(bgId: string): Promise<Asset> {
  const entry = IMAGE_BACKGROUNDS.find((bg) => bg.id === bgId);
  if (!entry) throw new Error(`Unknown background ${bgId}`);
  const res = await fetch(`/backgrounds/${entry.filename}`);
  if (!res.ok) throw new Error(`Could not load ${entry.filename}`);
  const blob = await res.blob();
  const file = new File([blob], entry.filename, { type: blob.type || "image/jpeg" });
  const [item] = createAssetsFromFiles([file]);
  const meta = await item.meta;
  return { ...item.asset, ...assetMetaPatch(meta), name: entry.label };
}

/** The demo must boot even if a bundled file is unreachable. */
async function loadSceneAsset(bgId: string): Promise<Asset> {
  try {
    return await loadPhoto(bgId);
  } catch {
    const fallback = generateDemoImage();
    return { ...fallback.asset, ...assetMetaPatch(await fallback.meta) };
  }
}

/* ------------------------------------------------------------------ *
 * The film, as data
 * ------------------------------------------------------------------ */

/**
 * Five scenes laid end to end. `motion` describes the Ken Burns move in
 * multipliers of the cover scale and pixel offsets from centre — the builder
 * turns them into keyframes. `bond` is the transition INTO the next scene.
 */
interface SceneSpec {
  bgId: string;
  start: number;
  duration: number;
  motion: { fromScale: number; toScale: number; fromX?: number; toX?: number; fromY?: number; toY?: number };
  bond?: Partial<Transition>;
}

const SCENES: SceneSpec[] = [
  {
    bgId: "imgbg-mountain",
    start: 0,
    duration: 4.6,
    motion: { fromScale: 1.1, toScale: 1.18, fromY: 25, toY: -25 },
    bond: { type: "crossZoom", duration: 0.7 },
  },
  {
    bgId: "imgbg-night",
    start: 4.6,
    duration: 4,
    motion: { fromScale: 1.14, toScale: 1.14, fromX: 55, toX: -55 },
    bond: { type: "softWipe", duration: 0.6, direction: "left" },
  },
  {
    bgId: "imgbg-aurora",
    start: 8.6,
    duration: 4,
    motion: { fromScale: 1.2, toScale: 1.1, fromY: 20, toY: -20 },
    bond: { type: "ripple", duration: 0.7 },
  },
  {
    bgId: "imgbg-galaxy",
    start: 12.6,
    duration: 3.8,
    motion: { fromScale: 1.1, toScale: 1.2 },
    bond: { type: "lightLeak", duration: 0.8 },
  },
  {
    bgId: "imgbg-sunset",
    start: 16.4,
    duration: 3.6,
    motion: { fromScale: 1.12, toScale: 1.2, fromY: -20, toY: 20 },
  },
];

/** The guided tour: one small label + one line of copy per scene. */
const CAPTIONS: { start: number; end: number; kicker: string; title: string }[] = [
  { start: 5.3, end: 8.4, kicker: "01 · LAYERS", title: "Everything is a layer" },
  { start: 9.3, end: 12.4, kicker: "02 · MOTION", title: "Keyframes bring photos to life" },
  { start: 13.3, end: 16.2, kicker: "03 · TRANSITIONS", title: "Bonds turn cuts into transitions" },
];

/* ------------------------------------------------------------------ *
 * Layer builders
 * ------------------------------------------------------------------ */

function sceneLayer(spec: SceneSpec, asset: Asset, trackId: string): Layer {
  const base = coverScale(asset);
  const { motion } = spec;
  const keyframes: Keyframe[] = [
    key("scale", 0, base * motion.fromScale, "easeInOut"),
    key("scale", spec.duration, base * motion.toScale, "easeInOut"),
  ];
  if (motion.fromX !== undefined && motion.toX !== undefined) {
    keyframes.push(key("x", 0, W / 2 + motion.fromX, "linear"), key("x", spec.duration, W / 2 + motion.toX, "linear"));
  }
  if (motion.fromY !== undefined && motion.toY !== undefined) {
    keyframes.push(key("y", 0, H / 2 + motion.fromY, "linear"), key("y", spec.duration, H / 2 + motion.toY, "linear"));
  }
  return createLayer({
    type: "image",
    name: asset.name,
    assetId: asset.id,
    trackId,
    startTime: spec.start,
    duration: spec.duration,
    transform: { x: W / 2, y: H / 2, scale: base * motion.fromScale, rotation: 0 },
    keyframes,
  });
}

/** A line of copy that rises in, holds, and fades out — the demo's text voice. */
function copyLayer(
  trackId: string,
  name: string,
  content: string,
  start: number,
  end: number,
  y: number,
  style: Partial<TextStyle>,
): Layer {
  return createLayer({
    type: "text",
    name,
    trackId,
    startTime: start,
    duration: end - start,
    text: { ...DEFAULT_TEXT(DEMO_SETTINGS), content, ...style },
    transform: { x: W / 2, y, scale: 1, rotation: 0 },
    transitionIn: { type: "fade", duration: 0.35, direction: "left" },
    transitionOut: { type: "fade", duration: 0.35, direction: "left" },
    keyframes: [key("y", 0, y + 34, "easeOut"), key("y", 0.7, y, "easeOut")],
  });
}

const TITLE_STYLE: Partial<TextStyle> = {
  fontSize: Math.round(H * 0.06),
  fontWeight: 800,
  letterSpacing: 1,
  color: "#ffffff",
  strokeColor: "#0b0b14",
  strokeWidth: 5,
  shadow: true,
};

const KICKER_STYLE: Partial<TextStyle> = {
  fontSize: Math.round(H * 0.027),
  fontWeight: 700,
  letterSpacing: 6,
  color: "#7dd3fc",
  shadow: true,
};

export interface DemoProgress {
  (message: string, progress: number): void;
}

/* ------------------------------------------------------------------ *
 * The build
 * ------------------------------------------------------------------ */

/**
 * Generates the demo media and loads the resulting project into the store.
 * Safe to call repeatedly — the stable project id means every call replaces
 * the demo rather than accumulating copies. Autosave then persists it, so the
 * welcome reel is a real library entry the user can duplicate or delete.
 */
export async function buildDemoProject(onProgress?: DemoProgress): Promise<void> {
  onProgress?.("Loading the photography…", 0.1);
  const photos = await Promise.all(SCENES.map((scene) => loadSceneAsset(scene.bgId)));

  onProgress?.("Rendering the music bed…", 0.45);
  const musicItem = await generateDemoAudio(TIMELINE_SECONDS);
  const music: Asset = { ...musicItem.asset, name: "Demo Music" };

  onProgress?.("Building the timeline…", 0.85);

  const assets: Record<string, Asset> = Object.fromEntries([...photos, music].map((a) => [a.id, a]));

  /* Rows are named and ordered up front so the rail reads like a finished
     edit: pictures, finish, copy, music — not one anonymous row per layer. */
  const main = createTrack(MAIN_TRACK_NAME, true);
  const grainTrack = createTrack("Film grain");
  const vignetteTrack = createTrack("Vignette");
  const washTrack = createTrack("Sunset wash");
  const titles = createTrack("Titles");
  const kickers = createTrack("Kickers");
  const musicTrack = createTrack("Music");
  const tracks = [main, grainTrack, vignetteTrack, washTrack, titles, kickers, musicTrack];

  const layers: Layer[] = [];

  /* --- the main sequence ------------------------------------------- */
  const sceneLayers = SCENES.map((scene, i) => sceneLayer(scene, photos[i], main.id));
  layers.push(...sceneLayers);

  /* --- the finish: grain + vignette over everything, warm wash at the end */
  layers.push(
    createLayer({
      type: "effect",
      name: "Film grain",
      trackId: grainTrack.id,
      startTime: 0,
      duration: TIMELINE_SECONDS,
      opacity: 0.35,
      effect: {
        kind: "grain",
        color: "rgba(255,255,255,0.5)",
        color2: "rgba(0,0,0,0.5)",
        angle: 45,
        blend: "overlay",
        amount: 0.3,
        scale: 0.5,
        seed: 0.4,
      },
      transform: { x: W / 2, y: H / 2, scale: 1.05, rotation: 0 },
    }),
    createLayer({
      type: "effect",
      name: "Vignette",
      trackId: vignetteTrack.id,
      startTime: 0,
      duration: TIMELINE_SECONDS,
      opacity: 0.8,
      effect: {
        kind: "vignette",
        color: "rgba(0,0,0,0.75)",
        color2: "#000000",
        angle: 45,
        blend: "source-over",
        amount: 0.5,
        scale: 0.5,
        seed: 0.4,
      },
      transform: { x: W / 2, y: H / 2, scale: 1.05, rotation: 0 },
    }),
    createLayer({
      type: "effect",
      name: "Sunset wash",
      trackId: washTrack.id,
      startTime: SCENES[4].start,
      duration: SCENES[4].duration,
      opacity: 0,
      effect: {
        kind: "gradient",
        color: "#f97316",
        color2: "#7c3aed",
        angle: 35,
        blend: "overlay",
        amount: 0.5,
        scale: 0.5,
        seed: 0.3,
      },
      transform: { x: W / 2, y: H / 2, scale: 1.08, rotation: 0 },
      keyframes: [
        key("opacity", 0, 0, "easeOut"),
        key("opacity", 0.9, 0.4, "easeInOut"),
        key("opacity", SCENES[4].duration - 0.6, 0.4, "linear"),
        key("opacity", SCENES[4].duration, 0, "linear"),
      ],
    }),
  );

  /* --- hero title over the opening scene ---------------------------- */
  layers.push(
    createLayer({
      type: "text",
      name: "SOLOMAN EDITOR",
      trackId: titles.id,
      startTime: 0.5,
      duration: 3.9,
      text: {
        ...DEFAULT_TEXT(DEMO_SETTINGS),
        content: "SOLOMAN EDITOR",
        fontSize: Math.round(H * 0.115),
        fontWeight: 900,
        letterSpacing: 8,
        color: "#ffffff",
        strokeColor: "#0b0b14",
        strokeWidth: 6,
        shadow: true,
      },
      transform: { x: W / 2, y: H * 0.47, scale: 1, rotation: 0 },
      transitionOut: { type: "fade", duration: 0.5, direction: "left" },
      keyframes: [
        key("opacity", 0, 0, "easeOut"),
        key("opacity", 0.5, 1, "linear"),
        key("scale", 0, 0.85, "easeOut"),
        key("scale", 0.9, 1, "easeOut"),
        key("y", 0, H * 0.51, "easeOut"),
        key("y", 1.1, H * 0.47, "easeOut"),
      ],
    }),
    copyLayer(kickers.id, "Subtitle", "Your story starts here", 1.2, 4.4, H * 0.58, {
      fontSize: Math.round(H * 0.04),
      fontWeight: 600,
      letterSpacing: 3,
      color: "#e2e8f0",
      shadow: true,
    }),
  );

  /* --- the guided tour ---------------------------------------------- */
  for (const caption of CAPTIONS) {
    layers.push(
      copyLayer(titles.id, caption.title, caption.title, caption.start, caption.end, H * 0.5, TITLE_STYLE),
      copyLayer(kickers.id, caption.kicker, caption.kicker, caption.start, caption.end, H * 0.42, KICKER_STYLE),
    );
  }

  /* --- outro --------------------------------------------------------- */
  layers.push(
    copyLayer(titles.id, "Make it yours", "Make it yours", 17.2, 19.9, H * 0.46, {
      ...TITLE_STYLE,
      fontSize: Math.round(H * 0.085),
      fontWeight: 900,
      letterSpacing: 3,
    }),
    copyLayer(kickers.id, "Outro hint", "Press Space to play · every layer is editable", 17.7, 19.9, H * 0.57, {
      ...KICKER_STYLE,
      color: "#fcd34d",
      letterSpacing: 3,
    }),
  );

  /* --- music --------------------------------------------------------- */
  layers.push(
    createLayer({
      type: "audio",
      name: "Music bed",
      assetId: music.id,
      trackId: musicTrack.id,
      startTime: 0,
      duration: Math.max(1, Math.min(TIMELINE_SECONDS, music.duration ?? TIMELINE_SECONDS)),
      volume: 0.7,
      audioFadeIn: 1.2,
      audioFadeOut: 2.2,
      transform: { x: W / 2, y: H / 2, scale: 1, rotation: 0 },
    }),
  );

  let project = withTrackOrder(
    normalizeTracks(
      withNormalizedZ({
        id: DEMO_PROJECT_ID,
        settings: DEMO_SETTINGS,
        tracks: Object.fromEntries(tracks.map((track) => [track.id, track])),
        trackIds: tracks.map((track) => track.id),
        layers: Object.fromEntries(layers.map((layer) => [layer.id, layer])),
        layerIds: layers.map((layer) => layer.id),
      }),
    ),
  );

  /* Every seam carries a bond, so the demo opens with four transitions
     already in place — something to watch, retime and swap rather than a
     feature list. Bonds own the overlap: the outgoing clip's tail grows to
     cover it, which is why the scenes were laid abutting above. */
  for (let i = 0; i < sceneLayers.length - 1; i++) {
    const bond = SCENES[i].bond;
    if (bond) project = applyBond(project, sceneLayers[i].id, sceneLayers[i + 1].id, bond);
  }

  editor().loadProject(project, assets);
  editor().setZoom(60);
  editor().setCurrentTime(0);
}

/** Boots (or restores) the demo project and clears the boot overlay. */
export async function resetToDemo(onProgress?: DemoProgress): Promise<void> {
  try {
    await buildDemoProject(onProgress);
  } finally {
    editor().setUi({ booting: false });
  }
}