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
const AGENT_RADIUS = 34;         // reduced to fit 4-agent middle row on mobile
const DRAG_ENERGY_SCALE = 160;
const DRAG_THRESHOLD = 12;

// ── Energy ────────────────────────────────────────────────────────────────────
const ENERGY_THRESHOLD = 0.12;
const HOLD_RATE = 0.008;
const DECAY_BASE = 0.88;
const MAX_TRIGGERS_PER_STEP = 5; // increased for 10 agents
const TAP_ENERGY_BOOST = 0.5;

// ── Emergence ─────────────────────────────────────────────────────────────────
const GHOST_NOTE_PROB = 0.12;    // probability of ghost echo at high energy
const GHOST_GAIN = 0.3;          // relative gain of ghost note
const INFLUENCE_RATE = 0.003;    // energy nudge from ensemble per step
const MEMORY_WINDOW = 16;        // steps of firing history tracked
const DRIFT_RATE = 0.0025;       // long-term density drift per step
const HOLD_PHASE_RATE = 0.0012;  // phase shift added per animation frame while holding

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
  holdStart: number | null;  // performance.now() when hold began
  pulseUntil: number;        // performance.now() until visual pulse shows
  scheduledTap: boolean;     // pending quantised tap on next step
  lastStep: number;          // last clock step this agent triggered on
  // ── Interaction influence ──────────────────────────────────────────────────
  holdModPhase: number;      // fractional phase shift accumulated while holding
  tapMutationLen: number;    // ±1 pattern length mutation from taps
  tapPhaseShift: number;     // ±0..2 step phase shift from taps
  // ── Memory ────────────────────────────────────────────────────────────────
  fireHistory: number;       // 16-bit bitmask — 1=fired that step, LSB=most recent
  driftBias: number;         // long-term density preference drift (−0.25..+0.25)
}

export interface GrooveSystemProps {
  ensureAudioContext: () => Promise<AudioContext>;
  audioContextRef: React.MutableRefObject<AudioContext | null>;
  compressorRef: React.MutableRefObject<DynamicsCompressorNode | null>;
  reverbRef: React.MutableRefObject<ConvolverNode | null>;
  rainbowFieldRef: React.MutableRefObject<RainbowField | null>;
}

// ── Hamming weight for 16-bit integer ────────────────────────────────────────
function bitCount16(n: number): number {
  n = n & 0xffff;
  let c = 0;
  while (n) { c += n & 1; n >>>= 1; }
  return c;
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
      try { osc.disconnect(); filt.disconnect(); gain.disconnect(); send.disconnect(); } catch { /* ignore */ }
    };
  };
}

// ── Wind / flute factory ──────────────────────────────────────────────────────
// Two harmonically-related sines through a bandpass for a breathy flute warmth.
function makeWind(freq: number, attack: number, decay: number, peak: number): PlayFn {
  return (ctx, when, output, reverb) => {
    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(freq, when);

    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 1.5, when); // perfect-5th harmonic

    const harmGain = ctx.createGain();
    harmGain.gain.value = 0.35;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(freq * 1.15, when);
    bp.Q.value = 2.8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);

    const send = ctx.createGain();
    send.gain.value = 0.5;

    osc1.connect(bp);
    osc2.connect(harmGain);
    harmGain.connect(bp);
    bp.connect(gain);
    gain.connect(output);
    gain.connect(send);
    if (reverb) send.connect(reverb);

    const stopAt = when + attack + decay + 0.1;
    osc1.start(when);
    osc2.start(when);
    osc1.stop(stopAt);
    osc2.stop(stopAt);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try { osc1.disconnect(); osc2.disconnect(); harmGain.disconnect(); bp.disconnect(); gain.disconnect(); send.disconnect(); } catch { /* ignore */ }
    };
    osc1.onended = cleanup;
    osc2.onended = cleanup;
  };
}

