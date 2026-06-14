"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";

// Dynamic imports — both are client-only (browser APIs: Web Audio, TensorFlow.js, SpeechRecognition)
const YAMNetAudioMonitor = dynamic(
  () => import("@/components/YAMNetAudioMonitor").then((m) => m.YAMNetAudioMonitor),
  { ssr: false }
);
const AlexaVoiceController = dynamic(
  () => import("@/components/AlexaVoiceController").then((m) => m.AlexaVoiceController),
  { ssr: false }
);

// ─── Types ────────────────────────────────────────────────
type DeviceId =
  | "bedroom_light" | "night_light" | "geyser" | "ac" | "bedroom_fan"
  | "kitchen_light" | "induction" | "microwave"
  | "tv" | "living_fan" | "living_light"
  | "study_ceiling_light" | "study_lamp" | "study_fan"
  | "water_motor" | "washing_machine";

type RoomId = "bedroom" | "kitchen" | "living" | "study" | "utility";
type AlertType = "danger" | "attention" | "info";

interface AudioEvent { roomId: RoomId; type: AlertType; label: string; }
interface HouseState { devices: Record<DeviceId, boolean>; time: string; audioEvents: AudioEvent[]; }

// Full 5-field shape — persisted to DynamoDB
interface SuggestedAutomation { id: string; name: string; trigger: string; action: string; reasoning: string; }
interface ActiveAutomation    { id: string; name: string; trigger: string; action: string; reasoning: string; }
interface RoutinePattern { event: string; occurrences: number; typical_window: string; confidence: string; }

// ─── Static Config ────────────────────────────────────────
const DEVICE_CONFIG: Record<DeviceId, { label: string; icon: string; room: RoomId }> = {
  bedroom_light:      { label: "Ceiling Light",   icon: "💡", room: "bedroom" },
  night_light:        { label: "Night Light",     icon: "🌙", room: "bedroom" },
  geyser:             { label: "Geyser",          icon: "🚿", room: "bedroom" },
  ac:                 { label: "AC",              icon: "❄️", room: "bedroom" },
  bedroom_fan:        { label: "Ceiling Fan",     icon: "fan", room: "bedroom" },
  kitchen_light:      { label: "Kitchen Light",   icon: "💡", room: "kitchen" },
  induction:          { label: "Induction",       icon: "🍳", room: "kitchen" },
  microwave:          { label: "Microwave",       icon: "📦", room: "kitchen" },
  tv:                 { label: "Smart TV",        icon: "📺", room: "living" },
  living_fan:         { label: "Ceiling Fan",     icon: "fan", room: "living" },
  living_light:       { label: "Main Light",      icon: "💡", room: "living" },
  study_ceiling_light:{ label: "Ceiling Light",   icon: "💡", room: "study" },
  study_lamp:         { label: "Desk Lamp",       icon: "💡", room: "study" },
  study_fan:          { label: "Ceiling Fan",     icon: "fan", room: "study" },
  water_motor:        { label: "Water Motor",     icon: "💧", room: "utility" },
  washing_machine:    { label: "Washing Machine", icon: "🫧", room: "utility" },
};

const ROOMS: { id: RoomId; label: string; wide?: boolean; devices: DeviceId[] }[] = [
  { id: "bedroom", label: "Bedroom",           devices: ["bedroom_light","night_light","geyser","ac","bedroom_fan"] },
  { id: "kitchen", label: "Kitchen",           devices: ["kitchen_light","induction","microwave"] },
  { id: "living",  label: "Living Room", wide: true, devices: ["tv","living_fan","living_light"] },
  { id: "study",   label: "Study Room",        devices: ["study_ceiling_light","study_lamp","study_fan"] },
  { id: "utility", label: "Utility / Balcony", devices: ["water_motor","washing_machine"] },
];

const initialDevices = Object.fromEntries(
  (Object.keys(DEVICE_CONFIG) as DeviceId[]).map((k) => [k, false])
) as Record<DeviceId, boolean>;

// ─── Fan SVG ──────────────────────────────────────────────
function FanIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 48 48" width="30" height="30" fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={spinning ? { animation: "spinFan 1.2s linear infinite", transformOrigin: "center" } : {}}
    >
      <style>{`@keyframes spinFan { to { transform: rotate(360deg); } }`}</style>
      <path d="M24 22 C22 14, 14 10, 10 12 C12 18, 18 22, 24 24Z" fill="currentColor" opacity="0.9"/>
      <path d="M26 24 C34 22, 38 14, 36 10 C30 12, 26 18, 24 24Z" fill="currentColor" opacity="0.9"/>
      <path d="M24 26 C26 34, 34 38, 38 36 C36 30, 30 26, 24 24Z" fill="currentColor" opacity="0.9"/>
      <path d="M22 24 C14 26, 10 34, 12 38 C18 36, 22 30, 24 24Z" fill="currentColor" opacity="0.9"/>
      <circle cx="24" cy="24" r="3.5" fill="currentColor"/>
      <circle cx="24" cy="24" r="1.5" fill="#0f1117"/>
    </svg>
  );
}

