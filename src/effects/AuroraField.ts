import { clamp } from "../utils/math";

export type AuroraVariant = "lead" | "pad" | "chime" | "shimmer";

interface AuroraParticle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  size: number;
  growth: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  glow: number;
  spin: number;
}

interface VariantConfig {
  minSpeed: number;
  maxSpeed: number;
  count: number;
  ttl: [number, number];
  size: [number, number];
  growth: [number, number];
  alpha: [number, number];
  drag: number;
  glow: [number, number];
  spin: [number, number];
  turbulence: number;
}

const VARIANT_CONFIG: Record<AuroraVariant, VariantConfig> = {
  lead: {
    minSpeed: 120,
    maxSpeed: 240,
    count: 16,
    ttl: [0.65, 1.1],
    size: [12, 22],
    growth: [16, 36],
    alpha: [0.35, 0.55],
    drag: 0.86,
    glow: [18, 28],
    spin: [-1.6, 1.6],
    turbulence: 18,
  },
  pad: {
    minSpeed: 60,
    maxSpeed: 140,
    count: 24,
    ttl: [1.25, 1.8],
    size: [22, 40],
    growth: [12, 26],
    alpha: [0.22, 0.38],
    drag: 0.9,
    glow: [32, 44],
    spin: [-0.8, 0.8],
    turbulence: 28,
  },
  chime: {
    minSpeed: 220,
    maxSpeed: 420,
    count: 28,
    ttl: [0.45, 0.8],
    size: [10, 18],
    growth: [30, 46],
    alpha: [0.45, 0.68],
    drag: 0.82,
    glow: [14, 24],
    spin: [-2.6, 2.6],
    turbulence: 42,
  },
  shimmer: {
    minSpeed: 140,
    maxSpeed: 260,
    count: 34,
    ttl: [0.8, 1.4],
    size: [16, 28],
    growth: [18, 34],
    alpha: [0.32, 0.52],
    drag: 0.87,
    glow: [26, 40],
    spin: [-3.2, 3.2],
    turbulence: 56,
  },
};

let PARTICLE_ID = 0;

const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min;

export class AuroraField {
  private ctx: CanvasRenderingContext2D | null = null;
  private width = 0;
  private height = 0;
  private particles: AuroraParticle[] = [];
  private rafId: number | null = null;
  private lastTime: number | null = null;
  private dpr = window.devicePixelRatio || 1;
  private destroyed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", {
      alpha: true,
      desynchronized: true,
    });
    if (!context) {
      throw new Error("Unable to acquire 2D canvas context");
    }
    this.ctx = context;
    this.ctx.globalCompositeOperation = "lighter";
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
    if (!this.ctx) {
      return;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  spawnBurst(x: number, y: number, color: string, variant: AuroraVariant) {
    if (!this.ctx || this.destroyed) {
      return;
    }
    const config = VARIANT_CONFIG[variant];
    const { r, g, b } = this.hexToRgb(color);

    for (let i = 0; i < config.count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = randomInRange(config.minSpeed, config.maxSpeed);
      const ttl = randomInRange(config.ttl[0], config.ttl[1]);
      const size = randomInRange(config.size[0], config.size[1]);
      const growth = randomInRange(config.growth[0], config.growth[1]);
      const alpha = randomInRange(config.alpha[0], config.alpha[1]);
      const glow = randomInRange(config.glow[0], config.glow[1]);
      const spin = randomInRange(config.spin[0], config.spin[1]);

      this.particles.push({
        id: PARTICLE_ID++,
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: ttl,
        ttl,
        size,
        growth,
        r,
        g,
        b,
        alpha,
        glow,
        spin,
      });
    }

    if (this.particles.length > 1600) {
      this.particles.splice(0, this.particles.length - 1600);
    }
  }

  start() {
    if (this.rafId !== null) {
      return;
    }
    const loop = (time: number) => {
      if (this.destroyed) {
        return;
      }
      if (this.lastTime == null) {
        this.lastTime = time;
      }
      const delta = Math.min((time - this.lastTime) / 1000, 0.045);
      this.lastTime = time;
      this.update(delta);
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
    this.particles = [];
    this.ctx?.clearRect(0, 0, this.width, this.height);
  }

  private update(delta: number) {
    if (!this.ctx) {
      return;
    }

    const gravity = 22;

    this.particles = this.particles
      .map((particle) => {
        const variant = this.getVariantForParticle(particle);
        const config = VARIANT_CONFIG[variant];
        const life = particle.life - delta;
        const turbulence = config.turbulence * delta;
        const vx = (particle.vx + (Math.random() - 0.5) * turbulence) * config.drag;
        const vy =
          (particle.vy + (Math.random() - 0.5) * turbulence + gravity * delta) *
          config.drag;

        return {
          ...particle,
          life,
          vx,
          vy,
          size: particle.size + particle.growth * delta,
          spin: particle.spin * (1 - delta * 0.2),
        };
      })
      .filter((particle) => particle.life > 0);
  }

  private draw() {
    if (!this.ctx) {
      return;
    }

    this.ctx.save();
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.fillStyle = "rgba(15, 23, 42, 0.2)";
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.globalCompositeOperation = "lighter";

    for (const particle of this.particles) {
      const lifeRatio = clamp(particle.life / particle.ttl, 0, 1);
      const opacity = lifeRatio * particle.alpha;
      if (opacity <= 0.01) {
        continue;
      }

      this.ctx.save();
      this.ctx.translate(particle.x, particle.y);
      this.ctx.rotate(particle.spin * 0.15);
      const gradient = this.ctx.createRadialGradient(
        0,
        0,
        0,
        0,
        0,
        particle.size
      );
      const color = `rgba(${particle.r}, ${particle.g}, ${particle.b}, ${opacity})`;
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.55, `rgba(${particle.r}, ${particle.g}, ${particle.b}, ${
        opacity * 0.6
      })`);
      gradient.addColorStop(1, "rgba(15, 23, 42, 0)");

      this.ctx.fillStyle = gradient;
      this.ctx.shadowColor = `rgba(${particle.r}, ${particle.g}, ${particle.b}, ${
        opacity * 0.8
      })`;
      this.ctx.shadowBlur = particle.glow;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, particle.size, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  private getVariantForParticle(particle: AuroraParticle): AuroraVariant {
    if (particle.ttl > 1.4) {
      return "pad";
    }
    if (particle.ttl < 0.6 && particle.growth > 32) {
      return "chime";
    }
    if (particle.spin > 2 || particle.spin < -2) {
      return "shimmer";
    }
    return "lead";
  }

  private hexToRgb(hex: string) {
    const normalized = hex.replace("#", "");
    const bigint = parseInt(normalized, 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255,
    };
  }
}
