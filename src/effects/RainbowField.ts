import { clamp } from "../utils/math";
import { RGBColor, mixRgb } from "../utils/color";

const clampChannel = (value: number) => Math.max(0, Math.min(255, value));

const accentuateBandColor = (color: RGBColor): RGBColor => {
  const saturationBoost = 1.18;
  const darknessFactor = 0.86;
  const average = (color.r + color.g + color.b) / 3;

  const saturated = {
    r: clampChannel(average + (color.r - average) * saturationBoost),
    g: clampChannel(average + (color.g - average) * saturationBoost),
    b: clampChannel(average + (color.b - average) * saturationBoost),
  };

  return {
    r: clampChannel(saturated.r * darknessFactor),
    g: clampChannel(saturated.g * darknessFactor),
    b: clampChannel(saturated.b * darknessFactor),
  };
};

interface RainbowEmitter {
  id: number;
  x: number;
  y: number;
  frequency: number;
  createdAt: number;
  lastUpdate: number;
  active: boolean;
  releaseAt?: number;
  zIndex: number;
  color: RGBColor;
  targetColor: RGBColor;
  startColor: RGBColor;
  colorTransitionStart: number;
  colorTransitionDuration: number;
}

interface RainbowPulse {
  x: number;
  y: number;
  frequency: number;
  createdAt: number;
  ttl: number;
  color: RGBColor;
}