// ─── Automation helpers ───────────────────────────────────
// Derive trigger start minute from automation name OR trigger field keywords
function getAutomationStartMinutes(automation: { name: string; trigger: string }): number {
  const text = (automation.name + " " + automation.trigger).toLowerCase();
  if (text.includes("morning") || text.match(/\b(6|7|8)\s*am\b/))   return 360;
  if (text.includes("afternoon") || text.match(/\b(12|1|2)\s*pm\b/)) return 720;
  if (text.includes("evening") || text.match(/\b(5|6|7)\s*pm\b/))   return 1020;
  if (text.includes("night") || text.match(/\b(8|9|10)\s*pm\b/))    return 1200;
  return -1;
}

// Derive display time label from automation name + trigger
function getAutomationTimeLabel(automation: { name: string; trigger?: string }): string {
  const start = getAutomationStartMinutes({ name: automation.name, trigger: automation.trigger ?? "" });
  if (start === 360)  return "6:00 AM";
  if (start === 720)  return "12:00 PM";
  if (start === 1020) return "5:00 PM";
  if (start === 1200) return "8:00 PM";
  return "";
}

// Parse automation.action text → device + desired state
// Handles: "turn on", "switch on", "enable", "activate", "start", "run", "turn off", "switch off", "disable", "stop", "deactivate"
function parseActionToDevice(
  action: string,
  deviceConfig: Record<string, { label: string }>
): { deviceId: string; state: boolean } | null {
  const lower = action.toLowerCase();
  const turnOn  = lower.includes("turn on")    || lower.includes("switch on")   ||
                  lower.includes("enable")     || lower.includes("activate")    ||
                  lower.includes("start")      || lower.includes("run");
  const turnOff = lower.includes("turn off")   || lower.includes("switch off")  ||
                  lower.includes("disable")    || lower.includes("deactivate")  ||
                  lower.includes("stop");
  if (!turnOn && !turnOff) return null;
  for (const [id, cfg] of Object.entries(deviceConfig)) {
    const idSlug = id.replace(/_/g, " ");
    const label  = cfg.label.toLowerCase();
    if (lower.includes(idSlug) || lower.includes(id) || lower.includes(label)) {
      return { deviceId: id, state: turnOn };
    }
  }
  return null;
}

