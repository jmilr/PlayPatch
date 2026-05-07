import React, { useCallback, useEffect, useRef } from "react";
import { hexToRgb } from "../utils/color";
import type { RainbowField } from "../effects/RainbowField";

// ── Timing ────────────────────────────────────────────────────────────────────
const BPM = 120;
const STEPS_PER_BEAT = 2; // 8th-note grid → one step = 0.25 s at 120 BPM
const STEP_SECONDS = 60 / BPM / STEPS_PER_BEAT;
const SWING_LATE = 0.035; // fraction of a step that odd steps are delayed

// ── Physics ───────────────────────────────────────────────────────────────────
const SPRING_K = 0.16;
const SPRING_DAMPING = 0.78;
const BASE_AGENT_RADIUS = 40;
const MIN_AGENT_RADIUS = 18;
const MAX_AGENT_RADIUS = 46;
const MIN_LAYOUT_ASPECT = 0.45;
const CELL_WIDTH_RADIUS_FACTOR = 0.35;
const CELL_HEIGHT_LABEL_PADDING = 20;
const CELL_HEIGHT_RADIUS_FACTOR = 0.5;
const HIT_TEST_PADDING = 12;
const LABEL_FONT_SIZE_FACTOR = 0.28;
const DRAG_ENERGY_SCALE = 160; // px of displacement for energy = 1.0
const DRAG_THRESHOLD = 12;     // px of movement before a press counts as a drag

// ── Energy ────────────────────────────────────────────────────────────────────
const ENERGY_THRESHOLD = 0.14;
const HOLD_INTENSITY_PER_SECOND = 0.42;
const MAX_TRIGGERS_PER_STEP_BASE = 4;
const TAP_INTENSITY_BOOST = 0.44;
const RELEASE_LIFETIME_MIN_SECONDS = 6.0;
const RELEASE_LIFETIME_MAX_SECONDS = 10.0;
const RELEASE_COMMIT_MIN_SECONDS = 0.5;
const RELEASE_COMMIT_MAX_SECONDS = 1.5;
const RELEASE_DECAY_CURVE = 1.35;

// ── Interaction influence ─────────────────────────────────────────────────────
const HOLD_PHASE_RATE = 0.30;         // phase steps shifted per second while holding
const HOLD_SUBDIVIDE_THRESHOLD = 0.48;
const HOLD_SUBDIVIDE_ODD_THRESHOLD = 0.74;
const HOLD_SUBDIVIDE_ODD_CHANCE = 0.33;

// ── Inter-agent influence ─────────────────────────────────────────────────────
const INTER_AGENT_NUDGE = 0.026;

// ── Ghost / echo notes ────────────────────────────────────────────────────────
const GHOST_ENERGY_THRESHOLD = 0.66;
const GHOST_CHANCE = 0.08;
const GHOST_GAIN = 0.22;
const GHOST_CROWDED_AGENT_THRESHOLD = 6;
const GHOST_CROWDED_MULTIPLIER = 0.55;

// ── Mix management ─────────────────────────────────────────────────────────────
const CROWD_SOFT_START = 4;
const CROWD_SOFT_PER_AGENT = 0.065;
const CROWD_SOFT_MAX_REDUCTION = 0.46;
const HIT_INTENSITY_BASE = 0.34;
const HIT_INTENSITY_SCALE = 0.78;

// ── Memory ───────────────────────────────────────────────────────────────────
const MEMORY_TC   = 40;   // leaky-average time constant in steps
const MEMORY_BIAS = 0.06; // max effective-energy lift from memory

// ── Drift ─────────────────────────────────────────────────────────────────────
const DRIFT_STEPS_MIN = 40;
const DRIFT_STEPS_MAX = 96;
const DRIFT_LENGTH_RANGE: [number, number] = [4, 13];

// ── Types ─────────────────────────────────────────────────────────────────────
type PlayFn = (
  ctx: AudioContext,
  when: number,
  output: AudioNode,
  reverb: ConvolverNode | null
) => void;

function createNoiseBuffer(ctx: AudioContext, durationSeconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSeconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

const noiseBufferCache = new WeakMap<AudioContext, AudioBuffer>();

function getPercussionNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const cached = noiseBufferCache.get(ctx);
  if (cached) return cached;
  const created = createNoiseBuffer(ctx, 0.6);
  noiseBufferCache.set(ctx, created);
  return created;
}

interface AgentDef {
  readonly id: number;
  readonly label: string;
  readonly emoji: string;
  readonly color: string;
  readonly layerPriority: 0 | 1 | 2; // lower = more structurally important in dense mixes
  readonly patternLength: number; // number of steps per cycle
  readonly phaseOffset: number;   // step offset to stagger entry
  readonly playFn: PlayFn;
}

