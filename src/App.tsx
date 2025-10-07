import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RainbowField } from "./effects/RainbowField";
import { clamp } from "./utils/math";
import { hexToRgb, mixRgb, rgbToCss, RGBColor } from "./utils/color";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

interface TouchPoint {
  id: number;
  x: number;
  y: number;
  color: RGBColor;
}

interface TapConfig {
  waveform: OscillatorType;
  octaveOffset: number;
  detune?: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  gain: number;
  filterFrequency: number;
  filterQ: number;
}

interface InstrumentDefinition {
  id: string;
  waveform: OscillatorType;
  detune?: number;
  attack: number;
  sustain: number;
  release: number;
  filter: {
    type: BiquadFilterType;
    frequency: number;
    Q: number;
    gain?: number;
  };
  vibrato?: {
    rate: number;
    depth: number;
  };
  tap: TapConfig;
}

interface GridCell {
  id: number;
  label: string;
  hex: string;
  color: RGBColor;
  frequency: number;
  instrument: InstrumentDefinition;
}

interface CellMix {
  primaryCell: GridCell;
  blendedColor: RGBColor;
  blendedFrequency: number;
  rowIndex: number;
  columnIndex: number;
}

interface Voice {
  oscillator: OscillatorNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  panner?: StereoPannerNode;
  vibratoOsc: OscillatorNode;
  vibratoGain: GainNode;
  instrument: InstrumentDefinition;
  currentCellIndex: number;
}

interface PointerMeta {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  totalDistance: number;
  startTime: number;
  currentCellIndex: number;
  lastColor: RGBColor;
  lastFrequency: number;
}

const GRID_ROWS = 5;
const GRID_COLUMNS = 5;

const ROW_BASES = [554.37, 466.16, 369.99, 293.66, 220.0];
const COLUMN_RATIOS = [1, 1.1225, 1.26, 1.498, 1.682];

const makeInstrument = (config: InstrumentDefinition): InstrumentDefinition => config;

const GRID_SPEC: Array<
  Array<{ hex: string; label: string; instrument: InstrumentDefinition }>
