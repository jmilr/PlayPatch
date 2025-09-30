import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RainbowField } from "./effects/RainbowField";
import { clamp } from "./utils/math";

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
  filter: BiquadFilterNode;
  panner?: StereoPannerNode;
  instrument: InstrumentType;
}

interface PointerMeta {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  totalDistance: number;
  startTime: number;
  instrumentLocked: boolean;
  triggeredShimmer: boolean;
}

type InstrumentType = "lead" | "pad";

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

const pickColor = (id: number) => COLOR_PALETTE[id % COLOR_PALETTE.length];

const getPanForPosition = (x: number, width: number) => {
  if (width <= 0) {
    return 0;
  }
  return clamp((x / width) * 2 - 1, -1, 1);
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rainbowFieldRef = useRef<RainbowField | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const unlockedRef = useRef(false);
  const voicesRef = useRef<Map<number, Voice>>(new Map());
  const releaseTimersRef = useRef<Map<number, number>>(new Map());
  const activePointersRef = useRef<Set<number>>(new Set());
  const pointerMetaRef = useRef<Map<number, PointerMeta>>(new Map());

  const [touchPoints, setTouchPoints] = useState<Map<number, TouchPoint>>(new Map());
  const [statusMessage, setStatusMessage] = useState("Touch or click to play");
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

  const triggerBellChime = useCallback(
    (x: number, y: number, baseFrequency: number) => {
      const context = audioContextRef.current;
      if (!context) {
        return;
      }

      const now = context.currentTime;
      const osc = context.createOscillator();
      const gain = context.createGain();
      const shimmer = context.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(baseFrequency, now);
      osc.frequency.exponentialRampToValueAtTime(baseFrequency * 2, now + 0.5);

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.4, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);

      shimmer.gain.setValueAtTime(0.0001, now);
      shimmer.gain.exponentialRampToValueAtTime(1, now + 0.04);
      shimmer.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

      osc.connect(shimmer);
      shimmer.connect(gain);
      gain.connect(context.destination);

      osc.start(now);
      osc.stop(now + 1.2);
      osc.onended = () => {
        try {
          osc.disconnect();
          shimmer.disconnect();
          gain.disconnect();
        } catch (error) {
          console.warn("Chime cleanup failed", error);
        }
      };

      rainbowFieldRef.current?.pulse(x, y, baseFrequency, 1100);
    },
    []
  );

  const triggerShimmerArpeggio = useCallback(
    (x: number, y: number, baseFrequency: number) => {
      const context = audioContextRef.current;
      if (!context) {
        return;
      }

      const now = context.currentTime;
      const intervals = [0, 7, 12, 19];

      intervals.forEach((semitones, index) => {
        const start = now + index * 0.08;
        const osc = context.createOscillator();
        const gain = context.createGain();

        osc.type = "sine";
        const frequency = baseFrequency * Math.pow(2, semitones / 12);
        osc.frequency.setValueAtTime(frequency, start);

        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.22, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);

        osc.connect(gain);
        gain.connect(context.destination);

        osc.start(start);
        osc.stop(start + 0.65);
        osc.onended = () => {
          try {
            osc.disconnect();
            gain.disconnect();
          } catch (error) {
            console.warn("Shimmer cleanup failed", error);
          }
        };
      });

      rainbowFieldRef.current?.pulse(x, y, baseFrequency * 1.5, 1200);
    },
    []
  );

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
          voice.filter.disconnect();
          voice.panner?.disconnect();
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
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(14000, context.currentTime);
      filter.Q.setValueAtTime(0.001, context.currentTime);

      const gain = context.createGain();
      gain.gain.value = 0;

      let panner: StereoPannerNode | undefined;
      if (context.createStereoPanner) {
        panner = context.createStereoPanner();
        oscillator.connect(panner);
        panner.connect(filter);
      } else {
        oscillator.connect(filter);
      }

      filter.connect(gain);
      gain.connect(context.destination);

      const frequency = getFrequencyForPosition(x, rect.width);
      oscillator.frequency.setValueAtTime(frequency, context.currentTime);

      const gainValue = getGainForPosition(y, rect.height);
      const now = context.currentTime;

      oscillator.start(now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(gainValue, now + 0.06);

      if (panner) {
        const panPosition = getPanForPosition(x, rect.width);
        panner.pan.setValueAtTime(panPosition, now);
      }

      voicesRef.current.set(pointerId, {
        oscillator,
        gain,
        filter,
        panner,
        instrument: "lead",
      });

      pointerMetaRef.current.set(pointerId, {
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        totalDistance: 0,
        startTime: performance.now(),
        instrumentLocked: false,
        triggeredShimmer: false,
      });

      updateTouchPoint({
        id: pointerId,
        x,
        y,
        color: pointerColor,
      });

      rainbowFieldRef.current?.setEmitter(pointerId, x, y, frequency);

      setStatusMessage("Slide around to explore expressive gestures");
    },
    [ensureAudioContext, updateTouchPoint]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const voice = voicesRef.current.get(event.pointerId);
      const container = containerRef.current;
      const context = audioContextRef.current;
      const meta = pointerMetaRef.current.get(event.pointerId);
      if (!voice || !container || !context || !meta) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const dx = x - meta.lastX;
      const dy = y - meta.lastY;
      const distance = Math.hypot(dx, dy);
      meta.lastX = x;
      meta.lastY = y;
      meta.totalDistance += distance;

      const pointerColor = pickColor(event.pointerId);

      if (!meta.triggeredShimmer) {
        const totalDx = x - meta.startX;
        const totalDy = y - meta.startY;
        const absDx = Math.abs(totalDx);
        const absDy = Math.abs(totalDy);

        if (!meta.instrumentLocked) {
          if (
            absDx > 60 &&
            absDy > 60 &&
            Math.abs(absDx - absDy) < 40
          ) {
            meta.triggeredShimmer = true;
            pointerMetaRef.current.set(event.pointerId, meta);

            const baseFrequency = getFrequencyForPosition(x, rect.width);
            stopVoice(event.pointerId);
            rainbowFieldRef.current?.releaseEmitter(event.pointerId);
            triggerShimmerArpeggio(x, y, baseFrequency);
            updateTouchPoint({
              id: event.pointerId,
              x,
              y,
              color: pointerColor,
            });
            setStatusMessage("Diagonal flares trigger sparkling arpeggios");
            return;
          }

          if (absDy > absDx * 1.35 && absDy > 50 && voice.instrument !== "pad") {
            const now = context.currentTime;
            voice.instrument = "pad";
            voice.oscillator.type = "triangle";
            voice.filter.frequency.cancelScheduledValues(now);
            voice.filter.frequency.setValueAtTime(1200, now);
            voice.filter.Q.setValueAtTime(3.2, now);
            meta.instrumentLocked = true;
            setStatusMessage("Vertical drifts unlock the mellow pad");
          } else if (absDx > 40) {
            meta.instrumentLocked = true;
          }
        }

        const frequency = getFrequencyForPosition(x, rect.width);
        const level = getGainForPosition(y, rect.height);
        const now = context.currentTime;

        voice.oscillator.frequency.cancelScheduledValues(now);
        voice.oscillator.frequency.linearRampToValueAtTime(
          frequency,
          now + (voice.instrument === "pad" ? 0.12 : 0.05)
        );

        if (voice.instrument === "pad") {
          const padLevel = clamp(level * 1.35, 0.12, 0.78);
          voice.gain.gain.cancelScheduledValues(now);
          voice.gain.gain.linearRampToValueAtTime(padLevel, now + 0.18);
          const cutoff = clamp(
            420 + (1 - clamp(y / rect.height, 0, 1)) * 2000,
            360,
            2600
          );
          voice.filter.frequency.cancelScheduledValues(now);
          voice.filter.frequency.linearRampToValueAtTime(cutoff, now + 0.18);
          voice.filter.Q.cancelScheduledValues(now);
          voice.filter.Q.linearRampToValueAtTime(4.2, now + 0.18);

          rainbowFieldRef.current?.setEmitter(event.pointerId, x, y, frequency);
        } else {
          voice.gain.gain.cancelScheduledValues(now);
          voice.gain.gain.linearRampToValueAtTime(level, now + 0.08);
          if (voice.panner) {
            const panPosition = getPanForPosition(x, rect.width);
            voice.panner.pan.cancelScheduledValues(now);
            voice.panner.pan.linearRampToValueAtTime(panPosition, now + 0.12);
          }

          rainbowFieldRef.current?.setEmitter(event.pointerId, x, y, frequency);
        }
      }

      updateTouchPoint({
        id: event.pointerId,
        x,
        y,
        color: pointerColor,
      });
    },
    [stopVoice, triggerShimmerArpeggio, updateTouchPoint]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      activePointersRef.current.delete(event.pointerId);
      stopVoice(event.pointerId);
      removeTouchPoint(event.pointerId);
      rainbowFieldRef.current?.releaseEmitter(event.pointerId);

      const meta = pointerMetaRef.current.get(event.pointerId);
      pointerMetaRef.current.delete(event.pointerId);

      const container = containerRef.current;
      const context = audioContextRef.current;
      if (!container || !context || !meta || meta.triggeredShimmer) {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const duration = performance.now() - meta.startTime;

      if (duration < 220 && meta.totalDistance < 32) {
        const frequency = getFrequencyForPosition(meta.startX, rect.width);
        triggerBellChime(x, y, frequency);
        setStatusMessage("Quick taps unleash crystalline chimes");
      }

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [removeTouchPoint, stopVoice, triggerBellChime]
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      activePointersRef.current.delete(event.pointerId);
      stopVoice(event.pointerId);
      removeTouchPoint(event.pointerId);
      pointerMetaRef.current.delete(event.pointerId);
      rainbowFieldRef.current?.releaseEmitter(event.pointerId);

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
          voice.filter.disconnect();
          voice.panner?.disconnect();
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
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }

    const field = new RainbowField(canvas);
    rainbowFieldRef.current = field;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      field.resize(rect.width, rect.height);
    };

    resize();
    field.start();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      field.destroy();
      rainbowFieldRef.current = null;
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
          "radial-gradient(circle at 20% 25%, rgba(34,197,94,0.28), transparent 55%)," +
          "radial-gradient(circle at 80% 20%, rgba(59,130,246,0.24), transparent 50%)," +
          "linear-gradient(140deg, #020617 0%, #0f172a 45%, #1e1b4b 100%)",
        color: "#f8fafc",
        fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "none",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          filter: "blur(0.3px)",
        }}
      />

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
            maxWidth: 460,
            padding: "36px 28px",
            borderRadius: 36,
            backgroundColor: "rgba(15, 23, 42, 0.55)",
            boxShadow: "0 40px 120px rgba(8, 47, 73, 0.45)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div style={{ fontSize: 56, marginBottom: 12 }}>🎶</div>
          <h1 style={{ fontSize: 28, margin: "0 0 12px", letterSpacing: 0.6 }}>
            PlayPatch
          </h1>
          <p style={{ fontSize: 18, margin: "0 0 6px", opacity: 0.9 }}>
            Slide, drift, and flick to paint sound with light.
          </p>
          <p style={{ fontSize: 14, margin: 0, opacity: 0.75 }}>
            Horizontal glides play the lead, vertical sweeps bloom a pad, and
            quick taps sparkle with crystalline chimes.
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
    </div>
  );
}
