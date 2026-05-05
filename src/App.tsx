import React, { useCallback, useEffect, useRef, useState } from "react";
import { RainbowField } from "./effects/RainbowField";
import { clamp } from "./utils/math";
import { hexToRgb, mixRgb, rgbToCss, RGBColor } from "./utils/color";
import { SlideMenu, SlideMenuPage } from "./components/SlideMenu";
import { PatchSequencer } from "./components/PatchSequencer";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
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
  reverbSend: GainNode;
}

interface PointerMeta {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  totalDistance: number;
  startTime: number;
  currentCellIndex: number;
  lastTileColor: RGBColor;
  lastFrequency: number;
}

const GRID_ROWS = 5;
const GRID_COLUMNS = 5;

// A-major pentatonic roots (A2–A4) – any row×column combination is consonant
const ROW_BASES = [440, 329.628, 220, 164.814, 110];
// Just-intonation ratios of the pentatonic scale: unison, M2 (9/8), M3 (5/4), P5 (3/2), M6 (5/3)
const COLUMN_RATIOS = [1, 1.125, 1.25, 1.5, 5 / 3];

const makeInstrument = (config: InstrumentDefinition): InstrumentDefinition => config;

const GRID_SPEC: Array<
  Array<{ hex: string; label: string; instrument: InstrumentDefinition }>
