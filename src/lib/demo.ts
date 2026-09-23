/**
 * DEMO PROJECT.
 *
 * The editor has to be usable the moment it opens, so the "media" it starts
 * with is generated in the browser: a procedural artwork, an offline-rendered
 * music bed and a short motion clip captured from a canvas. No network, no
 * files on disk, no stubbed placeholders.
 *
 * The wallpaper and the motion clip are laid end to end on the main layer, so
 * the demo opens with a real junction between them — and with a transition bond
 * already spanning it, so that feature is visible rather than merely available.
 */
import {
  assetMetaPatch,
  generateDemoAudio,
  generateDemoImage,
  generateDemoVideo,
  type LoadedMeta,
} from "@/lib/media";
import { DEFAULT_TEXT, createLayer, withNormalizedZ } from "@/lib/project";
import { applyBond } from "@/lib/bonds";
import { normalizeTracks } from "@/lib/tracks";
import { uid } from "@/lib/time";
import { DEFAULT_SETTINGS, editor } from "@/store/editorStore";
import type { Asset, Keyframe, Layer, ProjectSettings } from "@/types/editor";

/** The canvas every generated asset aims at. */
const DEMO_SETTINGS: ProjectSettings = {
  ...DEFAULT_SETTINGS,
  name: "Neon Demo Reel",
  width: 1920,
  height: 1080,
  fps: 30,
  backgroundColor: "#05050a",
};

const TIMELINE_SECONDS = 8;
/** Where the wallpaper hands over to the motion clip — the main layer's seam. */
const BACKDROP_SECONDS = 4;

/**
 * A STABLE id, so rebuilding the demo replaces the demo rather than leaving
 * another one behind. Records are keyed by the project's own id, which means
 * the demo is one library entry however many times it is regenerated — and the
 * "Demo" button stays what it says it is instead of quietly filling the shelf.
 */
export const DEMO_PROJECT_ID = "project-demo";

interface MediaItem {
  asset: Asset;
  meta: Promise<LoadedMeta> | LoadedMeta;
}

/** Resolves an asset's metadata (which may already be a plain patch). */
async function ready(item: MediaItem): Promise<Asset> {
  const meta = await item.meta;
  return { ...item.asset, ...assetMetaPatch(meta) };
}

const key = (prop: Keyframe["prop"], time: number, value: number, easing: Keyframe["easing"]): Keyframe => ({
  id: uid("kf"),
  prop,
  time,
  value,
  easing,
});

const coverScale = (asset: Asset, settings: ProjectSettings) =>
  Math.max(settings.width / (asset.width || settings.width), settings.height / (asset.height || settings.height));

export interface DemoProgress {
  (message: string, progress: number): void;
}

/**
 * Generates the demo media and loads the resulting project into the store.
 * Safe to call repeatedly — every call builds a fresh project.
 */
