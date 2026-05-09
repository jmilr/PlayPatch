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
const DRAG_ENERGY_SCALE = 140; // px of displacement for energy = 1.0 (superlinear curve)
const DRAG_THRESHOLD = 12;     // px of movement before a press counts as a drag

// ── Energy ────────────────────────────────────────────────────────────────────
const ENERGY_THRESHOLD = 0.18;
const HOLD_RATE = 0.008; // energy gained per animation frame while holding
const MAX_TRIGGERS_PER_STEP = 2;
const TAP_ENERGY_BOOST = 0.35; // gentle nudge on tap — big pulls are how you rev

// ── Interaction influence ─────────────────────────────────────────────────────
const HOLD_PHASE_RATE = 0.30;          // phase steps shifted per second while holding
const HOLD_SUBDIVIDE_THRESHOLD = 0.55; // energy above which hold triggers freely on even steps

// ── Non-linear decay ──────────────────────────────────────────────────────────
const DECAY_HIGH  = 0.78;  // fast decay when energy > 0.65
const DECAY_MID   = 0.84;  // normal decay 0.30 – 0.65
const DECAY_LOW   = 0.90;  // slow "sustain" decay when energy < 0.30
const DECAY_JITTER = 0.02; // ±random variance (reduced from 0.03)

// ── Inter-agent influence ─────────────────────────────────────────────────────
// Base nudge is amplified by the firing agent's energy, so high-energy cascades explode.
const INTER_AGENT_NUDGE_BASE = 0.018;
const INTER_AGENT_NUDGE_SCALE = 4.0; // multiplier on sender energy added to nudge

// ── Eruption / glide-back system ─────────────────────────────────────────────
// When system-wide energy is high, decay slows so the eruption glides back gracefully.
const ERUPTION_THRESHOLD = 0.40; // average agent energy above which glide kicks in
const ERUPTION_DECAY_BOOST = 0.12; // max extra decay-rate lift at full eruption

// ── Memory ───────────────────────────────────────────────────────────────────
const MEMORY_TC   = 40;   // leaky-average time constant in steps
const MEMORY_BIAS = 0.06; // max effective-energy lift from memory

// ── Pattern length bounds ─────────────────────────────────────────────────────
const PATTERN_LENGTH_RANGE: [number, number] = [4, 13];

// ── Types ─────────────────────────────────────────────────────────────────────
type PlayFn = (
  ctx: AudioContext,
  when: number,
  output: AudioNode,
  reverb: ConvolverNode | null
) => void;

interface AgentDef {
  readonly id: number;
  readonly label: string;
  readonly emoji: string;
  readonly color: string;
  readonly patternLength: number;
  readonly phaseOffset: number;
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
  holdStart: number | null;
  pulseUntil: number;
  scheduledTap: boolean;
  lastStep: number;
  dynamicLength: number;
  dynamicPhase: number;
  holdPhaseAccum: number;
  pendingInfluence: number;
  memoryAvg: number;
}

export interface GrooveSystemProps {
  ensureAudioContext: () => Promise<AudioContext>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
  compressorRef: React.MutableRefObject<DynamicsCompressorNode | null>;
  reverbRef: React.MutableRefObject<ConvolverNode | null>;
  rainbowFieldRef: React.MutableRefObject<RainbowField | null>;
}

// ── Melodic tone — detuned unison chorus + delayed vibrato ────────────────────
function makeTone(
  freq: number,
  waveform: OscillatorType,
  filterHz: number,
  attack: number,
  decay: number,
  peak: number
): PlayFn {
  return (ctx, when, output, reverb) => {
    // Two oscillators detuned ±7 cents give natural chorus without flanging
    const osc1 = ctx.createOscillator();
    osc1.type = waveform;
    osc1.frequency.setValueAtTime(freq, when);

    const osc2 = ctx.createOscillator();
    osc2.type = waveform;
    osc2.frequency.setValueAtTime(freq * Math.pow(2, 7 / 1200), when);

    // Vibrato LFO — starts silent, swells in after attack to avoid pitchy onset
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(4.5, when);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.setValueAtTime(0, when);
    lfoDepth.gain.linearRampToValueAtTime(freq * 0.003, when + attack + 0.08);
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc1.frequency);
    lfoDepth.connect(osc2.frequency);

    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(filterHz, when);
    filt.frequency.exponentialRampToValueAtTime(
      Math.max(filterHz * 0.25, 80),
      when + attack + decay
    );

    // Both oscs share the filter; use ~55% of peak so the combined level stays natural
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak * 0.55, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);

    const send = ctx.createGain();
    send.gain.value = 0.4;

    osc1.connect(filt);
    osc2.connect(filt);
    filt.connect(gain);
    gain.connect(output);
    gain.connect(send);
    if (reverb) send.connect(reverb);

    const stopAt = when + attack + decay + 0.1;
    lfo.start(when);
    lfo.stop(stopAt);
    osc1.start(when);
    osc1.stop(stopAt);
    osc2.start(when);
    osc2.stop(stopAt);

    osc1.onended = () => {
      try {
        lfo.disconnect(); lfoDepth.disconnect();
        osc1.disconnect(); osc2.disconnect();
        filt.disconnect(); gain.disconnect(); send.disconnect();
      } catch { /* ignore */ }
    };
  };
}

