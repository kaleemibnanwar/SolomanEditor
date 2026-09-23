/**
 * WEBGL TRANSITION PASS.
 *
 * The Canvas-2D transitions in `transitions.ts` can fade, mask, slide and slice,
 * but they cannot resample pixels — so swirls, ripples, melts and true A→B
 * cross-warps are out of reach. This module covers that gap: it uploads the
 * frame *below* the layer (texture A) and the frame *including* it (texture B),
 * runs one fragment shader over both and hands a canvas back to the compositor.
 *
 * The shaders are reimplementations of the classic MIT-licensed `gl-transitions`
 * collection (gl-transitions.com), reduced to WebGL 1 / GLSL ES 1.0 so they run
 * everywhere. Everything degrades gracefully: if WebGL is missing, or the pass
 * throws, the compositor falls back to a plain cross-fade and the export still
 * completes.
 */

export type ShaderTransitionId = "swirl" | "ripple" | "melt" | "crossZoom" | "luma" | "crosswarp" | "waterDrop";

export interface ShaderFrame {
  /** frame with only the layers below the current one */
  from: CanvasImageSource;
  /** the same frame plus the current layer */
  to: CanvasImageSource;
  /** 0 → A visible, 1 → B visible */
  progress: number;
  /** 0..1 feather for the mask-style shaders */
  softness: number;
  /** rgb 0..1 for the colour-aware shaders */
  color: [number, number, number];
}

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform float u_softness;
uniform vec3 u_color;
uniform float u_ratio;