// ── Warm string factory ───────────────────────────────────────────────────────
// Sawtooth through a steep lowpass for a warm cello/viola tone.
function makeString(freq: number, attack: number, decay: number, peak: number): PlayFn {
  return (ctx, when, output, reverb) => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(freq, when);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(freq * 3.5, when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 80), when + attack + decay);
    lp.Q.value = 1.2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);

    const send = ctx.createGain();
    send.gain.value = 0.45;

    osc.connect(lp);
    lp.connect(gain);
    gain.connect(output);
    gain.connect(send);
    if (reverb) send.connect(reverb);

    const stopAt = when + attack + decay + 0.1;
    osc.start(when);
    osc.stop(stopAt);
    osc.onended = () => {
      try { osc.disconnect(); lp.disconnect(); gain.disconnect(); send.disconnect(); } catch { /* ignore */ }
    };
  };
}

// ── Soft cymbal / shimmer factory ─────────────────────────────────────────────
// White noise through highpass + peaking EQ for a very soft, airy crash.
function makeCymbal(hpFreq: number, decay: number, peak: number): PlayFn {
  return (ctx, when, output, reverb) => {
    const duration = decay + 0.05;
    const bufLen = Math.ceil(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let j = 0; j < bufLen; j++) data[j] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(hpFreq, when);

    const pk = ctx.createBiquadFilter();
    pk.type = "peaking";
    pk.frequency.setValueAtTime(hpFreq * 1.8, when);
    pk.gain.value = 4;
    pk.Q.value = 0.8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    const send = ctx.createGain();
    send.gain.value = 0.6; // cymbals love reverb

    src.connect(hp);
    hp.connect(pk);
    pk.connect(gain);
    gain.connect(output);
    gain.connect(send);
    if (reverb) send.connect(reverb);

    src.start(when);
    src.stop(when + duration);
    src.onended = () => {
      try { src.disconnect(); hp.disconnect(); pk.disconnect(); gain.disconnect(); send.disconnect(); } catch { /* ignore */ }
    };
  };
}

// ── Ghost-note wrapper ────────────────────────────────────────────────────────
// Plays fn at reduced gain; schedules cleanup of the wrapper GainNode.
function withGainFactor(fn: PlayFn, factor: number): PlayFn {
  return (ctx, when, output, reverb) => {
    const g = ctx.createGain();
    g.gain.value = factor;
    g.connect(output);
    fn(ctx, when, g, reverb);
    // Disconnect g once the underlying sound could possibly be done (max ~3 s).
    const ms = Math.max(100, (when - ctx.currentTime + 3) * 1000);
    setTimeout(() => { try { g.disconnect(); } catch { /* ignore */ } }, ms);
  };
}

