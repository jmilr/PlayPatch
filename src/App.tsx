// src/App.tsx

import React, { useEffect, useRef, useState, useCallback } from "react";
import * as Tone from "tone";

interface Touch {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  isDragging: boolean;
  startTime: number;
}

interface VisualEffect {
  id: string;
  touchId: number;
  x: number;
  y: number;
  type: "tap" | "drag";
  color: string;
  timestamp: number;
  trail?: Array<{ x: number; y: number; timestamp: number }>;
}

interface SynthWithFilter {
  synth: Tone.Synth;
  filter: Tone.Filter;
}

const BRIGHT_COLORS = [
  "#FF6B6B",
  "#4ECDC4",
  "#45B7D1",
  "#96CEB4",
  "#FFEAA7",
  "#DDA0DD",
  "#98D8C8",
  "#F7DC6F",
  "#BB8FCE",
  "#85C1E9",
];

// Pentatonic scale notes (C major pentatonic)
const PENTATONIC_NOTES = [
  "C4",
  "D4",
  "E4",
  "G4",
  "A4",
  "C5",
  "D5",
  "E5",
  "G5",
  "A5",
];

/**
 * Unlocks the Web Audio hardware by playing a very short, silent buffer.
 * Safari on iOS in particular requires this nudge even after calling Tone.start().
 */
const unlockAudioHardware = (context: AudioContext) => {
  try {
    const buffer = context.createBuffer(1, 1, context.sampleRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const now = context.currentTime;
    source.start(now);
    source.stop(now + 0.01);
    source.onended = () => {
      try {
        source.disconnect();
      } catch (disconnectError) {
        console.warn("Audio unlock disconnect failed", disconnectError);
      }
    };
  } catch (error) {
    console.warn("Audio unlock failed", error);
  }
};

interface EnsureContextOptions {
  timeoutMs?: number;
}

/**
 * Ensures that the provided audio context reaches the "running" state.
 * Retries resume attempts and waits for the state change event with a timeout.
 */
const ensureAudioContextRunning = async (
  context: AudioContext,
  options: EnsureContextOptions = {}
) => {
  const { timeoutMs = 4000 } = options;

  const attemptResume = async () => {
    try {
      await context.resume();
    } catch (error) {
      console.warn("Audio context resume failed", error);
    }
  };

  if (context.state !== "running") {
    await attemptResume();
  }

  if (context.state === "running") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      context.removeEventListener("statechange", handleStateChange);
      window.clearTimeout(timerId);
    };

    const handleStateChange = () => {
      if (context.state === "running" && !settled) {
        cleanup();
        resolve();
      }
    };

    const timerId = window.setTimeout(() => {
      if (!settled) {
        cleanup();
        reject(
          new Error("Audio context did not enter running state within timeout")
        );
      }
    }, timeoutMs);

    context.addEventListener("statechange", handleStateChange);

    unlockAudioHardware(context);
    void attemptResume();
  });
};