> = [
  [
    {
      hex: "#ff2f92",
      label: "Nova",
      instrument: makeInstrument({
        id: "nova",
        waveform: "sawtooth",
        detune: 6,
        attack: 0.05,
        sustain: 0.62,
        release: 0.48,
        filter: { type: "lowpass", frequency: 5200, Q: 0.9 },
        vibrato: { rate: 5.2, depth: 7 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 1,
          detune: 14,
          attack: 0.01,
          decay: 0.2,
          sustain: 0.28,
          release: 0.32,
          gain: 0.38,
          filterFrequency: 6200,
          filterQ: 1.2,
        },
      }),
    },
    {
      hex: "#ff6b4a",
      label: "Flare",
      instrument: makeInstrument({
        id: "flare",
        waveform: "square",
        detune: -4,
        attack: 0.03,
        sustain: 0.55,
        release: 0.42,
        filter: { type: "bandpass", frequency: 3400, Q: 9.5 },
        vibrato: { rate: 7.6, depth: 11 },
        tap: {
          waveform: "square",
          octaveOffset: 0,
          detune: -12,
          attack: 0.006,
          decay: 0.16,
          sustain: 0.22,
          release: 0.28,
          gain: 0.36,
          filterFrequency: 2600,
          filterQ: 5,
        },
      }),
    },
    {
      hex: "#ffd23f",
      label: "Solar",
      instrument: makeInstrument({
        id: "solar",
        waveform: "triangle",
        detune: 8,
        attack: 0.06,
        sustain: 0.58,
        release: 0.5,
        filter: { type: "lowpass", frequency: 7800, Q: 0.7 },
        vibrato: { rate: 3.8, depth: 5 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.012,
          decay: 0.22,
          sustain: 0.32,
          release: 0.34,
          gain: 0.32,
          filterFrequency: 6400,
          filterQ: 1.4,
        },
      }),
    },
    {
      hex: "#7dff5c",
      label: "Verdant",
      instrument: makeInstrument({
        id: "verdant",
        waveform: "sine",
        detune: 2,
        attack: 0.08,
        sustain: 0.64,
        release: 0.62,
        filter: { type: "lowpass", frequency: 6200, Q: 0.8 },
        vibrato: { rate: 4.4, depth: 6 },
        tap: {
          waveform: "sine",
          octaveOffset: 1,
          detune: 7,
          attack: 0.015,
          decay: 0.24,
          sustain: 0.35,
          release: 0.4,
          gain: 0.28,
          filterFrequency: 5400,
          filterQ: 1,
        },
      }),
    },
    {
      hex: "#32ffe0",
      label: "Lagoon",
      instrument: makeInstrument({
        id: "lagoon",
        waveform: "sawtooth",
        detune: -9,
        attack: 0.04,
        sustain: 0.6,
        release: 0.5,
        filter: { type: "lowpass", frequency: 6800, Q: 0.9 },
        vibrato: { rate: 6.5, depth: 8 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 1,
          attack: 0.01,
          decay: 0.18,
          sustain: 0.26,
          release: 0.36,
          gain: 0.35,
          filterFrequency: 6000,
          filterQ: 2,
        },
      }),
    },
  ],
  [
    {
      hex: "#b967ff",
      label: "Lumen",
      instrument: makeInstrument({
        id: "lumen",
        waveform: "triangle",
        detune: 4,
        attack: 0.07,
        sustain: 0.56,
        release: 0.58,
        filter: { type: "lowpass", frequency: 7400, Q: 0.6 },
        vibrato: { rate: 3.6, depth: 4.5 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.014,
          decay: 0.26,
          sustain: 0.3,
          release: 0.36,
          gain: 0.3,
          filterFrequency: 5800,
          filterQ: 1.3,
        },
      }),
    },
    {
      hex: "#ff5dac",
      label: "Bloom",
      instrument: makeInstrument({
        id: "bloom",
        waveform: "sawtooth",
        detune: 10,
        attack: 0.05,
        sustain: 0.65,
        release: 0.54,
        filter: { type: "lowpass", frequency: 5400, Q: 1.1 },
        vibrato: { rate: 5.8, depth: 9 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 0,
          detune: 12,
          attack: 0.008,
          decay: 0.18,
          sustain: 0.24,
          release: 0.34,
          gain: 0.38,
          filterFrequency: 4200,
          filterQ: 2.2,
        },
      }),
    },
    {
      hex: "#ff9f1c",
      label: "Spark",
      instrument: makeInstrument({
        id: "spark",
        waveform: "square",
        detune: -6,
        attack: 0.04,
        sustain: 0.58,
        release: 0.46,
        filter: { type: "bandpass", frequency: 2800, Q: 7.5 },
        vibrato: { rate: 7.1, depth: 12 },
        tap: {
          waveform: "square",
          octaveOffset: 0,
          detune: -7,
          attack: 0.006,
          decay: 0.16,
          sustain: 0.2,
          release: 0.28,
          gain: 0.34,
          filterFrequency: 2300,
          filterQ: 6,
        },
      }),
    },
    {
      hex: "#5dffb5",
      label: "Mist",
      instrument: makeInstrument({
        id: "mist",
        waveform: "sine",
        detune: 3,
        attack: 0.09,
        sustain: 0.68,
        release: 0.62,
        filter: { type: "lowpass", frequency: 6000, Q: 0.9 },
        vibrato: { rate: 4.8, depth: 5.5 },
        tap: {
          waveform: "sine",
          octaveOffset: 1,
          detune: 5,
          attack: 0.016,
          decay: 0.24,
          sustain: 0.28,
          release: 0.4,
          gain: 0.27,
          filterFrequency: 5200,
          filterQ: 1.2,
        },
      }),
    },
    {
      hex: "#34d2ff",
      label: "Azure",
      instrument: makeInstrument({
        id: "azure",
        waveform: "triangle",
        detune: -8,
        attack: 0.06,
        sustain: 0.6,
        release: 0.56,
        filter: { type: "lowpass", frequency: 7000, Q: 0.7 },
        vibrato: { rate: 6.1, depth: 6.5 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.012,
          decay: 0.22,
          sustain: 0.32,
          release: 0.34,
          gain: 0.31,
          filterFrequency: 5800,
          filterQ: 1.5,
        },
      }),
    },
  ],
  [
    {
      hex: "#ff3b30",
      label: "Crimson",
      instrument: makeInstrument({
        id: "crimson",
        waveform: "sawtooth",
        detune: 5,
        attack: 0.05,
        sustain: 0.64,
        release: 0.52,
        filter: { type: "lowpass", frequency: 4200, Q: 1.3 },
        vibrato: { rate: 5.9, depth: 10 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 0,
          detune: 9,
          attack: 0.008,
          decay: 0.18,
          sustain: 0.22,
          release: 0.3,
          gain: 0.36,
          filterFrequency: 3800,
          filterQ: 2.4,
        },
      }),
    },
    {
      hex: "#ff6f61",
      label: "Glow",
      instrument: makeInstrument({
        id: "glow",
        waveform: "triangle",
        detune: -5,
        attack: 0.07,
        sustain: 0.6,
        release: 0.56,
        filter: { type: "lowpass", frequency: 5600, Q: 0.9 },
        vibrato: { rate: 4.9, depth: 6 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.013,
          decay: 0.24,
          sustain: 0.28,
          release: 0.36,
          gain: 0.3,
          filterFrequency: 5000,
          filterQ: 1.4,
        },
      }),
    },
    {
      hex: "#ffcf70",
      label: "Honey",
      instrument: makeInstrument({
        id: "honey",
        waveform: "sine",
        detune: 1,
        attack: 0.08,
        sustain: 0.66,
        release: 0.64,
        filter: { type: "lowpass", frequency: 6400, Q: 0.8 },
        vibrato: { rate: 3.9, depth: 5 },
        tap: {
          waveform: "sine",
          octaveOffset: 1,
          attack: 0.015,
          decay: 0.28,
          sustain: 0.32,
          release: 0.42,
          gain: 0.26,
          filterFrequency: 5200,
          filterQ: 1.1,
        },
      }),
    },
    {
      hex: "#4ad0ff",
      label: "Stream",
      instrument: makeInstrument({
        id: "stream",
        waveform: "sawtooth",
        detune: -10,
        attack: 0.04,
        sustain: 0.58,
        release: 0.5,
        filter: { type: "lowpass", frequency: 6400, Q: 0.7 },
        vibrato: { rate: 6.8, depth: 7 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 1,
          attack: 0.009,
          decay: 0.2,
          sustain: 0.26,
          release: 0.34,
          gain: 0.34,
          filterFrequency: 5200,
          filterQ: 1.8,
        },
      }),
    },
    {
      hex: "#2b6bff",
      label: "Tide",
      instrument: makeInstrument({
        id: "tide",
        waveform: "triangle",
        detune: 3,
        attack: 0.06,
        sustain: 0.6,
        release: 0.55,
        filter: { type: "lowpass", frequency: 6800, Q: 0.6 },
        vibrato: { rate: 5.6, depth: 6.8 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.012,
          decay: 0.24,
          sustain: 0.3,
          release: 0.36,
          gain: 0.3,
          filterFrequency: 5600,
          filterQ: 1.3,
        },
      }),
    },
  ],
  [
    {
      hex: "#5a3bff",
      label: "Pulse",
      instrument: makeInstrument({
        id: "pulse",
        waveform: "square",
        detune: -3,
        attack: 0.05,
        sustain: 0.5,
        release: 0.44,
        filter: { type: "bandpass", frequency: 2200, Q: 8.2 },
        vibrato: { rate: 7.8, depth: 10 },
        tap: {
          waveform: "square",
          octaveOffset: 0,
          detune: -9,
          attack: 0.007,
          decay: 0.16,
          sustain: 0.18,
          release: 0.26,
          gain: 0.32,
          filterFrequency: 2000,
          filterQ: 6.2,
        },
      }),
    },
    {
      hex: "#8a46ff",
      label: "Prism",
      instrument: makeInstrument({
        id: "prism",
        waveform: "sawtooth",
        detune: 12,
        attack: 0.05,
        sustain: 0.58,
        release: 0.5,
        filter: { type: "lowpass", frequency: 4800, Q: 1.2 },
        vibrato: { rate: 5.4, depth: 8.5 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 1,
          attack: 0.01,
          decay: 0.2,
          sustain: 0.24,
          release: 0.34,
          gain: 0.34,
          filterFrequency: 4600,
          filterQ: 2,
        },
      }),
    },
    {
      hex: "#ff61f7",
      label: "Fable",
      instrument: makeInstrument({
        id: "fable",
        waveform: "triangle",
        detune: 6,
        attack: 0.07,
        sustain: 0.62,
        release: 0.58,
        filter: { type: "lowpass", frequency: 5200, Q: 0.9 },
        vibrato: { rate: 4.3, depth: 6 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.014,
          decay: 0.24,
          sustain: 0.28,
          release: 0.38,
          gain: 0.3,
          filterFrequency: 4800,
          filterQ: 1.4,
        },
      }),
    },
    {
      hex: "#ff4b8c",
      label: "Blaze",
      instrument: makeInstrument({
        id: "blaze",
        waveform: "sawtooth",
        detune: -8,
        attack: 0.04,
        sustain: 0.57,
        release: 0.5,
        filter: { type: "lowpass", frequency: 5600, Q: 1 },
        vibrato: { rate: 6.4, depth: 9 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 0,
          detune: 10,
          attack: 0.009,
          decay: 0.18,
          sustain: 0.22,
          release: 0.32,
          gain: 0.35,
          filterFrequency: 4200,
          filterQ: 2.1,
        },
      }),
    },
    {
      hex: "#ffa24c",
      label: "Glowr",
      instrument: makeInstrument({
        id: "glowr",
        waveform: "triangle",
        detune: 2,
        attack: 0.06,
        sustain: 0.59,
        release: 0.52,
        filter: { type: "lowpass", frequency: 6000, Q: 0.8 },
        vibrato: { rate: 5.1, depth: 6.2 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.012,
          decay: 0.22,
          sustain: 0.3,
          release: 0.34,
          gain: 0.31,
          filterFrequency: 5000,
          filterQ: 1.5,
        },
      }),
    },
  ],
  [
    {
      hex: "#1f77ff",
      label: "Skye",
      instrument: makeInstrument({
        id: "skye",
        waveform: "sine",
        detune: -2,
        attack: 0.09,
        sustain: 0.64,
        release: 0.62,
        filter: { type: "lowpass", frequency: 5600, Q: 0.7 },
        vibrato: { rate: 3.8, depth: 4.2 },
        tap: {
          waveform: "sine",
          octaveOffset: 1,
          attack: 0.016,
          decay: 0.28,
          sustain: 0.32,
          release: 0.42,
          gain: 0.26,
          filterFrequency: 4800,
          filterQ: 1.1,
        },
      }),
    },
    {
      hex: "#15c6ff",
      label: "Glacier",
      instrument: makeInstrument({
        id: "glacier",
        waveform: "triangle",
        detune: 5,
        attack: 0.07,
        sustain: 0.6,
        release: 0.56,
        filter: { type: "lowpass", frequency: 6000, Q: 0.8 },
        vibrato: { rate: 4.6, depth: 5.4 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.014,
          decay: 0.26,
          sustain: 0.3,
          release: 0.38,
          gain: 0.29,
          filterFrequency: 5200,
          filterQ: 1.3,
        },
      }),
    },
    {
      hex: "#2dff88",
      label: "Grove",
      instrument: makeInstrument({
        id: "grove",
        waveform: "sawtooth",
        detune: -6,
        attack: 0.05,
        sustain: 0.58,
        release: 0.5,
        filter: { type: "lowpass", frequency: 5200, Q: 0.9 },
        vibrato: { rate: 6.2, depth: 7.5 },
        tap: {
          waveform: "sawtooth",
          octaveOffset: 0,
          detune: 11,
          attack: 0.009,
          decay: 0.2,
          sustain: 0.24,
          release: 0.34,
          gain: 0.34,
          filterFrequency: 4400,
          filterQ: 2,
        },
      }),
    },
    {
      hex: "#aaff2c",
      label: "Lush",
      instrument: makeInstrument({
        id: "lush",
        waveform: "triangle",
        detune: 4,
        attack: 0.08,
        sustain: 0.64,
        release: 0.58,
        filter: { type: "lowpass", frequency: 5800, Q: 0.85 },
        vibrato: { rate: 4.2, depth: 5.8 },
        tap: {
          waveform: "triangle",
          octaveOffset: 1,
          attack: 0.014,
          decay: 0.26,
          sustain: 0.32,
          release: 0.38,
          gain: 0.3,
          filterFrequency: 5200,
          filterQ: 1.2,
        },
      }),
    },
    {
      hex: "#ffd1ff",
      label: "Glowm",
      instrument: makeInstrument({
        id: "glowm",
        waveform: "sine",
        detune: -4,
        attack: 0.1,
        sustain: 0.66,
        release: 0.64,
        filter: { type: "lowpass", frequency: 5400, Q: 0.7 },
        vibrato: { rate: 3.6, depth: 4.5 },
        tap: {
          waveform: "sine",
          octaveOffset: 1,
          attack: 0.016,
          decay: 0.3,
          sustain: 0.34,
          release: 0.44,
          gain: 0.24,
          filterFrequency: 4600,
          filterQ: 1,
        },
      }),
    },
  ],
];