interface AgentState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  restX: number;
  restY: number;
  energy: number;
  dragging: boolean;
  pointerId: number | null;
  holdStart: number | null; // performance.now() when hold began
  pulseUntil: number;       // performance.now() until visual pulse shows
  scheduledTap: boolean;    // pending quantised tap on next step
  lastStep: number;         // last clock step this agent triggered on
  // Mutable pattern state (mutated by taps, hold, and drift)
  dynamicLength: number;    // current pattern cycle length (may differ from AgentDef)
  dynamicPhase: number;     // current phase offset in steps
  holdPhaseAccum: number;   // fractional phase steps accumulated while held
  // Inter-agent coupling
  pendingInfluence: number; // energy nudge queued from ring-neighbour fires
  // Memory / drift
  memoryAvg: number;        // leaky-average fire density (0..1)
  driftTimer: number;       // steps until next spontaneous evolution event
  releaseAgeSteps: number;      // elapsed steps since release envelope started
  releaseCommitSteps: number;   // fixed-intensity window after release
  releaseDecaySteps: number;    // fade duration after commit
  releaseStartIntensity: number;// initial intensity of current release envelope
}

export interface GrooveSystemProps {
  ensureAudioContext: () => Promise<AudioContext>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
  compressorRef: React.MutableRefObject<DynamicsCompressorNode | null>;
  reverbRef: React.MutableRefObject<ConvolverNode | null>;
  rainbowFieldRef: React.MutableRefObject<RainbowField | null>;
}

// ── Percussive tone factory ───────────────────────────────────────────────────
function makeTone(
  freq: number,
  waveform: OscillatorType,
  filterHz: number,
  attack: number,
  decay: number,
  peak: number
): PlayFn {
  return (ctx, when, output, reverb) => {
    const osc = ctx.createOscillator();
    osc.type = waveform;
    osc.frequency.setValueAtTime(freq, when);

    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(filterHz, when);
    filt.frequency.exponentialRampToValueAtTime(
      Math.max(filterHz * 0.25, 80),
      when + attack + decay
    );

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);

    const send = ctx.createGain();
    send.gain.value = 0.4;

    osc.connect(filt);
    filt.connect(gain);
    gain.connect(output);
    gain.connect(send);
    if (reverb) send.connect(reverb);

    const stopAt = when + attack + decay + 0.1;
    osc.start(when);
    osc.stop(stopAt);
    osc.onended = () => {
      try {
        osc.disconnect();
        filt.disconnect();
        gain.disconnect();
        send.disconnect();
      } catch { /* ignore */ }
    };
  };
}

function makeHandDrum(
  bodyFreq: number,
  bodyDecay: number,
  peak: number
): PlayFn {
  return (ctx, when, output, reverb) => {
    const mix = ctx.createGain();
    mix.gain.value = 1;
    mix.connect(output);

    const send = ctx.createGain();
    send.gain.value = 0.26;
    mix.connect(send);
    if (reverb) send.connect(reverb);

    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = "triangle";
    bodyOsc.frequency.setValueAtTime(bodyFreq, when);
    bodyOsc.frequency.exponentialRampToValueAtTime(Math.max(58, bodyFreq * 0.58), when + bodyDecay);
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = "lowpass";
    bodyFilter.frequency.setValueAtTime(1150, when);
    bodyFilter.frequency.exponentialRampToValueAtTime(360, when + bodyDecay);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, when);
    bodyGain.gain.linearRampToValueAtTime(peak * 0.68, when + 0.018);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + bodyDecay);

    bodyOsc.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(mix);

    const noise = ctx.createBufferSource();
    noise.buffer = getPercussionNoiseBuffer(ctx);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.setValueAtTime(bodyFreq * 5.2, when);
    noiseFilter.Q.value = 0.7;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, when);
    noiseGain.gain.linearRampToValueAtTime(peak * 0.26, when + 0.014);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + bodyDecay * 0.9);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(mix);

    const stopAt = when + bodyDecay + 0.1;
    bodyOsc.start(when);
    bodyOsc.stop(stopAt);
    noise.start(when);
    noise.stop(stopAt);

    bodyOsc.onended = () => {
      try {
        bodyOsc.disconnect();
        bodyFilter.disconnect();
        bodyGain.disconnect();
      } catch { /* ignore */ }
    };
    noise.onended = () => {
      try {
        noise.disconnect();
        noiseFilter.disconnect();
        noiseGain.disconnect();
        send.disconnect();
        mix.disconnect();
      } catch { /* ignore */ }
    };
  };
}

function makeWoodBlock(freq: number, peak: number): PlayFn {
  return (ctx, when, output, reverb) => {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.66, when + 0.16);

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.setValueAtTime(Math.max(300, freq * 2.6), when);
    band.Q.value = 1.4;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.linearRampToValueAtTime(peak, when + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);

    const send = ctx.createGain();
    send.gain.value = 0.22;
    if (reverb) send.connect(reverb);

    osc.connect(band);
    band.connect(amp);
    amp.connect(output);
    amp.connect(send);

    const stopAt = when + 0.34;
    osc.start(when);
    osc.stop(stopAt);
    osc.onended = () => {
      try {
        osc.disconnect();
        band.disconnect();
        amp.disconnect();
        send.disconnect();
      } catch { /* ignore */ }
    };
  };
}

