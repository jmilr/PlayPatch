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
const AGENT_RADIUS = 40;
const DRAG_ENERGY_SCALE = 160; // px of displacement for energy = 1.0
const DRAG_THRESHOLD = 12;     // px of movement before a press counts as a drag

// ── Energy ────────────────────────────────────────────────────────────────────
const ENERGY_THRESHOLD = 0.12;
const HOLD_RATE = 0.008; // energy gained per animation frame while holding
const DECAY_PER_STEP = 0.88; // energy multiplier after each clock step
const MAX_TRIGGERS_PER_STEP = 3;
const TAP_ENERGY_BOOST = 0.5; // energy added to an agent on a quick tap

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
  holdStart: number | null; // performance.now() when hold began
  pulseUntil: number;       // performance.now() until visual pulse shows
  scheduledTap: boolean;    // pending quantised tap on next step
  lastStep: number;         // last clock step this agent triggered on
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

// ── Agent definitions ─────────────────────────────────────────────────────────
// Frequencies form an A-major pentatonic set (A2–A4) — all consonant together.
// Pattern lengths are co-prime enough to create evolving polyrhythm.
const AGENTS: AgentDef[] = [
  {
    id: 0,
    label: "Bloom",
    emoji: "🌸",
    color: "#ff5dac",
    patternLength: 8,
    phaseOffset: 0,
    playFn: makeTone(220, "sine", 700, 0.06, 0.55, 0.22),
  },
  {
    id: 1,
    label: "Drift",
    emoji: "🌊",
    color: "#34d2ff",
    patternLength: 6,
    phaseOffset: 2,
    playFn: makeTone(329.628, "triangle", 620, 0.07, 0.60, 0.18),
  },
  {
    id: 2,
    label: "Mist",
    emoji: "🌫️",
    color: "#b967ff",
    patternLength: 8,
    phaseOffset: 1,
    playFn: makeTone(440, "sine", 800, 0.05, 0.50, 0.20),
  },
  {
    id: 3,
    label: "Earth",
    emoji: "🌿",
    color: "#4ade80",
    patternLength: 12,
    phaseOffset: 4,
    playFn: makeTone(164.814, "triangle", 560, 0.10, 0.65, 0.24),
  },
  {
    id: 4,
    label: "Deep",
    emoji: "🌙",
    color: "#1f77ff",
    patternLength: 4,
    phaseOffset: 0,
    playFn: makeTone(110, "sine", 500, 0.12, 0.70, 0.28),
  },
];

// ── Pattern density logic ─────────────────────────────────────────────────────
/**
 * Returns true if step `step` (within a cycle of `length`) should fire,
 * given the agent's current energy. Higher energy unlocks denser patterns.
 *
 *  energy ≥ 0.12  → downbeat only (step 0 always fires, guarded by caller)
 *  energy ≥ 0.25  → + half-note point (step at length/2)
 *  energy ≥ 0.45  → + quarter-note points (length/4, 3*length/4)
 *  energy ≥ 0.65  → + all even steps
 *  energy ≥ 0.80  → + all remaining steps except the last
 */