export async function buildDemoProject(onProgress?: DemoProgress): Promise<void> {
  onProgress?.("Painting the background…", 0.08);
  const backdrop = await ready(generateDemoImage());

  onProgress?.("Rendering the music bed…", 0.35);
  const music = await ready(await generateDemoAudio(TIMELINE_SECONDS));

  onProgress?.("Recording a motion clip…", 0.72);
  let clip: Asset | null = null;
  try {
    const item = await generateDemoVideo(3);
    if (item) clip = await ready(item);
  } catch {
    // Capture is unsupported in some browsers; the demo just ships without it.
    clip = null;
  }

  onProgress?.("Building the timeline…", 0.92);

  const assets: Record<string, Asset> = { [backdrop.id]: backdrop, [music.id]: music };
  if (clip) assets[clip.id] = clip;

  const layers: Layer[] = [];

  /* --- background artwork, the head of the main sequence ------------ */
  /* The main layer is a SEQUENCE, not one clip: the wallpaper runs to the
     four-second mark and the video picks up exactly there. Two clips that abut
     on one track are a junction — and a junction is where a transition bond
     lives, which is why the demo is laid out this way. */
  const back = createLayer({
    type: "image",
    name: backdrop.name,
    assetId: backdrop.id,
    startTime: 0,
    duration: BACKDROP_SECONDS,
    opacity: 1,
    transform: {
      x: DEMO_SETTINGS.width / 2,
      y: DEMO_SETTINGS.height / 2,
      scale: coverScale(backdrop, DEMO_SETTINGS),
      rotation: 0,
    },
    keyframes: [
      key("scale", 0, coverScale(backdrop, DEMO_SETTINGS), "linear"),
      key("scale", BACKDROP_SECONDS, coverScale(backdrop, DEMO_SETTINGS) * 1.03, "linear"),
    ],
  });
  layers.push(back);

  /* --- colour grade over the backdrop ------------------------------ */
  layers.push(
    createLayer({
      type: "effect",
      name: "Sunset grade",
      startTime: 0,
      duration: 6,
      opacity: 0.55,
      effect: {
        kind: "gradient",
        color: "#f97316",
        color2: "#7c3aed",
        angle: 35,
        blend: "overlay",
        amount: 0.6,
        scale: 0.5,
        seed: 0.3,
      },
      transform: { x: DEMO_SETTINGS.width / 2, y: DEMO_SETTINGS.height / 2, scale: 1.08, rotation: 0 },
      keyframes: [key("opacity", 0, 0, "easeOut"), key("opacity", 0.8, 0.55, "easeInOut"), key("opacity", 5.2, 0.55, "easeIn"), key("opacity", 6, 0, "linear")],
    }),
  );

  /* --- generated video clip ---------------------------------------- */
  /* Sits flush against the wallpaper's end, so the pair forms a junction. Its
     enter-transition is NOT set here: the bond below owns it, and writing one
     by hand would only be overwritten. */
  let clipLayer: Layer | null = null;
  if (clip) {
    const clipWidth = (clip.width || 1280) * (DEMO_SETTINGS.height / (clip.height || 720));
    const baseScale = Math.min(DEMO_SETTINGS.width / clipWidth, 1);
    clipLayer = createLayer({
      type: "video",
      name: clip.name,
      assetId: clip.id,
      startTime: BACKDROP_SECONDS,
      duration: 3,
      inPoint: 0,
      transform: {
        x: DEMO_SETTINGS.width / 2,
        y: DEMO_SETTINGS.height / 2,
        scale: baseScale * 0.94,
        rotation: 0,
      },
      volume: 0.85,
      audioFadeIn: 0.2,
      audioFadeOut: 0.4,
      transitionOut: { type: "fade", duration: 0.5, direction: "left" },
      keyframes: [
        key("scale", 0, baseScale * 0.94, "easeOut"),
        key("scale", 3, baseScale * 1.06, "linear"),
      ],
    });
    layers.push(clipLayer);
  }

  /* --- vignette ----------------------------------------------------- */
  layers.push(
    createLayer({
      type: "effect",
      name: "Vignette",
      startTime: 0,
      duration: TIMELINE_SECONDS,
      opacity: 0.85,
      effect: {
        kind: "vignette",
        color: "rgba(0,0,0,0.8)",
        color2: "#000000",
        angle: 45,
        blend: "source-over",
        amount: 0.55,
        scale: 0.5,
        seed: 0.4,
      },
      transform: { x: DEMO_SETTINGS.width / 2, y: DEMO_SETTINGS.height / 2, scale: 1.05, rotation: 0 },
    }),
  );

  /* --- title -------------------------------------------------------- */
  layers.push(
    createLayer({
      type: "text",
      name: "OCTO CUT",
      startTime: 0.4,
      duration: 3.6,
      text: {
        ...DEFAULT_TEXT(DEMO_SETTINGS),
        content: "OCTO CUT",
        fontSize: Math.round(DEMO_SETTINGS.height * 0.11),
        fontWeight: 900,
        letterSpacing: 6,
        color: "#ffffff",
        strokeColor: "#0b0b14",
        strokeWidth: 6,
        shadow: true,
      },
      transform: { x: DEMO_SETTINGS.width / 2, y: DEMO_SETTINGS.height * 0.6, scale: 1, rotation: 0 },
      keyframes: [
        key("opacity", 0, 0, "easeOut"),
        key("opacity", 0.45, 1, "linear"),
        key("scale", 0, 0.72, "easeOut"),
        key("scale", 0.8, 1, "easeOut"),
        key("y", 0, DEMO_SETTINGS.height * 0.64, "easeOut"),
        key("y", 1.1, DEMO_SETTINGS.height * 0.6, "easeOut"),
      ],
    }),
  );

  /* --- subtitle ----------------------------------------------------- */
  layers.push(
    createLayer({
      type: "text",
      name: "Subtitle",
      startTime: 3.9,
      duration: 2.6,
      text: {
        ...DEFAULT_TEXT(DEMO_SETTINGS),
        content: "drag, trim, keyframe, export",
        fontSize: Math.round(DEMO_SETTINGS.height * 0.042),
        fontWeight: 600,
        letterSpacing: 2,
        color: "#dbeafe",
        backgroundColor: "rgba(6,10,24,0.55)",
        backgroundRadius: 999,
        shadow: false,
      },
      transform: { x: DEMO_SETTINGS.width / 2, y: DEMO_SETTINGS.height * 0.76, scale: 1, rotation: 0 },
      transitionIn: { type: "fade", duration: 0.4, direction: "left" },
      transitionOut: { type: "fade", duration: 0.4, direction: "left" },
    }),
  );

  /* --- sticker ------------------------------------------------------ */
  layers.push(
    createLayer({
      type: "sticker",
      name: "🎬",
      startTime: 3.5,
      duration: 1.7,
      sticker: { glyph: "🎬", fill: "#f5a524", stroke: "#1a1206", strokeWidth: 0, depth: 0.25 },
      transform: { x: DEMO_SETTINGS.width * 0.76, y: DEMO_SETTINGS.height * 0.3, scale: 1, rotation: 0 },
      transitionIn: { type: "zoomIn", duration: 0.45, direction: "left" },
      transitionOut: { type: "zoomOut", duration: 0.45, direction: "left" },
      keyframes: [
        key("rotation", 0, -14, "easeInOut"),
        key("rotation", 1.7, 12, "easeInOut"),
        key("y", 0, DEMO_SETTINGS.height * 0.28, "easeOut"),
        key("y", 1.7, DEMO_SETTINGS.height * 0.32, "easeIn"),
      ],
    }),
  );

  /* --- closing mark ------------------------------------------------- */
  layers.push(
    createLayer({
      type: "text",
      name: "Outro",
      startTime: 6.9,
      duration: 1.1,
      text: {
        ...DEFAULT_TEXT(DEMO_SETTINGS),
        content: "made in the browser",
        fontSize: Math.round(DEMO_SETTINGS.height * 0.05),
        fontWeight: 700,
        letterSpacing: 4,
        color: "#93c5fd",
        shadow: false,
      },
      transform: { x: DEMO_SETTINGS.width / 2, y: DEMO_SETTINGS.height * 0.5, scale: 1, rotation: 0 },
      transitionIn: { type: "fade", duration: 0.6, direction: "left" },
      transitionOut: { type: "fade", duration: 0.4, direction: "left" },
    }),
  );

  /* --- music -------------------------------------------------------- */
  layers.push(
    createLayer({
      type: "audio",
      name: music.name,
      assetId: music.id,
      startTime: 0,
      duration: Math.max(1, Math.min(TIMELINE_SECONDS, music.duration ?? TIMELINE_SECONDS)),
      volume: 0.75,
      audioFadeIn: 0.8,
      audioFadeOut: 1.4,
      transform: { x: DEMO_SETTINGS.width / 2, y: DEMO_SETTINGS.height / 2, scale: 1, rotation: 0 },
    }),
  );

  /* Tracks are laid out here rather than left to `loadProject`, because the bond
     below needs its two clips to already share the main layer. Normalising
     first also means the pair abuts — a plain cut, which the placement rules
     read as "the row is free" — and the bond is then free to overlap them. */
  const base = normalizeTracks(
    withNormalizedZ({
      id: DEMO_PROJECT_ID,
      settings: DEMO_SETTINGS,
      tracks: {},
      trackIds: [],
      layers: Object.fromEntries(layers.map((layer) => [layer.id, layer])),
      layerIds: layers.map((layer) => layer.id),
    }),
  );

  /* The demo opens with one bond already in place: the wallpaper cross-zooms
     into the motion clip rather than hard-cutting, so the feature is something
     you can see and take apart instead of something you have to discover. */
  const project = clipLayer
    ? applyBond(base, back.id, clipLayer.id, { type: "crossZoom", duration: 0.6 })
    : base;

  editor().loadProject(project, assets);
  editor().setZoom(110);
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