const PERCUSSIVE_PATTERN: boolean[][] = [
  [true, false, true, false, true],
  [false, true, false, true, false],
  [true, false, true, false, true],
  [false, true, false, true, false],
  [true, false, true, false, true],
];

const createPercussiveInstrument = (
  baseId: string,
  baseFrequency: number,
  variant: number
): InstrumentDefinition => {
  const waveforms: OscillatorType[] = [
    "square",
    "sawtooth",
    "triangle",
    "square",
    "sine",
  ];
  const waveform = waveforms[variant % waveforms.length];
  const detune = (variant % 5) * 2 - 4;
  const filterFrequency = clamp(baseFrequency * 1.7 + variant * 35, 350, 5200);
  const filterQ = 5 + (variant % 4) * 1.1;
  const tapFilter = clamp(filterFrequency * 1.1, 500, 5600);

  return makeInstrument({
    id: `percussive-${baseId}`,
    waveform,
    detune,
    attack: 0.008,
    sustain: 0.18,
    release: 0.16,
    filter: { type: "bandpass", frequency: filterFrequency, Q: filterQ },
    tap: {
      waveform,
      octaveOffset: 0,
      detune: detune * 1.5,
      attack: 0.003,
      decay: 0.12,
      sustain: 0.1,
      release: 0.14,
      gain: 0.38 + (variant % 3) * 0.03,
      filterFrequency: tapFilter,
      filterQ: filterQ + 1.5,
    },
  });
};

