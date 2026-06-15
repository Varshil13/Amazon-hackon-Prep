"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// ─── Types (mirrored from page.tsx — keep in sync) ────────
type DeviceId =
  | "bedroom_light" | "night_light" | "geyser" | "ac" | "bedroom_fan"
  | "kitchen_light" | "induction" | "microwave"
  | "tv" | "living_fan" | "living_light"
  | "study_ceiling_light" | "study_lamp" | "study_fan"
  | "water_motor" | "washing_machine";

type RoomId = "bedroom" | "kitchen" | "living" | "study" | "utility";
type AlertType = "danger" | "attention" | "info";
interface AudioEvent { roomId: RoomId; type: AlertType; label: string; }
interface HouseState {
  devices: Record<DeviceId, boolean>;
  time: string;
  audioEvents: AudioEvent[];
}

type VoiceState = "idle" | "listening" | "woke" | "recording";

interface ActiveAutomation { id: string; name: string; trigger: string; action: string; reasoning: string; }

export interface AlexaVoiceControllerProps {
  houseState: HouseState;
  onDeviceCommand: (deviceId: DeviceId, state: boolean, delayMs: number) => void;
  onAIResponse?: (message: string, detail: string) => void;
  activeAutomations?: ActiveAutomation[];
  onAutomationUpdate?: (updated: ActiveAutomation[]) => void;
}