// ─── Main Page ────────────────────────────────────────────
export default function Home() {
  const [houseState, setHouseState] = useState<HouseState>({
    devices: initialDevices,
    time: "06:00",
    audioEvents: [],
  });
  const [isThinking, setIsThinking]   = useState(false);
  const [reasoning, setReasoning]     = useState({ message: "Waiting for activity...", detail: "" });
  const [suggested, setSuggested]     = useState<SuggestedAutomation[]>([]);
  const [active, setActive]           = useState<ActiveAutomation[]>([]);
  const [patterns, setPatterns]       = useState<RoutinePattern[]>([
    { event: "water_motor",             occurrences: 5, typical_window: "Morning",   confidence: "high" },
    { event: "morning_puja_bell",       occurrences: 4, typical_window: "Morning",   confidence: "high" },
    { event: "pressure_cooker_whistle", occurrences: 3, typical_window: "Afternoon", confidence: "medium" },
    { event: "study_hour_silence",      occurrences: 3, typical_window: "Evening",   confidence: "medium" },
  ]);
  const [pendingAutomationAsk, setPendingAutomationAsk] = useState<string | null>(null);
  const [toast, setToast]             = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [isSeedLoading, setIsSeedLoading] = useState(false);
  // Scheduled voice commands — fired when time slider reaches targetMinutes
  const [pendingCommands, setPendingCommands] = useState<{ deviceId: DeviceId; state: boolean; targetMinutes: number }[]>([]);
  // Tracks the slider-minute at which each device was turned ON — used for anomaly detection
  const [deviceOnTimes, setDeviceOnTimes] = useState<Partial<Record<DeviceId, number>>>({});

  const debounceRef          = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestStateRef       = useRef(houseState);
  latestStateRef.current     = houseState;
  const activeRef            = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const pendingCommandsRef   = useRef(pendingCommands);
  useEffect(() => { pendingCommandsRef.current = pendingCommands; }, [pendingCommands]);
  // Cooldown refs — prevent re-firing same automation / greeting on every slider tick
  const lastAnnouncedAutoRef = useRef<string | null>(null);
  const lastGreetedPeriodRef = useRef<string | null>(null);

  // ── Toast helper ───────────────────────────────────────
  const showToast = useCallback((message: string, type: "success" | "error" | "info" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Global TTS — Alexa speaks everything ───────────────
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    // Strip emojis/non-speakable chars, keep letters/numbers/punctuation
    const clean = text.replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, " ").replace(/\s+/g, " ").trim();
    if (!clean) return;

    const PREFERRED = [
      "Google UK English Female",
      "Microsoft Aria Online (Natural) - English (United States)",
      "Microsoft Jenny Online (Natural) - English (United States)",
      "Microsoft Zira - English (United States)",
      "Google US English",
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
      const utt = new SpeechSynthesisUtterance(clean);
      if (voice) utt.voice = voice;
      utt.rate = 0.92;
      utt.pitch = 1.1;
      utt.volume = 1.0;
      window.speechSynthesis.speak(utt);
    };

    // Cancel then yield a tick — Chrome drops utterances queued synchronously after cancel()
    window.speechSynthesis.cancel();
    setTimeout(() => {
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
    }, 50);
  }, []);

  // Wrapper — sets reasoning panel AND speaks it
  const setReasoningAndSpeak = useCallback((r: { message: string; detail: string }) => {
    setReasoning(r);
    speak(r.message);
  }, [speak]);

  // ── Mount fetches ──────────────────────────────────────
  useEffect(() => {
    fetch("/api/routines")
      .then((r) => r.json())
      .then((d) => { if (d.success && d.routines?.length) setPatterns(d.routines); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/automations")
      .then((r) => r.json())
      .then((d) => { if (d.success && d.automations?.length) setActive(d.automations); })
      .catch(() => {}); // silent failure on load
  }, []);

  // ── Automation proactive checker ──────────────────────
  // Called from interval (every 60s) AND from handleTimeChange (immediate on slider move).
  // Auto-executes the device action + speaks what it did.
  const checkAutomations = useCallback((currentMinutes: number) => {
    if (activeRef.current.length === 0) return;

    // Reset cooldown for automations whose window has passed — allows re-fire next day
    activeRef.current.forEach((automation) => {
      if (lastAnnouncedAutoRef.current !== automation.id) return;
      const start = getAutomationStartMinutes(automation);
      if (start === -1) return;
      // Window ended — reset so it can fire again
      if (currentMinutes > start + 45) {
        lastAnnouncedAutoRef.current = null;
      }
    });

    const matched = activeRef.current.find((automation) => {
      const start = getAutomationStartMinutes(automation);
      if (start !== -1) {
        return currentMinutes >= start - 15 && currentMinutes <= start + 45;
      }
      // Fallback: if no time keyword, try matching trigger text against current time window
      const window =
        currentMinutes < 480  ? "morning" :
        currentMinutes < 720  ? "morning" :
        currentMinutes < 900  ? "afternoon" :
        currentMinutes < 1020 ? "afternoon" :
        currentMinutes < 1200 ? "evening" : "night";
      const text = (automation.name + " " + automation.trigger).toLowerCase();
      return text.includes(window);
    });

    if (!matched) {
      // Debug: log what each automation resolved to
      if (activeRef.current.length > 0) {
        console.log("[checkAutomations] currentMinutes:", currentMinutes, "active:", activeRef.current.map(a => ({
          name: a.name,
          trigger: a.trigger,
          start: getAutomationStartMinutes(a),
        })));
      }
      return;
    }
    // Cooldown — don't re-fire the same automation twice
    if (lastAnnouncedAutoRef.current === matched.id) return;
    lastAnnouncedAutoRef.current = matched.id;

    // Auto-execute the device action
    const parsed = parseActionToDevice(matched.action, DEVICE_CONFIG);
    if (parsed) {
      setHouseState((prev) => ({
        ...prev,
        devices: { ...prev.devices, [parsed.deviceId as DeviceId]: parsed.state },
      }));
    }

    const actionDesc = parsed
      ? `Turning ${parsed.state ? "on" : "off"} ${DEVICE_CONFIG[parsed.deviceId as DeviceId]?.label ?? parsed.deviceId} for your ${matched.name}.`
      : `Running your ${matched.name} routine now.`;

    speak(actionDesc);
    setReasoningAndSpeak({
      message: `✅ ${matched.name} triggered!`,
      detail: actionDesc,
    });
  }, [speak, setReasoningAndSpeak]);

  // Real-time interval checker (every 60s)
  useEffect(() => {
    const interval = setInterval(() => {
      const [h, m] = latestStateRef.current.time.split(":").map(Number);
      checkAutomations(h * 60 + m);
    }, 60000);
    return () => clearInterval(interval);
  }, [checkAutomations]);

  // ── Entry Point 1 & 2: POST state to AI ───────────────
  // FROM thinking-and-suggestion: proper "Thinking..." state + selective speak
  const sendStateToAI = useCallback(async (state: HouseState, onTimes?: Partial<Record<DeviceId, number>>) => {
    setIsThinking(true);
    setReasoning((p) => ({ ...p, message: "Thinking..." }));
    try {
      const res = await fetch("/api/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ houseState: state, sourceProfile: "parents", deviceOnTimes: onTimes ?? {} }),
      });
      const data = await res.json();
      if (data.success) {
        const { message, reasoning: r, action_type, suggested_automation } = data.data;
        setReasoning({ message, detail: r || "" });
        // Speak for meaningful events
        const shouldSpeak = ["alert", "anomaly", "family_connect", "routine_suggestion"].includes(action_type);
        if (shouldSpeak) speak(message);
        // Show suggestion card whenever the AI provides one — regardless of action_type
        if (suggested_automation) {
          setSuggested((prev) => {
            if (prev.find((a) => a.name === suggested_automation.name)) return prev;
            return [{ id: Date.now().toString(), ...suggested_automation, reasoning: r }, ...prev];
          });
        }
      }
    } catch {
      setReasoning({ message: "Could not reach AI.", detail: "Check API connection." });
    }
    setIsThinking(false);
  }, [speak]);

  // ── Device toggle ──────────────────────────────────────
  const toggleDevice = useCallback((deviceId: DeviceId) => {
    const currentMinutes = (() => {
      const [h, m] = latestStateRef.current.time.split(":").map(Number);
      return h * 60 + m;
    })();
    setDeviceOnTimes((prev) => {
      const next = { ...prev };
      if (!latestStateRef.current.devices[deviceId]) {
        // turning ON — record current slider time
        next[deviceId] = currentMinutes;
      } else {
        // turning OFF — remove the on-time
        delete next[deviceId];
      }
      return next;
    });
    setHouseState((prev) => {
      const next = { ...prev, devices: { ...prev.devices, [deviceId]: !prev.devices[deviceId] } };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setDeviceOnTimes((onTimes) => { sendStateToAI(next, onTimes); return onTimes; });
      }, 800);
      return next;
    });
  }, [sendStateToAI]);

  // ── Handle device command from AlexaVoiceController ────
  // FROM main-2: delayed commands use time-slider targeting, not real setTimeout
  const handleDeviceCommand = useCallback((deviceId: DeviceId, state: boolean, delayMs: number) => {
    if (delayMs > 0) {
      const delayMinutes = Math.round(delayMs / 60000);
      const [h, m] = latestStateRef.current.time.split(":").map(Number);
      const targetMinutes = (h * 60 + m + delayMinutes) % 1440;
      setPendingCommands((prev) => [...prev, { deviceId, state, targetMinutes }]);
      const th = Math.floor(targetMinutes / 60);
      const tm = targetMinutes % 60;
      const ampm = th < 12 ? "AM" : "PM";
      const th12 = th === 0 ? 12 : th > 12 ? th - 12 : th;
      showToast(`Scheduled ${DEVICE_CONFIG[deviceId].label} to turn ${state ? "on" : "off"} at ${th12}:${String(tm).padStart(2, "0")} ${ampm}`, "success");
    } else {
      setHouseState((prev) => ({
        ...prev,
        devices: { ...prev.devices, [deviceId]: state },
      }));
    }
  }, [showToast]);

  // ── Handle AI response from voice controller ───────────
  const handleVoiceAIResponse = useCallback((message: string, detail: string) => {
    setReasoningAndSpeak({ message, detail });
  }, [setReasoningAndSpeak]);

  // ── Optimistic "Automate This" with POST + rollback ────
  const handleAutomateThis = useCallback(async (automation: SuggestedAutomation) => {
    const newActive: ActiveAutomation = {
      id: automation.id,
      name: automation.name,
      trigger: automation.trigger,
      action: automation.action,
      reasoning: automation.reasoning,
    };
    setActive((prev) => [...prev, newActive]);
    setSuggested((prev) => prev.filter((x) => x.id !== automation.id));
    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newActive),
      });
      const data = await res.json();
      if (data.success) {
        showToast("Automation saved!");
      } else {
        throw new Error(data.error || "Server error");
      }
    } catch {
      // Rollback
      setActive((prev) => prev.filter((x) => x.id !== automation.id));
      setSuggested((prev) => [automation, ...prev]);
      showToast("Failed to save automation. Please try again.", "error");
    }
  }, [showToast]);

  // ── Optimistic "Remove" with DELETE + rollback ─────────
  const handleRemoveAutomation = useCallback(async (automationId: string) => {
    let removedItem: ActiveAutomation | undefined;
    let removedIndex = -1;
    setActive((prev) => {
      removedIndex = prev.findIndex((x) => x.id === automationId);
      removedItem = prev[removedIndex];
      return prev.filter((x) => x.id !== automationId);
    });
    try {
      const res = await fetch(`/api/automations?id=${encodeURIComponent(automationId)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("Automation removed.");
      } else {
        throw new Error(data.error || "Server error");
      }
    } catch {
      if (removedItem !== undefined) {
        const item = removedItem;
        const idx  = removedIndex;
        setActive((prev) => { const next = [...prev]; next.splice(idx, 0, item); return next; });
      }
      showToast("Failed to remove automation. Please try again.", "error");
    }
  }, [showToast]);

  // ── Seed demo data ─────────────────────────────────────
  const handleSeed = useCallback(async () => {
    setIsSeedLoading(true);
    try {
      const res  = await fetch("/api/seed?force=true");
      const data = await res.json();
      if (data.success) {
        showToast(data.message || "Demo data seeded!", "success");
        fetch("/api/routines").then((r) => r.json()).then((d) => { if (d.success && d.routines?.length) setPatterns(d.routines); }).catch(() => {});
      } else {
        showToast(data.reason || data.error || "Seed failed", "error");
      }
    } catch {
      showToast("Network error — check connection", "error");
    }
    setIsSeedLoading(false);
  }, [showToast]);

  // ── Time slider — FROM main-2 ──────────────────────────
  // Full 24h range (0–1439), time-period greetings, pending command execution, checkAutomations
  const handleTimeChange = useCallback((minutes: number) => {
    const h    = Math.floor(minutes / 60);
    const m    = minutes % 60;
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

    // Time-period greetings
    const period =
      minutes < 360  ? "midnight" :
      minutes < 480  ? "morning" :
      minutes < 720  ? "late_morning" :
      minutes < 900  ? "afternoon" :
      minutes < 1020 ? "evening" :
      minutes < 1200 ? "night" : "late_night";

    const greetings: Record<string, string> = {
      morning:      "Good morning! It's 6 AM. The house is quiet. Should I start your morning routine?",
      late_morning: "Good morning! It's a new day. Kitchen devices are ready when you are.",
      afternoon:    "Good afternoon! Lunch time. Shall I check if the kitchen is in use?",
      evening:      "Good evening! The family is likely home. Study hours may be starting soon.",
      night:        "It's evening. TV time perhaps? I'll keep an ear out for any activity.",
      late_night:   "It's getting late. Most devices should be off. Should I check the house?",
    };

    if (greetings[period] && lastGreetedPeriodRef.current !== period) {
      lastGreetedPeriodRef.current = period;
      speak(greetings[period]);
      setReasoning({ message: greetings[period], detail: "" });
    }

    // Fire any pending voice commands that fall within this time window
    const triggered: typeof pendingCommands = [];
    const remaining: typeof pendingCommands = [];
    pendingCommandsRef.current.forEach((cmd) => {
      if (minutes >= cmd.targetMinutes && minutes <= cmd.targetMinutes + 60) {
        triggered.push(cmd);
      } else {
        remaining.push(cmd);
      }
    });
    if (triggered.length > 0) {
      setPendingCommands(remaining);
      showToast("Executed scheduled voice command!", "success");
    }

    setHouseState((prev) => {
      const nextDevices = { ...prev.devices };
      triggered.forEach((cmd) => { nextDevices[cmd.deviceId] = cmd.state; });
      const next = { ...prev, devices: nextDevices, time };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        setDeviceOnTimes((onTimes) => { sendStateToAI(next, onTimes); return onTimes; });
      }, 800);
      return next;
    });

    // Check active automations immediately when slider moves
    checkAutomations(minutes);
  }, [sendStateToAI, checkAutomations, speak, showToast]);

  const formatTimeDisplay = (time: string) => {
    const [hStr, mStr] = time.split(":");
    const h    = parseInt(hStr);
    const ampm = h < 12 ? "AM" : "PM";
    const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${String(h12).padStart(2, "0")}:${mStr} ${ampm}`;
  };

  const timeMinutes = (() => {
    const [h, m] = houseState.time.split(":").map(Number);
    return h * 60 + m;
  })();

  // ── YAMNet audio event handler ─────────────────────────
  const handleAudioEvent = useCallback((classification: string) => {
    const roomMap: Partial<Record<string, { roomId: RoomId; type: AlertType }>> = {
      baby_crying:             { roomId: "bedroom", type: "attention" },
      glass_break:             { roomId: "living",  type: "danger" },
      smoke_alarm:             { roomId: "kitchen", type: "danger" },
      pressure_cooker_whistle: { roomId: "kitchen", type: "attention" },
      washing_machine_done:    { roomId: "utility", type: "info" },
      doorbell:                { roomId: "living",  type: "info" },
      morning_puja_bell:       { roomId: "bedroom", type: "info" },
      water_motor_on:          { roomId: "utility", type: "info" },
      study_hour_silence:      { roomId: "study",   type: "info" },
      power_cut:               { roomId: "living",  type: "attention" },
      evening_conversation:    { roomId: "living",  type: "info" },
    };
    const mapped     = roomMap[classification] ?? { roomId: "living" as RoomId, type: "info" as AlertType };
    const audioEvent: AudioEvent = { roomId: mapped.roomId, type: mapped.type, label: classification };
    setHouseState((prev) => {
      const next = { ...prev, audioEvents: [audioEvent] };
      setDeviceOnTimes((onTimes) => { sendStateToAI(next, onTimes); return onTimes; });
      return next;
    });
    setTimeout(() => { setHouseState((prev) => ({ ...prev, audioEvents: [] })); }, 8000);
  }, [sendStateToAI]);

  // ── Room alert CSS class ───────────────────────────────
  const getRoomAlertClass = (roomId: RoomId) => {
    const ev = houseState.audioEvents.find((e) => e.roomId === roomId);
    if (!ev) return "";
    return ev.type === "danger" ? "room-alert-danger" : ev.type === "attention" ? "room-alert-attention" : "room-alert-info";
  };

  // ─────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        :root{
          --bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;
          --muted:#374151;--text:#e5e7eb;--text-dim:#6b7280;
          --amber:#f59e0b;--green:#10b981;--blue:#3b82f6;--red:#ef4444;
        }
        body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden;display:flex;flex-direction:column}

        /* ── Navbar ── */
        .navbar{background:var(--surface);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;gap:20px;flex-shrink:0;height:56px}
        .nav-brand{font-size:15px;font-weight:700;color:#fff;white-space:nowrap;flex-shrink:0}
        .nav-slider-wrap{flex:1;display:flex;align-items:center;gap:12px;min-width:0}
        .time-label{font-size:12px;font-weight:600;color:var(--amber);white-space:nowrap;min-width:72px;text-align:center}
        input[type="range"]{flex:1;height:4px;accent-color:var(--amber);cursor:pointer;background:var(--border);border-radius:4px}
        .time-range-labels{display:flex;justify-content:space-between;gap:8px}
        .time-range-labels span{font-size:10px;color:var(--text-dim);white-space:nowrap}
        .nav-right{flex-shrink:0;display:flex;align-items:center;gap:10px}

        .seed-btn{height:28px;padding:0 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;color:var(--amber);display:flex;align-items:center;gap:5px;transition:background .2s,border-color .2s;white-space:nowrap}
        .seed-btn:hover{background:rgba(245,158,11,0.18);border-color:rgba(245,158,11,0.5)}
        .seed-btn:disabled{opacity:0.45;cursor:not-allowed}

        /* ── Layout ── */
        .app{flex:1;display:flex;min-height:0;overflow:hidden}

        /* ── Floor plan ── */
        .floorplan{flex:1;padding:20px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1.1fr 1fr;gap:12px;min-width:0;overflow:hidden}
        .room{background:var(--surface);border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;position:relative;transition:border-color .3s}
        .room.wide{grid-column:1/3}
        .room-alert-danger{border:2px solid var(--red)!important;animation:pulse-border 1.5s infinite}
        .room-alert-attention{border:2px solid var(--amber)!important;animation:pulse-border 1.5s infinite}
        .room-alert-info{border:2px solid var(--blue)!important;animation:pulse-border 1.5s infinite}
        @keyframes pulse-border{0%,100%{opacity:1}50%{opacity:0.45}}
        .room-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px;border-bottom:1px solid var(--border);flex-shrink:0}
        .room-name{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim)}
        .room-alert-tag{display:none;font-size:10px;font-weight:600;border-radius:20px;padding:2px 8px}
        .room-alert-danger .room-alert-tag{display:block;color:#fca5a5;background:rgba(239,68,68,.15);border:1px solid #ef4444}
        .room-alert-attention .room-alert-tag{display:block;color:#fcd34d;background:rgba(245,158,11,.15);border:1px solid #f59e0b}
        .room-alert-info .room-alert-tag{display:block;color:#93c5fd;background:rgba(59,130,246,.15);border:1px solid #3b82f6}

        /* ── Devices ── */
        .devices{flex:1;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:14px;padding:14px}
        .wide .devices{justify-content:space-evenly}
        .device{display:flex;flex-direction:column;align-items:center;gap:7px;cursor:pointer;user-select:none;border:none;background:none;padding:0}
        .device-btn{width:52px;height:52px;border-radius:14px;background:var(--muted);border:1px solid transparent;display:flex;align-items:center;justify-content:center;transition:background .25s,border-color .25s,box-shadow .25s;cursor:pointer;font-size:22px;line-height:1}
        .device-label{font-size:10.5px;font-weight:500;color:var(--text-dim);transition:color .25s;white-space:nowrap}
        .device-btn span{filter:grayscale(1) opacity(0.55);transition:filter .25s}
        .device-btn svg{color:#6b7280;transition:color .25s}
        .device-on .device-btn{background:rgba(245,158,11,0.12);border-color:var(--amber);box-shadow:0 0 12px rgba(245,158,11,0.5)}
        .device-on .device-btn span{filter:none}
        .device-on .device-btn svg{color:#f59e0b}
        .device-on .device-label{color:var(--amber);font-weight:600}

        /* ── Sidebar ── */
        .sidebar{width:310px;flex-shrink:0;background:var(--bg);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow-y:auto;padding:16px 14px;gap:12px}
        .sidebar-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;flex-shrink:0}
        .card-title{font-size:12px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:7px}
        .pulse-dot{width:8px;height:8px;background:var(--blue);border-radius:50%;animation:pulseDot 1.6s ease-in-out infinite;flex-shrink:0}
        @keyframes pulseDot{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.5);opacity:.5}}
        .card-body{font-size:12.5px;color:#9ca3af;font-style:italic;line-height:1.5}
        .card-body-detail{font-size:11px;color:var(--text-dim);font-style:italic;line-height:1.4;margin-top:-4px}
        .empty-state{font-size:12px;color:var(--text-dim);font-style:italic}
        .auto-item{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
        .auto-item-name{font-size:12px;font-weight:600;color:var(--text)}
        .auto-item-desc{font-size:11px;color:var(--text-dim)}
        .auto-item-btns{display:flex;gap:6px;margin-top:2px}
        .active-item{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)}
        .active-item:last-child{border-bottom:none}
        .active-item-left{display:flex;align-items:center;gap:7px}
        .active-dot{width:7px;height:7px;background:var(--green);border-radius:50%;flex-shrink:0}
        .active-name{font-size:12px;color:var(--text)}
        .btn-green{background:var(--green);color:#fff;border:none;border-radius:20px;font-size:11px;font-weight:600;padding:5px 12px;cursor:pointer;transition:background .2s}
        .btn-green:hover{background:#059669}
        .btn-muted{background:var(--muted);color:#9ca3af;border:1px solid var(--border);border-radius:20px;font-size:11px;font-weight:600;padding:5px 12px;cursor:pointer;transition:background .2s}
        .btn-muted:hover{background:#4b5563}
        .btn-remove{background:rgba(239,68,68,.12);color:#f87171;border:1px solid #ef4444;border-radius:20px;font-size:10px;font-weight:600;padding:3px 10px;cursor:pointer}
        .pattern-row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)}
        .pattern-row:last-child{border-bottom:none}
        .pattern-left{display:flex;flex-direction:column;gap:2px}
        .pattern-name{font-size:11.5px;color:var(--text);font-weight:500}
        .pattern-time{font-size:10px;color:var(--text-dim)}
        .badge{font-size:10px;font-weight:700;border-radius:20px;padding:3px 9px;color:#fff}
        .badge-high{background:var(--green)}
        .badge-medium{background:var(--amber)}
        .badge-low{background:var(--text-dim)}
        .yamnet-wrap{padding-top:8px;border-top:1px solid var(--border)}

        /* ── Toast ── */
        @keyframes toastIn{from{transform:translateX(120px);opacity:0}to{transform:translateX(0);opacity:1}}
      `}</style>

      {/* ── NAVBAR ─────────────────────────────────────── */}
      <nav className="navbar">
        <span className="nav-brand">⚡ Alexa Ambient</span>

        {/* Full 24h time slider — FROM main-2 */}
        <div className="nav-slider-wrap">
          <span className="time-label">{formatTimeDisplay(houseState.time)}</span>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <input
              type="range" min={0} max={1439} step={15}
              value={timeMinutes}
              onChange={(e) => handleTimeChange(parseInt(e.target.value))}
              style={{ flex: 1, height: 4, accentColor: "#f59e0b", cursor: "pointer" }}
            />
            <div className="time-range-labels"><span>12:00 AM</span><span>11:59 PM</span></div>
          </div>
        </div>

        <div className="nav-right">
          <button className="seed-btn" onClick={handleSeed} disabled={isSeedLoading} title="Seed 5 days of realistic household data into DynamoDB">
            {isSeedLoading ? "⏳" : "🌱"} {isSeedLoading ? "Seeding..." : "Seed Demo"}
          </button>
          <AlexaVoiceController
            houseState={houseState}
            onDeviceCommand={handleDeviceCommand}
            onAIResponse={handleVoiceAIResponse}
          />
        </div>
      </nav>

      {/* ── MAIN ───────────────────────────────────────── */}
      <div className="app">

        {/* ── FLOOR PLAN ─────────────────────────────────── */}
        <div className="floorplan">
          {ROOMS.map((room) => (
            <div
              key={room.id}
              className={`room${room.wide ? " wide" : ""} ${getRoomAlertClass(room.id)}`}
              data-room-id={room.id}
            >
              <div className="room-header">
                <span className="room-name">{room.label}</span>
                <span className="room-alert-tag">
                  {houseState.audioEvents.find((e) => e.roomId === room.id)?.label.replace(/_/g, " ") || "Alert"}
                </span>
              </div>
              <div className="devices">
                {room.devices.map((deviceId) => {
                  const cfg   = DEVICE_CONFIG[deviceId];
                  const isOn  = houseState.devices[deviceId];
                  const isFan = cfg.icon === "fan";
                  return (
                    <button
                      key={deviceId}
                      className={`device${isFan ? " fan-device" : ""}${isOn ? " device-on" : ""}`}
                      onClick={() => toggleDevice(deviceId)}
                      aria-label={cfg.label}
                      data-device-id={deviceId}
                    >
                      <div className="device-btn">
                        {isFan ? <FanIcon spinning={isOn} /> : <span>{cfg.icon}</span>}
                      </div>
                      <span className="device-label">{cfg.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* ── SIDEBAR ─────────────────────────────────────── */}
        <aside className="sidebar">

          {/* Card 1: AI Reasoning — FROM thinking-and-suggestion: "Thinking..." state */}
          <div className="sidebar-card">
            <div className="card-title">
              <span className="pulse-dot" style={{ opacity: isThinking ? 1 : 0.3 }}></span>
              🧠 Alexa is Thinking...
            </div>
            <p className="card-body">{reasoning.message}</p>
            {reasoning.detail && <p className="card-body-detail">💡 {reasoning.detail}</p>}
          </div>

          {/* Card 2: Suggested Automations — FROM thinking-and-suggestion */}
          <div className="sidebar-card">
            <div className="card-title">⚡ Suggested Automations</div>
            {suggested.length === 0 ? (
              <p className="empty-state">Trigger some events to see AI suggestions</p>
            ) : (
              suggested.map((a) => (
                <div key={a.id} className="auto-item">
                  <div className="auto-item-name">{a.name}</div>
                  <div className="auto-item-desc">{a.trigger} → {a.action}</div>
                  <div className="auto-item-desc" style={{ fontStyle: "italic", color: "#6b7280" }}>
                    💡 {a.reasoning}
                  </div>
                  <div className="auto-item-btns">
                    <button className="btn-green" onClick={() => handleAutomateThis(a)}>
                      Automate This
                    </button>
                    <button className="btn-muted" onClick={() => setSuggested((p) => p.filter((x) => x.id !== a.id))}>
                      Dismiss
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Card 3: Active Automations — with trigger time label */}
          <div className="sidebar-card">
            <div className="card-title">✅ Active Automations</div>
            {active.length === 0 ? (
              <p className="empty-state">No automations active yet</p>
            ) : (
              active.map((a) => (
                <div key={a.id} className="active-item">
                  <div className="active-item-left">
                    <span className="active-dot"></span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span className="active-name">{a.name}</span>
                      {getAutomationTimeLabel(a) && (
                        <span style={{ fontSize: 10, color: "var(--amber)", fontWeight: 600 }}>
                          ⏰ {getAutomationTimeLabel(a)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button className="btn-remove" onClick={() => handleRemoveAutomation(a.id)}>
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Card 4: Household Patterns */}
          <div className="sidebar-card">
            <div className="card-title">📊 Household Patterns</div>
            {patterns.map((r, i) => (
              <div key={i} className="pattern-row">
                <div className="pattern-left">
                  <span className="pattern-name">{r.event.replace(/_/g, " ")}</span>
                  <span className="pattern-time">{r.typical_window} · {r.occurrences}x</span>
                </div>
                <span className={`badge badge-${r.confidence}`}>{r.confidence}</span>
              </div>
            ))}
          </div>

          {/* Card 5: YAMNet Audio Monitor */}
          <div className="sidebar-card">
            <div className="card-title">🎙️ Audio Monitor</div>
            <div className="yamnet-wrap">
              <YAMNetAudioMonitor onEventDetected={handleAudioEvent} />
            </div>
          </div>

        </aside>
      </div>

      {/* ── Toast notification ─────────────────────────── */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24,
          background: toast.type === "error" ? "var(--red)" : "var(--green)",
          color: "#fff", padding: "12px 20px", borderRadius: 10,
          fontSize: 13, fontWeight: 600, zIndex: 9999,
          boxShadow: "0 4px 28px rgba(0,0,0,0.55)", animation: "toastIn 0.3s ease",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {toast.type === "error" ? "❌" : "✅"} {toast.message}
        </div>
      )}
    </>
  );
}