> = [
  // Row 0 – highest register (A4 range)
  [
    {
      hex: "#ff2f92",
      label: "Mist",
      instrument: makeInstrument({
        id: "mist-0",
        waveform: "sine",
        detune: 5,
        attack: 0.14,
        sustain: 0.62,
        release: 2.8,
        filter: { type: "lowpass", frequency: 820, Q: 0.7 },
        vibrato: { rate: 0.28, depth: 3 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 5, attack: 0.10, decay: 0.5, sustain: 0.4, release: 2.0, gain: 0.18, filterFrequency: 580, filterQ: 0.7 },
      }),
    },
    {
      hex: "#ff6b4a",
      label: "Haze",
      instrument: makeInstrument({
        id: "haze-1",
        waveform: "triangle",
        detune: -6,
        attack: 0.16,
        sustain: 0.60,
        release: 3.0,
        filter: { type: "lowpass", frequency: 760, Q: 0.65 },
        vibrato: { rate: 0.32, depth: 2.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -6, attack: 0.10, decay: 0.5, sustain: 0.38, release: 2.2, gain: 0.17, filterFrequency: 540, filterQ: 0.65 },
      }),
    },
    {
      hex: "#ffd23f",
      label: "Veil",
      instrument: makeInstrument({
        id: "veil-2",
        waveform: "sine",
        detune: 8,
        attack: 0.12,
        sustain: 0.64,
        release: 2.6,
        filter: { type: "lowpass", frequency: 880, Q: 0.6 },
        vibrato: { rate: 0.25, depth: 3.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 8, attack: 0.09, decay: 0.45, sustain: 0.42, release: 1.8, gain: 0.19, filterFrequency: 620, filterQ: 0.6 },
      }),
    },
    {
      hex: "#7dff5c",
      label: "Dew",
      instrument: makeInstrument({
        id: "dew-3",
        waveform: "triangle",
        detune: -4,
        attack: 0.18,
        sustain: 0.58,
        release: 3.2,
        filter: { type: "lowpass", frequency: 700, Q: 0.75 },
        vibrato: { rate: 0.35, depth: 2 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -4, attack: 0.11, decay: 0.55, sustain: 0.36, release: 2.4, gain: 0.16, filterFrequency: 500, filterQ: 0.7 },
      }),
    },
    {
      hex: "#32ffe0",
      label: "Ether",
      instrument: makeInstrument({
        id: "ether-4",
        waveform: "sine",
        detune: 3,
        attack: 0.20,
        sustain: 0.60,
        release: 3.5,
        filter: { type: "lowpass", frequency: 740, Q: 0.65 },
        vibrato: { rate: 0.22, depth: 4 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 3, attack: 0.12, decay: 0.6, sustain: 0.34, release: 2.6, gain: 0.15, filterFrequency: 520, filterQ: 0.65 },
      }),
    },
  ],
  // Row 1 – upper-middle register (E4 range)
  [
    {
      hex: "#b967ff",
      label: "Drift",
      instrument: makeInstrument({
        id: "drift-5",
        waveform: "triangle",
        detune: -5,
        attack: 0.15,
        sustain: 0.60,
        release: 2.8,
        filter: { type: "lowpass", frequency: 780, Q: 0.7 },
        vibrato: { rate: 0.30, depth: 3 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -5, attack: 0.10, decay: 0.5, sustain: 0.38, release: 2.0, gain: 0.18, filterFrequency: 560, filterQ: 0.7 },
      }),
    },
    {
      hex: "#ff5dac",
      label: "Float",
      instrument: makeInstrument({
        id: "float-6",
        waveform: "sine",
        detune: 7,
        attack: 0.13,
        sustain: 0.62,
        release: 2.6,
        filter: { type: "lowpass", frequency: 840, Q: 0.65 },
        vibrato: { rate: 0.26, depth: 2.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 7, attack: 0.09, decay: 0.48, sustain: 0.40, release: 1.9, gain: 0.19, filterFrequency: 600, filterQ: 0.65 },
      }),
    },
    {
      hex: "#ff9f1c",
      label: "Hover",
      instrument: makeInstrument({
        id: "hover-7",
        waveform: "triangle",
        detune: -3,
        attack: 0.17,
        sustain: 0.58,
        release: 3.0,
        filter: { type: "lowpass", frequency: 720, Q: 0.72 },
        vibrato: { rate: 0.38, depth: 2 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -3, attack: 0.10, decay: 0.52, sustain: 0.36, release: 2.2, gain: 0.17, filterFrequency: 510, filterQ: 0.68 },
      }),
    },
    {
      hex: "#5dffb5",
      label: "Glide",
      instrument: makeInstrument({
        id: "glide-8",
        waveform: "sine",
        detune: 4,
        attack: 0.16,
        sustain: 0.64,
        release: 2.8,
        filter: { type: "lowpass", frequency: 800, Q: 0.68 },
        vibrato: { rate: 0.33, depth: 3.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 4, attack: 0.11, decay: 0.5, sustain: 0.38, release: 2.1, gain: 0.18, filterFrequency: 570, filterQ: 0.65 },
      }),
    },
    {
      hex: "#34d2ff",
      label: "Flow",
      instrument: makeInstrument({
        id: "flow-9",
        waveform: "triangle",
        detune: -7,
        attack: 0.19,
        sustain: 0.60,
        release: 3.2,
        filter: { type: "lowpass", frequency: 680, Q: 0.65 },
        vibrato: { rate: 0.28, depth: 2.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -7, attack: 0.12, decay: 0.55, sustain: 0.35, release: 2.3, gain: 0.16, filterFrequency: 480, filterQ: 0.62 },
      }),
    },
  ],
  // Row 2 – middle register (A3 range)
  [
    {
      hex: "#ff3b30",
      label: "Ripple",
      instrument: makeInstrument({
        id: "ripple-10",
        waveform: "sine",
        detune: 6,
        attack: 0.14,
        sustain: 0.62,
        release: 2.8,
        filter: { type: "lowpass", frequency: 740, Q: 0.7 },
        vibrato: { rate: 0.27, depth: 3.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 6, attack: 0.10, decay: 0.5, sustain: 0.38, release: 2.0, gain: 0.18, filterFrequency: 530, filterQ: 0.7 },
      }),
    },
    {
      hex: "#ff6f61",
      label: "Wave",
      instrument: makeInstrument({
        id: "wave-11",
        waveform: "triangle",
        detune: -5,
        attack: 0.16,
        sustain: 0.60,
        release: 3.0,
        filter: { type: "lowpass", frequency: 700, Q: 0.68 },
        vibrato: { rate: 0.32, depth: 2.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -5, attack: 0.10, decay: 0.5, sustain: 0.36, release: 2.2, gain: 0.17, filterFrequency: 500, filterQ: 0.68 },
      }),
    },
    {
      hex: "#ffcf70",
      label: "Surge",
      instrument: makeInstrument({
        id: "surge-12",
        waveform: "sine",
        detune: 2,
        attack: 0.18,
        sustain: 0.64,
        release: 2.6,
        filter: { type: "lowpass", frequency: 780, Q: 0.65 },
        vibrato: { rate: 0.24, depth: 3 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 2, attack: 0.09, decay: 0.48, sustain: 0.40, release: 1.8, gain: 0.19, filterFrequency: 560, filterQ: 0.65 },
      }),
    },
    {
      hex: "#4ad0ff",
      label: "Swell",
      instrument: makeInstrument({
        id: "swell-13",
        waveform: "triangle",
        detune: -8,
        attack: 0.20,
        sustain: 0.62,
        release: 3.2,
        filter: { type: "lowpass", frequency: 660, Q: 0.70 },
        vibrato: { rate: 0.36, depth: 2 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -8, attack: 0.11, decay: 0.55, sustain: 0.36, release: 2.4, gain: 0.16, filterFrequency: 470, filterQ: 0.65 },
      }),
    },
    {
      hex: "#2b6bff",
      label: "Pool",
      instrument: makeInstrument({
        id: "pool-14",
        waveform: "sine",
        detune: 5,
        attack: 0.15,
        sustain: 0.60,
        release: 2.8,
        filter: { type: "lowpass", frequency: 720, Q: 0.67 },
        vibrato: { rate: 0.30, depth: 3.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 5, attack: 0.10, decay: 0.5, sustain: 0.38, release: 2.0, gain: 0.18, filterFrequency: 510, filterQ: 0.67 },
      }),
    },
  ],
  // Row 3 – lower-middle register (E3 range)
  [
    {
      hex: "#5a3bff",
      label: "Earth",
      instrument: makeInstrument({
        id: "earth-15",
        waveform: "triangle",
        detune: -3,
        attack: 0.18,
        sustain: 0.62,
        release: 3.2,
        filter: { type: "lowpass", frequency: 640, Q: 0.72 },
        vibrato: { rate: 0.25, depth: 3 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -3, attack: 0.11, decay: 0.55, sustain: 0.36, release: 2.2, gain: 0.17, filterFrequency: 460, filterQ: 0.70 },
      }),
    },
    {
      hex: "#8a46ff",
      label: "Stone",
      instrument: makeInstrument({
        id: "stone-16",
        waveform: "sine",
        detune: 7,
        attack: 0.16,
        sustain: 0.60,
        release: 2.8,
        filter: { type: "lowpass", frequency: 680, Q: 0.68 },
        vibrato: { rate: 0.32, depth: 2.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 7, attack: 0.10, decay: 0.5, sustain: 0.38, release: 2.0, gain: 0.18, filterFrequency: 490, filterQ: 0.68 },
      }),
    },
    {
      hex: "#ff61f7",
      label: "Grove",
      instrument: makeInstrument({
        id: "grove-17",
        waveform: "triangle",
        detune: -6,
        attack: 0.20,
        sustain: 0.64,
        release: 3.5,
        filter: { type: "lowpass", frequency: 600, Q: 0.65 },
        vibrato: { rate: 0.28, depth: 4 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -6, attack: 0.12, decay: 0.6, sustain: 0.34, release: 2.6, gain: 0.15, filterFrequency: 430, filterQ: 0.65 },
      }),
    },
    {
      hex: "#ff4b8c",
      label: "Moss",
      instrument: makeInstrument({
        id: "moss-18",
        waveform: "sine",
        detune: 4,
        attack: 0.17,
        sustain: 0.62,
        release: 3.0,
        filter: { type: "lowpass", frequency: 660, Q: 0.70 },
        vibrato: { rate: 0.35, depth: 2.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 4, attack: 0.11, decay: 0.52, sustain: 0.36, release: 2.2, gain: 0.17, filterFrequency: 470, filterQ: 0.68 },
      }),
    },
    {
      hex: "#ffa24c",
      label: "Fern",
      instrument: makeInstrument({
        id: "fern-19",
        waveform: "triangle",
        detune: -2,
        attack: 0.19,
        sustain: 0.60,
        release: 3.2,
        filter: { type: "lowpass", frequency: 620, Q: 0.67 },
        vibrato: { rate: 0.30, depth: 3 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -2, attack: 0.12, decay: 0.58, sustain: 0.35, release: 2.4, gain: 0.16, filterFrequency: 450, filterQ: 0.66 },
      }),
    },
  ],
  // Row 4 – lowest register (A2 range)
  [
    {
      hex: "#1f77ff",
      label: "Deep",
      instrument: makeInstrument({
        id: "deep-20",
        waveform: "sine",
        detune: -4,
        attack: 0.22,
        sustain: 0.64,
        release: 3.8,
        filter: { type: "lowpass", frequency: 580, Q: 0.70 },
        vibrato: { rate: 0.22, depth: 4 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -4, attack: 0.13, decay: 0.65, sustain: 0.34, release: 2.8, gain: 0.15, filterFrequency: 420, filterQ: 0.68 },
      }),
    },
    {
      hex: "#15c6ff",
      label: "Cave",
      instrument: makeInstrument({
        id: "cave-21",
        waveform: "triangle",
        detune: 6,
        attack: 0.20,
        sustain: 0.62,
        release: 3.5,
        filter: { type: "lowpass", frequency: 560, Q: 0.68 },
        vibrato: { rate: 0.25, depth: 3.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 6, attack: 0.12, decay: 0.62, sustain: 0.32, release: 2.6, gain: 0.16, filterFrequency: 400, filterQ: 0.65 },
      }),
    },
    {
      hex: "#2dff88",
      label: "Abyss",
      instrument: makeInstrument({
        id: "abyss-22",
        waveform: "sine",
        detune: -8,
        attack: 0.24,
        sustain: 0.66,
        release: 4.0,
        filter: { type: "lowpass", frequency: 540, Q: 0.65 },
        vibrato: { rate: 0.20, depth: 4.5 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -8, attack: 0.14, decay: 0.7, sustain: 0.30, release: 3.0, gain: 0.14, filterFrequency: 380, filterQ: 0.62 },
      }),
    },
    {
      hex: "#aaff2c",
      label: "Well",
      instrument: makeInstrument({
        id: "well-23",
        waveform: "triangle",
        detune: 3,
        attack: 0.22,
        sustain: 0.64,
        release: 3.6,
        filter: { type: "lowpass", frequency: 560, Q: 0.70 },
        vibrato: { rate: 0.28, depth: 3 },
        tap: { waveform: "sine", octaveOffset: 0, detune: 3, attack: 0.13, decay: 0.65, sustain: 0.32, release: 2.7, gain: 0.15, filterFrequency: 400, filterQ: 0.67 },
      }),
    },
    {
      hex: "#ffd1ff",
      label: "Void",
      instrument: makeInstrument({
        id: "void-24",
        waveform: "sine",
        detune: -5,
        attack: 0.25,
        sustain: 0.62,
        release: 4.0,
        filter: { type: "lowpass", frequency: 520, Q: 0.65 },
        vibrato: { rate: 0.20, depth: 4 },
        tap: { waveform: "sine", octaveOffset: 0, detune: -5, attack: 0.15, decay: 0.7, sustain: 0.30, release: 3.0, gain: 0.14, filterFrequency: 370, filterQ: 0.62 },
      }),
    },
  ],
];

