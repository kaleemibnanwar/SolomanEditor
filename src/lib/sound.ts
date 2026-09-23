/**
 * Procedural sound design pack.
 *
 * Every effect is synthesised in an OfflineAudioContext and encoded to WAV, so
 * the pack ships with zero binary assets and always works offline. Rendering is
 * seeded (no Math.random) so a given preset sounds identical every session.
 */
import { toast } from "sonner";
import type { Asset } from "@/types/editor";
import { uid } from "@/lib/time";
import {
  assetMetaPatch,
  computePeaks,
  encodeWav,
  getAudioContext,
  resumeAudioContext,
  type LoadedMeta,
} from "@/lib/media";
import { editor } from "@/store/editorStore";

export type SoundCategory = "transition" | "ui" | "impact" | "ambience";

export interface SoundPreset {
  id: string;
  name: string;
  category: SoundCategory;
  blurb: string;
  seconds: number;
  gain: number;
  render: (ctx: OfflineAudioContext, out: AudioNode, seconds: number) => void;
}

/* ------------------------------------------------------------------ *
 * Synthesis primitives
 * ------------------------------------------------------------------ */

/** Deterministic white noise — the same seed always yields the same tail. */
function noiseBuffer(ctx: OfflineAudioContext, seconds: number, seed: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let s = (seed * 9301 + 49297) % 233280;
  for (let i = 0; i < length; i++) {
    s = (s * 9301 + 49297) % 233280;
    data[i] = (s / 233280) * 2 - 1;
  }
  return buf;
}

/** Exponentially decaying stereo noise burst used as a cheap convolution IR. */
function impulseResponse(ctx: OfflineAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let s = c === 0 ? 12345 : 54321;
    for (let i = 0; i < length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const r = (s / 0x7fffffff) * 2 - 1;
      data[i] = r * Math.pow(1 - i / length, decay);
    }
  }
  return buf;
}

function reverb(ctx: OfflineAudioContext, out: AudioNode, seconds = 0.9, decay = 3.2, wet = 0.35): AudioNode {
  const conv = ctx.createConvolver();
  conv.buffer = impulseResponse(ctx, seconds, decay);
  const mix = ctx.createGain();
  mix.gain.value = wet;
  conv.connect(mix).connect(out);
  return conv;
}

/** Attack/decay shape that never touches true zero (exponential ramps forbid it). */
function envelope(
  ctx: OfflineAudioContext,
  target: AudioParam,
  start: number,
  attack: number,
  hold: number,
  tail: number,
  peak: number,
) {
  const floor = 0.0001;
  target.setValueAtTime(floor, start);
  target.exponentialRampToValueAtTime(Math.max(floor, peak), start + attack);
  target.setValueAtTime(Math.max(floor, peak), start + attack + hold);
  target.exponentialRampToValueAtTime(floor, start + attack + hold + tail);
}

function osc(ctx: OfflineAudioContext, type: OscillatorType, freq: number, start: number, stop: number): OscillatorNode {
  const node = ctx.createOscillator();
  node.type = type;
  node.frequency.setValueAtTime(freq, start);
  node.start(start);
  node.stop(stop);
  return node;
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

const whoosh =
  (opts: { from: number; to: number; peak: number; q: number; reverse?: boolean; seed: number }): SoundPreset["render"] =>
  (ctx, out, seconds) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, seconds, opts.seed);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = opts.q;
    band.frequency.setValueAtTime(opts.reverse ? opts.to : opts.from, 0);
    band.frequency.exponentialRampToValueAtTime(opts.reverse ? opts.from : opts.to, seconds);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, 0);
    gain.gain.exponentialRampToValueAtTime(opts.peak, seconds * (opts.reverse ? 0.65 : 0.35));
    gain.gain.exponentialRampToValueAtTime(0.0001, seconds);

    src.connect(band).connect(gain);
    gain.connect(out);
    gain.connect(reverb(ctx, out, 0.7, 3.5, 0.22));
    src.start(0);
  };