// ── Agent definitions ─────────────────────────────────────────────────────────
// 10 agents arranged in a 3-4-3 grid.
// All frequencies belong to the A-major pentatonic scale (A, B, C#, E, F#)
// so every combination remains consonant.
// Pattern lengths are chosen to be mutually co-prime, giving a polyrhythmic
// cycle long enough (~10 min at 120 BPM) that the system never feels looped.
const AGENTS: AgentDef[] = [
  // ── Row 0 — top 3 ─────────────────────────────────────────────────────────
  {
    id: 0, label: "Bloom", emoji: "🌸", color: "#ff5dac",
    patternLength: 8,  phaseOffset: 0,
    playFn: makeTone(220,     "sine",     700, 0.06, 0.55, 0.22),
  },
  {
    id: 1, label: "Drift", emoji: "🌊", color: "#34d2ff",
    patternLength: 6,  phaseOffset: 2,
    playFn: makeTone(329.628, "triangle", 620, 0.07, 0.60, 0.18),
  },
  {
    id: 2, label: "Mist",  emoji: "🌫️",  color: "#b967ff",
    patternLength: 8,  phaseOffset: 1,
    playFn: makeTone(440,     "sine",     800, 0.05, 0.50, 0.20),
  },
  // ── Row 1 — middle 4 ──────────────────────────────────────────────────────
  {
    id: 3, label: "Earth", emoji: "🌿", color: "#4ade80",
    patternLength: 12, phaseOffset: 4,
    playFn: makeTone(164.814, "triangle", 560, 0.10, 0.65, 0.24),
  },
  {
    id: 4, label: "Deep",  emoji: "🌙", color: "#1f77ff",
    patternLength: 4,  phaseOffset: 0,
    playFn: makeTone(110,     "sine",     500, 0.12, 0.70, 0.28),
  },
  {
    id: 5, label: "Reed",  emoji: "🎋", color: "#2dd4bf",  // F#4 — wind flute
    patternLength: 7,  phaseOffset: 3,
    playFn: makeWind(369.99, 0.05, 0.55, 0.17),
  },
  {
    id: 6, label: "Bow",   emoji: "🎻", color: "#f59e0b",  // B3 — warm string
    patternLength: 5,  phaseOffset: 1,
    playFn: makeString(246.94, 0.09, 0.80, 0.15),
  },
  // ── Row 2 — bottom 3 ──────────────────────────────────────────────────────
  {
    id: 7, label: "Veil",  emoji: "🍃", color: "#67e8f9",  // B4 — high wind flute
    patternLength: 9,  phaseOffset: 5,
    playFn: makeWind(493.88, 0.04, 0.45, 0.14),
  },
  {
    id: 8, label: "Silk",  emoji: "🌺", color: "#fda4af",  // C#3 — deep warm string
    patternLength: 7,  phaseOffset: 2,
    playFn: makeString(138.59, 0.10, 0.85, 0.16),
  },
  {
    id: 9, label: "Hush",  emoji: "🥁", color: "#94a3b8",  // soft cymbal shimmer
    patternLength: 5,  phaseOffset: 4,
    playFn: makeCymbal(2800,  0.55, 0.08),
  },
];

// ── Pattern density logic ─────────────────────────────────────────────────────
/**
 * Returns true if step `step` (within a cycle of `length`) should fire given
 * the agent's effective energy (base + memory/drift bias).
 *
 *  energy ≥ 0.12  → downbeat only (step 0)
 *  energy ≥ 0.25  → + half-note point (step at length/2)
 *  energy ≥ 0.45  → + quarter-note points (length/4, 3·length/4)
 *  energy ≥ 0.65  → + all even steps
 *  energy ≥ 0.80  → + all remaining steps except the last
 */
