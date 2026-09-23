/**
 * PROCEDURAL EFFECTS & OVERLAYS.
 *
 * Every overlay, light effect, particle field and background in the library is
 * drawn from code — no image files, no network, and resolution independent. One
 * function serves three callers: the compositor (paints it on the canvas), the
 * library thumbnails (paints the same thing into a small canvas) and the demo
 * project. That shared path is why a thumbnail cannot misrepresent an effect.
 *
 * All drawing happens in LAYER-LOCAL space, centred on (0,0) and spanning the
 * layer's box (w × h). `time` is the layer-local time in seconds, which is what
 * animates the kinds that move.
 */
import { rngFrom } from "@/lib/random";
import type { EffectStyle } from "@/types/editor";

const TAU = Math.PI * 2;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function fillBox(ctx: CanvasRenderingContext2D, w: number, h: number, style: string | CanvasGradient) {
  ctx.fillStyle = style;
  ctx.fillRect(-w / 2, -h / 2, w, h);
}

function withAlpha(ctx: CanvasRenderingContext2D, alpha: number, draw: () => void) {
  if (alpha <= 0.002) return;
  const previous = ctx.globalAlpha;
  ctx.globalAlpha = previous * clamp01(alpha);
  draw();
  ctx.globalAlpha = previous;
}

/** Radial gradient helper that always returns a usable gradient. */
function radial(ctx: CanvasRenderingContext2D, r: number, stops: [number, string][]) {
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, r));
  for (const [at, color] of stops) grad.addColorStop(at, color);
  return grad;
}

/** Linear gradient across the box at `angleDeg`. */
function linear(ctx: CanvasRenderingContext2D, w: number, h: number, angleDeg: number, stops: [number, string][]) {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad) * (w / 2);
  const dy = Math.sin(rad) * (h / 2);
  const grad = ctx.createLinearGradient(-dx, -dy, dx, dy);
  for (const [at, color] of stops) grad.addColorStop(at, color);
  return grad;
}