const GRID_CELLS: GridCell[] = (() => {
  const cells: GridCell[] = [];
  let id = 0;
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLUMNS; col += 1) {
      const spec = GRID_SPEC[row][col];
      const frequency = ROW_BASES[row] * COLUMN_RATIOS[col];
      const instrument = PERCUSSIVE_PATTERN[row][col]
        ? createPercussiveInstrument(`${spec.instrument.id}-${id}`, frequency, id)
        : spec.instrument;
      cells.push({
        id,
        label: spec.label,
        hex: spec.hex,
        color: hexToRgb(spec.hex),
        frequency,
        instrument,
      });
      id += 1;
    }
  }
  return cells;
})();

const getCell = (row: number, col: number) =>
  GRID_CELLS[row * GRID_COLUMNS + col] ?? GRID_CELLS[0];

const pointerGlowColor = (color: RGBColor) => color;
const emitterColor = (color: RGBColor) => color;

const getPanForPosition = (x: number, width: number) => {
  if (width <= 0) {
    return 0;
  }
  return clamp((x / width) * 2 - 1, -0.85, 0.85);
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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const computeCellMix = (
  x: number,
  y: number,
  width: number,
  height: number
): CellMix => {
  if (width <= 0 || height <= 0) {
    const fallback = GRID_CELLS[0];
    return {
      primaryCell: fallback,
      blendedColor: fallback.color,
      blendedFrequency: fallback.frequency,
      rowIndex: 0,
      columnIndex: 0,
    };
  }

  const normalizedX = clamp(x / width, 0, 0.9999);
  const normalizedY = clamp(y / height, 0, 0.9999);

  const columnIndex = Math.min(
    Math.floor(normalizedX * GRID_COLUMNS),
    GRID_COLUMNS - 1
  );
  const rowIndex = Math.min(
    Math.floor(normalizedY * GRID_ROWS),
    GRID_ROWS - 1
  );

  const nextColumn = Math.min(columnIndex + 1, GRID_COLUMNS - 1);
  const nextRow = Math.min(rowIndex + 1, GRID_ROWS - 1);

  const blendX = clamp(normalizedX * GRID_COLUMNS - columnIndex, 0, 1);
  const blendY = clamp(normalizedY * GRID_ROWS - rowIndex, 0, 1);

  const cell00 = getCell(rowIndex, columnIndex);
  const cell10 = getCell(rowIndex, nextColumn);
  const cell01 = getCell(nextRow, columnIndex);
  const cell11 = getCell(nextRow, nextColumn);

  const topColor = mixRgb(cell00.color, cell10.color, blendX);
  const bottomColor = mixRgb(cell01.color, cell11.color, blendX);
  const blendedColor = mixRgb(topColor, bottomColor, blendY);

  const topFrequency = lerp(cell00.frequency, cell10.frequency, blendX);
  const bottomFrequency = lerp(cell01.frequency, cell11.frequency, blendX);
  const blendedFrequency = lerp(topFrequency, bottomFrequency, blendY);

  return {
    primaryCell: cell00,
    blendedColor,
    blendedFrequency,
    rowIndex,
    columnIndex,
  };
};

const getGainForPosition = (y: number, height: number) => {
  if (height <= 0) {
    return 0.45;
  }

  const normalized = 1 - clamp(y / height, 0, 1);
  return clamp(0.18 + normalized * 0.5, 0.12, 0.7);
};

const computeTargetGain = (
  y: number,
  height: number,
  instrument: InstrumentDefinition
) => clamp(getGainForPosition(y, height) * instrument.sustain, 0.04, 0.9);

const morphVoiceToInstrument = (
  voice: Voice,
  instrument: InstrumentDefinition,
  now: number
) => {
  voice.instrument = instrument;
  voice.oscillator.type = instrument.waveform;
  voice.filter.type = instrument.filter.type;
  voice.filter.frequency.setTargetAtTime(instrument.filter.frequency, now, 0.1);
  voice.filter.Q.setTargetAtTime(instrument.filter.Q, now, 0.1);
  if (instrument.filter.gain !== undefined) {
    voice.filter.gain.setTargetAtTime(instrument.filter.gain, now, 0.1);
  }
  voice.oscillator.detune.setTargetAtTime(instrument.detune ?? 0, now, 0.1);
  const vibratoDepth = instrument.vibrato?.depth ?? 0;
  const vibratoRate = instrument.vibrato?.rate ?? 0.01;
  voice.vibratoGain.gain.setTargetAtTime(vibratoDepth, now, 0.12);
  voice.vibratoOsc.frequency.setTargetAtTime(vibratoRate, now, 0.12);
};

const createVoice = (
  context: AudioContext,
  instrument: InstrumentDefinition,
  frequency: number,
  pan: number
): Voice => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  const vibratoOsc = context.createOscillator();
  const vibratoGain = context.createGain();

  gain.gain.value = 0;
  vibratoGain.gain.value = instrument.vibrato?.depth ?? 0;
  vibratoOsc.type = "sine";
  vibratoOsc.frequency.setValueAtTime(instrument.vibrato?.rate ?? 0.01, context.currentTime);

  oscillator.connect(filter);
  vibratoOsc.connect(vibratoGain);
  vibratoGain.connect(oscillator.frequency);

  let panner: StereoPannerNode | undefined;
  if (context.createStereoPanner) {
    panner = context.createStereoPanner();
    filter.connect(panner);
    panner.connect(gain);
    panner.pan.setValueAtTime(pan, context.currentTime);
  } else {
    filter.connect(gain);
  }

  gain.connect(context.destination);

  const now = context.currentTime;
  morphVoiceToInstrument(
    {
      oscillator,
      gain,
      filter,
      panner,
      vibratoOsc,
      vibratoGain,
      instrument,
      currentCellIndex: -1,
    },
    instrument,
    now
  );
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.detune.setValueAtTime(instrument.detune ?? 0, now);

  oscillator.start(now);
  vibratoOsc.start(now);

  return {
    oscillator,
    gain,
    filter,
    panner,
    vibratoOsc,
    vibratoGain,
    instrument,
    currentCellIndex: -1,
  };
};