function shouldFire(step: number, length: number, energy: number): boolean {
  if (step === 0) return true;
  if (energy >= 0.25 && step * 2 === length) return true;
  if (energy >= 0.45 && (step * 4 === length || step * 4 === length * 3)) return true;
  if (energy >= 0.65 && step % 2 === 0) return true;
  if (energy >= 0.80 && step < length - 1) return true;
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
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef<number | null>(null);
  const orientationAngleRef = useRef<number>(0);

  // ── Orientation tracking ─────────────────────────────────────────────────────
  // Tracks the device rotation angle so text/emoji can be counter-rotated,
  // keeping labels readable regardless of phone orientation while agents stay
  // fixed in their grid positions.
  useEffect(() => {
    const update = () => {
      const raw =
        screen.orientation?.angle ??
        (typeof (window as Window & { orientation?: number }).orientation === "number"
          ? (window as Window & { orientation?: number }).orientation!
          : 0);
      orientationAngleRef.current = ((raw % 360) + 360) % 360;
    };
    update();
    screen.orientation?.addEventListener?.("change", update);
    window.addEventListener("orientationchange", update);
    return () => {
      screen.orientation?.removeEventListener?.("change", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // ── Rest-position layout — 3-4-3 vertical column ────────────────────────────
  const computeRestPositions = useCallback((w: number, h: number) => {
    const rowDefs: number[][] = [[0, 1, 2], [3, 4, 5, 6], [7, 8, 9]];
    const rowSpacing = Math.min(h * 0.27, 140);
    const rowYs = [h / 2 - rowSpacing, h / 2, h / 2 + rowSpacing];

    const positions: { x: number; y: number }[] = new Array(AGENTS.length);
    rowDefs.forEach((row, ri) => {
      const y = rowYs[ri];
      const colStep = w / (row.length + 1);
      row.forEach((agentIdx, ci) => {
        positions[agentIdx] = { x: colStep * (ci + 1), y };
      });
    });
    return positions;
  }, []);

  // ── Hit test ─────────────────────────────────────────────────────────────────
  const hitTest = useCallback((x: number, y: number): number => {
    const states = agentStateRef.current;
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (Math.hypot(x - s.x, y - s.y) <= AGENT_RADIUS + 14) return i;
    }
    return -1;
  }, []);

  // ── Pointer handlers ─────────────────────────────────────────────────────────
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
      const holdDuration = s.holdStart !== null ? performance.now() - s.holdStart : 0;
      const wasDragging = s.dragging;

      // Tap: short press with no significant drag → scheduled note + random mutation
      if (!wasDragging && holdDuration < 280) {
        s.scheduledTap = true;
        s.energy = Math.max(s.energy, TAP_ENERGY_BOOST);
        // Each tap randomly mutates either pattern length or phase offset,
        // introducing variation that slowly drifts back to the agent default.
        const roll = Math.random();
        if (roll < 0.35) {
          s.tapMutationLen = Math.random() < 0.5 ? 1 : -1;
        } else if (roll < 0.70) {
          s.tapPhaseShift = Math.floor(Math.random() * 5) - 2; // −2..+2
        }
        // else: pure energy boost, no structural mutation this tap
      }

      if (wasDragging) {
        const dist = Math.hypot(s.x - s.restX, s.y - s.restY);
        s.energy = Math.min(1, dist / DRAG_ENERGY_SCALE);
        s.vx = (s.restX - s.x) * 0.05;
        s.vy = (s.restY - s.y) * 0.05;
      }

      s.dragging = false;
      s.pointerId = null;
      s.holdStart = null;
    },
    []
  );

  // ── Main animation + clock loop ───────────────────────────────────────────────
  useEffect(() => {
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);

      const canvas = canvasRef.current;
      const canvasCtx = canvas?.getContext("2d");
      if (!canvas || !canvasCtx) return;

      const { w, h } = sizeRef.current;
      const states = agentStateRef.current;
      const audioCtx = audioContextRef.current;

      // ── 1. Clock: process each new step ────────────────────────────────────
      if (audioCtx && clockStartRef.current !== null) {
        const elapsed = audioCtx.currentTime - clockStartRef.current;
        const currentStep = Math.floor(elapsed / STEP_SECONDS);

        if (currentStep > lastStepRef.current) {
          for (let step = lastStepRef.current + 1; step <= currentStep; step++) {
            let triggersThisStep = 0;

            // ── Inter-agent influence: compute ensemble average energy ────────
            let ensembleSum = 0;
            let activeCount = 0;
            for (let i = 0; i < states.length; i++) {
              if (states[i].energy >= ENERGY_THRESHOLD) {
                ensembleSum += states[i].energy;
                activeCount++;
              }
            }
            const avgEnsemble = activeCount > 0 ? ensembleSum / activeCount : 0;

            // ── User-scheduled taps (highest priority) ───────────────────────
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
              triggersThisStep++;
              rainbowFieldRef.current?.pulse(s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180);
            }

            // ── Autonomous triggers ──────────────────────────────────────────
            for (let i = 0; i < states.length; i++) {
              if (triggersThisStep >= MAX_TRIGGERS_PER_STEP) break;
              const s = states[i];

              // Ensemble lift: active neighbours subtly raise this agent's energy,
              // making the system feel like a coordinated ensemble.
              if (s.energy > 0 && avgEnsemble > 0.3) {
                s.energy = Math.min(1, s.energy + INFLUENCE_RATE * avgEnsemble);
              }

              if (s.energy < ENERGY_THRESHOLD) {
                s.energy *= 0.98;
                s.fireHistory = (s.fireHistory << 1) & 0xffff; // record no-fire
                continue;
              }

              const agent = AGENTS[i];

              // Tap mutations shift the effective pattern length and phase,
              // breaking repetition. The values decay back to zero over time.
              const effectiveLen = Math.max(3, Math.min(16,
                agent.patternLength + s.tapMutationLen));
              const effectivePhase = agent.phaseOffset + s.tapPhaseShift +
                Math.round(s.holdModPhase * effectiveLen);
              const cycle =
                ((step - effectivePhase) % effectiveLen + effectiveLen) % effectiveLen;

              // Memory bias: if the agent has been firing densely, ease off a
              // little; if sparse, encourage more firing. Drift adds long-term
              // unpredictable variation.
              const recentDensity = bitCount16(s.fireHistory) / MEMORY_WINDOW;
              const memBias = s.driftBias + (0.35 - recentDensity) * 0.25;
              const effectiveEnergy = s.energy + memBias;

              const fired = shouldFire(cycle, effectiveLen, effectiveEnergy)
                && s.lastStep !== step;

              // Update firing history regardless of outcome
              s.fireHistory = ((s.fireHistory << 1) | (fired ? 1 : 0)) & 0xffff;

              if (fired) {
                const swing = step % 2 === 1 ? SWING_LATE * STEP_SECONDS : 0;
                const when = clockStartRef.current! + step * STEP_SECONDS + swing;
                const output = compressorRef.current ?? audioCtx.destination;
                agent.playFn(audioCtx, when, output, reverbRef.current);
                s.pulseUntil = performance.now() + 220;
                s.lastStep = step;
                triggersThisStep++;
                rainbowFieldRef.current?.pulse(s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180);

                // Ghost note (echo) at high energy — soft secondary event
                // played a quarter-step later at reduced gain.
                if (s.energy > 0.78 && Math.random() < GHOST_NOTE_PROB) {
                  const ghostWhen = when + STEP_SECONDS * 0.25;
                  withGainFactor(agent.playFn, GHOST_GAIN)(audioCtx, ghostWhen, output, reverbRef.current);
                }
              }

              // ── Non-linear decay ───────────────────────────────────────────
              // Slightly irregular: faster at low energy (avoids infinite-tail
              // drift), with a small random variance to prevent lock-step decay.
              const noiseVar = 0.97 + Math.random() * 0.04;   // 0.97–1.01
              const curvature = 0.90 + 0.10 * s.energy;        // faster when E is low
              s.energy *= DECAY_BASE * noiseVar * curvature;

              // ── Tap mutation decay ─────────────────────────────────────────
              // Each mutation step-shifts toward zero at a low random rate,
              // so variations naturally dissolve back to the agent's default.
              if (s.tapMutationLen !== 0 && Math.random() < 0.04) {
                s.tapMutationLen -= Math.sign(s.tapMutationLen);
              }
              if (s.tapPhaseShift !== 0 && Math.random() < 0.04) {
                s.tapPhaseShift -= Math.sign(s.tapPhaseShift);
              }

              // ── Long-term density drift ────────────────────────────────────
              s.driftBias += DRIFT_RATE * (Math.random() - 0.5);
              s.driftBias = Math.max(-0.25, Math.min(0.25, s.driftBias));
            }
          }
          lastStepRef.current = currentStep;
        }
      }

      // ── 2. Physics & per-frame energy accumulation ──────────────────────────
      for (let i = 0; i < states.length; i++) {
        const s = states[i];

        // Hold: accumulate energy + gradually shift phase, giving a timing
        // displacement that creates subtle phasing / roll effects.
        if (s.holdStart !== null && !s.dragging) {
          s.energy = Math.min(1, s.energy + HOLD_RATE);
          s.holdModPhase = (s.holdModPhase + HOLD_PHASE_RATE) % 1.0;
        }

        // Slowly unwind holdModPhase after release.
        if (s.holdStart === null && s.holdModPhase > 0) {
          s.holdModPhase = Math.max(0, s.holdModPhase - 0.0004);
        }

        // Spring physics
        if (!s.dragging) {
          const ax = -SPRING_K * (s.x - s.restX);
          const ay = -SPRING_K * (s.y - s.restY);
          s.vx = (s.vx + ax) * SPRING_DAMPING;
          s.vy = (s.vy + ay) * SPRING_DAMPING;
          s.x += s.vx;
          s.y += s.vy;
        }
      }

      // ── 3. Render ───────────────────────────────────────────────────────────
      canvasCtx.clearRect(0, 0, w, h);

      // Text counter-rotation: if the browser has NOT auto-rotated the viewport
      // (e.g. orientation is locked), counter-rotate emoji/labels so they remain
      // readable. When the browser DOES auto-rotate, angle=0 after resize and
      // textRotation is harmlessly 0.
      const orAngle = orientationAngleRef.current;
      const isLandscapeAngle = orAngle === 90 || orAngle === 270;
      const isLandscapeViewport = w > h;
      const textRotation = isLandscapeAngle !== isLandscapeViewport
        ? -(orAngle * Math.PI / 180)
        : 0;

      for (let i = 0; i < AGENTS.length; i++) {
        const agent = AGENTS[i];
        const s = states[i];
        const pT = Math.max(0, (s.pulseUntil - now) / 220); // 1→0 over pulse duration

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
          const glowR = AGENT_RADIUS + energyVis * 28 + pT * 18;
          const alphaHex = Math.round(energyVis * 255).toString(16).padStart(2, "0");
          const grd = canvasCtx.createRadialGradient(
            s.x, s.y, AGENT_RADIUS * 0.5,
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
        const r = AGENT_RADIUS * scale;
        canvasCtx.beginPath();
        canvasCtx.arc(s.x, s.y, r, 0, 2 * Math.PI);
        canvasCtx.fillStyle = `${agent.color}cc`;
        canvasCtx.fill();
        canvasCtx.strokeStyle = `${agent.color}ff`;
        canvasCtx.lineWidth = 2.5;
        canvasCtx.stroke();

        // Energy arc
        if (s.energy > 0.02) {
          const arcEnd = -Math.PI / 2 + s.energy * 2 * Math.PI;
          canvasCtx.beginPath();
          canvasCtx.arc(s.x, s.y, AGENT_RADIUS + 8, -Math.PI / 2, arcEnd);
          canvasCtx.strokeStyle = `${agent.color}ee`;
          canvasCtx.lineWidth = 3.5;
          canvasCtx.lineCap = "round";
          canvasCtx.stroke();
        }

        // Emoji + label — rotated to stay upright in any phone orientation
        canvasCtx.save();
        canvasCtx.translate(s.x, s.y);
        canvasCtx.rotate(textRotation);
        const emojiSize = Math.round(r * 0.7);
        canvasCtx.font = `${emojiSize}px serif`;
        canvasCtx.textAlign = "center";
        canvasCtx.textBaseline = "middle";
        canvasCtx.fillText(agent.emoji, 0, 0);
        canvasCtx.font = "bold 10px system-ui, sans-serif";
        canvasCtx.fillStyle = "rgba(226,232,240,0.85)";
        canvasCtx.textBaseline = "top";
        canvasCtx.fillText(agent.label, 0, r + 5);
        canvasCtx.restore();

        canvasCtx.restore();
      }

      // Tempo pulse dot (bottom-centre)
      if (audioCtx && clockStartRef.current !== null) {
        const elapsed = audioCtx.currentTime - clockStartRef.current;
        const phase = (elapsed / (STEP_SECONDS * 2)) % 1;
        const pr = 4 + phase * 6;
        const alpha = 0.3 + phase * 0.5;
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
  }, []); // intentional: stable closure via refs

  // ── Canvas resize ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const { width: w, height: h } = rect;
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      sizeRef.current = { w, h };

      const positions = computeRestPositions(w, h);
      const states = agentStateRef.current;

      if (states.length === 0) {
        agentStateRef.current = positions.map((pos) => ({
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
          holdModPhase: 0,
          tapMutationLen: 0,
          tapPhaseShift: 0,
          fireHistory: 0,
          driftBias: 0,
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
  }, [computeRestPositions]);

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
