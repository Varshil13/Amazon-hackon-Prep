"use client";

import { useState, useEffect, useRef } from "react";
import * as tf from "@tensorflow/tfjs";

// Sustain config: how many detections within windowMs are needed to confirm the sound
const SUSTAIN_CONFIG: Record<string, { count: number; windowMs: number }> = {
  baby_crying:             { count: 4, windowMs: 8000 },
  glass_break:             { count: 1, windowMs: 1000 }, // immediate danger
  smoke_alarm:             { count: 1, windowMs: 1000 }, // immediate danger
  pressure_cooker_whistle: { count: 2, windowMs: 4000 },
  doorbell:                { count: 1, windowMs: 1000 },
  washing_machine_done:    { count: 2, windowMs: 5000 },
  default:                 { count: 3, windowMs: 6000 },
};

interface YAMNetAudioMonitorProps {
  onEventDetected: (classification: string, label: string) => void;
}

export function YAMNetAudioMonitor({ onEventDetected }: YAMNetAudioMonitorProps) {
  const [isListening, setIsListening]   = useState(false);
  const [isLoading, setIsLoading]       = useState(false);
  const [detectedEvent, setDetectedEvent] = useState<string | null>(null);

  const modelRef           = useRef<tf.GraphModel | null>(null);
  const classMapRef        = useRef<string[]>([]);
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const processorRef       = useRef<ScriptProcessorNode | null>(null);
  const streamRef          = useRef<MediaStream | null>(null);
  const lastTriggerTime    = useRef<number>(0);
  const audioBufferRef     = useRef<Float32Array>(new Float32Array(0));
  const detectionBufferRef = useRef<{ classification: string; timestamp: number }[]>([]);

  useEffect(() => {
    return () => { stopListening(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load YAMNet 521-class map from TF repo ─────────────
  const loadClassMap = async () => {
    try {
      const response = await fetch(
        "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv"
      );
      const text = await response.text();
      const lines = text.trim().split("\n");
      const classes: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(",");
        const name = parts.slice(2).join(",").replace(/"/g, "").trim();
        classes.push(name);
      }
      classMapRef.current = classes;
    } catch (e) {
      console.error("Failed to load YAMNet class map:", e);
    }
  };

  // ── Load YAMNet model from TFHub ────────────────────────
  const initModel = async () => {
    setIsLoading(true);
    try {
      await tf.ready();
      const loadedModel = await tf.loadGraphModel(
        "https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1",
        { fromTFHub: true }
      );
      modelRef.current = loadedModel;
      await loadClassMap();
      console.log("[YAMNet] Model loaded — 521 classes active.");
    } catch (error) {
      console.error("[YAMNet] Failed to load model:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Run inference on a 15600-sample buffer (~1s @ 16kHz) ──
  const runPrediction = async (buffer: Float32Array) => {
    if (!modelRef.current || classMapRef.current.length === 0) return;

    const tensor = tf.tensor1d(buffer);
    try {
      const outputs = modelRef.current.predict(tensor) as tf.Tensor | tf.Tensor[];
      const scoresTensor = Array.isArray(outputs) ? outputs[0] : outputs;
      const maxScores    = tf.max(scoresTensor, 0);
      const scoresArray  = await maxScores.data();

      // Find highest-scoring class
      let maxScore = -1, maxIndex = -1;
      for (let i = 0; i < scoresArray.length; i++) {
        if (scoresArray[i] > maxScore) { maxScore = scoresArray[i]; maxIndex = i; }
      }

      if (maxScore > 0.4) {
        const label = classMapRef.current[maxIndex];
        if (maxScore > 0.6) {
          console.log(`[YAMNet] Detected: ${label} (${(maxScore * 100).toFixed(1)}%)`);
        }

        const now = Date.now();
        const ll  = label.toLowerCase();

        // ── Map YAMNet labels → our household classification keys ──
        let classification: string | null = null;
        if (ll.includes("baby") || ll.includes("cry") || ll.includes("infant"))
          classification = "baby_crying";
        else if (ll.includes("smoke") || ll.includes("fire alarm") || ll.includes("siren") || ll.includes("alarm"))
          classification = "smoke_alarm";
        else if (ll.includes("shatter") || ll.includes("glass") || ll.includes("breaking"))
          classification = "glass_break";
        else if (ll.includes("whistle"))
          classification = "pressure_cooker_whistle";
        else if (ll.includes("motor") || ll.includes("engine") || ll.includes("mechanisms") || ll.includes("pump"))
          classification = "water_motor_on";
        else if (ll.includes("bell") || ll.includes("chime") || ll.includes("gong") || ll.includes("ding"))
          classification = "morning_puja_bell";
        else if (ll.includes("door") || ll.includes("knock") || ll.includes("doorbell"))
          classification = "doorbell";
        else if (ll.includes("typing") || ll.includes("keyboard") || ll.includes("click"))
          classification = "study_hour_silence";
        else if (ll.includes("speech") || ll.includes("conversation") || ll.includes("talk") || ll.includes("chat"))
          classification = "evening_conversation";
        else if (ll.includes("washing") || ll.includes("spin") || ll.includes("laundry"))
          classification = "washing_machine_done";

        if (classification) {
          // Add to detection buffer
          detectionBufferRef.current.push({ classification, timestamp: now });
          // Prune to 8s window
          detectionBufferRef.current = detectionBufferRef.current.filter(
            (d) => now - d.timestamp < 8000
          );

          // Check sustain threshold
          const cfg = SUSTAIN_CONFIG[classification] || SUSTAIN_CONFIG.default;
          const recentCount = detectionBufferRef.current.filter(
            (d) => d.classification === classification && now - d.timestamp < cfg.windowMs
          ).length;

          // Fire if sustained + 10s global cooldown between fires
          if (recentCount >= cfg.count && now - lastTriggerTime.current > 10000) {
            setDetectedEvent(label);
            onEventDetected(classification, `${label} (sustained)`);
            lastTriggerTime.current = now;
            detectionBufferRef.current = []; // Reset after confirmed fire
          }
        }
      }

      tf.dispose([tensor, outputs, maxScores, scoresTensor]);
    } catch (e) {
      console.error("[YAMNet] Prediction error:", e);
      tf.dispose(tensor);
    }
  };

  // ── Start mic + ScriptProcessorNode pipeline ────────────
  const startListening = async () => {
    if (!modelRef.current) await initModel();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;

      // YAMNet requires 16kHz input
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
      });
      audioCtxRef.current = audioCtx;

      const source    = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessorNode: deprecated but reliable for hackathon demos
      const processor = audioCtx.createScriptProcessor(8192, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const channelData = e.inputBuffer.getChannelData(0);
        const newBuffer   = new Float32Array(audioBufferRef.current.length + channelData.length);
        newBuffer.set(audioBufferRef.current, 0);
        newBuffer.set(channelData, audioBufferRef.current.length);

        // YAMNet needs ~15600 samples (0.975s @ 16kHz)
        if (newBuffer.length >= 15600) {
          const slice = newBuffer.slice(newBuffer.length - 15600);
          audioBufferRef.current = slice;
          runPrediction(slice);
        } else {
          audioBufferRef.current = newBuffer;
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination); // Required for Chrome/Safari to fire events

      setIsListening(true);
    } catch (err) {
      console.error("[YAMNet] Microphone access error:", err);
    }
  };

  // ── Stop and clean up audio pipeline ───────────────────
  const stopListening = () => {
    try { if (processorRef.current) processorRef.current.disconnect(); } catch { /* ignore */ }
    try { if (streamRef.current)    streamRef.current.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try {
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close();
      }
    } catch { /* ignore */ }
    setIsListening(false);
    setDetectedEvent(null);
  };

  // ── Inline styles using CSS variables (no Tailwind) ────
  const containerStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  };

  const statusTextStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-dim)",
    display: "flex",
    alignItems: "center",
    gap: 6,
  };

  const btnStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 14px",
    borderRadius: 8,
    border: isListening
      ? "1px solid rgba(239,68,68,0.5)"
      : "1px solid var(--border)",
    background: isListening
      ? "rgba(239,68,68,0.1)"
      : "var(--muted)",
    color: isListening ? "#f87171" : "var(--text)",
    fontSize: 12,
    fontWeight: 600,
    cursor: isLoading ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    transition: "background 0.2s, border-color 0.2s",
    opacity: isLoading ? 0.6 : 1,
  };

  const footerStyle: React.CSSProperties = {
    fontSize: 10,
    color: "var(--text-dim)",
    lineHeight: 1.5,
    fontStyle: "italic",
  };

  return (
    <div style={containerStyle}>
      {/* Status row */}
      <div style={rowStyle}>
        <span style={statusTextStyle}>
          Status:{" "}
          {isLoading ? (
            <span style={{ color: "var(--blue)", animation: "pulseDot 1.6s ease-in-out infinite" }}>
              Loading YAMNet...
            </span>
          ) : isListening ? (
            <span style={{ color: "var(--red)", fontWeight: 700, animation: "pulseDot 1.6s ease-in-out infinite" }}>
              24/7 Monitoring
            </span>
          ) : (
            <span style={{ color: "var(--text-dim)" }}>Idle</span>
          )}
        </span>

        {detectedEvent && (
          <span
            style={{
              fontSize: 10,
              color: "var(--amber)",
              background: "rgba(245,158,11,0.12)",
              border: "1px solid rgba(245,158,11,0.35)",
              padding: "2px 8px",
              borderRadius: 20,
              maxWidth: 130,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {detectedEvent}
          </span>
        )}
      </div>

      {/* Toggle button */}
      <button
        style={btnStyle}
        onClick={isListening ? stopListening : startListening}
        disabled={isLoading}
      >
        {isLoading ? (
          <>⟳&nbsp;Initializing YAMNet...</>
        ) : isListening ? (
          <>⏹&nbsp;Stop Monitoring</>
        ) : (
          <>🎙️&nbsp;Start Audio Monitoring (YAMNet)</>
        )}
      </button>

      <p style={footerStyle}>
        Real-time YAMNet · 521 classes · fully local, no server
      </p>
    </div>
  );
}
