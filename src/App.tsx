import React, { useCallback, useEffect, useRef } from "react";
import { RainbowField } from "./effects/RainbowField";
import { GrooveSystem } from "./components/GrooveSystem";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

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

export default function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rainbowFieldRef = useRef<RainbowField | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const unlockedRef = useRef(false);
  const compressorRef = useRef<DynamicsCompressorNode | null>(null);
  const reverbRef = useRef<ConvolverNode | null>(null);

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

  // RainbowField visual setup
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

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      audioContextRef.current?.close().catch((error) => {
        console.warn("Audio context close failed", error);
      });
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
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
        ref={containerRef}
        style={{ position: "absolute", inset: 0 }}
      >
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
        <GrooveSystem
          ensureAudioContext={ensureAudioContext}
          audioContextRef={audioContextRef}
          compressorRef={compressorRef}
          reverbRef={reverbRef}
          rainbowFieldRef={rainbowFieldRef}
        />
      </div>
    </div>
  );
}