vec4 getFromColor(vec2 uv) { return texture2D(u_from, uv); }
vec4 getToColor(vec2 uv) { return texture2D(u_to, uv); }

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec2 aspect(vec2 uv) { return vec2(uv.x * u_ratio, uv.y); }
`;

/**
 * Each body must assign `gl_FragColor`. `P` is the eased progress.
 * Ported from gl-transitions (MIT). `SWIRL_ANGLE`, `RIPPLE_*` etc. are inlined.
 */
const BODIES: Record<ShaderTransitionId, string> = {
  /* https://gl-transitions.com/editor/Swirl */
  swirl: `
    vec2 center = vec2(0.5);
    float radius = distance(aspect(v_uv), aspect(center));
    float angle = 4.0 * (1.0 - P) * (1.0 - radius);
    float s = sin(angle);
    float c = cos(angle);
    vec2 d = v_uv - center;
    vec2 warped = center + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
    gl_FragColor = mix(getFromColor(v_uv), getToColor(warped), P);
  `,

  /* https://gl-transitions.com/editor/WaterDrop — concentric displacement */
  ripple: `
    vec2 d = aspect(v_uv) - aspect(vec2(0.5));
    float r = length(d);
    float wave = sin(r * 42.0 - P * 16.0) * (1.0 - P) * 0.035;
    vec2 warped = clamp(v_uv + normalize(d + 1e-6) * wave, 0.0, 1.0);
    gl_FragColor = mix(getFromColor(v_uv), getToColor(warped), smoothstep(0.0, 0.35, P));
  `,

  /* https://gl-transitions.com/editor/Melt — column-wise drip */
  melt: `
    float col = floor(v_uv.x * 40.0);
    float drop = hash(vec2(col, 7.0)) * 0.6 + 0.25;
    float slide = P * drop;
    float up = v_uv.y + slide;
    vec4 a = getFromColor(vec2(v_uv.x, up));
    vec4 b = getToColor(vec2(v_uv.x, up));
    float edge = smoothstep(slide - 0.14 - u_softness * 0.2, slide + 0.05, 1.0 - v_uv.y);
    gl_FragColor = mix(b, a, edge);
  `,

  /* https://gl-transitions.com/editor/CrossZoom */
  crossZoom: `
    float strength = 0.4;
    vec2 center = vec2(0.5);
    float zoom = mix(1.0 + strength, 0.0, P);
    vec4 a = getFromColor(center + (v_uv - center) * (1.0 + zoom * 0.6));
    vec4 b = getToColor(center + (v_uv - center) * (1.0 - zoom * 0.6));
    float fade = smoothstep(0.0, 0.6, P) * (1.0 - smoothstep(0.6, 1.0, P) * 0.0);
    gl_FragColor = mix(a, b, clamp(fade, 0.0, 1.0));
    gl_FragColor = mix(gl_FragColor, mix(a, b, P), 0.35);
  `,

  /* https://gl-transitions.com/editor/SimpleLuma — procedural luma mask wipe */
  luma: `
    float n = noise(v_uv * 6.0) * 0.6 + noise(v_uv * 18.0) * 0.4;
    float radial = 1.0 - distance(aspect(v_uv), aspect(vec2(0.5))) * 1.35;
    float mask = clamp(n * 0.55 + radial * 0.45, 0.0, 1.0);
    float feather = max(0.02, u_softness * 0.45);
    float t = smoothstep(mask - feather, mask + feather, P * 1.15);
    gl_FragColor = mix(getFromColor(v_uv), getToColor(v_uv), t);
  `,

  /* https://gl-transitions.com/editor/Crosswarp — opposing warps meeting in the middle */
  crosswarp: `
    vec2 dir = v_uv - vec2(0.5);
    float dist = length(aspect(dir));
    float move = smoothstep(0.0, 1.0, P);
    vec2 fromUv = v_uv + dir * move * 0.55;
    vec2 toUv = v_uv - dir * (1.0 - move) * 0.55;
    vec4 a = getFromColor(clamp(fromUv, 0.0, 1.0));
    vec4 b = getToColor(clamp(toUv, 0.0, 1.0));
    gl_FragColor = mix(a, b, move);
  `,

  /* https://gl-transitions.com/editor/WaterDrop */
  waterDrop: `
    vec2 d = aspect(v_uv) - aspect(vec2(0.5));
    float r = length(d);
    float radius = P * 0.85;
    float wobble = sin(r * 30.0 - P * 20.0) * 0.02 * (1.0 - P);
    vec2 warped = v_uv + normalize(d + 1e-6) * wobble;
    float inner = smoothstep(radius, radius - 0.06 - u_softness * 0.1, r);
    gl_FragColor = mix(getFromColor(v_uv), getToColor(warped), inner);
  `,
};

/* ------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------ */

interface CompiledProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let quad: WebGLBuffer | null = null;
let textures: [WebGLTexture, WebGLTexture] | null = null;
const programs = new Map<string, CompiledProgram | null>();
const failed = new Set<string>();
let disabled = false;

function compile(source: string, type: number): WebGLShader | null {
  if (!gl) return null;
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function build(id: ShaderTransitionId): CompiledProgram | null {
  if (!gl) return null;
  const body = BODIES[id] ?? BODIES.luma;
  const vs = compile(VERTEX_SHADER, gl.VERTEX_SHADER);
  const fs = compile(`${HEADER}\nvoid main() {\n  float P = clamp(u_progress, 0.0, 1.0);\n${body}\n}`, gl.FRAGMENT_SHADER);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of ["u_from", "u_to", "u_progress", "u_softness", "u_color", "u_ratio"]) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

/** Lazily boots the WebGL context. Returns false when the pass is unusable. */
export function ensureShaderRuntime(): boolean {
  if (disabled) return false;
  if (gl && canvas) return true;
  try {
    const c = document.createElement("canvas");
    const ctx =
      (c.getContext("webgl", { premultipliedAlpha: false, alpha: true, antialias: false }) as WebGLRenderingContext | null) ??
      (c.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (!ctx) {
      disabled = true;
      return false;
    }
    canvas = c;
    gl = ctx;
    quad = ctx.createBuffer();
    ctx.bindBuffer(ctx.ARRAY_BUFFER, quad);
    ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), ctx.STATIC_DRAW);
    ctx.enableVertexAttribArray(0);
    ctx.vertexAttribPointer(0, 2, ctx.FLOAT, false, 0, 0);
    textures = [ctx.createTexture(), ctx.createTexture()];
    for (const tex of textures) {
      ctx.bindTexture(ctx.TEXTURE_2D, tex);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
      ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
    }
    return true;
  } catch {
    disabled = true;
    return false;
  }
}

export function transitionShaderAvailable(id: ShaderTransitionId): boolean {
  if (disabled || failed.has(id)) return false;
  if (!ensureShaderRuntime()) return false;
  if (!programs.has(id)) programs.set(id, build(id));
  const compiled = programs.get(id);
  if (!compiled) {
    failed.add(id);
    return false;
  }
  return true;
}

function uploadTexture(unit: number, tex: WebGLTexture, source: CanvasImageSource) {
  if (!gl) return;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
}

/**
 * Runs a transition shader and returns the canvas holding the result, or null
 * when the pass cannot run (caller must fall back).
 */
export function runTransitionShader(
  id: ShaderTransitionId,
  frame: ShaderFrame,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  if (!transitionShaderAvailable(id)) return null;
  const compiled = programs.get(id);
  if (!gl || !canvas || !compiled || !textures) return null;

  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  try {
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compiled.program);

    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    uploadTexture(0, textures[0], frame.from);
    uploadTexture(1, textures[1], frame.to);

    gl.uniform1i(compiled.uniforms.u_from ?? null, 0);
    gl.uniform1i(compiled.uniforms.u_to ?? null, 1);
    gl.uniform1f(compiled.uniforms.u_progress ?? null, frame.progress);
    gl.uniform1f(compiled.uniforms.u_softness ?? null, frame.softness);
    gl.uniform3f(compiled.uniforms.u_color ?? null, frame.color[0], frame.color[1], frame.color[2]);
    gl.uniform1f(compiled.uniforms.u_ratio ?? null, w / h);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return canvas;
  } catch {
    failed.add(id);
    return null;
  }
}

/** Drops the compiled programs — used when the shader source set changes. */
export function resetShaderRuntime() {
  if (gl) {
    for (const entry of programs.values()) if (entry) gl.deleteProgram(entry.program);
  }
  programs.clear();
  failed.clear();
}