const riser = (peak: number, seconds: number): SoundPreset["render"] => (ctx, out) => {
  const saw = osc(ctx, "sawtooth", 110, 0, seconds);
  saw.frequency.exponentialRampToValueAtTime(110 * 8, seconds);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 8;
  filter.frequency.setValueAtTime(240, 0);
  filter.frequency.exponentialRampToValueAtTime(7000, seconds);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, 0);
  gain.gain.exponentialRampToValueAtTime(peak, seconds * 0.92);
  gain.gain.exponentialRampToValueAtTime(0.0001, seconds);

  const air = ctx.createBufferSource();
  air.buffer = noiseBuffer(ctx, seconds, 313);
  const airGain = ctx.createGain();
  airGain.gain.setValueAtTime(0.0001, 0);
  airGain.gain.exponentialRampToValueAtTime(peak * 0.5, seconds * 0.9);
  airGain.gain.exponentialRampToValueAtTime(0.0001, seconds);

  saw.connect(filter).connect(gain).connect(out);
  air.connect(airGain).connect(out);
  air.start(0);
};

const downlifter = (peak: number, seconds: number): SoundPreset["render"] => (ctx, out) => {
  const saw = osc(ctx, "sawtooth", 900, 0, seconds);
  saw.frequency.exponentialRampToValueAtTime(90, seconds);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 6;
  filter.frequency.setValueAtTime(6000, 0);
  filter.frequency.exponentialRampToValueAtTime(300, seconds);

  const gain = ctx.createGain();
  envelope(ctx, gain.gain, 0, 0.01, seconds * 0.3, seconds * 0.68, peak);
  saw.connect(filter).connect(gain);
  gain.connect(out);
  gain.connect(reverb(ctx, out, 1.1, 2.6, 0.3));
};

const impact = (peak: number, seconds: number): SoundPreset["render"] => (ctx, out) => {
  const boom = osc(ctx, "sine", 150, 0, seconds);
  boom.frequency.exponentialRampToValueAtTime(38, 0.5);
  const boomGain = ctx.createGain();
  envelope(ctx, boomGain.gain, 0, 0.006, 0.05, seconds - 0.056, peak);

  const crack = ctx.createBufferSource();
  crack.buffer = noiseBuffer(ctx, 0.3, 977);
  const crackFilter = ctx.createBiquadFilter();
  crackFilter.type = "bandpass";
  crackFilter.frequency.value = 2100;
  crackFilter.Q.value = 0.8;
  const crackGain = ctx.createGain();
  envelope(ctx, crackGain.gain, 0, 0.002, 0.01, 0.26, peak * 0.7);

  boom.connect(boomGain);
  boomGain.connect(out);
  boomGain.connect(reverb(ctx, out, 1.4, 2.2, 0.45));
  crack.connect(crackFilter).connect(crackGain).connect(out);
  crack.start(0);
};

const blip = (opts: { from: number; to: number; seconds: number; peak: number; type: OscillatorType }): SoundPreset["render"] =>
  (ctx, out) => {
    const node = osc(ctx, opts.type, opts.from, 0, opts.seconds);
    node.frequency.exponentialRampToValueAtTime(opts.to, opts.seconds * 0.6);
    const gain = ctx.createGain();
    envelope(ctx, gain.gain, 0, 0.004, 0.008, opts.seconds - 0.012, opts.peak);
    node.connect(gain).connect(out);
  };

const bell = (fundamental: number, seconds: number, peak: number): SoundPreset["render"] => (ctx, out) => {
  const partials = [1, 2.76, 5.4, 8.93];
  const decays = [1, 0.7, 0.45, 0.3];
  const wet = reverb(ctx, out, 1.2, 2.4, 0.34);
  partials.forEach((mult, i) => {
    const node = osc(ctx, "sine", fundamental * mult, 0, seconds);
    const gain = ctx.createGain();
    const tail = seconds * decays[i];
    gain.gain.setValueAtTime(0.0001, 0);
    gain.gain.exponentialRampToValueAtTime(peak / (i + 1.4), 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, tail);
    node.connect(gain);
    gain.connect(out);
    gain.connect(wet);
  });
};

const sparkle: SoundPreset["render"] = (ctx, out) => {
  const notes = [1318.5, 1760, 2093, 2637, 3136];
  const wet = reverb(ctx, out, 0.9, 3.4, 0.3);
  notes.forEach((freq, i) => {
    const start = i * 0.055;
    const node = osc(ctx, "sine", freq, start, start + 0.5);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
    node.connect(gain);
    gain.connect(out);
    gain.connect(wet);
  });
};

