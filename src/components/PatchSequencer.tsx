import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const GRID_ROWS = 5;
const GRID_COLUMNS = 5;
const STEP_DURATION_SECONDS = 1.2;

interface PatchSequencerProps {
  ensureAudioContext: () => Promise<AudioContext>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
}

interface SequencerInstrument {
  id: string;
  label: string;
  emoji: string;
  color: string;
  play: (context: AudioContext, when: number) => void;
}

const INSTRUMENTS: SequencerInstrument[] = [
  {
    id: "bloom",
    label: "Bloom",
    emoji: "🌸",
    color: "#ff5dac",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(220, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.28, when + 0.14);
      gain.gain.setTargetAtTime(0.14, when + 0.14, 0.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 2.6);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(700, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 2.8);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "drift",
    label: "Drift",
    emoji: "🌊",
    color: "#34d2ff",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(329.628, when);
      oscillator.detune.setValueAtTime(-5, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.25, when + 0.18);
      gain.gain.setTargetAtTime(0.12, when + 0.18, 0.5);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 3.0);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(780, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 3.2);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "mist",
    label: "Mist",
    emoji: "🌫️",
    color: "#b967ff",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(440, when);
      oscillator.detune.setValueAtTime(5, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.22, when + 0.16);
      gain.gain.setTargetAtTime(0.10, when + 0.16, 0.45);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 2.8);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(820, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 3.0);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "earth",
    label: "Earth",
    emoji: "🌿",
    color: "#4ade80",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(164.814, when);
      oscillator.detune.setValueAtTime(-3, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.30, when + 0.20);
      gain.gain.setTargetAtTime(0.15, when + 0.20, 0.5);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 3.2);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(640, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 3.5);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "tide",
    label: "Tide",
    emoji: "💧",
    color: "#2b6bff",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(293.628, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.26, when + 0.15);
      gain.gain.setTargetAtTime(0.13, when + 0.15, 0.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 2.8);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(720, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 3.0);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "glow",
    label: "Glow",
    emoji: "✨",
    color: "#facc15",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
    // 495 Hz = A4 (440 Hz) × 9/8, which is B4 in just intonation (A-major pentatonic)
      oscillator.frequency.setValueAtTime(495, when);
      oscillator.detune.setValueAtTime(7, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.20, when + 0.17);
      gain.gain.setTargetAtTime(0.09, when + 0.17, 0.45);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 2.6);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(860, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 2.8);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "deep",
    label: "Deep",
    emoji: "🌙",
    color: "#1f77ff",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(110, when);
      oscillator.detune.setValueAtTime(-4, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.32, when + 0.22);
      gain.gain.setTargetAtTime(0.16, when + 0.22, 0.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 3.8);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(580, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 4.0);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
];

const instrumentMap = new Map(INSTRUMENTS.map((instrument) => [instrument.id, instrument]));

type GridState = (string | null)[][];

const createInitialGrid = (): GridState =>
  Array.from({ length: GRID_ROWS }, () => Array.from({ length: GRID_COLUMNS }, () => null));