// ─── Component ────────────────────────────────────────────
export function AlexaVoiceController({
  houseState,
  onDeviceCommand,
  onAIResponse,
  activeAutomations = [],
  onAutomationUpdate,
}: AlexaVoiceControllerProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [isActive, setIsActive] = useState(false);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [speechApiAvailable, setSpeechApiAvailable] = useState(true);

  // Refs — avoid stale closures in async callbacks
  const recognitionRef = useRef<any>(null);
  const isActiveRef = useRef(false);
  const isCommandModeRef = useRef(false);
  const houseStateRef = useRef(houseState);
  houseStateRef.current = houseState; // Always fresh
  const activeAutomationsRef = useRef(activeAutomations);
  useEffect(() => { activeAutomationsRef.current = activeAutomations; }, [activeAutomations]);

  // startWakeWordRef breaks the circular dependency:
  // startWakeWordLoop → (on wake) → startCommandRecording → (on result) → startWakeWordLoop
  const startWakeWordRef = useRef<() => void>(() => {});

  // ── Check browser capability ────────────────────────────
  useEffect(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setSpeechApiAvailable(!!SpeechRecognition);
  }, []);

  // ── 880 Hz chime (Web Audio API, no external dep) ──────
  const playChime = useCallback(() => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
      // Clean up context after done
      setTimeout(() => ctx.close(), 500);
    } catch {
      // AudioContext may not be available in all environments
    }
  }, []);

  // ── Browser TTS (speechSynthesis, no external dep) ─────
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    const PREFERRED = [
      "Google UK English Female",
      "Microsoft Aria Online (Natural) - English (United States)",
      "Microsoft Jenny Online (Natural) - English (United States)",
      "Microsoft Zira - English (United States)",
      "Google US English",
      "Samantha",  // macOS
      "Karen",     // macOS
      "Moira",     // macOS
    ];

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      return PREFERRED.reduce<SpeechSynthesisVoice | null>((found, name) =>
        found ?? voices.find((v) => v.name === name) ?? null, null)
        ?? voices.find((v) => v.lang.startsWith("en") && v.name.toLowerCase().includes("female"))
        ?? voices.find((v) => v.lang.startsWith("en"))
        ?? null;
    };

    const utter = (voice: SpeechSynthesisVoice | null) => {
      const utt = new SpeechSynthesisUtterance(text);
      if (voice) utt.voice = voice;
      utt.rate = 0.92;
      utt.pitch = 1.1;
      utt.volume = 1.0;
      window.speechSynthesis.speak(utt);
    };

    const voice = pickVoice();
    if (voice) {
      utter(voice);
    } else {
      const onVoices = () => {
        window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
        utter(pickVoice());
      };
      window.speechSynthesis.addEventListener("voiceschanged", onVoices);
    }
  }, []);

  // ── Core: POST voice command → /api/event ──────────────
  const sendVoiceCommand = useCallback(
    async (command: string) => {
      try {
        const res = await fetch("/api/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            houseState: houseStateRef.current,
            sourceProfile: "parents",
            voiceCommand: command,
            activeAutomations: activeAutomationsRef.current,
          }),
        });
        const data = await res.json();
        if (data.success) {
          const { message, reasoning, action_type, device_commands, updated_automations } = data.data;

          // 1. Propagate message to parent for TTS
          onAIResponse?.(message, reasoning || "");

          // 2. Handle automation update
          if (action_type === "automation_update" && Array.isArray(updated_automations)) {
            onAutomationUpdate?.(updated_automations);
          }

          // 3. Execute device commands — always, regardless of action_type
          if (Array.isArray(device_commands) && device_commands.length > 0) {
            device_commands.forEach((cmd: { deviceId: string; state: boolean; target_time?: string; delay_minutes?: number }) => {
              if (!cmd.deviceId) return;
              let delayMs = 0;
              if (cmd.target_time && cmd.target_time !== "now") {
                const [th, tm] = cmd.target_time.split(":").map(Number);
                const targetTotal = th * 60 + tm;
                const [ch, cm] = (houseStateRef.current.time || "00:00").split(":").map(Number);
                const currentTotal = ch * 60 + cm;
                let diffMinutes = targetTotal - currentTotal;
                if (diffMinutes <= 0) diffMinutes += 1440;
                delayMs = diffMinutes * 60000;
              } else if (cmd.delay_minutes && cmd.delay_minutes > 0) {
                delayMs = cmd.delay_minutes * 60000;
              }
              onDeviceCommand(cmd.deviceId as DeviceId, !!cmd.state, delayMs);
            });
          } else if (action_type === "voice_command_execute") {
            // Fallback: LLM returned empty device_commands — parse command text directly
            const lower = command.toLowerCase();
            const isOn  = lower.includes("turn on") || lower.includes("switch on") || lower.includes("enable") || lower.includes("start");
            const isOff = lower.includes("turn off") || lower.includes("switch off") || lower.includes("disable") || lower.includes("stop");
            if (isOn || isOff) {
              const DEVICE_KEYWORDS: Record<string, string> = {
                bedroom_light: "bedroom light", night_light: "night light", geyser: "geyser",
                ac: " ac ", bedroom_fan: "bedroom fan", kitchen_light: "kitchen light",
                induction: "induction", microwave: "microwave", tv: " tv ",
                living_fan: "living fan", living_light: "living light",
                study_ceiling_light: "study ceiling", study_lamp: "study lamp",
                study_fan: "study fan", water_motor: "water motor", washing_machine: "washing machine",
              };
              for (const [deviceId, keyword] of Object.entries(DEVICE_KEYWORDS)) {
                if (lower.includes(keyword.trim())) {
                  onDeviceCommand(deviceId as DeviceId, isOn, 0);
                  break;
                }
              }
            }
          }
        }
      } catch {
        speak("Sorry, I couldn't reach Alexa. Please try again.");
      }
    },
    [speak, onAIResponse, onDeviceCommand, onAutomationUpdate]
  );

  // ── Entry Point 3a: One-shot command recording ─────────
  // Fires after wake word is detected. Records one utterance then
  // hands back control to the wake word loop.
  const startCommandRecording = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    setVoiceState("recording");
    isCommandModeRef.current = true;

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-IN"; // Indian English
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript.trim();
      console.log(`[AlexaVoice] Command captured: "${transcript}"`);
      setLastCommand(transcript);
      isCommandModeRef.current = false;
      setVoiceState("idle");

      // Send to AI, then restart wake word loop
      sendVoiceCommand(transcript).finally(() => {
        if (isActiveRef.current) {
          setTimeout(() => startWakeWordRef.current(), 700);
        }
      });
    };

    recognition.onerror = (e: any) => {
      console.warn("[AlexaVoice] Command recognition error:", e.error);
      isCommandModeRef.current = false;
      if (isActiveRef.current) {
        setVoiceState("listening");
        setTimeout(() => startWakeWordRef.current(), 600);
      } else {
        setVoiceState("idle");
      }
    };

    recognition.onend = () => {
      // onend fires if silence timeout — no result received
      if (isCommandModeRef.current) {
        isCommandModeRef.current = false;
        speak("I didn't catch that. Please say Alexa again.");
        if (isActiveRef.current) {
          setVoiceState("listening");
          setTimeout(() => startWakeWordRef.current(), 700);
        } else {
          setVoiceState("idle");
        }
      }
    };

    try {
      recognition.start();
    } catch {
      /* may throw if already running — ignore */
    }
  }, [sendVoiceCommand, speak]);

  // ── Entry Point 3b: Continuous wake word loop ──────────
  // Runs continuously in the background when active.
  // Restarts itself on every `onend` to stay alive.
  useEffect(() => {
    startWakeWordRef.current = () => {
      if (!isActiveRef.current || isCommandModeRef.current) return;

      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) return;

      // Stop any existing session first
      try {
        if (recognitionRef.current) recognitionRef.current.abort();
      } catch {
        /* ignore */
      }

      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true; // Needed for real-time "Alexa" detection
      recognition.lang = "en-IN";

      recognition.onresult = (event: any) => {
        if (isCommandModeRef.current) return; // Already in command mode

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript.toLowerCase();
          // Detect "Alexa" in any interim or final result
          if (transcript.includes("alexa")) {
            console.log(`[AlexaVoice] Wake word detected in: "${transcript}"`);
            isCommandModeRef.current = true;
            try {
              recognition.stop();
            } catch {
              /* ignore */
            }
            setVoiceState("woke");
            playChime();
            // Brief delay to let chime play, then start recording command
            setTimeout(() => {
              if (isActiveRef.current) startCommandRecording();
            }, 350);
            return;
          }
        }
      };

      recognition.onerror = (e: any) => {
        // "no-speech" and "aborted" are normal — suppress them
        if (e.error !== "no-speech" && e.error !== "aborted") {
          console.warn("[AlexaVoice] Wake word error:", e.error);
        }
      };

      recognition.onend = () => {
        // Auto-restart the loop as long as we're active and not in command mode
        if (isActiveRef.current && !isCommandModeRef.current) {
          setTimeout(() => startWakeWordRef.current(), 300);
        }
      };

      try {
        recognition.start();
        setVoiceState("listening");
      } catch {
        /* may throw if mic is unavailable */
      }
    };
  }, [playChime, startCommandRecording]);

  // ── Toggle on/off ──────────────────────────────────────
  const toggleListening = useCallback(() => {
    if (isActiveRef.current) {
      // --- STOP ---
      isActiveRef.current = false;
      isCommandModeRef.current = false;
      try {
        if (recognitionRef.current) recognitionRef.current.abort();
      } catch {
        /* ignore */
      }
      setVoiceState("idle");
      setIsActive(false);
      setLastCommand(null);
    } else {
      // --- START ---
      isActiveRef.current = true;
      setIsActive(true);
      setTimeout(() => startWakeWordRef.current(), 150);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      try {
        if (recognitionRef.current) recognitionRef.current.abort();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // ── Visual derived values ──────────────────────────────
  const btnBg =
    !isActive
      ? "var(--muted)"
      : voiceState === "woke"
      ? "#3b82f6"
      : voiceState === "recording"
      ? "#ef4444"
      : "rgba(59,130,246,0.18)";

  const btnBorder =
    isActive ? "1px solid rgba(59,130,246,0.5)" : "1px solid transparent";

  const btnShadow =
    voiceState === "woke"
      ? "0 0 22px rgba(59,130,246,0.95)"
      : voiceState === "recording"
      ? "0 0 18px rgba(239,68,68,0.85)"
      : "none";

  const btnAnim =
    voiceState === "listening"
      ? "alexaDimPulse 2.5s ease-in-out infinite"
      : voiceState === "woke"
      ? "alexaBrightPulse 0.7s ease-in-out infinite"
      : voiceState === "recording"
      ? "alexaRecordPulse 0.5s ease-in-out infinite"
      : "none";

  const emoji =
    voiceState === "woke"
      ? "✨"
      : voiceState === "recording"
      ? "🔴"
      : voiceState === "listening"
      ? "👂"
      : "🎤";

  const tooltip =
    !isActive
      ? 'Click to enable Alexa voice control (Chrome)'
      : voiceState === "listening"
      ? 'Listening for "Alexa"... click to stop'
      : voiceState === "woke"
      ? 'Wake word heard! Speak your command...'
      : voiceState === "recording"
      ? 'Recording command...'
      : 'Starting...';

  return (
    <>
      <style>{`
        @keyframes alexaDimPulse {
          0%,100%{opacity:0.65;transform:scale(1)}
          50%{opacity:1;transform:scale(1.07)}
        }
        @keyframes alexaBrightPulse {
          0%,100%{transform:scale(1);box-shadow:0 0 22px rgba(59,130,246,0.95)}
          50%{transform:scale(0.93);box-shadow:0 0 34px rgba(59,130,246,1)}
        }
        @keyframes alexaRecordPulse {
          0%,100%{transform:scale(1)}
          50%{transform:scale(1.12)}
        }
      `}</style>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 3,
          position: "relative",
        }}
      >
        <button
          onClick={toggleListening}
          disabled={!speechApiAvailable}
          title={tooltip}
          aria-label={tooltip}
          style={{
            width: 36,
            height: 36,
            background: btnBg,
            border: btnBorder,
            borderRadius: "50%",
            cursor: speechApiAvailable ? "pointer" : "not-allowed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            transition: "background 0.3s, box-shadow 0.3s",
            boxShadow: btnShadow,
            animation: btnAnim,
            flexShrink: 0,
          }}
        >
          {emoji}
        </button>

        {/* Chrome-only notice */}
        {!speechApiAvailable && (
          <span
            style={{
              fontSize: 9,
              color: "var(--red)",
              whiteSpace: "nowrap",
              fontWeight: 600,
            }}
          >
            Chrome only
          </span>
        )}

        {/* Last command echo (briefly shown after command is processed) */}
        {lastCommand && isActive && voiceState === "idle" && (
          <span
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              fontSize: 9,
              color: "var(--text-dim)",
              whiteSpace: "nowrap",
              maxWidth: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "2px 6px",
              zIndex: 100,
            }}
          >
            &ldquo;{lastCommand}&rdquo;
          </span>
        )}
      </div>
    </>
  );
}