const shutter: SoundPreset["render"] = (ctx, out) => {
  const wet = reverb(ctx, out, 0.6, 3.6, 0.25);
  [0, 0.055].forEach((start, i) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 0.09, 400 + i * 17);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 2600 + i * 900;
    band.Q.value = 1.6;
    const gain = ctx.createGain();
    envelope(ctx, gain.gain, start, 0.001, 0.004, 0.055, i === 0 ? 0.5 : 0.34);
    src.connect(band).connect(gain);
    gain.connect(out);
    gain.connect(wet);
    src.start(start);
  });
};

const glitch: SoundPreset["render"] = (ctx, out, seconds) => {
  const steps = 22;
  for (let i = 0; i < steps; i++) {
    const start = (i / steps) * seconds;
    const dur = 0.018 + ((i * 37) % 5) * 0.006;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, dur + 0.01, 700 + i * 13);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 400 + ((i * 613) % 4200);
    band.Q.value = 6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.36 * (i % 3 === 0 ? 1 : 0.6), start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(band).connect(gain);
    gain.connect(out);
    gain.connect(reverb(ctx, out, 0.45, 4, 0.2));
    src.start(start);
  }
};

const ambience = (seconds: number, peak: number): SoundPreset["render"] => (ctx, out) => {
  [55, 82.5, 110.3].forEach((freq, i) => {
    const node = osc(ctx, "sawtooth", freq, 0, seconds);
    node.detune.value = i * 7 - 7;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 380 + i * 90;
    filter.Q.value = 2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, 0);
    gain.gain.exponentialRampToValueAtTime(peak / (i + 1.5), 1.1);
    gain.gain.setValueAtTime(peak / (i + 1.5), seconds - 1.2);
    gain.gain.exponentialRampToValueAtTime(0.0001, seconds);
    node.connect(filter).connect(gain).connect(out);
  });

  const hiss = ctx.createBufferSource();
  hiss.buffer = noiseBuffer(ctx, seconds, 555);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 900;
  const hissGain = ctx.createGain();
  hissGain.gain.setValueAtTime(0.0001, 0);
  hissGain.gain.exponentialRampToValueAtTime(peak * 0.28, 1.4);
  hissGain.gain.exponentialRampToValueAtTime(0.0001, seconds);
  hiss.connect(lp).connect(hissGain).connect(out);
  hiss.start(0);
};

export const SOUND_PRESETS: SoundPreset[] = [
  {
    id: "whoosh-soft",
    name: "Whoosh Soft",
    category: "transition",
    blurb: "Gentle airy sweep",
    seconds: 0.9,
    gain: 0.85,
    render: whoosh({ from: 260, to: 2400, peak: 0.55, q: 1.1, seed: 91 }),
  },
  {
    id: "whoosh-hard",
    name: "Whoosh Hard",
    category: "transition",
    blurb: "Fast, punchy swipe",
    seconds: 0.55,
    gain: 1,
    render: whoosh({ from: 420, to: 5200, peak: 0.8, q: 2.4, seed: 137 }),
  },
  {
    id: "swipe-back",
    name: "Swipe Back",
    category: "transition",
    blurb: "Reverse-style pull",
    seconds: 0.8,
    gain: 0.9,
    render: whoosh({ from: 300, to: 2800, peak: 0.6, q: 1.6, reverse: true, seed: 211 }),
  },
  {
    id: "riser",
    name: "Riser",
    category: "transition",
    blurb: "Tension build, 2s",
    seconds: 2,
    gain: 0.8,
    render: riser(0.34, 2),
  },
  {
    id: "downlifter",
    name: "Downlifter",
    category: "transition",
    blurb: "Falling tail after a cut",
    seconds: 1.4,
    gain: 0.85,
    render: downlifter(0.4, 1.4),
  },
  {
    id: "impact",
    name: "Impact",
    category: "impact",
    blurb: "Cinematic hit with tail",
    seconds: 1.8,
    gain: 1,
    render: impact(0.75, 1.8),
  },
  {
    id: "sub-drop",
    name: "Sub Drop",
    category: "impact",
    blurb: "Deep low-end drop",
    seconds: 1.2,
    gain: 1,
    render: blip({ from: 90, to: 32, seconds: 1.2, peak: 0.85, type: "sine" }),
  },
  {
    id: "glitch",
    name: "Glitch",
    category: "impact",
    blurb: "Stuttered digital noise",
    seconds: 0.8,
    gain: 0.8,
    render: glitch,
  },
  {
    id: "pop",
    name: "Pop",
    category: "ui",
    blurb: "Short bubble blip",
    seconds: 0.16,
    gain: 0.9,
    render: blip({ from: 780, to: 220, seconds: 0.16, peak: 0.6, type: "sine" }),
  },
  {
    id: "click",
    name: "Click",
    category: "ui",
    blurb: "Tiny tactile tick",
    seconds: 0.08,
    gain: 0.7,
    render: blip({ from: 1600, to: 900, seconds: 0.08, peak: 0.4, type: "triangle" }),
  },
  {
    id: "ding",
    name: "Ding",
    category: "ui",
    blurb: "Bright notification bell",
    seconds: 2.2,
    gain: 0.55,
    render: bell(880, 2.2, 0.3),
  },
  {
    id: "sparkle",
    name: "Sparkle",
    category: "ui",
    blurb: "Ascending shimmer",
    seconds: 0.9,
    gain: 0.8,
    render: sparkle,
  },
  {
    id: "shutter",
    name: "Shutter",
    category: "ui",
    blurb: "Camera shutter double-click",
    seconds: 0.4,
    gain: 0.9,
    render: shutter,
  },
  {
    id: "ambience-drone",
    name: "Drone Bed",
    category: "ambience",
    blurb: "Slow tonal backdrop, 8s",
    seconds: 8,
    gain: 0.7,
    render: ambience(8, 0.5),
  },
];