export default function App() {
  const [touches, setTouches] = useState<Map<number, Touch>>(new Map());
  const [visualEffects, setVisualEffects] = useState<VisualEffect[]>([]);
  interface AudioStatusState {
    message: string;
    progress: number | null;
  }

  const [audioStatus, setAudioStatus] = useState<AudioStatusState>({
    message: "Click to start audio",
    progress: null,
  });
  const [isMouseDown, setIsMouseDown] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const drumsRef = useRef<any[]>([]);
  const synthsRef = useRef<Map<number, SynthWithFilter>>(new Map());
  const audioInitialized = useRef(false);
  const audioInitPromise = useRef<Promise<void> | null>(null);
  const audioContextCleanup = useRef<(() => void) | null>(null);
  const mouseId = useRef(999999); // Fixed ID for mouse events
  const effectIdCounter = useRef(0); // Counter for unique effect IDs

  // Generate unique effect ID
  const generateEffectId = () => {
    effectIdCounter.current += 1;
    return `effect_${Date.now()}_${effectIdCounter.current}`;
  };

  // Create synthesized drum sounds
  const createDrumSounds = useCallback(() => {
    // Kick drum - low frequency with quick attack
    const kick = new Tone.MembraneSynth({
      pitchDecay: 0.05,
      octaves: 10,
      oscillator: { type: "sine" },
      envelope: {
        attack: 0.001,
        decay: 0.4,
        sustain: 0.01,
        release: 1.4,
      },
    }).toDestination();

    // Snare drum - noise with sharp attack
    const snare = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
    }).toDestination();

    // Hi-hat - high frequency noise with very short decay
    const hihat = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.03 },
    }).toDestination();

    // Cymbal - metallic sound with longer sustain
    const cymbal = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.4, sustain: 0.1, release: 1.2 },
      harmonicity: 12,
      modulationIndex: 100,
      resonance: 4000,
      octaves: 1.5,
    }).toDestination();
    cymbal.frequency.value = 250; // Set frequency after construction

    return [kick, snare, hihat, cymbal];
  }, []);

  // Initialize audio context and instruments
  const initializeAudio = useCallback((): Promise<void> => {
    const existingContext = Tone.getContext()
      .rawContext as AudioContext | undefined;

    if (audioInitialized.current) {
      if (existingContext && existingContext.state !== "running") {
        return ensureAudioContextRunning(existingContext).catch((error) => {
          console.error("Audio resume failed:", error);
          setAudioStatus({
            message: "Tap to resume audio",
            progress: null,
          });
          throw error;
        });
      }
      return Promise.resolve();
    }

    if (!audioInitPromise.current) {
      audioInitPromise.current = (async () => {
        const preStartContext = existingContext ?? null;

        try {
          if (preStartContext) {
            setAudioStatus({
              message: "Preparing audio hardware...",
              progress: 0.1,
            });
            await ensureAudioContextRunning(preStartContext).catch((error) => {
              console.warn("Pre-start audio resume failed", error);
            });
          }

          setAudioStatus({
            message: "Starting audio context...",
            progress: 0.25,
          });
          await Tone.start();

          const runningContext =
            (Tone.getContext().rawContext as AudioContext | undefined) ??
            preStartContext;

          if (runningContext) {
            setAudioStatus({
              message: "Stabilizing audio engine...",
              progress: 0.45,
            });
            await ensureAudioContextRunning(runningContext, {
              timeoutMs: 6000,
            });
          }

          setAudioStatus({
            message: "Creating drum sounds...",
            progress: 0.6,
          });
          drumsRef.current = createDrumSounds();

          audioInitialized.current = true;

          setAudioStatus({
            message: "Audio ready!",
            progress: 1,
          });

          setTimeout(
            () => setAudioStatus({ message: "", progress: null }),
            2000
          );

          if (runningContext) {
            if (audioContextCleanup.current) {
              audioContextCleanup.current();
            }

            const handleStateChange = () => {
              if (runningContext.state === "suspended") {
                runningContext.resume().catch((error) => {
                  console.warn(
                    "Audio context resume after suspension failed",
                    error
                  );
                  setAudioStatus({
                    message: "Tap to resume audio",
                    progress: null,
                  });
                });
              }
            };

            const handleVisibilityChange = () => {
              if (document.visibilityState === "visible") {
                runningContext.resume().catch((error) => {
                  console.warn(
                    "Audio context resume on visibility change failed",
                    error
                  );
                });
              }
            };

            runningContext.addEventListener("statechange", handleStateChange);
            document.addEventListener(
              "visibilitychange",
              handleVisibilityChange
            );

            audioContextCleanup.current = () => {
              runningContext.removeEventListener(
                "statechange",
                handleStateChange
              );
              document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange
              );
            };
          }
        } catch (error) {
          console.error("Audio initialization failed:", error);
          setAudioStatus({
            message: "Audio failed to initialize. Tap again to retry.",
            progress: null,
          });
          audioInitPromise.current = null;
          audioInitialized.current = false;
          throw error;
        }
      })();
    }

    return audioInitPromise.current;
  }, [createDrumSounds]);

  // Get random bright color
  const getRandomColor = () =>
    BRIGHT_COLORS[Math.floor(Math.random() * BRIGHT_COLORS.length)];

  // Convert screen position to pentatonic note
  const getNote = useCallback((x: number, containerWidth: number) => {
    const noteIndex = Math.floor(
      (x / containerWidth) * PENTATONIC_NOTES.length
    );
    return PENTATONIC_NOTES[Math.min(noteIndex, PENTATONIC_NOTES.length - 1)];
  }, []);

  // Get drum index based on Y position
  const getDrumIndex = (y: number, containerHeight: number) => {
    return Math.floor((y / containerHeight) * drumsRef.current.length);
  };

  useEffect(() => {
    return () => {
      audioContextCleanup.current?.();
    };
  }, []);

  // Play drum sound
  const playDrum = useCallback(
    async (y: number, containerHeight: number) => {
      try {
        await initializeAudio();
      } catch (error) {
        return;
      }

      if (!audioInitialized.current || drumsRef.current.length === 0) {
        return;
      }

      const drumIndex = getDrumIndex(y, containerHeight);
      const drum = drumsRef.current[drumIndex];

      if (drum) {
        try {
          if (drumIndex === 0) {
            // Kick drum - play a low note
            drum.triggerAttackRelease("C1", "8n");
          } else if (drumIndex === 1 || drumIndex === 2) {
            // Snare and hi-hat - trigger noise
            drum.triggerAttackRelease("4n");
          } else {
            // Cymbal - trigger metallic sound
            drum.triggerAttackRelease("C4", "2n");
          }
        } catch (error) {
          console.error("Drum play error:", error);
        }
      }
    },
    [initializeAudio]
  );

  // Play synth note
  const playSynth = useCallback(
    (
      touch: Touch,
      x: number,
      y: number,
      containerWidth: number,
      containerHeight: number
    ) => {
      if (!audioInitialized.current) {
        return;
      }

      const note = getNote(x, containerWidth);
      const filterFreq = 200 + (1 - y / containerHeight) * 2000; // Y controls filter cutoff

      let entry = synthsRef.current.get(touch.id);
      if (!entry) {
        // Create filter and synth, connect synth to filter
        const filter = new Tone.Filter({
          type: "lowpass",
          frequency: filterFreq,
          Q: 1,
        }).toDestination();

        const synth = new Tone.Synth({
          oscillator: { type: "triangle" },
          envelope: { attack: 0.1, decay: 0.3, sustain: 0.3, release: 1 },
        }).connect(filter);

        entry = { synth, filter };
        synthsRef.current.set(touch.id, entry);
      } else {
        // Update filter frequency for existing synth
        entry.filter.frequency.value = filterFreq;
      }

      try {
        entry.synth.triggerAttackRelease(note, "4n");
      } catch (error) {
        console.error("Synth play error:", error);
      }
    },
  [getNote]
  );

  // Handle touch start
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      initializeAudio().catch(() => {});

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const touches = Array.from(e.touches);

      touches.forEach((touch) => {
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        const touchId = touch.identifier;

        const newTouch: Touch = {
          id: touchId,
          x,
          y,
          startX: x,
          startY: y,
          isDragging: false,
          startTime: Date.now(),
        };

        setTouches((prev) => new Map(prev).set(touchId, newTouch));

        // Create initial visual effect with unique ID
        const effect: VisualEffect = {
          id: generateEffectId(),
          touchId: touchId,
          x,
          y,
          type: "tap",
          color: getRandomColor(),
          timestamp: Date.now(),
          trail: [{ x, y, timestamp: Date.now() }],
        };

        setVisualEffects((prev) => [...prev, effect]);
      });
    },
    [initializeAudio]
  );

  // Handle mouse start
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      initializeAudio().catch(() => {});
      setIsMouseDown(true);

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const touchId = mouseId.current;

      const newTouch: Touch = {
        id: touchId,
        x,
        y,
        startX: x,
        startY: y,
        isDragging: false,
        startTime: Date.now(),
      };

      setTouches((prev) => new Map(prev).set(touchId, newTouch));

      // Create initial visual effect with unique ID
      const effect: VisualEffect = {
        id: generateEffectId(),
        touchId: touchId,
        x,
        y,
        type: "tap",
        color: getRandomColor(),
        timestamp: Date.now(),
        trail: [{ x, y, timestamp: Date.now() }],
      };

      setVisualEffects((prev) => [...prev, effect]);
    },
    [initializeAudio]
  );

  // Handle touch move
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const touches = Array.from(e.touches);

    touches.forEach((touch) => {
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const touchId = touch.identifier;

      setTouches((prev) => {
        const newTouches = new Map(prev);
        const existingTouch = newTouches.get(touchId);

        if (existingTouch) {
          const distance = Math.sqrt(
            Math.pow(x - existingTouch.startX, 2) +
              Math.pow(y - existingTouch.startY, 2)
          );
          const isDragging = distance > 10; // 10px threshold for drag

          if (isDragging && !existingTouch.isDragging) {
            // Just started dragging - play synth
            playSynth(existingTouch, x, y, rect.width, rect.height);
          } else if (isDragging) {
            // Continue dragging - update synth
            playSynth(existingTouch, x, y, rect.width, rect.height);
          }

          const updatedTouch = { ...existingTouch, x, y, isDragging };
          newTouches.set(touchId, updatedTouch);

          // Update visual effects for dragging
          if (isDragging) {
            setVisualEffects((prev) =>
              prev.map((effect) => {
                if (effect.touchId === touchId) {
                  return {
                    ...effect,
                    type: "drag",
                    trail: [
                      ...(effect.trail || []),
                      { x, y, timestamp: Date.now() },
                    ].slice(-30), // Keep last 30 points for smoother trail
                    timestamp: Date.now(),
                  };
                }
                return effect;
              })
            );
          }
        }

        return newTouches;
      });
    });
  }, [playSynth]);

  // Handle mouse move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      if (!isMouseDown) return;

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const touchId = mouseId.current;

      setTouches((prev) => {
        const newTouches = new Map(prev);
        const existingTouch = newTouches.get(touchId);

        if (existingTouch) {
          const distance = Math.sqrt(
            Math.pow(x - existingTouch.startX, 2) +
              Math.pow(y - existingTouch.startY, 2)
          );
          const isDragging = distance > 10; // 10px threshold for drag

          if (isDragging && !existingTouch.isDragging) {
            // Just started dragging - play synth
            playSynth(existingTouch, x, y, rect.width, rect.height);
          } else if (isDragging) {
            // Continue dragging - update synth
            playSynth(existingTouch, x, y, rect.width, rect.height);
          }

          const updatedTouch = { ...existingTouch, x, y, isDragging };
          newTouches.set(touchId, updatedTouch);

          // Update visual effects for dragging
          if (isDragging) {
            setVisualEffects((prev) =>
              prev.map((effect) => {
                if (effect.touchId === touchId) {
                  return {
                    ...effect,
                    type: "drag",
                    trail: [
                      ...(effect.trail || []),
                      { x, y, timestamp: Date.now() },
                    ].slice(-30), // Keep last 30 points for smoother trail
                    timestamp: Date.now(),
                  };
                }
                return effect;
              })
            );
          }
        }

        return newTouches;
      });
    },
    [isMouseDown, playSynth]
  );

  // Handle touch end
  const handleTouchEnd = useCallback(
    async (e: React.TouchEvent) => {
      e.preventDefault();

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const endedTouchIds = Array.from(e.changedTouches).map(
        (touch) => touch.identifier
      );
      const touchesToHandle: Touch[] = [];

      setTouches((prev) => {
        const newTouches = new Map(prev);
        endedTouchIds.forEach((touchId) => {
          const existingTouch = newTouches.get(touchId);
          if (existingTouch) {
            touchesToHandle.push(existingTouch);
          }
          newTouches.delete(touchId);
        });
        return newTouches;
      });

      if (touchesToHandle.length === 0) {
        return;
      }

      try {
        await initializeAudio();
      } catch (error) {
        return;
      }

      const endedTouchIdSet = new Set(endedTouchIds);
      setVisualEffects((prev) =>
        prev.map((effect) =>
          endedTouchIdSet.has(effect.touchId)
            ? { ...effect, timestamp: Date.now() }
            : effect
        )
      );

      touchesToHandle.forEach((existingTouch) => {
        if (!existingTouch.isDragging) {
          void playDrum(existingTouch.y, rect.height);
        } else {
          const entry = synthsRef.current.get(existingTouch.id);
          if (entry) {
            try {
              entry.synth.triggerRelease();
            } catch (error) {
              console.error("Synth release error:", error);
            }
            entry.synth.dispose();
            entry.filter.dispose();
            synthsRef.current.delete(existingTouch.id);
          }
        }
      });
    },
    [initializeAudio, playDrum]
  );

  // Handle mouse end
  const handleMouseUp = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      setIsMouseDown(false);

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const touchId = mouseId.current;
      let touchToHandle: Touch | undefined;

      setTouches((prev) => {
        const newTouches = new Map(prev);
        const existingTouch = newTouches.get(touchId);

        if (existingTouch) {
          touchToHandle = existingTouch;
          newTouches.delete(touchId);
        }

        return newTouches;
      });

      if (!touchToHandle) {
        return;
      }

      try {
        await initializeAudio();
      } catch (error) {
        return;
      }

      setVisualEffects((prev) =>
        prev.map((effect) =>
          effect.touchId === touchId
            ? { ...effect, timestamp: Date.now() }
            : effect
        )
      );

      if (!touchToHandle.isDragging) {
        void playDrum(touchToHandle.y, rect.height);
      } else {
        const entry = synthsRef.current.get(touchId);
        if (entry) {
          try {
            entry.synth.triggerRelease();
          } catch (error) {
            console.error("Synth release error:", error);
          }
          entry.synth.dispose();
          entry.filter.dispose();
          synthsRef.current.delete(touchId);
        }
      }
    },
    [initializeAudio, playDrum]
  );

  // Clean up old visual effects
  useEffect(() => {
    const cleanup = setInterval(() => {
      setVisualEffects((prev) =>
        prev.filter((effect) => Date.now() - effect.timestamp < 4000)
      );
    }, 100);

    return () => clearInterval(cleanup);
  }, []);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      synthsRef.current.forEach((entry) => {
        try {
          entry.synth.dispose();
          entry.filter.dispose();
        } catch (error) {
          console.error("Cleanup error:", error);
        }
      });
      drumsRef.current.forEach((drum) => {
        try {
          if (drum && drum.dispose) {
            drum.dispose();
          }
        } catch (error) {
          console.error("Drum cleanup error:", error);
        }
      });
    };
  }, []);

  // Create smooth trail path using SVG
  const createTrailPath = (
    trail: Array<{ x: number; y: number; timestamp: number }>
  ) => {
    if (trail.length < 2) return "";

    let path = `M ${trail[0].x} ${trail[0].y}`;
    for (let i = 1; i < trail.length; i++) {
      const curr = trail[i];
      const prev = trail[i - 1];
      const midX = (curr.x + prev.x) / 2;
      const midY = (curr.y + prev.y) / 2;
      path += ` Q ${prev.x} ${prev.y} ${midX} ${midY}`;
    }
    return path;
  };

  return (
    <>
      {/* PWA Meta Tags */}
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
      />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta
        name="apple-mobile-web-app-status-bar-style"
        content="black-translucent"
      />
      <meta name="mobile-web-app-capable" content="yes" />

      {/* Ping animation keyframes */}
      <style>
        {`
      @keyframes ping {
        0% { transform: scale(1); opacity: 1; }
        75%, 100% { transform: scale(2); opacity: 0; }
      }
    `}
      </style>

      <div
        ref={containerRef}
        style={{
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100vh",
          background:
            "linear-gradient(135deg, #6D28D9 0%, #1E3A8A 50%, #3730A3 100%)",
          overflow: "hidden",
          userSelect: "none",
          touchAction: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
          cursor: "none",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Audio Status Indicator */}
        {audioStatus.message && (
          <div
            style={{
              position: "absolute",
              top: 16,
              left: 16,
              background: "rgba(0,0,0,0.5)",
              color: "#fff",
              padding: "8px 12px",
              borderRadius: 12,
              fontSize: 14,
              backdropFilter: "blur(4px)",
              zIndex: 10,
            }}
          >
            <div>{audioStatus.message}</div>
            {audioStatus.progress !== null && (
              <div
                style={{
                  marginTop: 8,
                  width: "100%",
                  height: 6,
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(Math.max(audioStatus.progress, 0), 1) * 100}%`,
                    height: "100%",
                    background: "linear-gradient(90deg, #F59E0B, #10B981)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            )}
          </div>
        )}

        {/* Debug Info for Testing */}
        <div
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            background: "rgba(0,0,0,0.5)",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 12,
            fontSize: 12,
            backdropFilter: "blur(4px)",
            zIndex: 10,
          }}
        >
          Active: {touches.size} | Effects: {visualEffects.length}
        </div>

        {/* Visual Effects */}
        {visualEffects.map((effect) => (
          <div key={effect.id}>
            {effect.type === "tap" ? (
              // Tap bubble effect
              <div
                style={{
                  position: "absolute",
                  pointerEvents: "none",
                  left: effect.x - 25,
                  top: effect.y - 25,
                  width: 50,
                  height: 50,
                  background: effect.color,
                  borderRadius: "50%",
                  opacity: Math.max(
                    0,
                    1 - (Date.now() - effect.timestamp) / 1000
                  ),
                  animation: "ping 1s cubic-bezier(0,0,0.2,1) 1",
                }}
              />
            ) : (
              // Enhanced drag trail effect using SVG
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: "none",
                }}
              >
                <svg
                  width="100%"
                  height="100%"
                  style={{ position: "absolute", inset: 0 }}
                >
                  {effect.trail && effect.trail.length > 1 && (
                    <>
                      {/* Main trail path */}
                      <path
                        d={createTrailPath(effect.trail)}
                        stroke={effect.color}
                        strokeWidth="8"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={Math.max(
                          0,
                          0.8 *
                            Math.max(
                              0,
                              1 - (Date.now() - effect.timestamp) / 3000
                            )
                        )}
                      />
                      {/* Glow effect */}
                      <path
                        d={createTrailPath(effect.trail)}
                        stroke={effect.color}
                        strokeWidth="16"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity={Math.max(
                          0,
                          0.3 *
                            Math.max(
                              0,
                              1 - (Date.now() - effect.timestamp) / 3000
                            )
                        )}
                      />
                    </>
                  )}
                </svg>
                {/* Trail points */}
                {effect.trail?.map((point, index) => (
                  <div
                    key={`${effect.id}_point_${index}`}
                    style={{
                      position: "absolute",
                      pointerEvents: "none",
                      borderRadius: "50%",
                      left: point.x - 6,
                      top: point.y - 6,
                      width: 12,
                      height: 12,
                      background: effect.color,
                      opacity: Math.max(
                        0,
                        (index / (effect.trail?.length || 1)) *
                          0.9 *
                          Math.max(0, 1 - (Date.now() - point.timestamp) / 2000)
                      ),
                      transform: `scale(${
                        0.3 + (index / (effect.trail?.length || 1)) * 0.7
                      })`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Instruction overlay (fades after first interaction) */}
        {touches.size === 0 && visualEffects.length === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                color: "rgba(255,255,255,0.6)",
                textAlign: "center",
                padding: 32,
                maxWidth: 400,
              }}
            >
              <div style={{ fontSize: 56, marginBottom: 16 }}>🎵</div>
              <h1 style={{ fontSize: 24, marginBottom: 16 }}>
                Baby Music Touch
              </h1>
              <p style={{ fontSize: 18 }}>
                Click for drums • Drag for melodies
              </p>
              <p
                style={{
                  fontSize: 14,
                  marginTop: 8,
                  opacity: 0.75,
                }}
              >
                Click/touch anywhere to start audio
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