function shouldFire(step: number, length: number, energy: number): boolean {
  if (step === 0) return true;
  // Half-note point
  if (energy >= 0.25 && step * 2 === length) return true;
  // Quarter-note points (integer only)
  if (energy >= 0.45 && (step * 4 === length || step * 4 === length * 3)) return true;
  // All even steps
  if (energy >= 0.65 && step % 2 === 0) return true;
  // Everything except the last step
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
  const clockStartRef = useRef<number | null>(null); // AudioContext time when clock started
  const lastStepRef = useRef<number>(-1);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef<number | null>(null);

  // ── Rest-position layout ────────────────────────────────────────────────────
  const computeRestPositions = useCallback((w: number, h: number) => {
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.31;
    return AGENTS.map((_, i) => {
      const angle = (2 * Math.PI * i) / AGENTS.length - Math.PI / 2;
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    });
  }, []);

  // ── Hit test ────────────────────────────────────────────────────────────────
  const hitTest = useCallback((x: number, y: number): number => {
    const states = agentStateRef.current;
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (Math.hypot(x - s.x, y - s.y) <= AGENT_RADIUS + 14) return i;
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

      // Tap: short press with no significant drag → schedule quantised note
      if (!wasDragging && holdDuration < 280) {
        s.scheduledTap = true;
        s.energy = Math.max(s.energy, TAP_ENERGY_BOOST);
      }

      // Release drag: store displacement as energy and kick spring
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

  // ── Main animation + clock loop ─────────────────────────────────────────────
  // Defined in a single useEffect with empty deps so the closure is stable.
  // All mutable state is accessed through refs so no stale data.
  useEffect(() => {
    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);

      const canvas = canvasRef.current;
      const canvasCtx = canvas?.getContext("2d");
      if (!canvas || !canvasCtx) return;

      const { w, h } = sizeRef.current;
      const states = agentStateRef.current;
      const audioCtx = audioContextRef.current;

      // ── 1. Clock: process each new step ──────────────────────────────────
      if (audioCtx && clockStartRef.current !== null) {
        const elapsed = audioCtx.currentTime - clockStartRef.current;
        const currentStep = Math.floor(elapsed / STEP_SECONDS);

        if (currentStep > lastStepRef.current) {
          for (let step = lastStepRef.current + 1; step <= currentStep; step++) {
            let triggersThisStep = 0;

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
              triggersThisStep++;
              rainbowFieldRef.current?.pulse(
                s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180
              );
            }

            // Autonomous triggers from agent energy + pattern
            for (let i = 0; i < states.length; i++) {
              if (triggersThisStep >= MAX_TRIGGERS_PER_STEP) break;
              const s = states[i];

              if (s.energy < ENERGY_THRESHOLD) {
                s.energy *= 0.98; // drain residual slowly
                continue;
              }

              const agent = AGENTS[i];
              const cycle =
                ((step - agent.phaseOffset) % agent.patternLength +
                  agent.patternLength) %
                agent.patternLength;

              if (
                shouldFire(cycle, agent.patternLength, s.energy) &&
                s.lastStep !== step
              ) {
                const swing = step % 2 === 1 ? SWING_LATE * STEP_SECONDS : 0;
                const when = clockStartRef.current! + step * STEP_SECONDS + swing;
                const output = compressorRef.current ?? audioCtx.destination;
                agent.playFn(audioCtx, when, output, reverbRef.current);
                s.pulseUntil = performance.now() + 220;
                s.lastStep = step;
                triggersThisStep++;
                rainbowFieldRef.current?.pulse(
                  s.x, s.y, 220 + i * 55, hexToRgb(agent.color), 180
                );
              }

              s.energy *= DECAY_PER_STEP;
            }
          }
          lastStepRef.current = currentStep;
        }
      }

      // ── 2. Physics & energy per agent ─────────────────────────────────────
      for (let i = 0; i < states.length; i++) {
        const s = states[i];

        // Hold: accumulate energy while pointer is held (not dragging)
        if (s.holdStart !== null && !s.dragging) {
          s.energy = Math.min(1, s.energy + HOLD_RATE);
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
          const glowR = AGENT_RADIUS + energyVis * 28 + pT * 18;
          const alphaHex = Math.round(energyVis * 255)
            .toString(16)
            .padStart(2, "0");
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

        // Energy arc around the circle
        if (s.energy > 0.02) {
          const arcEnd = -Math.PI / 2 + s.energy * 2 * Math.PI;
          canvasCtx.beginPath();
          canvasCtx.arc(s.x, s.y, AGENT_RADIUS + 9, -Math.PI / 2, arcEnd);
          canvasCtx.strokeStyle = `${agent.color}ee`;
          canvasCtx.lineWidth = 4;
          canvasCtx.lineCap = "round";
          canvasCtx.stroke();
        }

        // Emoji centred in circle
        const emojiSize = Math.round(r * 0.7);
        canvasCtx.font = `${emojiSize}px serif`;
        canvasCtx.textAlign = "center";
        canvasCtx.textBaseline = "middle";
        canvasCtx.fillText(agent.emoji, s.x, s.y);

        // Label below circle
        canvasCtx.font = "bold 11px system-ui, sans-serif";
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
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      sizeRef.current = { w, h };

      const positions = computeRestPositions(w, h);
      const states = agentStateRef.current;

      if (states.length === 0) {
        // First initialisation
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