/** A soft blurred blob — the building block for bokeh, dust and light leaks. */
function blob(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = radial(ctx, r, [
    [0, color],
    [0.55, color],
    [1, "rgba(0,0,0,0)"],
  ]);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * The renderer
 * ------------------------------------------------------------------ */

export interface EffectDrawArgs {
  ctx: CanvasRenderingContext2D;
  style: EffectStyle;
  /** layer box, in local units */
  width: number;
  height: number;
  /** layer-local seconds */
  time: number;
  /** stable key for seeding — usually the layer id */
  seedKey: string;
}

/**
 * Draws one effect/overlay centred on the origin.
 * The caller owns `globalCompositeOperation` (from `style.blend`) and alpha.
 */
export function drawEffect({ ctx, style, width, height, time, seedKey }: EffectDrawArgs): void {
  const w = Math.max(2, width);
  const h = Math.max(2, height);
  const span = Math.max(w, h);
  const amount = clamp01(style.amount);
  const size = clamp01(style.scale);
  const phase = style.seed || 0;
  const rand = rngFrom(`${seedKey}:${style.kind}:${Math.round(style.seed * 997)}`);
  const t = time + phase * 10;

  switch (style.kind) {
    /* ---------------- plates ---------------- */

    case "solid":
      fillBox(ctx, w, h, style.color);
      break;

    case "gradient":
      fillBox(ctx, w, h, linear(ctx, w, h, style.angle, [
        [0, style.color],
        [1, style.color2],
      ]));
      break;

    case "rail": {
      // A full-width horizontal bar pinned to the bottom of the frame — the
      // brand "red rail". Thickness is ~8px at 1080p and scales with the frame;
      // `style.color` is the fill.
      const thickness = Math.max(2, h * 0.0075);
      const inset = h * 0.02;
      const top = h / 2 - inset - thickness;
      ctx.fillStyle = style.color;
      ctx.fillRect(-w / 2, top, w, thickness);
      break;
    }

    case "vignette": {
      // Strength comes from `amount` so the preset can be gentle or crushing.
      const strength = 0.25 + amount * 0.75;
      const grad = radial(ctx, span * 0.72, [
        [0, "rgba(0,0,0,0)"],
        [0.45, `rgba(0,0,0,${0.12 * strength})`],
        [0.78, `rgba(0,0,0,${0.55 * strength})`],
        [1, style.color],
      ]);
      fillBox(ctx, w, h, grad);
      break;
    }

    case "grid": {
      const cells = 4 + Math.round(amount * 20);
      const step = span / cells;
      withAlpha(ctx, 0.35 + amount * 0.55, () => {
        ctx.strokeStyle = style.color;
        ctx.lineWidth = Math.max(1, span * 0.0022);
        ctx.beginPath();
        for (let x = -w / 2; x <= w / 2 + 0.5; x += step) {
          ctx.moveTo(x, -h / 2);
          ctx.lineTo(x, h / 2);
        }
        for (let y = -h / 2; y <= h / 2 + 0.5; y += step) {
          ctx.moveTo(-w / 2, y);
          ctx.lineTo(w / 2, y);
        }
        ctx.stroke();
      });
      break;
    }

    case "halftone": {
      const cells = 14 + Math.round((1 - size) * 46);
      const step = span / cells;
      const maxR = step * 0.62;
      const rad = (style.angle * Math.PI) / 180;
      const nx = Math.cos(rad);
      const ny = Math.sin(rad);
      ctx.fillStyle = style.color;
      for (let y = -h / 2; y <= h / 2; y += step) {
        for (let x = -w / 2; x <= w / 2; x += step) {
          // Dot radius follows a projection across the box, plus a soft falloff.
          const proj = ((x * nx + y * ny) / span) * 0.5 + 0.5;
          const r = maxR * clamp01(1 - proj * (0.4 + amount * 0.9));
          if (r < 0.35) continue;
          ctx.beginPath();
          ctx.arc(x + step / 2, y + step / 2, r, 0, TAU);
          ctx.fill();
        }
      }
      break;
    }

    case "prism": {
      const gradient = linear(ctx, w, h, style.angle, [
        [0, "rgba(255,0,128,0.55)"],
        [0.2, "rgba(255,214,0,0.5)"],
        [0.4, "rgba(0,255,170,0.5)"],
        [0.6, "rgba(0,170,255,0.5)"],
        [0.8, "rgba(140,0,255,0.5)"],
        [1, style.color2],
      ]);
      withAlpha(ctx, 0.35 + amount * 0.6, () => fillBox(ctx, w, h, gradient));
      break;
    }

    /* ---------------- light ---------------- */

    case "glow": {
      const pulse = 0.72 + Math.sin(t * 2.1) * 0.28;
      const r = span * (0.3 + size * 0.55) * pulse;
      withAlpha(ctx, 0.5 + amount * 0.5, () => {
        ctx.save();
        ctx.translate(0, 0);
        fillBox(ctx, w, h, radial(ctx, r, [
          [0, style.color],
          [0.42, style.color2],
          [1, "rgba(0,0,0,0)"],
        ]));
        ctx.restore();
      });
      break;
    }

    case "lightLeak": {
      const sweep = (t * 0.28 + phase) % 1;
      const rad = (style.angle * Math.PI) / 180;
      const cx = (sweep * 2 - 1) * w * 0.55;
      const cy = -h * 0.2 + Math.sin(t * 0.6) * h * 0.14;
      withAlpha(ctx, 0.55 + amount * 0.45, () => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rad);
        fillBox(ctx, w * 1.4, h * 2, linear(ctx, w * 1.4, h * 2, 0, [
          [0, "rgba(0,0,0,0)"],
          [0.38, style.color],
          [0.5, style.color2],
          [0.62, style.color],
          [1, "rgba(0,0,0,0)"],
        ]));
        ctx.restore();
        blob(ctx, cx + w * 0.1, cy, span * 0.32, style.color2);
      });
      break;
    }

    case "flares": {
      const count = 3 + Math.round(amount * 9);
      const r0 = span * (0.18 + size * 0.4);
      const drift = t * 0.5;
      withAlpha(ctx, 0.45 + amount * 0.55, () => {
        // Streaks radiating from a hotspot.
        ctx.save();
        ctx.translate(0, 0);
        for (let i = 0; i < count; i++) {
          const a = (i / count) * TAU + drift * 0.2;
          const len = r0 * (1 + rand() * 1.8);
          ctx.save();
          ctx.rotate(a);
          ctx.fillStyle = linear(ctx, len, span * 0.06, 0, [
            [0, style.color],
            [1, "rgba(0,0,0,0)"],
          ]);
          ctx.fillRect(0, -span * 0.008, len, span * 0.016);
          ctx.restore();
        }
        ctx.restore();
        // Hexagonal ghosting, the classic anamorphic tell.
        for (let i = 0; i < 5; i++) {
          const a = drift * 0.35 + (i / 5) * TAU;
          const dist = r0 * (0.5 + i * 0.24);
          ctx.save();
          ctx.translate(Math.cos(a) * dist, Math.sin(a) * dist * 0.55);
          ctx.globalAlpha = ctx.globalAlpha * (0.3 - i * 0.05);
          ctx.fillStyle = i % 2 ? style.color2 : style.color;
          ctx.beginPath();
          for (let s = 0; s < 6; s++) {
            const ang = (s / 6) * TAU;
            const px = Math.cos(ang) * span * 0.045;
            const py = Math.sin(ang) * span * 0.045;
            if (s === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        blob(ctx, 0, 0, span * 0.22, style.color);
      });
      break;
    }

    case "rays": {
      const blades = 8 + Math.round(amount * 28);
      const spin = t * 0.22 + phase;
      const length = span * (0.6 + size * 1.4);
      withAlpha(ctx, 0.3 + amount * 0.55, () => {
        ctx.save();
        ctx.rotate(spin);
        for (let i = 0; i < blades; i++) {
          const a = (i / blades) * TAU;
          const spread = (TAU / blades) * (0.22 + rand() * 0.3);
          const fade = 0.35 + rand() * 0.65;
          ctx.save();
          ctx.rotate(a);
          ctx.fillStyle = linear(ctx, length, h, 0, [
            [0, style.color],
            [1, "rgba(0,0,0,0)"],
          ]);
          ctx.globalAlpha = ctx.globalAlpha * fade;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(length, -Math.tan(spread / 2) * length);
          ctx.lineTo(length, Math.tan(spread / 2) * length);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        ctx.restore();
        blob(ctx, 0, 0, span * 0.3, style.color2);
      });
      break;
    }

    case "streaks": {
      const count = 5 + Math.round(amount * 18);
      withAlpha(ctx, 0.3 + amount * 0.5, () => {
        for (let i = 0; i < count; i++) {
          const y = (i / count - 0.5) * h * 1.1 + Math.sin(t * 0.7 + i) * h * 0.03;
          const x = Math.sin(t * 0.42 + i * 1.7) * w * 0.22;
          const len = w * (0.35 + rand() * 0.65);
          const thick = Math.max(1, h * (0.002 + rand() * 0.008) * (0.5 + size * 3));
          ctx.fillStyle = linear(ctx, len, thick, 0, [
            [0, "rgba(0,0,0,0)"],
            [0.5, style.color],
            [1, "rgba(0,0,0,0)"],
          ]);
          ctx.fillRect(x - len / 2, y - thick / 2, len, thick);
        }
      });
      break;
    }

    /* ---------------- particles ---------------- */

    case "bokeh": {
      const count = 10 + Math.round(amount * 50);
      withAlpha(ctx, 0.55 + amount * 0.45, () => {
        // Read once: an alpha attributed per particle by multiplying
        // ctx.globalAlpha into itself compounds downwards, so the field thins
        // out as it is drawn instead of holding its density.
        const base = ctx.globalAlpha;
        for (let i = 0; i < count; i++) {
          const x = (rand() - 0.5) * w * 1.15;
          const baseY = (rand() - 0.5) * h * 1.15;
          const r = span * (0.012 + rand() * 0.075) * (0.4 + size * 2.4);
          const drift = Math.sin(t * (0.25 + rand() * 0.5) + i) * h * 0.03;
          const color = i % 3 === 0 ? style.color2 : style.color;
          ctx.globalAlpha = base * (0.25 + rand() * 0.6);
          blob(ctx, x, baseY + drift, r, color);
        }
      });
      break;
    }

    case "dust": {
      const count = 60 + Math.round(amount * 340);
      withAlpha(ctx, 0.45 + amount * 0.55, () => {
        ctx.fillStyle = style.color;
        const base = ctx.globalAlpha;
        for (let i = 0; i < count; i++) {
          const x = (rand() - 0.5) * w;
          const y = (rand() - 0.5) * h;
          const s = span * (0.0008 + rand() * 0.0035) * (0.4 + size * 3);
          const drift = Math.sin(t * (0.6 + rand()) + i * 2.3) * span * 0.006;
          ctx.globalAlpha = base * (0.3 + rand() * 0.7);
          ctx.fillRect(x, y + drift, s, s);
        }
      });
      break;
    }

    case "snow": {
      const count = 40 + Math.round(amount * 280);
      withAlpha(ctx, 0.5 + amount * 0.5, () => {
        const base = ctx.globalAlpha;
        for (let i = 0; i < count; i++) {
          const speed = 0.06 + rand() * 0.22;
          const x0 = (rand() - 0.5) * w * 1.2;
          const y = ((rand() + t * speed) % 1.2) * h * 1.2 - h * 0.6;
          const sway = Math.sin(t * 0.8 + i) * w * 0.02;
          const r = span * (0.0015 + rand() * 0.005) * (0.5 + size * 3);
          ctx.globalAlpha = base * (0.35 + rand() * 0.65);
          blob(ctx, x0 + sway, y, r * 3.4, style.color);
        }
      });
      break;
    }

    case "confetti": {
      const count = 30 + Math.round(amount * 220);
      const colors = [style.color, style.color2, "#ffffff"];
      withAlpha(ctx, 0.75 + amount * 0.25, () => {
        for (let i = 0; i < count; i++) {
          const speed = 0.1 + rand() * 0.3;
          const y = ((rand() + t * speed) % 1.25) * h * 1.25 - h * 0.62;
          const x = (rand() - 0.5) * w * 1.15 + Math.sin(t * 1.4 + i) * w * 0.04;
          const cw = span * (0.006 + rand() * 0.012) * (0.5 + size * 2.6);
          const ch = cw * (0.35 + rand() * 0.9);
          ctx.save();
          ctx.translate(x, y + h / 2);
          ctx.rotate(t * (1 + rand() * 3) + i);
          ctx.fillStyle = colors[i % colors.length];
          ctx.globalAlpha = ctx.globalAlpha * (0.6 + rand() * 0.4);
          ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
          ctx.restore();
        }
      });
      break;
    }

    case "sparkle": {
      const count = 12 + Math.round(amount * 90);
      withAlpha(ctx, 0.6 + amount * 0.4, () => {
        for (let i = 0; i < count; i++) {
          const x = (rand() - 0.5) * w * 1.05;
          const y = (rand() - 0.5) * h * 1.05;
          const life = (t * (0.5 + rand()) + rand() * 4) % 1;
          const grow = Math.sin(life * Math.PI);
          if (grow <= 0.02) continue;
          const arm = span * (0.006 + rand() * 0.02) * (0.4 + size * 2.6) * grow;
          ctx.save();
          ctx.translate(x, y);
          ctx.fillStyle = i % 2 ? style.color2 : style.color;
          ctx.globalAlpha = ctx.globalAlpha * grow;
          ctx.beginPath();
          ctx.moveTo(0, -arm);
          ctx.quadraticCurveTo(arm * 0.14, -arm * 0.14, arm, 0);
          ctx.quadraticCurveTo(arm * 0.14, arm * 0.14, 0, arm);
          ctx.quadraticCurveTo(-arm * 0.14, arm * 0.14, -arm, 0);
          ctx.quadraticCurveTo(-arm * 0.14, -arm * 0.14, 0, -arm);
          ctx.fill();
          ctx.restore();
        }
      });
      break;
    }

    /* ---------------- texture ---------------- */

    case "grain": {
      const count = 400 + Math.round(amount * 3200);
      withAlpha(ctx, 0.25 + amount * 0.5, () => {
        const base = ctx.globalAlpha;
        for (let i = 0; i < count; i++) {
          const x = (rand() - 0.5) * w;
          const y = (rand() - 0.5) * h;
          const s = Math.max(1, span * 0.0018 * (0.4 + size * 3));
          const v = rand();
          ctx.fillStyle = v > 0.5 ? style.color : style.color2;
          ctx.globalAlpha = base * (0.15 + rand() * 0.55);
          ctx.fillRect(x, y, s, s);
        }
      });
      break;
    }

    case "noise": {
      // Blocky signal noise rather than per-pixel grain — cheap and stylised.
      const cells = 22 + Math.round((1 - size) * 70);
      const step = span / cells;
      const shift = Math.floor(t * 12) % cells;
      withAlpha(ctx, 0.25 + amount * 0.5, () => {
        const base = ctx.globalAlpha;
        for (let row = 0; row * step < h + step; row++) {
          const jitter = ((row * 7 + shift) % 5) - 2;
          for (let col = -2; col * step < w + step * 2; col++) {
            const idx = (col + jitter + cells * 3) % cells;
            const v = ((idx * 37 + row * 53 + shift * 17) % 100) / 100;
            if (v < 1 - amount * 0.9) continue;
            ctx.fillStyle = v > 0.85 ? style.color2 : style.color;
            ctx.globalAlpha = base * (0.2 + v * 0.5);
            ctx.fillRect(-w / 2 + col * step, -h / 2 + row * step, step, step);
          }
        }
      });
      break;
    }

    case "scanlines": {
      const step = Math.max(2, span * (0.012 - size * 0.008));
      const band = ((t * 0.35 + phase) % 1) * (h + span * 0.3) - h / 2 - span * 0.15;
      withAlpha(ctx, 0.3 + amount * 0.6, () => {
        ctx.fillStyle = style.color;
        const base = ctx.globalAlpha;
        for (let y = -h / 2; y < h / 2; y += step) {
          ctx.globalAlpha = base * 0.7;
          ctx.fillRect(-w / 2, y, w, step * 0.42);
        }
        ctx.fillStyle = linear(ctx, w, span * 0.4, 90, [
          [0, "rgba(0,0,0,0)"],
          [0.5, style.color2],
          [1, "rgba(0,0,0,0)"],
        ]);
        ctx.fillRect(-w / 2, band, w, span * 0.16);
      });
      break;
    }

    default:
      break;
  }
}