const updateVoiceForMix = (
  voice: Voice,
  frequency: number,
  gainValue: number,
  pan: number,
  now: number
) => {
  voice.oscillator.frequency.cancelScheduledValues(now);
  voice.oscillator.frequency.linearRampToValueAtTime(
    frequency,
    now + 0.08
  );
  voice.gain.gain.setTargetAtTime(gainValue, now, 0.08);
  if (voice.panner) {
    voice.panner.pan.setTargetAtTime(pan, now, 0.08);
  }
};

const playTapSound = (
  context: AudioContext,
  cell: GridCell,
  x: number,
  y: number,
  rainbowField?: RainbowField | null
) => {
  const now = context.currentTime;
  const tap = cell.instrument.tap;
  const oscillator = context.createOscillator();
  oscillator.type = tap.waveform;
  const baseFrequency =
    cell.frequency * Math.pow(2, tap.octaveOffset) + (tap.detune ?? 0);
  oscillator.frequency.setValueAtTime(baseFrequency, now);

  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, now);

  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(tap.filterFrequency, now);
  filter.Q.setValueAtTime(tap.filterQ, now);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);

  gain.gain.exponentialRampToValueAtTime(tap.gain, now + tap.attack);
  gain.gain.linearRampToValueAtTime(
    tap.gain * tap.sustain,
    now + tap.attack + tap.decay
  );
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    now + tap.attack + tap.decay + tap.release
  );

  const stopTime = now + tap.attack + tap.decay + tap.release + 0.3;
  oscillator.start(now);
  oscillator.stop(stopTime);
  oscillator.onended = () => {
    try {
      oscillator.disconnect();
      filter.disconnect();
      gain.disconnect();
    } catch (error) {
      console.warn("Tap oscillator cleanup failed", error);
    }
  };

  rainbowField?.pulse(
    x,
    y,
    cell.frequency,
    cell.color,
    1100
  );
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
      const releaseTime = Math.max(0.12, voice.instrument.release);
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), now);
      voice.gain.gain.linearRampToValueAtTime(0.0001, now + releaseTime);

      try {
        voice.oscillator.stop(now + releaseTime + 0.05);
        voice.vibratoOsc.stop(now + releaseTime + 0.05);
      } catch (error) {
        console.warn("Oscillator stop failed", error);
      }

      const timeoutId = window.setTimeout(() => {
        try {
          voice.oscillator.disconnect();
          voice.vibratoOsc.disconnect();
          voice.filter.disconnect();
          voice.panner?.disconnect();
          voice.gain.disconnect();
        } catch (error) {
          console.warn("Voice disconnect failed", error);
        }
        releaseTimersRef.current.delete(id);
      }, (releaseTime + 0.25) * 1000);

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

      activePointersRef.current.add(pointerId);
      event.currentTarget.setPointerCapture?.(pointerId);

      const mix = computeCellMix(x, y, rect.width, rect.height);

      pointerMetaRef.current.set(pointerId, {
        startX: x,
        startY: y,
        lastX: x,
        lastY: y,
        totalDistance: 0,
        startTime: performance.now(),
        currentCellIndex: mix.primaryCell.id,
        lastColor: mix.blendedColor,
        lastFrequency: mix.blendedFrequency,
      });

      updateTouchPoint({
        id: pointerId,
        x,
        y,
        color: pointerGlowColor(mix.blendedColor),
      });

      rainbowFieldRef.current?.setEmitter(
        pointerId,
        x,
        y,
        mix.blendedFrequency,
        emitterColor(mix.blendedColor)
      );

      let context: AudioContext;
      try {
        context = await ensureAudioContext();
      } catch (error) {
        console.error("Unable to create audio context", error);
        activePointersRef.current.delete(pointerId);
        pointerMetaRef.current.delete(pointerId);
        removeTouchPoint(pointerId);
        rainbowFieldRef.current?.releaseEmitter(pointerId);
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

      const pan = getPanForPosition(x, rect.width);
      const voice = createVoice(
        context,
        mix.primaryCell.instrument,
        mix.blendedFrequency,
        pan
      );
      voice.currentCellIndex = mix.primaryCell.id;

      const now = context.currentTime;
      const gainValue = computeTargetGain(
        y,
        rect.height,
        mix.primaryCell.instrument
      );
      voice.gain.gain.setValueAtTime(0, now);
      voice.gain.gain.linearRampToValueAtTime(
        gainValue,
        now + Math.max(0.04, mix.primaryCell.instrument.attack)
      );

      voicesRef.current.set(pointerId, voice);

    },
    [ensureAudioContext, removeTouchPoint, updateTouchPoint]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      const meta = pointerMetaRef.current.get(event.pointerId);
      if (!container || !meta) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const dx = x - meta.lastX;
      const dy = y - meta.lastY;
      meta.lastX = x;
      meta.lastY = y;
      meta.totalDistance += Math.hypot(dx, dy);

      const mix = computeCellMix(x, y, rect.width, rect.height);

      meta.currentCellIndex = mix.primaryCell.id;
      meta.lastColor = mix.blendedColor;
      meta.lastFrequency = mix.blendedFrequency;

      updateTouchPoint({
        id: event.pointerId,
        x,
        y,
        color: pointerGlowColor(mix.blendedColor),
      });

      rainbowFieldRef.current?.setEmitter(
        event.pointerId,
        x,
        y,
        mix.blendedFrequency,
        emitterColor(mix.blendedColor)
      );

      const voice = voicesRef.current.get(event.pointerId);
      const context = audioContextRef.current;
      if (!voice || !context) {
        return;
      }

      const now = context.currentTime;

      if (voice.currentCellIndex !== mix.primaryCell.id) {
        morphVoiceToInstrument(voice, mix.primaryCell.instrument, now);
        voice.currentCellIndex = mix.primaryCell.id;
      }

      const gainValue = computeTargetGain(y, rect.height, voice.instrument);
      const pan = getPanForPosition(x, rect.width);
      updateVoiceForMix(voice, mix.blendedFrequency, gainValue, pan, now);
    },
    [updateTouchPoint]
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
      if (!container || !context || !meta) {
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
        const cell = GRID_CELLS.find((c) => c.id === meta.currentCellIndex) ?? GRID_CELLS[0];
        playTapSound(
          context,
          cell,
          x,
          y,
          rainbowFieldRef.current
        );
      }

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
          voice.vibratoOsc.stop();
          voice.oscillator.disconnect();
          voice.vibratoOsc.disconnect();
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
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        backgroundColor: "#06070c",
        fontFamily:
          "'Inter', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "none",
      }}
    >
      <div
        style={{
          position: "relative",
          flex: 1,
      }}
      >
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 4,
            overflow: "hidden",
            backgroundColor: "#06070c",
            touchAction: "none",
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
            }}
          />

          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)`,
              gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
              gap: 4,
              padding: 4,
              pointerEvents: "none",
            }}
          >
            {GRID_CELLS.map((cell) => (
              <div
                key={cell.id}
                style={{
                  borderRadius: 4,
                  backgroundColor: rgbToCss(cell.color),
                }}
              >
              </div>
            ))}
          </div>

          {touchPointArray.map((point) => (
            <div
              key={point.id}
              style={{
                position: "absolute",
                width: 72,
                height: 72,
                borderRadius: 4,
                pointerEvents: "none",
                left: point.x - 36,
                top: point.y - 36,
                backgroundColor: rgbToCss(point.color),
                opacity: 0.9,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
