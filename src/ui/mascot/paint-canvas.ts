import type { DavePainter } from "./engine.ts";

export type CanvasDavePainter = DavePainter & {
  /** Size the backing store for `size` CSS px at `dpr` and clear it. Call once per frame. */
  begin(size: number, dpr: number): void;
};

const MAX_SPRITES = 48;

/** Canvas2D DavePainter: devicePixelRatio aware, with cached radial-glow sprites per colour/radius. */
export function createCanvasPainter(canvas: HTMLCanvasElement): CanvasDavePainter | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const sprites = new Map<string, HTMLCanvasElement>();
  let scale = 1;

  const sprite = (color: string, r: number): HTMLCanvasElement | null => {
    const px = Math.max(2, Math.round(r * scale));
    const key = `${color}|${px}`;
    const hit = sprites.get(key);
    if (hit) return hit;
    const c = document.createElement("canvas");
    c.width = c.height = px * 2;
    const g = c.getContext("2d");
    if (!g) return null;
    const grad = g.createRadialGradient(px, px, 0, px, px, px);
    grad.addColorStop(0, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, px * 2, px * 2);
    if (sprites.size >= MAX_SPRITES) {
      const oldest = sprites.keys().next().value;
      if (oldest !== undefined) sprites.delete(oldest);
    }
    sprites.set(key, c);
    return c;
  };

  return {
    begin(size, dpr) {
      const d = dpr > 0 && Number.isFinite(dpr) ? Math.min(dpr, 3) : 1;
      const w = Math.round(size * d);
      if (canvas.width !== w || canvas.height !== w) { canvas.width = w; canvas.height = w; }
      if (d !== scale) { scale = d; sprites.clear(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, w);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.globalAlpha = 1;
    },
    dot(x, y, r, color, alpha = 1) {
      if (alpha <= 0.003) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    },
    glow(x, y, r, color, alpha = 1) {
      if (alpha <= 0.003) return;
      const s = sprite(color, r);
      if (!s) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(s, x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    },
    roundRect(x, y, w, h, r, fill, stroke) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    },
    line(x1, y1, x2, y2, color, width) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    },
    poly(points, fill, stroke) {
      if (points.length < 6) return;
      ctx.beginPath();
      ctx.moveTo(points[0] ?? 0, points[1] ?? 0);
      for (let i = 2; i + 1 < points.length; i += 2) ctx.lineTo(points[i] ?? 0, points[i + 1] ?? 0);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    },
    ellipse(x, y, rx, ry, color, alpha = 1) {
      if (alpha <= 0.003) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    },
  };
}