// ── Marimba — replaces crash percussion ───────────────────────────────────────
// Fast attack, short sine decay, slight pitch drop for bar-resonance character.
function makeMarimba(freq: number, peak = 0.26): PlayFn {
  return (ctx, when, output, reverb) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, when);
    // Slight pitch drop (bar resonance) — very subtle
    osc.frequency.exponentialRampToValueAtTime(freq * 0.975, when + 0.05);

    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.setValueAtTime(freq * 7, when);
    filt.frequency.exponentialRampToValueAtTime(freq * 2.2, when + 0.3);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.005); // 5 ms attack = punchy mallet
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.32);

    const send = ctx.createGain();
    send.gain.value = 0.18;

    osc.connect(filt);
    filt.connect(gain);
    gain.connect(output);
    gain.connect(send);
    if (reverb) send.connect(reverb);

    const stopAt = when + 0.38;
    osc.start(when);
    osc.stop(stopAt);
    osc.onended = () => {
      try { osc.disconnect(); filt.disconnect(); gain.disconnect(); send.disconnect(); } catch { /* ignore */ }
    };
  };
}

// ── Celesta — replaces bell ───────────────────────────────────────────────────
// Lower octave + inharmonic celesta partials (1, 2.756, 5.404) = warm sparkle.
function makeCelesta(freq: number): PlayFn {
  const f = freq * 0.5; // drop an octave — E5 → E4, much warmer
  return (ctx, when, output, reverb) => {
    const partials: Array<{ mul: number; gain: number; decay: number }> = [
      { mul: 1.0,   gain: 0.16, decay: 0.70 },
      { mul: 2.756, gain: 0.07, decay: 0.46 },
      { mul: 5.404, gain: 0.03, decay: 0.28 },
    ];
    let remaining = partials.length;

    const send = ctx.createGain();
    send.gain.value = 0.52;
    if (reverb) send.connect(reverb);

    partials.forEach(({ mul, gain: gVal, decay }) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(f * mul, when);

      const amp = ctx.createGain();
      amp.gain.setValueAtTime(0.0001, when);
      amp.gain.linearRampToValueAtTime(gVal, when + 0.008);
      amp.gain.exponentialRampToValueAtTime(0.0001, when + decay);

      osc.connect(amp);
      amp.connect(output);
      amp.connect(send);

      const stopAt = when + decay + 0.05;
      osc.start(when);
      osc.stop(stopAt);
      osc.onended = () => {
        try {
          osc.disconnect(); amp.disconnect();
          remaining -= 1;
          if (remaining === 0) send.disconnect();
        } catch { /* ignore */ }
      };
    });
  };
}

