import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Allow older Safari builds to expose the prefixed AudioContext constructor.
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

interface TouchPoint {
  id: number;
  x: number;
  y: number;
  color: string;
}

interface Voice {
  oscillator: OscillatorNode;
  gain: GainNode;
}

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  size: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
}

const COLOR_PALETTE = [
  "#38bdf8",
  "#f472b6",
  "#facc15",
  "#22d3ee",
  "#a855f7",
  "#34d399",
  "#fb7185",
  "#f97316",
];

// Frequencies for a bright pentatonic scale spanning two octaves (C major).
const PENTATONIC_FREQUENCIES = [
  261.63, // C4
  293.66, // D4
  329.63, // E4
  392.0, // G4
  440.0, // A4
  523.25, // C5
  587.33, // D5
  659.25, // E5
  783.99, // G5
  880.0, // A5
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const pickColor = (id: number) => COLOR_PALETTE[id % COLOR_PALETTE.length];

const hexToRgb = (hex: string) => {
  const normalized = hex.replace("#", "");
  const bigint = parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
};

const createSilentKick = (context: AudioContext) => {
  const buffer = context.createBuffer(1, 1, context.sampleRate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  source.stop(context.currentTime + 0.01);
  source.onended = () => {
    try {
      source.disconnect();
    } catch (error) {
      console.warn("Silent source cleanup failed", error);
    }
  };
};

const getFrequencyForPosition = (x: number, width: number) => {
  if (width <= 0) {
    return PENTATONIC_FREQUENCIES[0];
  }

  const position = clamp(x / width, 0, 1) * (PENTATONIC_FREQUENCIES.length - 1);
  const baseIndex = Math.floor(position);
  const nextIndex = clamp(baseIndex + 1, 0, PENTATONIC_FREQUENCIES.length - 1);
  const fraction = position - baseIndex;

  const startFreq = PENTATONIC_FREQUENCIES[baseIndex];
  const endFreq = PENTATONIC_FREQUENCIES[nextIndex];

  return startFreq + (endFreq - startFreq) * fraction;
};

const getGainForPosition = (y: number, height: number) => {
  if (height <= 0) {
    return 0.45;
  }

  const normalized = 1 - clamp(y / height, 0, 1);
  return clamp(0.18 + normalized * 0.5, 0.12, 0.68);
};

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const unlockedRef = useRef(false);
  const voicesRef = useRef<Map<number, Voice>>(new Map());
  const releaseTimersRef = useRef<Map<number, number>>(new Map());
  const activePointersRef = useRef<Set<number>>(new Set());
  const particlesRef = useRef<Particle[]>([]);
  const particleIdRef = useRef(0);

  const [touchPoints, setTouchPoints] = useState<Map<number, TouchPoint>>(new Map());
  const [statusMessage, setStatusMessage] = useState("Touch or click to play");
  const [particles, setParticles] = useState<Particle[]>([]);
  const hasActiveTouches = touchPoints.size > 0;

  const ensureAudioContext = useCallback(async () => {
    let context = audioContextRef.current;
    if (!context) {
      const Constructor = window.AudioContext ?? window.webkitAudioContext;
      if (!Constructor) {
        throw new Error("Web Audio API is not available in this browser");
      }
      context = new Constructor();
      audioContextRef.current = context;
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    if (!unlockedRef.current) {
      createSilentKick(context);
      unlockedRef.current = true;
    }

    return context;
  }, []);

  const spawnParticles = useCallback((x: number, y: number, color: string) => {
    const { r, g, b } = hexToRgb(color);
    const particlesToAdd: Particle[] = Array.from({ length: 6 }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 120;
      const ttl = 0.6 + Math.random() * 0.4;
      return {
        id: particleIdRef.current++,
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: ttl,
        ttl,
        size: 24 + Math.random() * 16,
        r,
        g,
        b,
        alpha: 0.55 + Math.random() * 0.35,
      };
    });

    particlesRef.current = [...particlesRef.current, ...particlesToAdd];
    if (particlesRef.current.length > 240) {
      particlesRef.current = particlesRef.current.slice(
        particlesRef.current.length - 240
      );
    }
  }, []);

  const updateTouchPoint = useCallback((point: TouchPoint | null) => {
    setTouchPoints((prev) => {
      const next = new Map(prev);
      if (!point) {
        return next;
      }
      next.set(point.id, point);
      return next;
    });
  }, []);

  const removeTouchPoint = useCallback((id: number) => {
    setTouchPoints((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const stopVoice = useCallback(
    (id: number) => {
      const context = audioContextRef.current;
      const voice = voicesRef.current.get(id);
      if (!voice || !context) {
        return;
      }

      voicesRef.current.delete(id);

      const now = context.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.12);

      try {
        voice.oscillator.stop(now + 0.15);
      } catch (error) {
        console.warn("Oscillator stop failed", error);
      }

      const timeoutId = window.setTimeout(() => {
        try {
          voice.oscillator.disconnect();
          voice.gain.disconnect();
        } catch (error) {
          console.warn("Voice disconnect failed", error);
        }
        releaseTimersRef.current.delete(id);
      }, 250);

      releaseTimersRef.current.set(id, timeoutId);
    },
    []
  );

  const handlePointerDown = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const pointerId = event.pointerId;
      const pointerColor = pickColor(pointerId);

      activePointersRef.current.add(pointerId);

      event.currentTarget.setPointerCapture?.(pointerId);

      let context: AudioContext;
      try {
        context = await ensureAudioContext();
      } catch (error) {
        console.error("Unable to create audio context", error);
        setStatusMessage("Audio is not supported in this browser");
        activePointersRef.current.delete(pointerId);
        return;
      }

      const releaseTimer = releaseTimersRef.current.get(pointerId);
      if (releaseTimer) {
        window.clearTimeout(releaseTimer);
        releaseTimersRef.current.delete(pointerId);
      }

      if (!activePointersRef.current.has(pointerId)) {
        return;
      }

      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      const gain = context.createGain();
      gain.gain.value = 0;

      oscillator.connect(gain);
      gain.connect(context.destination);

      const frequency = getFrequencyForPosition(x, rect.width);
      oscillator.frequency.setValueAtTime(frequency, context.currentTime);

      const gainValue = getGainForPosition(y, rect.height);
      const now = context.currentTime;

      oscillator.start(now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(gainValue, now + 0.06);

      voicesRef.current.set(pointerId, { oscillator, gain });

      spawnParticles(x, y, pointerColor);

      updateTouchPoint({
        id: pointerId,
        x,
        y,
        color: pointerColor,
      });

      setStatusMessage("Slide around to explore the scale");
    },
    [ensureAudioContext, spawnParticles, updateTouchPoint]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const voice = voicesRef.current.get(event.pointerId);
      const container = containerRef.current;
      const context = audioContextRef.current;
      if (!voice || !container || !context) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const frequency = getFrequencyForPosition(x, rect.width);
      const level = getGainForPosition(y, rect.height);
      const now = context.currentTime;

      voice.oscillator.frequency.cancelScheduledValues(now);
      voice.oscillator.frequency.linearRampToValueAtTime(
        frequency,
        now + 0.05
      );

      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.linearRampToValueAtTime(level, now + 0.08);

      const pointerColor = pickColor(event.pointerId);

      updateTouchPoint({
        id: event.pointerId,
        x,
        y,
        color: pointerColor,
      });

      spawnParticles(x, y, pointerColor);
    },
    [spawnParticles, updateTouchPoint]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      activePointersRef.current.delete(event.pointerId);
      stopVoice(event.pointerId);
      removeTouchPoint(event.pointerId);

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [removeTouchPoint, stopVoice]
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      activePointersRef.current.delete(event.pointerId);
      stopVoice(event.pointerId);
      removeTouchPoint(event.pointerId);

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [removeTouchPoint, stopVoice]
  );

  useEffect(() => {
    return () => {
      voicesRef.current.forEach((voice, id) => {
        try {
          voice.oscillator.stop();
          voice.oscillator.disconnect();
          voice.gain.disconnect();
        } catch (error) {
          console.warn("Voice cleanup failed", error);
        }
        const timer = releaseTimersRef.current.get(id);
        if (timer) {
          window.clearTimeout(timer);
        }
      });
      voicesRef.current.clear();
      releaseTimersRef.current.clear();
      activePointersRef.current.clear();
      audioContextRef.current?.close().catch((error) => {
        console.warn("Audio context close failed", error);
      });
    };
  }, []);

  const touchPointArray = useMemo(
    () => Array.from(touchPoints.values()),
    [touchPoints]
  );

  useEffect(() => {
    if (touchPoints.size === 0) {
      setStatusMessage("Touch or click to play");
    }
  }, [touchPoints]);

  useEffect(() => {
    let animationFrame: number;
    let lastTime: number | null = null;

    const tick = (time: number) => {
      if (lastTime === null) {
        lastTime = time;
      }

      const delta = (time - lastTime) / 1000;
      lastTime = time;

      if (particlesRef.current.length > 0) {
        const nextParticles = particlesRef.current
          .map((particle) => ({
            ...particle,
            life: particle.life - delta,
            x: particle.x + particle.vx * delta,
            y: particle.y + particle.vy * delta,
          }))
          .filter((particle) => particle.life > 0);

        particlesRef.current = nextParticles;
        setParticles(nextParticles);
      } else {
        setParticles((prev) => (prev.length > 0 ? [] : prev));
      }

      animationFrame = window.requestAnimationFrame(tick);
    };

    animationFrame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at 20% 20%, rgba(59,130,246,0.35), transparent 45%)," +
          "radial-gradient(circle at 80% 25%, rgba(248,113,113,0.3), transparent 50%)," +
          "radial-gradient(circle at 50% 80%, rgba(34,197,94,0.28), transparent 55%)," +
          "#0f172a",
        color: "#f8fafc",
        fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "none",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          padding: "10px 16px",
          borderRadius: 16,
          backgroundColor: "rgba(15, 23, 42, 0.55)",
          color: "rgba(226, 232, 240, 0.95)",
          fontSize: 14,
          letterSpacing: 0.2,
          backdropFilter: "blur(6px)",
        }}
      >
        {statusMessage}
      </div>

      {!hasActiveTouches && (
        <div
          style={{
            textAlign: "center",
            maxWidth: 420,
            padding: "32px 24px",
            borderRadius: 32,
            backgroundColor: "rgba(15, 23, 42, 0.55)",
            boxShadow: "0 40px 120px rgba(15, 23, 42, 0.45)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div style={{ fontSize: 56, marginBottom: 12 }}>🎶</div>
          <h1 style={{ fontSize: 28, margin: "0 0 12px", letterSpacing: 0.6 }}>
            PlayPatch
          </h1>
          <p style={{ fontSize: 18, margin: "0 0 6px", opacity: 0.9 }}>
            Slide your finger or mouse to paint sound.
          </p>
          <p style={{ fontSize: 14, margin: 0, opacity: 0.75 }}>
            Every horizontal position maps to a note in a warm pentatonic scale.
          </p>
        </div>
      )}

      {touchPointArray.map((point) => (
        <div
          key={point.id}
          style={{
            position: "absolute",
            width: 120,
            height: 120,
            borderRadius: "50%",
            pointerEvents: "none",
            left: point.x - 60,
            top: point.y - 60,
            background: `radial-gradient(circle, ${point.color} 0%, rgba(15, 23, 42, 0) 70%)`,
            boxShadow: `0 0 60px 30px ${point.color}40`,
            opacity: 0.85,
            transition: "transform 0.12s ease, opacity 0.12s ease",
            transform: "scale(1)",
          }}
        />
      ))}

      {particles.map((particle) => {
        const lifeRatio = particle.life / particle.ttl;
        const intensity = Math.max(0, Math.min(1, lifeRatio * particle.alpha));
        return (
          <div
            key={particle.id}
            style={{
              position: "absolute",
              pointerEvents: "none",
              left: particle.x - particle.size / 2,
              top: particle.y - particle.size / 2,
              width: particle.size,
              height: particle.size,
              borderRadius: "50%",
              background: `radial-gradient(circle, rgba(${particle.r}, ${
                particle.g
              }, ${particle.b}, ${intensity}) 0%, rgba(15, 23, 42, 0) 65%)`,
              boxShadow: `0 0 ${particle.size * 1.6}px ${particle.size * 0.4}px rgba(${particle.r}, ${
                particle.g
              }, ${particle.b}, ${intensity * 0.6})`,
              opacity: intensity,
              transform: "scale(1)",
            }}
          />
        );
      })}
    </div>
  );
}
