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
    color: "#b45309",
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
    emoji: "🥕",
    color: "#fb923c",
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
    color: "#4ade80",
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