export function PatchSequencer({
  ensureAudioContext,
  audioContextRef,
}: PatchSequencerProps) {
  const [grid, setGrid] = useState<GridState>(() => createInitialGrid());
  const gridRef = useRef<GridState>(grid);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState({ row: 0, progress: 0 });
  const playheadRef = useRef({ row: 0, progress: 0 });
  const animationFrameRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const progressRef = useRef(0);
  const rowRef = useRef(0);
  const isMountedRef = useRef(false);
  const holdTimersRef = useRef<Map<string, number>>(new Map());
  const holdTriggeredRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    gridRef.current = grid;
  }, [grid]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const triggerRow = useCallback(
    (rowIndex: number, when?: number) => {
      const context = audioContextRef.current;
      if (!context) {
        return;
      }
      const rowState = gridRef.current[rowIndex];
      if (!rowState) {
        return;
      }
      const startTime = when ?? context.currentTime + 0.01;
      rowState.forEach((cell) => {
        if (!cell) {
          return;
        }
        const instrument = instrumentMap.get(cell);
        if (!instrument) {
          return;
        }
        instrument.play(context, startTime);
      });
    },
    [audioContextRef]
  );

  const stepAnimation = useCallback(
    (timestamp: number) => {
      if (!isMountedRef.current || !isPlaying) {
        animationFrameRef.current = null;
        return;
      }

      if (lastTickRef.current === null) {
        lastTickRef.current = timestamp;
      }

      const delta = (timestamp - (lastTickRef.current ?? timestamp)) / 1000;
      lastTickRef.current = timestamp;

      let totalProgress = progressRef.current + delta / STEP_DURATION_SECONDS;
      let nextRow = rowRef.current;
      let advanced = false;

      while (totalProgress >= 1) {
        totalProgress -= 1;
        nextRow = (nextRow + 1) % GRID_ROWS;
        triggerRow(nextRow);
        advanced = true;
      }

      progressRef.current = totalProgress;
      rowRef.current = nextRow;

      const previous = playheadRef.current;
      if (
        advanced ||
        totalProgress !== previous.progress ||
        nextRow !== previous.row
      ) {
        const nextPlayhead = { row: nextRow, progress: totalProgress };
        playheadRef.current = nextPlayhead;
        setPlayhead(nextPlayhead);
      }

      animationFrameRef.current = requestAnimationFrame(stepAnimation);
    },
    [isPlaying, triggerRow]
  );

  useEffect(() => {
    if (!isPlaying) {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const start = async () => {
      try {
        await ensureAudioContext();
      } catch (error) {
        console.warn("Unable to start audio context", error);
        return;
      }

      if (cancelled) {
        return;
      }

      rowRef.current = 0;
      progressRef.current = 0;
      lastTickRef.current = null;
      const initialPlayhead = { row: 0, progress: 0 };
      playheadRef.current = initialPlayhead;
      setPlayhead(initialPlayhead);

      const context = audioContextRef.current;
      const when = context ? context.currentTime + 0.05 : undefined;
      triggerRow(0, when);

      animationFrameRef.current = requestAnimationFrame(stepAnimation);
    };

    start();

    return () => {
      cancelled = true;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [audioContextRef, ensureAudioContext, isPlaying, stepAnimation, triggerRow]);

  const getNextInstrumentId = useCallback((currentId: string | null) => {
    if (!currentId) {
      return INSTRUMENTS[0].id;
    }
    const index = INSTRUMENTS.findIndex((instrument) => instrument.id === currentId);
    if (index === -1) {
      return INSTRUMENTS[0].id;
    }
    const nextIndex = (index + 1) % INSTRUMENTS.length;
    return INSTRUMENTS[nextIndex].id;
  }, []);

  const handlePressStart = useCallback((rowIndex: number, columnIndex: number) => {
    const key = `${rowIndex}-${columnIndex}`;
    holdTriggeredRef.current.set(key, false);
    const timer = window.setTimeout(() => {
      holdTriggeredRef.current.set(key, true);
      setGrid((previous) => {
        const next = previous.map((row) => row.slice());
        next[rowIndex][columnIndex] = null;
        return next;
      });
    }, 2000);
    holdTimersRef.current.set(key, timer);
  }, []);

  const clearPressState = useCallback((key: string) => {
    const timer = holdTimersRef.current.get(key);
    if (timer) {
      window.clearTimeout(timer);
      holdTimersRef.current.delete(key);
    }
  }, []);

  const handlePressEnd = useCallback(
    async (rowIndex: number, columnIndex: number, shouldAdvance: boolean) => {
      const key = `${rowIndex}-${columnIndex}`;
      const wasHeld = holdTriggeredRef.current.get(key);
      holdTriggeredRef.current.delete(key);
      clearPressState(key);

      if (wasHeld) {
        return;
      }

      if (!shouldAdvance) {
        return;
      }

      const currentId = gridRef.current[rowIndex][columnIndex];
      const nextId = getNextInstrumentId(currentId);
      const nextInstrument = instrumentMap.get(nextId);

      setGrid((previous) => {
        const next = previous.map((row) => row.slice());
        next[rowIndex][columnIndex] = nextId;
        return next;
      });

      if (!isPlaying && nextInstrument) {
        try {
          const context = await ensureAudioContext();
          nextInstrument.play(context, context.currentTime + 0.02);
        } catch (error) {
          console.warn("Unable to preview instrument", error);
        }
      }
    },
    [clearPressState, ensureAudioContext, getNextInstrumentId, isPlaying]
  );

  const handleTogglePlayback = useCallback(async () => {
    if (!isPlaying) {
      try {
        await ensureAudioContext();
      } catch (error) {
        console.warn("Unable to unlock audio context", error);
      }
    }
    setIsPlaying((previous) => !previous);
  }, [ensureAudioContext, isPlaying]);

  const playButtonLabel = isPlaying ? "Pause sequencer" : "Play sequencer";
  const playButtonIcon = isPlaying ? "❚❚" : "▶";

  const lineStyle = useMemo<React.CSSProperties>(() => {
    const rowHeightPercent = 100 / GRID_ROWS;
    const translatePercent = (playhead.row + playhead.progress) * rowHeightPercent;
    return {
      position: "absolute",
      left: 4,
      right: 4,
      height: 3,
      borderRadius: 9999,
      background: "rgba(34, 197, 94, 0.9)",
      top: `calc(${translatePercent}% - 1.5px)`,
      transition: isPlaying ? "top 0.05s linear" : "top 0.3s ease",
      opacity: isPlaying ? 1 : 0,
      pointerEvents: "none",
      boxShadow: "0 0 12px rgba(34, 197, 94, 0.55)",
      willChange: "top",
    };
  }, [isPlaying, playhead.progress, playhead.row]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        color: "#e2e8f0",
        backgroundColor: "rgba(6, 7, 12, 0.92)",
        overflow: "hidden",
        zIndex: 6,
      }}
    >
      <button
        type="button"
        aria-label={playButtonLabel}
        onClick={handleTogglePlayback}
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 16px)",
          left: 16,
          width: 72,
          height: 72,
          borderRadius: "50%",
          border: "none",
          background: "linear-gradient(135deg, #22c55e, #16a34a)",
          color: "#0f172a",
          fontSize: 28,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 12px 32px rgba(15, 23, 42, 0.55)",
          cursor: "pointer",
          zIndex: 60,
          transition: "background 0.2s ease, transform 0.2s ease",
          touchAction: "manipulation",
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerLeave={(event) => {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
      >
        {playButtonIcon}
      </button>

      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          display: "grid",
          gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
          gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)`,
          gap: 0,
          padding: "calc(env(safe-area-inset-top, 0px) + 4px) 4px calc(env(safe-area-inset-bottom, 0px) + 4px)",
          boxSizing: "border-box",
        }}
      >
        <div style={lineStyle} aria-hidden />
        {grid.map((row, rowIndex) =>
          row.map((cell, columnIndex) => {
            const instrument = cell ? instrumentMap.get(cell) : null;
            const backgroundColor = instrument ? instrument.color : "#1f2937";
            const isActiveRow = playhead.row === rowIndex && isPlaying;

            return (
              <div key={`${rowIndex}-${columnIndex}`} style={{ padding: 2 }}>
                <button
                  type="button"
                  aria-label={
                    instrument ? `${instrument.label} patch` : "Empty patch slot"
                  }
                  onPointerDown={() => handlePressStart(rowIndex, columnIndex)}
                  onPointerUp={() => handlePressEnd(rowIndex, columnIndex, true)}
                  onPointerCancel={() => handlePressEnd(rowIndex, columnIndex, false)}
                  onPointerLeave={() => handlePressEnd(rowIndex, columnIndex, false)}
                  onContextMenu={(event) => event.preventDefault()}
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 4,
                    border: isActiveRow
                      ? "3px solid rgba(248, 250, 252, 0.75)"
                      : "3px solid transparent",
                    boxSizing: "border-box",
                    backgroundColor,
                    cursor: "pointer",
                    touchAction: "manipulation",
                    padding: 0,
                    position: "relative",
                    transition: "border 0.12s ease",
                  }}
                >
                  {instrument ? (
                    <span
                      aria-hidden
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 28,
                        lineHeight: 1,
                        width: "100%",
                        height: "100%",
                        filter: isActiveRow ? "brightness(1.05)" : "none",
                        transition: "filter 0.12s ease",
                      }}
                    >
                      {instrument.emoji}
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 20,
                        lineHeight: 1,
                        color: "#94a3b8",
                      }}
                    >
                      ·
                    </span>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