export const SOUND_CATEGORIES: { id: SoundCategory; label: string }[] = [
  { id: "transition", label: "Transitions" },
  { id: "impact", label: "Impacts" },
  { id: "ui", label: "Interface" },
  { id: "ambience", label: "Ambience" },
];

export function soundPreset(id: string): SoundPreset | undefined {
  return SOUND_PRESETS.find((p) => p.id === id);
}

/* ------------------------------------------------------------------ *
 * Rendering + playback
 * ------------------------------------------------------------------ */

const bufferCache = new Map<string, AudioBuffer>();

export async function renderSound(preset: SoundPreset): Promise<AudioBuffer> {
  const cached = bufferCache.get(preset.id);
  if (cached) return cached;

  const sampleRate = getAudioContext().sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * preset.seconds), sampleRate);
  const master = offline.createGain();
  master.gain.value = preset.gain;
  master.connect(offline.destination);
  preset.render(offline, master, preset.seconds);

  const buffer = await offline.startRendering();
  bufferCache.set(preset.id, buffer);
  return buffer;
}

export async function generateSound(preset: SoundPreset): Promise<{ asset: Asset; meta: LoadedMeta }> {
  const buffer = await renderSound(preset);
  const wav = encodeWav(buffer);
  const url = URL.createObjectURL(wav);
  const asset: Asset = {
    id: uid("asset"),
    kind: "audio",
    name: preset.name,
    mime: "audio/wav",
    url,
    size: wav.size,
    generated: true,
    width: 0,
    height: 0,
    duration: buffer.duration,
    audioBuffer: buffer,
    waveform: computePeaks(buffer),
  };
  return { asset, meta: assetMetaPatch(asset) };
}

let audition: AudioBufferSourceNode | null = null;

/** Plays a preset through the live output without touching the project. */
export async function auditionSound(preset: SoundPreset): Promise<void> {
  const ctx = await resumeAudioContext();
  const buffer = await renderSound(preset);
  audition?.stop();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = preset.gain;
  source.connect(gain).connect(ctx.destination);
  source.onended = () => {
    if (audition === source) audition = null;
  };
  source.start();
  audition = source;
}

export function stopAudition() {
  audition?.stop();
  audition = null;
}

/* ------------------------------------------------------------------ *
 * Store bridge
 * ------------------------------------------------------------------ */

export async function addSoundLayer(preset: SoundPreset, startTime?: number): Promise<string | null> {
  const { asset, meta } = await generateSound(preset);
  editor().addAsset(asset);
  editor().updateAsset(asset.id, meta);
  const id = editor().addMediaLayer(asset.id, startTime ?? editor().currentTime);
  if (!id) {
    toast.error("Couldn't place that sound");
    return null;
  }
  toast.success(`${preset.name} added`, { description: "Dropped on the timeline at the playhead." });
  return id;
}