// ── Rhodes chord — replaces guitar strum ──────────────────────────────────────
// FM synthesis for Rhodes "bark" on attack. Cycles through 4 A-major voicings
// in a predictable loop so the harmony feels composed, not random.
function makeRhodesChord(rootHz: number): PlayFn {
  // Semitone offsets from root — all drawn from A major (A, C#, E, G#, B)
  const CHORDS = [
    [0, 7, 14],      // A + E + A (open fifth, spacious)
    [4, 7, 11],      // C# + E + G# (major triad upper)
    [7, 12, 16],     // E + A + C# (second inversion)
    [2, 7, 11],      // B + E + G# (add9 feel)
  ];
  let chordIdx = 0;

  return (ctx, when, output, reverb) => {
    const chord = CHORDS[chordIdx % CHORDS.length];
    chordIdx++;

    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.42;
    if (reverb) reverbSend.connect(reverb);

    let remaining = chord.length;

    chord.forEach((semi, idx) => {
      const start = when + idx * 0.022; // gentler stagger than guitar
      const noteFreq = rootHz * Math.pow(2, semi / 12);

      // FM carrier
      const carrier = ctx.createOscillator();
      carrier.type = "sine";
      carrier.frequency.setValueAtTime(noteFreq, start);

      // FM modulator: same frequency as carrier, decays from rich to clean
      const modulator = ctx.createOscillator();
      modulator.type = "sine";
      modulator.frequency.setValueAtTime(noteFreq, start);

      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(noteFreq * 0.75, start);       // warm bark on attack
      modGain.gain.exponentialRampToValueAtTime(noteFreq * 0.04, start + 0.14); // fade to clean
      modulator.connect(modGain);
      modGain.connect(carrier.frequency);

      const amp = ctx.createGain();
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.linearRampToValueAtTime(0.10, start + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + 1.35);

      carrier.connect(amp);
      amp.connect(output);
      amp.connect(reverbSend);

      const stopAt = start + 1.45;
      carrier.start(start);
      modulator.start(start);
      carrier.stop(stopAt);
      modulator.stop(stopAt);
      carrier.onended = () => {
        try {
          carrier.disconnect(); modulator.disconnect();
          modGain.disconnect(); amp.disconnect();
          remaining -= 1;
          if (remaining === 0) reverbSend.disconnect();
        } catch { /* ignore */ }
      };
    });
  };
}

// ── Agent definitions ─────────────────────────────────────────────────────────
// Ordered for cascade: bass → melody → marimba → sparkle.
// Ring topology flows in this order, so energy builds naturally from foundation up.
const AGENTS: AgentDef[] = [
  // ── Bass foundation ──
  {
    id: 0,
    label: "Deep",
    emoji: "🌙",
    color: "#1f77ff",
    patternLength: 4,
    phaseOffset: 0,
    playFn: makeTone(110, "sine", 500, 0.12, 0.70, 0.28),
  },
  {
    id: 1,
    label: "Earth",
    emoji: "🌿",
    color: "#4ade80",
    patternLength: 12,
    phaseOffset: 4,
    playFn: makeTone(164.814, "triangle", 560, 0.10, 0.65, 0.24),
  },
  // ── Melodic layer ──
  {
    id: 2,
    label: "Bloom",
    emoji: "🌸",
    color: "#ff5dac",
    patternLength: 8,
    phaseOffset: 0,
    playFn: makeTone(220, "sine", 700, 0.06, 0.55, 0.22),
  },
  {
    id: 3,
    label: "Drift",
    emoji: "🌊",
    color: "#34d2ff",
    patternLength: 6,
    phaseOffset: 2,
    playFn: makeTone(329.628, "triangle", 620, 0.07, 0.60, 0.18),
  },
  {
    id: 4,
    label: "Mist",
    emoji: "🌫️",
    color: "#b967ff",
    patternLength: 8,
    phaseOffset: 1,
    playFn: makeTone(440, "sine", 800, 0.05, 0.50, 0.20),
  },
  // ── Marimba percussion ──
  {
    id: 5,
    label: "Ember",
    emoji: "🔥",
    color: "#ff8a65",
    patternLength: 10,
    phaseOffset: 3,
    playFn: makeMarimba(220, 0.24),   // A3 marimba
  },
  {
    id: 6,
    label: "Glow",
    emoji: "🕯️",
    color: "#ffb74d",
    patternLength: 7,
    phaseOffset: 1,
    playFn: makeMarimba(329.628, 0.22), // E4 marimba
  },
  {
    id: 7,
    label: "Hush",
    emoji: "☁️",
    color: "#f4a261",
    patternLength: 9,
    phaseOffset: 4,
    playFn: makeMarimba(110, 0.26),   // A2 deep marimba thump
  },
  // ── Sparkle accents ──
  {
    id: 8,
    label: "Dusk",
    emoji: "🌆",
    color: "#c084fc",
    patternLength: 11,
    phaseOffset: 5,
    playFn: makeCelesta(659.255),     // E5 → played at E4 inside makeCelesta
  },
  {
    id: 9,
    label: "Amber",
    emoji: "🍯",
    color: "#f59e0b",
    patternLength: 5,
    phaseOffset: 2,
    playFn: makeRhodesChord(110),
  },
];