function makeKalimba(freq: number): PlayFn {
  return (ctx, when, output, reverb) => {
    const fundamental = ctx.createOscillator();
    fundamental.type = "triangle";
    fundamental.frequency.setValueAtTime(freq, when);

    const tine = ctx.createOscillator();
    tine.type = "sine";
    tine.frequency.setValueAtTime(freq * 2.02, when);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1650, when);
    filter.frequency.exponentialRampToValueAtTime(540, when + 0.75);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.linearRampToValueAtTime(0.14, when + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.72);

    const tineMix = ctx.createGain();
    tineMix.gain.value = 0.22;
    const send = ctx.createGain();
    send.gain.value = 0.38;
    if (reverb) send.connect(reverb);

    fundamental.connect(filter);
    tine.connect(tineMix);
    tineMix.connect(filter);
    filter.connect(amp);
    amp.connect(output);
    amp.connect(send);

    const stopAt = when + 0.9;
    fundamental.start(when);
    tine.start(when);
    fundamental.stop(stopAt);
    tine.stop(stopAt);
    tine.onended = () => {
      try {
        fundamental.disconnect();
        tine.disconnect();
        filter.disconnect();
        tineMix.disconnect();
        amp.disconnect();
        send.disconnect();
      } catch { /* ignore */ }
    };
  };
}

function makeSoftShaker(centerHz: number, peak: number): PlayFn {
  return (ctx, when, output, reverb) => {
    const noise = ctx.createBufferSource();
    noise.buffer = getPercussionNoiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(centerHz, when);
    filter.Q.value = 0.65;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, when);
    amp.gain.linearRampToValueAtTime(peak, when + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.16);

    const send = ctx.createGain();
    send.gain.value = 0.18;
    if (reverb) send.connect(reverb);

    noise.connect(filter);
    filter.connect(amp);
    amp.connect(output);
    amp.connect(send);

    const stopAt = when + 0.28;
    noise.start(when);
    noise.stop(stopAt);
    noise.onended = () => {
      try {
        noise.disconnect();
        filter.disconnect();
        amp.disconnect();
        send.disconnect();
      } catch { /* ignore */ }
    };
  };
}

// ── Agent definitions ─────────────────────────────────────────────────────────
// Frequencies form an A-major pentatonic set (A2–A4) — all consonant together.
// Pattern lengths are co-prime enough to create evolving polyrhythm.
const AGENTS: AgentDef[] = [
  {
    id: 0,
    label: "Bloom",
    emoji: "🌸",
    color: "#ff5dac",
    layerPriority: 0,
    patternLength: 8,
    phaseOffset: 0,
    playFn: makeKalimba(220),
  },
  {
    id: 1,
    label: "Drift",
    emoji: "🌊",
    color: "#34d2ff",
    layerPriority: 1,
    patternLength: 6,
    phaseOffset: 2,
    playFn: makeWoodBlock(329.628, 0.15),
  },
  {
    id: 2,
    label: "Mist",
    emoji: "🌫️",
    color: "#b967ff",
    layerPriority: 1,
    patternLength: 8,
    phaseOffset: 1,
    playFn: makeSoftShaker(2200, 0.11),
  },
  {
    id: 3,
    label: "Earth",
    emoji: "🌿",
    color: "#4ade80",
    layerPriority: 0,
    patternLength: 12,
    phaseOffset: 4,
    playFn: makeHandDrum(164.814, 0.62, 0.18),
  },
  {
    id: 4,
    label: "Deep",
    emoji: "🌙",
    color: "#1f77ff",
    layerPriority: 0,
    patternLength: 4,
    phaseOffset: 0,
    playFn: makeHandDrum(110, 0.78, 0.2),
  },
  {
    id: 5,
    label: "Ember",
    emoji: "🔥",
    color: "#ff8a65",
    layerPriority: 1,
    patternLength: 10,
    phaseOffset: 3,
    playFn: makeKalimba(196),
  },
  {
    id: 6,
    label: "Glow",
    emoji: "🕯️",
    color: "#ffb74d",
    layerPriority: 2,
    patternLength: 7,
    phaseOffset: 1,
    playFn: makeWoodBlock(246.942, 0.13),
  },
  {
    id: 7,
    label: "Hush",
    emoji: "☁️",
    color: "#f4a261",
    layerPriority: 2,
    patternLength: 9,
    phaseOffset: 4,
    playFn: makeSoftShaker(1700, 0.1),
  },
  {
    id: 8,
    label: "Dusk",
    emoji: "🌆",
    color: "#c084fc",
    layerPriority: 1,
    patternLength: 11,
    phaseOffset: 5,
    playFn: makeKalimba(329.628),
  },
  {
    id: 9,
    label: "Amber",
    emoji: "🍯",
    color: "#f59e0b",
    layerPriority: 2,
    patternLength: 5,
    phaseOffset: 2,
    playFn: makeWoodBlock(220, 0.12),
  },
];

// ── Pattern density logic ─────────────────────────────────────────────────────
/**
 * Returns true if step `step` (within a cycle of `length`) should fire,
 * given the agent's current energy and memory bias. Higher energy unlocks
 * denser patterns; memoryAvg (0..1) adds a small upward nudge so recently
 * active agents stay slightly warmer.
 *
 *  eff ≥ 0.12  → downbeat only (step 0 always fires, guarded by caller)
 *  eff ≥ 0.22  → + half-note point (step at length/2)
 *  eff ≥ 0.38  → + quarter-note points (length/4, 3*length/4)
 *  eff ≥ 0.56  → + all even steps
 *  eff ≥ 0.72  → probabilistic odd-step syncopation
 *  eff ≥ 0.86  → occasional extra fills
 */
