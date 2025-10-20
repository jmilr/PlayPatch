import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const GRID_ROWS = 5;
const GRID_COLUMNS = 5;
const STEP_DURATION_SECONDS = 0.6;

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

const createNoiseBuffer = (context: AudioContext) => {
  const buffer = context.createBuffer(1, context.sampleRate * 1.5, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
};

const INSTRUMENTS: SequencerInstrument[] = [
  {
    id: "kick",
    label: "Kick",
    emoji: "🥔",
    color: "#f97316",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(150, when);
      oscillator.frequency.exponentialRampToValueAtTime(45, when + 0.4);

      const gain = context.createGain();
      gain.gain.setValueAtTime(1, when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.5);

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 0.5);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "snare",
    label: "Drum",
    emoji: "🍅",
    color: "#ef4444",
    play: (context, when) => {
      const noise = context.createBufferSource();
      noise.buffer = createNoiseBuffer(context);

      const filter = context.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.setValueAtTime(1800, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.6, when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.25);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      noise.start(when);
      noise.stop(when + 0.3);
      noise.onended = () => {
        noise.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "cymbal",
    label: "Cymbal",
    emoji: "🍋",
    color: "#facc15",
    play: (context, when) => {
      const noise = context.createBufferSource();
      noise.buffer = createNoiseBuffer(context);

      const filter = context.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.setValueAtTime(6500, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.4, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      noise.start(when);
      noise.stop(when + 0.4);
      noise.onended = () => {
        noise.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "synth",
    label: "Synth",
    emoji: "🍇",
    color: "#a855f7",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(440, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.4, when + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.6);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(2200, when);
      filter.frequency.exponentialRampToValueAtTime(800, when + 0.6);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 0.65);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "guitar",
    label: "Guitar",
    emoji: "🍑",
    color: "#fb7185",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(660, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.5, when + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.5);

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 0.55);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "bass",
    label: "Bass",
    emoji: "🥒",
    color: "#22c55e",
    play: (context, when) => {
      const oscillator = context.createOscillator();
      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(110, when);

      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.5, when + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.6);

      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(420, when);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);

      oscillator.start(when);
      oscillator.stop(when + 0.65);
      oscillator.onended = () => {
        oscillator.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    },
  },
  {
    id: "piano",
    label: "Piano",
    emoji: "🍏",
    color: "#34d399",
    play: (context, when) => {
      const createPartial = (ratio: number, gainAmount: number) => {
        const osc = context.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(330 * ratio, when);

        const partialGain = context.createGain();
        partialGain.gain.setValueAtTime(0.0001, when);
        partialGain.gain.exponentialRampToValueAtTime(gainAmount, when + 0.02);
        partialGain.gain.exponentialRampToValueAtTime(0.001, when + 0.8);

        osc.connect(partialGain);
        partialGain.connect(context.destination);

        osc.start(when);
        osc.stop(when + 0.85);
        osc.onended = () => {
          osc.disconnect();
          partialGain.disconnect();
        };
      };

      createPartial(1, 0.35);
      createPartial(2, 0.12);
      createPartial(3, 0.06);
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
    const translatePercent = ((playhead.row + playhead.progress) / GRID_ROWS) * 100;
    return {
      position: "absolute",
      left: 4,
      right: 4,
      height: 3,
      borderRadius: 9999,
      background: "rgba(34, 197, 94, 0.9)",
      transform: `translateY(calc(${translatePercent}% - 1.5px))`,
      transition: isPlaying ? "none" : "transform 0.3s ease",
      opacity: isPlaying ? 1 : 0,
      pointerEvents: "none",
      boxShadow: "0 0 12px rgba(34, 197, 94, 0.55)",
    };
  }, [isPlaying, playhead.progress, playhead.row]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        color: "#e2e8f0",
        backgroundColor: "rgba(6, 7, 12, 0.92)",
        padding: "calc(env(safe-area-inset-top, 0px) + 64px) 24px 32px",
        boxSizing: "border-box",
        overflow: "hidden",
        zIndex: 6,
      }}
    >
      <button
        onClick={handleTogglePlayback}
        aria-label={playButtonLabel}
        style={{
          position: "fixed",
          top: "calc(env(safe-area-inset-top, 0px) + 8px)",
          left: "calc(50% + 72px)",
          transform: "translateX(-50%)",
          width: 44,
          height: 44,
          borderRadius: 9999,
          border: "1px solid rgba(148, 163, 184, 0.45)",
          background: "rgba(15, 23, 42, 0.85)",
          color: "#f8fafc",
          fontSize: 16,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 10px 28px rgba(15, 23, 42, 0.45)",
          cursor: "pointer",
          zIndex: 60,
          transition: "background 0.2s ease, transform 0.2s ease",
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
          position: "relative",
          width: "min(88vw, 420px)",
          aspectRatio: "1",
          display: "grid",
          gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
          gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)`,
          padding: 4,
          background: "rgba(15, 23, 42, 0.75)",
          borderRadius: 12,
          border: "1px solid rgba(148, 163, 184, 0.2)",
          boxShadow: "0 24px 80px rgba(15, 23, 42, 0.65)",
          overflow: "hidden",
        }}
      >
        <div style={lineStyle} aria-hidden />
        {grid.map((row, rowIndex) =>
          row.map((cell, columnIndex) => {
            const instrument = cell ? instrumentMap.get(cell) : null;
            const isActiveRow = isPlaying && rowIndex === playhead.row;
            const background = instrument ? instrument.color : "#1f2937";
            const outline = isActiveRow
              ? "0 0 0 3px rgba(34, 197, 94, 0.9)"
              : "0 0 0 1px rgba(15, 23, 42, 0.6)";

            return (
              <div key={`${rowIndex}-${columnIndex}`} style={{ padding: 2 }}>
                <button
                  type="button"
                  onPointerDown={() => handlePressStart(rowIndex, columnIndex)}
                  onPointerUp={() => handlePressEnd(rowIndex, columnIndex, true)}
                  onPointerCancel={() => handlePressEnd(rowIndex, columnIndex, false)}
                  onPointerLeave={() => handlePressEnd(rowIndex, columnIndex, false)}
                  onContextMenu={(event) => event.preventDefault()}
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 8,
                    border: "none",
                    background,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "column",
                    gap: 4,
                    color: instrument ? "#0f172a" : "#94a3b8",
                    fontSize: instrument ? 28 : 18,
                    boxShadow: outline,
                    transition: "transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
                    cursor: "pointer",
                    touchAction: "manipulation",
                    position: "relative",
                  }}
                >
                  {instrument ? (
                    <>
                      <span style={{ fontSize: 30 }}>{instrument.emoji}</span>
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          letterSpacing: 1.2,
                          textTransform: "uppercase",
                          color: "rgba(15, 23, 42, 0.85)",
                        }}
                      >
                        {instrument.label}
                      </span>
                    </>
                  ) : (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: 1,
                        textTransform: "uppercase",
                        color: "rgba(148, 163, 184, 0.65)",
                      }}
                    >
                      Tap
                    </span>
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
      <div
        style={{
          textAlign: "center",
          maxWidth: 420,
          color: "rgba(226, 232, 240, 0.72)",
          fontSize: 14,
          lineHeight: 1.6,
          letterSpacing: 0.4,
        }}
      >
        Tap tiles to cycle instruments. Hold for two seconds to clear. Instruments play in order from
        top to bottom when the sequencer runs.
      </div>
    </div>
  );
}