// ── Pattern density logic ─────────────────────────────────────────────────────
function shouldFire(step: number, length: number, energy: number, memoryAvg: number): boolean {
  const eff = Math.min(1, energy + memoryAvg * MEMORY_BIAS);
  if (step === 0) return true;
  if (eff >= 0.25 && step * 2 === length) return true;
  if (eff >= 0.45 && (step * 4 === length || step * 4 === length * 3)) return true;
  if (eff >= 0.65 && step % 2 === 0) return true;
  if (eff >= 0.80 && step < length - 1) return true;
  return false;
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
  const clockStartRef = useRef<number | null>(null);
  const lastStepRef = useRef<number>(-1);
  const sizeRef = useRef({ w: 0, h: 0, radius: BASE_AGENT_RADIUS });
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);

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

      // Instant reveal: play at reduced volume immediately so touch feels responsive.
      // No reverb keeps it dry/close; the quantised note will arrive with full reverb.
      const audioCtx = audioContextRef.current;
      if (audioCtx && clockStartRef.current !== null) {
        const agent = AGENTS[idx];
        const output = compressorRef.current ?? audioCtx.destination;
        const revealGain = audioCtx.createGain();
        revealGain.gain.value = 0.38;
        revealGain.connect(output);
        agent.playFn(audioCtx, audioCtx.currentTime, revealGain, null);
        setTimeout(() => { try { revealGain.disconnect(); } catch { /* ignore */ } }, 2500);
      }
    },
    [ensureAudioContext, audioContextRef, compressorRef, hitTest]
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
        // Superlinear (power 1.8) curve: small pulls stay gentle, big pulls really rev
        const dist = Math.hypot(dx, dy);
        s.energy = Math.min(1, Math.pow(dist / DRAG_ENERGY_SCALE, 1.8));
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

      if (!wasDragging && holdDuration < 280) {
        s.scheduledTap = true;
        s.energy = Math.max(s.energy, TAP_ENERGY_BOOST);
        // Very rare mutation (5%) so taps feel stable — pulls are how you shape the pattern
        if (Math.random() < 0.05) {
          const delta = Math.random() < 0.5 ? 1 : -1;
          s.dynamicLength = Math.max(
            PATTERN_LENGTH_RANGE[0],
            Math.min(PATTERN_LENGTH_RANGE[1], s.dynamicLength + delta)
          );
        }
      }

      if (wasDragging) {
        const dist = Math.hypot(s.x - s.restX, s.y - s.restY);
        s.energy = Math.min(1, Math.pow(dist / DRAG_ENERGY_SCALE, 1.8));
        s.vx = (s.restX - s.x) * 0.05;
        s.vy = (s.restY - s.y) * 0.05;
      }

      s.dynamicPhase += Math.round(s.holdPhaseAccum);
      s.holdPhaseAccum = 0;

      s.dragging = false;
      s.pointerId = null;
      s.holdStart = null;
    },
    []
  );

  // ── Main animation + clock loop ─────────────────────────────────────────────
  useEffect(() => {
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);

      const deltaSeconds = lastFrameTimeRef.current !== null
        ? Math.min((now - lastFrameTimeRef.current) / 1000, 0.1)
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
            const firedThisStep = new Array<boolean>(states.length).fill(false);

            // User-scheduled taps have priority
            for (let i = 0; i < states.length; i++) {
              if (triggersThisStep >= MAX_TRIGGERS_PER_STEP) break;
              const s = states[i];
              if (!s.scheduledTap) continue;

              const swing = step % 2 === 1 ? SWING_LATE * STEP_SECONDS : 0;
              const when = clockStartRef.current! + step * STEP_SECONDS + swing;
              const agent = AGENTS[i];
              const output = compressorRef.current ?? audioCtx.destination;
              agent.playFn(audioCtx, when, output, reverbRef.current);
              s.pulseUntil = performance.now() + 220;
              s.scheduledTap = false;
              firedThisStep[i] = true;
              triggersThisStep++;
              rainbowFieldRef.current?.pulse(
                s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180
              );
            }

            // Autonomous triggers from agent energy + pattern
            for (let i = 0; i < states.length; i++) {
              if (triggersThisStep >= MAX_TRIGGERS_PER_STEP) break;
              const s = states[i];
              const agent = AGENTS[i];

              if (s.energy < ENERGY_THRESHOLD) {
                s.memoryAvg *= 1 - 1 / MEMORY_TC;
                s.energy *= DECAY_LOW * (1 + (Math.random() - 0.5) * DECAY_JITTER * 2);
                continue;
              }

              const effectivePhase = s.dynamicPhase + Math.round(s.holdPhaseAccum);
              const len = Math.max(PATTERN_LENGTH_RANGE[0], s.dynamicLength);
              const cycle = ((step - effectivePhase) % len + len) % len;

              const isHolding = s.holdStart !== null && !s.dragging;
              const holdSubdivide =
                isHolding && s.energy >= HOLD_SUBDIVIDE_THRESHOLD && step % 2 === 0;

              if (
                (shouldFire(cycle, len, s.energy, s.memoryAvg) || holdSubdivide) &&
                s.lastStep !== step
              ) {
                const swing = step % 2 === 1 ? SWING_LATE * STEP_SECONDS : 0;
                const when = clockStartRef.current! + step * STEP_SECONDS + swing;
                const output = compressorRef.current ?? audioCtx.destination;
                agent.playFn(audioCtx, when, output, reverbRef.current);
                s.pulseUntil = performance.now() + 220;
                s.lastStep = step;
                firedThisStep[i] = true;
                triggersThisStep++;
                rainbowFieldRef.current?.pulse(
                  s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180
                );

                s.memoryAvg = s.memoryAvg * (1 - 1 / MEMORY_TC) + 1 / MEMORY_TC;
              } else {
                s.memoryAvg *= 1 - 1 / MEMORY_TC;
              }

              // Decay — when system is erupting, slow all decay for graceful glide-down
              const systemEnergy = states.reduce((sum, st) => sum + st.energy, 0) / states.length;
              const eruptionFactor = Math.max(0, systemEnergy - ERUPTION_THRESHOLD) /
                (1 - ERUPTION_THRESHOLD);
              const baseDecay = s.energy > 0.65 ? DECAY_HIGH
                : s.energy > 0.30 ? DECAY_MID
                : DECAY_LOW;
              const decayRate = Math.min(0.965, baseDecay + eruptionFactor * ERUPTION_DECAY_BOOST);
              s.energy *= decayRate * (1 + (Math.random() - 0.5) * DECAY_JITTER * 2);
            }

            // Inter-agent influence: nudge amplified by sender's energy → high-energy cascades
            for (let i = 0; i < states.length; i++) {
              if (!firedThisStep[i]) continue;
              const nudge = INTER_AGENT_NUDGE_BASE *
                (1 + states[i].energy * INTER_AGENT_NUDGE_SCALE);
              const prev = (i - 1 + states.length) % states.length;
              const next = (i + 1) % states.length;
              states[prev].pendingInfluence += nudge;
              states[next].pendingInfluence += nudge;
            }
            for (let i = 0; i < states.length; i++) {
              if (states[i].pendingInfluence > 0) {
                states[i].energy = Math.min(1, states[i].energy + states[i].pendingInfluence);
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

        if (s.holdStart !== null && !s.dragging) {
          s.energy = Math.min(1, s.energy + HOLD_RATE);
          s.holdPhaseAccum += HOLD_PHASE_RATE * deltaSeconds;
        }

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
        const pT = Math.max(0, (s.pulseUntil - now) / 220);

        canvasCtx.save();

        const disp = Math.hypot(s.x - s.restX, s.y - s.restY);
        if (disp > 6) {
          canvasCtx.beginPath();
          canvasCtx.moveTo(s.restX, s.restY);
          canvasCtx.lineTo(s.x, s.y);
          canvasCtx.strokeStyle = `${agent.color}55`;
          canvasCtx.lineWidth = 2;
          canvasCtx.stroke();
        }

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

        const scale = 1 + pT * 0.18;
        const r = baseRadius * scale;
        canvasCtx.beginPath();
        canvasCtx.arc(s.x, s.y, r, 0, 2 * Math.PI);
        canvasCtx.fillStyle = `${agent.color}cc`;
        canvasCtx.fill();
        canvasCtx.strokeStyle = `${agent.color}ff`;
        canvasCtx.lineWidth = 2.5;
        canvasCtx.stroke();

        if (s.energy > 0.02) {
          const arcEnd = -Math.PI / 2 + s.energy * 2 * Math.PI;
          canvasCtx.beginPath();
          canvasCtx.arc(s.x, s.y, baseRadius + 9, -Math.PI / 2, arcEnd);
          canvasCtx.strokeStyle = `${agent.color}ee`;
          canvasCtx.lineWidth = 4;
          canvasCtx.lineCap = "round";
          canvasCtx.stroke();
        }

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

      // ── Tempo pulse indicator ─────────────────────────────────────────────
      if (audioCtx && clockStartRef.current !== null) {
        const elapsed = audioCtx.currentTime - clockStartRef.current;
        const quarterBeatPhase = (elapsed / (STEP_SECONDS * 2)) % 1;
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
          dynamicLength: AGENTS[i].patternLength,
          dynamicPhase: AGENTS[i].phaseOffset,
          holdPhaseAccum: 0,
          pendingInfluence: 0,
          memoryAvg: 0,
        }));
      } else {
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