function shouldFire(step: number, length: number, energy: number, memoryAvg: number): boolean {
  const eff = Math.min(1, energy + memoryAvg * MEMORY_BIAS);
  if (step === 0) return true;
  // Half-note point
  if (eff >= 0.22 && step * 2 === length) return true;
  // Quarter-note points (integer only)
  if (eff >= 0.38 && (step * 4 === length || step * 4 === length * 3)) return true;
  // All even steps
  if (eff >= 0.56 && step % 2 === 0) return true;
  // Syncopation and fills taper away naturally as intensity drops.
  if (eff >= 0.72 && step % 2 === 1 && step < length - 1) {
    return Math.random() < (eff - 0.72) * 1.2;
  }
  if (eff >= 0.86 && step < length - 1) {
    return Math.random() < (eff - 0.86) * 0.85;
  }
  return false;
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function beginReleaseEnvelope(state: AgentState, intensity: number): void {
  const commitSteps = Math.max(
    1,
    Math.round(randRange(RELEASE_COMMIT_MIN_SECONDS, RELEASE_COMMIT_MAX_SECONDS) / STEP_SECONDS)
  );
  const decaySteps = Math.max(
    1,
    Math.round(randRange(RELEASE_LIFETIME_MIN_SECONDS, RELEASE_LIFETIME_MAX_SECONDS) / STEP_SECONDS)
  );
  state.energy = Math.min(1, intensity);
  state.releaseStartIntensity = state.energy;
  state.releaseCommitSteps = commitSteps;
  state.releaseDecaySteps = decaySteps;
  state.releaseAgeSteps = 0;
}

function releaseEnvelopeValue(state: AgentState): number {
  const commit = state.releaseCommitSteps;
  const decay = state.releaseDecaySteps;
  if (state.releaseAgeSteps <= commit) return state.releaseStartIntensity;
  const decayAge = state.releaseAgeSteps - commit;
  const t = Math.min(1, decayAge / Math.max(1, decay));
  return state.releaseStartIntensity * Math.pow(1 - t, RELEASE_DECAY_CURVE);
}

function triggerDynamicHit(
  agent: AgentDef,
  ctx: AudioContext,
  when: number,
  output: AudioNode,
  reverb: ConvolverNode | null,
  intensity: number,
  overlapIndex: number,
  activeAgentCount: number
): void {
  const level = ctx.createGain();
  const crowdSoft = 1 - Math.min(
    CROWD_SOFT_MAX_REDUCTION,
    Math.max(0, activeAgentCount - CROWD_SOFT_START) * CROWD_SOFT_PER_AGENT
  );
  const overlapSoft = 1 / Math.sqrt(1 + overlapIndex * 0.9);
  const intensitySoft = HIT_INTENSITY_BASE + intensity * HIT_INTENSITY_SCALE;
  level.gain.value = Math.max(0.08, crowdSoft * overlapSoft * intensitySoft);
  level.connect(output);
  agent.playFn(ctx, when, level, reverb);
  const cleanupMs = Math.max(0, (when - ctx.currentTime + 1.6) * 1000);
  setTimeout(() => { try { level.disconnect(); } catch { /* ignore */ } }, cleanupMs);
}

// ── Ghost / echo note helper ──────────────────────────────────────────────────
/**
 * Schedules a quieter secondary note half a step after `when`, routed
 * through an intermediate gain node so the main signal path is untouched.
 */
function scheduleGhost(
  agent: AgentDef,
  audioCtx: AudioContext,
  when: number,
  mainOutput: AudioNode,
  reverb: ConvolverNode | null
): void {
  const ghostGain = audioCtx.createGain();
  ghostGain.gain.value = GHOST_GAIN;
  ghostGain.connect(mainOutput);
  agent.playFn(audioCtx, when + STEP_SECONDS * 0.5, ghostGain, reverb);
  // Disconnect ghost node after the note has fully decayed (max ~1.5 s after scheduled time)
  const cleanupMs = Math.max(0, (when - audioCtx.currentTime + 1.5) * 1000);
  setTimeout(() => { try { ghostGain.disconnect(); } catch { /* ignore */ } }, cleanupMs);
}

// ── Component ─────────────────────────────────────────────────────────────────
export function GrooveSystem({
  ensureAudioContext,
  audioContextRef,
  compressorRef,
  reverbRef,
  rainbowFieldRef,
}: GrooveSystemProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const agentStateRef = useRef<AgentState[]>([]);
  const clockStartRef = useRef<number | null>(null); // AudioContext time when clock started
  const lastStepRef = useRef<number>(-1);
  const sizeRef = useRef({ w: 0, h: 0, radius: BASE_AGENT_RADIUS });
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null); // performance.now() of previous frame

  // ── Rest-position layout ────────────────────────────────────────────────────
  const computeRestLayout = useCallback((w: number, h: number) => {
    const count = AGENTS.length;
    const minPad = 14;
    const aspect = h > 0 ? w / h : 1;
    let cols = Math.max(2, Math.round(Math.sqrt(count * Math.max(MIN_LAYOUT_ASPECT, aspect))));
    cols = Math.min(count, cols);
    let rows = Math.ceil(count / cols);
    if (h >= w && cols > rows) {
      [cols, rows] = [rows, cols];
      rows = Math.ceil(count / cols);
    }
    if (w > h && rows > cols) {
      [cols, rows] = [rows, cols];
      rows = Math.ceil(count / cols);
    }

    const usableW = Math.max(1, w - minPad * 2);
    const usableH = Math.max(1, h - minPad * 2);
    const cellW = usableW / Math.max(1, cols);
    const cellH = usableH / Math.max(1, rows);
    const radius = Math.max(
      MIN_AGENT_RADIUS,
      Math.min(
        MAX_AGENT_RADIUS,
        BASE_AGENT_RADIUS,
        cellW * CELL_WIDTH_RADIUS_FACTOR,
        (cellH - CELL_HEIGHT_LABEL_PADDING) * CELL_HEIGHT_RADIUS_FACTOR
      )
    );

    const positions: Array<{ x: number; y: number }> = [];
    for (let row = 0; row < rows; row++) {
      const rowStart = row * cols;
      const rowCount = Math.max(0, Math.min(cols, count - rowStart));
      if (rowCount === 0) break;
      const offset = (cols - rowCount) * 0.5;
      for (let col = 0; col < rowCount; col++) {
        positions.push({
          x: minPad + (offset + col + 0.5) * cellW,
          y: minPad + (row + 0.5) * cellH,
        });
      }
    }

    return { positions, radius };
  }, []);

  // ── Hit test ────────────────────────────────────────────────────────────────
  const hitTest = useCallback((x: number, y: number): number => {
    const states = agentStateRef.current;
    const r = sizeRef.current.radius;
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (Math.hypot(x - s.x, y - s.y) <= r + HIT_TEST_PADDING) return i;
    }
    return -1;
  }, []);

  // ── Pointer handlers ────────────────────────────────────────────────────────
  const handlePointerDown = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      // Start audio and clock on first interaction
      try {
        await ensureAudioContext();
        const audioCtx = audioContextRef.current;
        if (audioCtx && clockStartRef.current === null) {
          clockStartRef.current = audioCtx.currentTime;
          lastStepRef.current = -1;
        }
      } catch (err) {
        console.warn("Audio context init failed", err);
        return;
      }

      const idx = hitTest(x, y);
      if (idx === -1) return;

      const s = agentStateRef.current[idx];
      s.dragging = false;
      s.pointerId = event.pointerId;
      s.holdStart = performance.now();
    },
    [ensureAudioContext, audioContextRef, hitTest]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const states = agentStateRef.current;
      const idx = states.findIndex((s) => s.pointerId === event.pointerId);
      if (idx === -1) return;

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const s = states[idx];
      const dx = x - s.restX;
      const dy = y - s.restY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        s.dragging = true;
        s.x = x;
        s.y = y;
        s.vx = 0;
        s.vy = 0;
        // Displacement directly sets energy
        s.energy = Math.min(1, Math.hypot(dx, dy) / DRAG_ENERGY_SCALE);
      }
    },
    []
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }

      const states = agentStateRef.current;
      const idx = states.findIndex((s) => s.pointerId === event.pointerId);
      if (idx === -1) return;

      const s = states[idx];
      const holdDuration =
        s.holdStart !== null ? performance.now() - s.holdStart : 0;
      const wasDragging = s.dragging;

      // Tap: short press with no significant drag → schedule quantised note + small mutation
      if (!wasDragging && holdDuration < 280) {
        s.scheduledTap = true;
        s.energy = Math.min(1, Math.max(s.energy, TAP_INTENSITY_BOOST));
        // Introduce a small random pattern mutation: length ±1, phase ±1, or both
        const rng = Math.random();
        if (rng < 0.35) {
          const delta = Math.random() < 0.5 ? 1 : -1;
          s.dynamicLength = Math.max(
            DRIFT_LENGTH_RANGE[0],
            Math.min(DRIFT_LENGTH_RANGE[1], s.dynamicLength + delta)
          );
        } else if (rng < 0.7) {
          s.dynamicPhase += Math.random() < 0.5 ? 1 : -1;
        } else if (rng < 0.9) {
          // This branch intentionally mutates both length and phase for stronger tap-driven evolution.
          s.dynamicLength = Math.max(
            DRIFT_LENGTH_RANGE[0],
            Math.min(DRIFT_LENGTH_RANGE[1], s.dynamicLength + (Math.random() < 0.5 ? 1 : -1))
          );
          s.dynamicPhase += Math.random() < 0.5 ? 1 : -1;
        }
        beginReleaseEnvelope(s, s.energy);
      }

      // Release drag: store displacement as energy and kick spring
      if (wasDragging) {
        const dist = Math.hypot(s.x - s.restX, s.y - s.restY);
        const releasedIntensity = Math.min(1, dist / DRAG_ENERGY_SCALE);
        s.energy = releasedIntensity;
        s.vx = (s.restX - s.x) * 0.05;
        s.vy = (s.restY - s.y) * 0.05;
        beginReleaseEnvelope(s, releasedIntensity);
      } else if (holdDuration >= 280) {
        beginReleaseEnvelope(s, Math.max(s.energy, ENERGY_THRESHOLD));
      }

      // Persist any phase shift accumulated during this hold gesture
      s.dynamicPhase += Math.round(s.holdPhaseAccum);
      s.holdPhaseAccum = 0;

      s.dragging = false;
      s.pointerId = null;
      s.holdStart = null;
    },
    []
  );

  // ── Main animation + clock loop ─────────────────────────────────────────────
  // Defined in a single useEffect with empty deps so the closure is stable.
  // All mutable state is accessed through refs so no stale data.
  useEffect(() => {
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);

      // Frame delta for frame-rate-independent accumulations
      const deltaSeconds = lastFrameTimeRef.current !== null
        ? Math.min((now - lastFrameTimeRef.current) / 1000, 0.1) // cap at 100 ms to handle tab-hidden spikes
        : 1 / 60;
      lastFrameTimeRef.current = now;

      const canvas = canvasRef.current;
      const canvasCtx = canvas?.getContext("2d");
      if (!canvas || !canvasCtx) return;

      const { w, h, radius: baseRadius } = sizeRef.current;
      const states = agentStateRef.current;
      const audioCtx = audioContextRef.current;

      // ── 1. Clock: process each new step ──────────────────────────────────
      if (audioCtx && clockStartRef.current !== null) {
        const elapsed = audioCtx.currentTime - clockStartRef.current;
        const currentStep = Math.floor(elapsed / STEP_SECONDS);

        if (currentStep > lastStepRef.current) {
          for (let step = lastStepRef.current + 1; step <= currentStep; step++) {
            let triggersThisStep = 0;
            const activeAgentCount = states.reduce(
              (count, s) => count + (s.energy >= ENERGY_THRESHOLD || s.scheduledTap ? 1 : 0),
              0
            );
            const stepTriggerCap = Math.max(
              2,
              MAX_TRIGGERS_PER_STEP_BASE - (activeAgentCount >= 8 ? 1 : 0)
            );

            // Track which agents fire this step (for inter-agent influence)
            const firedThisStep = new Array<boolean>(states.length).fill(false);

            // User-scheduled taps have priority
            for (let i = 0; i < states.length; i++) {
              const s = states[i];
              if (!s.scheduledTap) continue;
              if (triggersThisStep >= stepTriggerCap) continue;

              const swing = step % 2 === 1 ? SWING_LATE * STEP_SECONDS : 0;
              const when = clockStartRef.current! + step * STEP_SECONDS + swing;
              const agent = AGENTS[i];
              const output = compressorRef.current ?? audioCtx.destination;
              triggerDynamicHit(
                agent,
                audioCtx,
                when,
                output,
                reverbRef.current,
                Math.max(s.energy, TAP_INTENSITY_BOOST),
                triggersThisStep,
                activeAgentCount
              );
              s.pulseUntil = performance.now() + 220;
              s.scheduledTap = false;
              firedThisStep[i] = true;
              triggersThisStep++;
              s.memoryAvg = s.memoryAvg * (1 - 1 / MEMORY_TC) + 1 / MEMORY_TC;
              rainbowFieldRef.current?.pulse(
                s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180
              );
            }

            // Autonomous triggers from agent energy + pattern
            for (let i = 0; i < states.length; i++) {
              const s = states[i];
              const agent = AGENTS[i];

              // Spontaneous slow drift: evolve pattern length or phase
              if (--s.driftTimer <= 0) {
                s.driftTimer = DRIFT_STEPS_MIN +
                  Math.round(Math.random() * (DRIFT_STEPS_MAX - DRIFT_STEPS_MIN));
                if (Math.random() < 0.5) {
                  const delta = Math.random() < 0.5 ? 1 : -1;
                  s.dynamicLength = Math.max(
                    DRIFT_LENGTH_RANGE[0],
                    Math.min(DRIFT_LENGTH_RANGE[1], s.dynamicLength + delta)
                  );
                } else {
                  s.dynamicPhase += Math.random() < 0.5 ? 1 : -1;
                }
              }

              const isHolding = s.holdStart !== null && !s.dragging;
              if (!isHolding) {
                // Release envelope advances only after release. While held, pressure sustains intensity.
                s.releaseAgeSteps += 1;
                s.energy = releaseEnvelopeValue(s);
              }

              if (s.energy < ENERGY_THRESHOLD) {
                // Memory: no fire
                s.memoryAvg *= 1 - 1 / MEMORY_TC;
                continue;
              }

              // Phase includes any shift accumulated during a hold gesture
              const effectivePhase = s.dynamicPhase + Math.round(s.holdPhaseAccum);
              const len = Math.max(DRIFT_LENGTH_RANGE[0], s.dynamicLength);
              const cycle = ((step - effectivePhase) % len + len) % len;

              // Hold subdivision: pressure while holding can briefly increase subdivision.
              const holdSubdivide = isHolding &&
                s.energy >= HOLD_SUBDIVIDE_THRESHOLD &&
                (step % 2 === 0 ||
                  (step % 2 === 1 &&
                    s.energy > HOLD_SUBDIVIDE_ODD_THRESHOLD &&
                    Math.random() < HOLD_SUBDIVIDE_ODD_CHANCE));

              if (
                (shouldFire(cycle, len, s.energy, s.memoryAvg) || holdSubdivide) &&
                s.lastStep !== step
              ) {
                if (triggersThisStep >= stepTriggerCap) {
                  s.memoryAvg *= 1 - 1 / MEMORY_TC;
                  continue;
                }
                const crowded = activeAgentCount >= 6;
                if (
                  crowded &&
                  ((agent.layerPriority === 2 && triggersThisStep >= 2) ||
                    (agent.layerPriority === 1 && triggersThisStep >= 3))
                ) {
                  s.memoryAvg *= 1 - 1 / MEMORY_TC;
                  continue;
                }
                const swing = step % 2 === 1 ? SWING_LATE * STEP_SECONDS : 0;
                const when = clockStartRef.current! + step * STEP_SECONDS + swing;
                const output = compressorRef.current ?? audioCtx.destination;
                triggerDynamicHit(
                  agent,
                  audioCtx,
                  when,
                  output,
                  reverbRef.current,
                  s.energy,
                  triggersThisStep,
                  activeAgentCount
                );
                s.pulseUntil = performance.now() + 220;
                s.lastStep = step;
                firedThisStep[i] = true;
                triggersThisStep++;
                rainbowFieldRef.current?.pulse(
                  s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180
                );

                // Emergent ghost / echo note at high intensity, suppressed in busy moments.
                const ghostRange = Math.max(0.0001, 1 - GHOST_ENERGY_THRESHOLD);
                const ghostChance = GHOST_CHANCE *
                  (activeAgentCount >= GHOST_CROWDED_AGENT_THRESHOLD ? GHOST_CROWDED_MULTIPLIER : 1) *
                  Math.max(0, (s.energy - GHOST_ENERGY_THRESHOLD) / ghostRange);
                if (s.energy >= GHOST_ENERGY_THRESHOLD && Math.random() < ghostChance) {
                  scheduleGhost(agent, audioCtx, when, output, reverbRef.current);
                }

                // Memory: record a fire
                s.memoryAvg = s.memoryAvg * (1 - 1 / MEMORY_TC) + 1 / MEMORY_TC;
              } else {
                // Memory: no fire this step
                s.memoryAvg *= 1 - 1 / MEMORY_TC;
              }

            }

            // Inter-agent influence: ring neighbours receive a small energy nudge
            for (let i = 0; i < states.length; i++) {
              if (!firedThisStep[i]) continue;
              const prev = (i - 1 + states.length) % states.length;
              const next = (i + 1) % states.length;
              states[prev].pendingInfluence += INTER_AGENT_NUDGE;
              states[next].pendingInfluence += INTER_AGENT_NUDGE;
            }
            for (let i = 0; i < states.length; i++) {
              if (states[i].pendingInfluence > 0) {
                states[i].energy = Math.min(1, states[i].energy + states[i].pendingInfluence);
                states[i].releaseStartIntensity = Math.min(
                  1,
                  Math.max(states[i].releaseStartIntensity, states[i].energy)
                );
                states[i].pendingInfluence = 0;
              }
            }
          }
          lastStepRef.current = currentStep;
        }
      }

      // ── 2. Physics & energy per agent ─────────────────────────────────────
      for (let i = 0; i < states.length; i++) {
        const s = states[i];

        // Hold: accumulate energy and slowly phase-shift while pointer is held (not dragging)
        if (s.holdStart !== null && !s.dragging) {
          s.energy = Math.min(1, s.energy + HOLD_INTENSITY_PER_SECOND * deltaSeconds);
          s.releaseStartIntensity = Math.max(s.releaseStartIntensity, s.energy);
          s.releaseAgeSteps = 0;
          // Frame-rate-independent phase shift accumulation
          s.holdPhaseAccum += HOLD_PHASE_RATE * deltaSeconds;
        }

        // Spring pull back toward rest position
        if (!s.dragging) {
          const ax = -SPRING_K * (s.x - s.restX);
          const ay = -SPRING_K * (s.y - s.restY);
          s.vx = (s.vx + ax) * SPRING_DAMPING;
          s.vy = (s.vy + ay) * SPRING_DAMPING;
          s.x += s.vx;
          s.y += s.vy;
        }
      }

      // ── 3. Render agents onto canvas ──────────────────────────────────────
      canvasCtx.clearRect(0, 0, w, h);

      for (let i = 0; i < AGENTS.length; i++) {
        const agent = AGENTS[i];
        const s = states[i];
        const pT = Math.max(0, (s.pulseUntil - now) / 220); // 0..1

        canvasCtx.save();

        // Spring tension line when displaced
        const disp = Math.hypot(s.x - s.restX, s.y - s.restY);
        if (disp > 6) {
          canvasCtx.beginPath();
          canvasCtx.moveTo(s.restX, s.restY);
          canvasCtx.lineTo(s.x, s.y);
          canvasCtx.strokeStyle = `${agent.color}55`;
          canvasCtx.lineWidth = 2;
          canvasCtx.stroke();
        }

        // Glow proportional to energy + pulse
        const energyVis = Math.max(s.energy, pT * 0.6);
        if (energyVis > 0.04) {
          const glowR = baseRadius + energyVis * 28 + pT * 18;
          const alphaHex = Math.round(energyVis * 255)
            .toString(16)
            .padStart(2, "0");
          const grd = canvasCtx.createRadialGradient(
            s.x, s.y, baseRadius * 0.5,
            s.x, s.y, glowR
          );
          grd.addColorStop(0, `${agent.color}${alphaHex}`);
          grd.addColorStop(1, `${agent.color}00`);
          canvasCtx.beginPath();
          canvasCtx.arc(s.x, s.y, glowR, 0, 2 * Math.PI);
          canvasCtx.fillStyle = grd;
          canvasCtx.fill();
        }

        // Main circle
        const scale = 1 + pT * 0.18;
        const r = baseRadius * scale;
        canvasCtx.beginPath();
        canvasCtx.arc(s.x, s.y, r, 0, 2 * Math.PI);
        canvasCtx.fillStyle = `${agent.color}cc`;
        canvasCtx.fill();
        canvasCtx.strokeStyle = `${agent.color}ff`;
        canvasCtx.lineWidth = 2.5;
        canvasCtx.stroke();

        // Energy arc around the circle
        if (s.energy > 0.02) {
          const arcEnd = -Math.PI / 2 + s.energy * 2 * Math.PI;
          canvasCtx.beginPath();
          canvasCtx.arc(s.x, s.y, baseRadius + 9, -Math.PI / 2, arcEnd);
          canvasCtx.strokeStyle = `${agent.color}ee`;
          canvasCtx.lineWidth = 4;
          canvasCtx.lineCap = "round";
          canvasCtx.stroke();
        }

        // Emoji + label
        const emojiSize = Math.round(r * 0.7);
        canvasCtx.font = `${emojiSize}px serif`;
        canvasCtx.fillStyle = "rgba(255,255,255,0.96)";
        canvasCtx.textAlign = "center";
        canvasCtx.textBaseline = "middle";
        canvasCtx.fillText(agent.emoji, s.x, s.y);
        canvasCtx.font = `600 ${Math.max(10, Math.round(baseRadius * LABEL_FONT_SIZE_FACTOR))}px system-ui, sans-serif`;
        canvasCtx.fillStyle = "rgba(226,232,240,0.85)";
        canvasCtx.textAlign = "center";
        canvasCtx.textBaseline = "top";
        canvasCtx.fillText(agent.label, s.x, s.y + r + 6);

        canvasCtx.restore();
      }

      // ── Tempo pulse indicator (small dot at bottom-centre) ────────────────
      if (audioCtx && clockStartRef.current !== null) {
        const elapsed = audioCtx.currentTime - clockStartRef.current;
        const quarterBeatPhase = (elapsed / (STEP_SECONDS * 2)) % 1; // quarter-beat phase
        const pr = 4 + quarterBeatPhase * 6;
        const alpha = 0.3 + quarterBeatPhase * 0.5;
        canvasCtx.beginPath();
        canvasCtx.arc(w / 2, h - 20, pr, 0, 2 * Math.PI);
        canvasCtx.fillStyle = `rgba(99,202,255,${alpha})`;
        canvasCtx.fill();
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // audioContextRef, compressorRef, reverbRef, rainbowFieldRef are stable refs.
  }, []);

  // ── Canvas resize ────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const { width: w, height: h } = rect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.imageSmoothingEnabled = false;
      }

      const { positions, radius } = computeRestLayout(w, h);
      sizeRef.current = { w, h, radius };
      const states = agentStateRef.current;

      if (states.length === 0) {
        // First initialisation
        agentStateRef.current = positions.map((pos, i) => ({
          x: pos.x,
          y: pos.y,
          vx: 0,
          vy: 0,
          restX: pos.x,
          restY: pos.y,
          energy: 0,
          dragging: false,
          pointerId: null,
          holdStart: null,
          pulseUntil: 0,
          scheduledTap: false,
          lastStep: -1,
          // Mutable pattern state — seeded from AgentDef
          dynamicLength: AGENTS[i].patternLength,
          dynamicPhase: AGENTS[i].phaseOffset,
          holdPhaseAccum: 0,
          // Inter-agent influence
          pendingInfluence: 0,
          // Memory / drift — stagger initial drift timers so agents don't all drift at once
            memoryAvg: 0,
            driftTimer: DRIFT_STEPS_MIN +
              Math.round(Math.random() * (DRIFT_STEPS_MAX - DRIFT_STEPS_MIN)),
            releaseAgeSteps: 0,
            releaseCommitSteps: Math.max(
              1,
              Math.round(RELEASE_COMMIT_MIN_SECONDS / STEP_SECONDS)
            ),
            releaseDecaySteps: Math.max(
              1,
              Math.round(RELEASE_LIFETIME_MIN_SECONDS / STEP_SECONDS)
            ),
            releaseStartIntensity: 0,
          }));
      } else {
        // Reposition rest points, preserving current spring displacement
        positions.forEach((pos, i) => {
          const s = states[i];
          if (!s) return;
          const dx = s.x - s.restX;
          const dy = s.y - s.restY;
          s.restX = pos.x;
          s.restY = pos.y;
          s.x = pos.x + dx;
          s.y = pos.y + dy;
        });
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [computeRestLayout]);

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        position: "absolute",
        inset: 0,
        touchAction: "none",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