const GRID_CELLS: GridCell[] = (() => {
  const cells: GridCell[] = [];
  let id = 0;
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLUMNS; col += 1) {
      const spec = GRID_SPEC[row][col];
      const frequency = ROW_BASES[row] * COLUMN_RATIOS[col];
      cells.push({
        id,
        label: spec.label,
        hex: spec.hex,
        color: hexToRgb(spec.hex),
        frequency,
        instrument: spec.instrument,
      });
      id += 1;
    }
  }
  return cells;
})();

const getCell = (row: number, col: number) =>
  GRID_CELLS[row * GRID_COLUMNS + col] ?? GRID_CELLS[0];

const emitterColor = (color: RGBColor) => color;

const getPanForPosition = (x: number, width: number) => {
  if (width <= 0) {
    return 0;
  }
  return clamp((x / width) * 2 - 1, -0.85, 0.85);
};

const createReverbBuffer = (context: AudioContext): AudioBuffer => {
  const duration = 4;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  const decay = 2.5;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) {
      // Exponential amplitude decay: exponent controls how steeply the tail falls off
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
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
  pan: number,
  outputNode: AudioNode,
  reverbNode: ConvolverNode | null
): Voice => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  const vibratoOsc = context.createOscillator();
  const vibratoGain = context.createGain();
  const reverbSend = context.createGain();
  reverbSend.gain.value = 0.5;

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

  gain.connect(outputNode);
  gain.connect(reverbSend);
  if (reverbNode) {
    reverbSend.connect(reverbNode);
  }

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
      reverbSend,
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
    reverbSend,
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
  outputNode: AudioNode,
  reverbNode: ConvolverNode | null,
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
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(tap.filterFrequency, now);
  filter.Q.setValueAtTime(tap.filterQ, now);

  const reverbSend = context.createGain();
  reverbSend.gain.value = 0.5;

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(outputNode);
  gain.connect(reverbSend);
  if (reverbNode) {
    reverbSend.connect(reverbNode);
  }

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
      reverbSend.disconnect();
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
    200
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
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const reverbRef = useRef<ConvolverNode | null>(null);
  const [activePage, setActivePage] = useState<SlideMenuPage>("play");

  const ensureAudioContext = useCallback(async () => {
    let context = audioContextRef.current;
    if (!context) {
      const Constructor = window.AudioContext ?? window.webkitAudioContext;
      if (!Constructor) {
        throw new Error("Web Audio API is not available in this browser");
      }
      context = new Constructor();
      audioContextRef.current = context;

      // Shared output compressor – prevents clipping with many simultaneous voices
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 30;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.05;
      compressor.release.value = 0.4;
      compressor.connect(context.destination);
      compressorRef.current = compressor;

      // Long diffuse reverb from a synthesised impulse response
      const reverb = context.createConvolver();
      reverb.buffer = createReverbBuffer(context);
      const reverbOutput = context.createGain();
      reverbOutput.gain.value = 0.35;
      reverb.connect(reverbOutput);
      reverbOutput.connect(compressor);
      reverbRef.current = reverb;
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
          voice.reverbSend.disconnect();
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
        lastTileColor: mix.primaryCell.color,
        lastFrequency: mix.blendedFrequency,
      });

      rainbowFieldRef.current?.setEmitter(
        pointerId,
        x,
        y,
        mix.blendedFrequency,
        emitterColor(mix.primaryCell.color)
      );

      let context: AudioContext;
      try {
        context = await ensureAudioContext();
      } catch (error) {
        console.error("Unable to create audio context", error);
        activePointersRef.current.delete(pointerId);
        pointerMetaRef.current.delete(pointerId);
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
        pan,
        compressorRef.current ?? context.destination,
        reverbRef.current
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
    [ensureAudioContext]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

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
      meta.lastTileColor = mix.primaryCell.color;
      meta.lastFrequency = mix.blendedFrequency;

      rainbowFieldRef.current?.setEmitter(
        event.pointerId,
        x,
        y,
        mix.blendedFrequency,
        emitterColor(mix.primaryCell.color)
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
    []
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      activePointersRef.current.delete(event.pointerId);
      stopVoice(event.pointerId);
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
          compressorRef.current ?? context.destination,
          reverbRef.current,
          rainbowFieldRef.current
        );
      }

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [stopVoice]
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      activePointersRef.current.delete(event.pointerId);
      stopVoice(event.pointerId);
      pointerMetaRef.current.delete(event.pointerId);
      rainbowFieldRef.current?.releaseEmitter(event.pointerId);

      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [stopVoice]
  );

  useEffect(() => {
    if (activePage !== "patch") {
      return;
    }

    activePointersRef.current.forEach((pointerId) => {
      stopVoice(pointerId);
      rainbowFieldRef.current?.releaseEmitter(pointerId);
    });
    activePointersRef.current.clear();
    pointerMetaRef.current.clear();
  }, [activePage, stopVoice]);

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
          voice.reverbSend.disconnect();
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
        minHeight: "100vh",
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
            transition: "opacity 0.3s ease",
            opacity: activePage === "play" ? 1 : 0,
            pointerEvents: activePage === "play" ? "auto" : "none",
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
              zIndex: 2,
            }}
          />

          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)`,
              gridTemplateRows: `repeat(${GRID_ROWS}, 1fr)`,
              gap: 0,
              padding: "calc(env(safe-area-inset-top, 0px) + 4px) 4px calc(env(safe-area-inset-bottom, 0px) + 4px)",
              boxSizing: "border-box",
              pointerEvents: "none",
              zIndex: 1,
            }}
          >
            {GRID_CELLS.map((cell) => (
              <div
                key={cell.id}
                style={{
                  padding: 2,
                }}
              >
                <div
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 4,
                    backgroundColor: rgbToCss(cell.color),
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        {activePage === "patch" && (
          <PatchSequencer
            ensureAudioContext={ensureAudioContext}
            audioContextRef={audioContextRef}
          />
        )}
      </div>
      <SlideMenu currentPage={activePage} onNavigate={setActivePage} />
    </div>
  );
}