export class RainbowField {
  private ctx: CanvasRenderingContext2D | null = null;
  private width = 0;
  private height = 0;
  private rafId: number | null = null;
  private dpr = window.devicePixelRatio || 1;
  private destroyed = false;
  private emitters = new Map<number, RainbowEmitter>();
  private pulses: RainbowPulse[] = [];
  private zCounter = 0;
  private readonly bandWidth = 26;
  private maxRadius = 0;
  private readonly releaseDuration = 200;

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", {
      alpha: true,
      desynchronized: true,
    });
    if (!context) {
      throw new Error("Unable to acquire 2D canvas context");
    }
    this.ctx = context;
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    const dpr = this.dpr;
    this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.maxRadius = Math.hypot(this.width, this.height);
    if (!this.ctx) {
      return;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  setEmitter(
    id: number,
    x: number,
    y: number,
    frequency: number,
    color: RGBColor,
    transitionDuration = 320
  ) {
    const now = performance.now();
    const existing = this.emitters.get(id);
    if (existing) {
      existing.x = x;
      existing.y = y;
      existing.frequency = frequency;
      existing.lastUpdate = now;
      if (!existing.active) {
        existing.active = true;
        existing.releaseAt = undefined;
        existing.createdAt = now;
      }
      const needsTransition =
        Math.abs(existing.targetColor.r - color.r) > 0.1 ||
        Math.abs(existing.targetColor.g - color.g) > 0.1 ||
        Math.abs(existing.targetColor.b - color.b) > 0.1;
      if (needsTransition) {
        existing.startColor = existing.color;
        existing.targetColor = color;
        existing.colorTransitionStart = now;
        existing.colorTransitionDuration = transitionDuration;
      }
      this.emitters.set(id, existing);
      return;
    }

    this.emitters.set(id, {
      id,
      x,
      y,
      frequency,
      createdAt: now,
      lastUpdate: now,
      active: true,
      zIndex: ++this.zCounter,
      color,
      startColor: color,
      targetColor: color,
      colorTransitionStart: now,
      colorTransitionDuration: transitionDuration,
    });
  }

  releaseEmitter(id: number) {
    const emitter = this.emitters.get(id);
    if (!emitter || !emitter.active) {
      return;
    }
    emitter.active = false;
    emitter.releaseAt = performance.now();
    this.emitters.set(id, emitter);
  }

  clearEmitter(id: number) {
    this.emitters.delete(id);
  }

  pulse(
    x: number,
    y: number,
    frequency: number,
    color: RGBColor,
    duration = 200
  ) {
    const now = performance.now();
    this.pulses.push({
      x,
      y,
      frequency,
      createdAt: now,
      ttl: duration,
      color,
    });
  }

  start() {
    if (this.rafId !== null) {
      return;
    }
    const loop = () => {
      if (this.destroyed) {
        return;
      }
      this.draw();
      this.rafId = window.requestAnimationFrame(loop);
    };

    this.rafId = window.requestAnimationFrame(loop);
  }

  destroy() {
    this.destroyed = true;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.emitters.clear();
    this.pulses = [];
  }

  private frequencyToSpeed(frequency: number) {
    const minFreq = 160;
    const maxFreq = 1200;
    const normalized = clamp((frequency - minFreq) / (maxFreq - minFreq), 0, 1);
    return 70 + normalized * 260;
  }

  private draw() {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, this.width, this.height);

    const now = performance.now();

    const emitters = Array.from(this.emitters.values()).sort(
      (a, b) => a.zIndex - b.zIndex
    );

    for (const emitter of emitters) {
      if (emitter.targetColor && emitter.colorTransitionDuration > 0) {
        const elapsed = now - emitter.colorTransitionStart;
        const progress = clamp(
          emitter.colorTransitionDuration === 0
            ? 1
            : elapsed / emitter.colorTransitionDuration,
          0,
          1
        );
        const mixed = mixRgb(emitter.startColor, emitter.targetColor, progress);
        emitter.color = mixed;
        if (progress >= 1) {
          emitter.startColor = mixed;
        }
      }

      const intensity = emitter.active
        ? 0.85
        : 0.85 * clamp(1 - ((now - (emitter.releaseAt ?? now)) / this.releaseDuration), 0, 1);

      if (intensity <= 0.001) {
        this.emitters.delete(emitter.id);
        continue;
      }

      this.renderRipple(
        emitter.x,
        emitter.y,
        emitter.frequency,
        now - emitter.createdAt,
        intensity,
        emitter.color
      );
    }

    const remainingPulses: RainbowPulse[] = [];
    for (const pulse of this.pulses) {
      const age = now - pulse.createdAt;
      if (age > pulse.ttl) {
        continue;
      }
      const intensity = 0.9 * (1 - age / pulse.ttl);
      this.renderRipple(
        pulse.x,
        pulse.y,
        pulse.frequency,
        age,
        intensity,
        pulse.color
      );
      remainingPulses.push(pulse);
    }
    this.pulses = remainingPulses;
  }

  private renderRipple(
    x: number,
    y: number,
    frequency: number,
    ageMs: number,
    intensity: number,
    color: RGBColor
  ) {
    const ctx = this.ctx;
    if (!ctx || intensity <= 0) {
      return;
    }

    const ageSeconds = ageMs / 1000;
    const speed = this.frequencyToSpeed(frequency);
    const offset = ageSeconds * speed;
    const band = this.bandWidth;
    const maxRadius = this.maxRadius;

    if (maxRadius <= 0) {
      return;
    }

    const minIndex = Math.floor(-offset / band) - 4;
    const maxIndex = Math.ceil((maxRadius - offset) / band) + 4;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";

    let bandIndex = 0;
    for (let i = minIndex; i <= maxIndex; i += 1) {
      const innerRadius = i * band + offset;
      const outerRadius = innerRadius + band;

      if (outerRadius <= 0) {
        continue;
      }
      if (innerRadius >= maxRadius) {
        break;
      }

      if (i % 2 !== 0) {
        continue;
      }

      const clippedInner = Math.max(0, innerRadius);
      const clippedOuter = Math.min(maxRadius, Math.max(0, outerRadius));

      if (clippedOuter <= clippedInner) {
        continue;
      }
      const bandColor =
        bandIndex % 2 === 1 ? accentuateBandColor(color) : color;
      const alpha = clamp(intensity, 0, 1);
      ctx.beginPath();
      ctx.fillStyle = `rgba(${Math.round(bandColor.r)}, ${Math.round(
        bandColor.g
      )}, ${Math.round(bandColor.b)}, ${alpha})`;
      ctx.arc(x, y, clippedOuter, 0, Math.PI * 2);
      if (clippedInner > 0) {
        ctx.arc(x, y, clippedInner, 0, Math.PI * 2, true);
      }
      ctx.closePath();
      ctx.fill("evenodd");
      bandIndex += 1;
    }

    ctx.restore();
  }
}
