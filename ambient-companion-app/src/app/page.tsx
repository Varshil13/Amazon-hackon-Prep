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
interface SuggestedAutomation { id: string; name: string; trigger: string; action: string; reasoning: string; device?: string; time?: string; }
interface ActiveAutomation    { id: string; name: string; trigger: string; action: string; reasoning: string; userApproved?: boolean; time?: string; device?: string; }
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

// ─── Queue builder helper ─────────────────────────────────
// Builds dailyQueue entries from an automation — handles multiple time formats:
// 1. action field: "on at 07:00" / "off at 07:00"
// 2. action field: "turn on X at 7 AM"
// 3. top-level time field (stored separately in DB)
function buildQueueFromAutomation(
  auto: { id: string; name: string; trigger: string; action: string; time?: string; device?: string },
  deviceConfig: Record<string, { label: string; room: string }>
): { time: string; device: string; action: boolean }[] {
  const results: { time: string; device: string; action: boolean }[] = [];

  // Priority 1: use explicit device field if it's a valid device ID
  const explicitDevice = auto.device && deviceConfig[auto.device] ? auto.device : null;

  // Detect device from name or action — sort by length desc to match longer names first
  const findDevice = (text: string): string | null => {
    const lower = text.toLowerCase();
    const sortedDevices = Object.keys(deviceConfig).sort((a, b) => b.length - a.length);
    for (const deviceId of sortedDevices) {
      const slug = deviceId.replace(/_/g, " ");
      const label = (deviceConfig[deviceId] as { label: string }).label.toLowerCase();
      // For short tokens (<=3 chars like "ac", "tv"), require word boundary to avoid false substring matches
      const needsBoundary = slug.length <= 3 || label.length <= 3;
      if (needsBoundary) {
        const re = new RegExp(`\\b${slug}\\b`);
        const reLabel = new RegExp(`\\b${label}\\b`);
        if (re.test(lower) || reLabel.test(lower)) return deviceId;
      } else {
        if (lower.includes(slug) || lower.includes(label)) return deviceId;
      }
    }
    return null;
  };

  const deviceId = explicitDevice ?? findDevice(auto.name) ?? findDevice(auto.action);
  if (!deviceId) return results;

  // Detect on/off state from action text
  const lower = auto.action.toLowerCase();
  const isOn  = lower.includes("turn on") || lower.includes("switch on") ||
                lower.includes("enable")  || lower.includes("activate") || lower.includes("start");
  const isOff = lower.includes("turn off") || lower.includes("switch off") ||
                lower.includes("disable") || lower.includes("deactivate") || lower.includes("stop");

  // Try format 1: explicit "on at 07:00" / "off at 07:00" or "turn on at 07:00" / "turn off at 07:00"
  const strictMatches = [...auto.action.matchAll(/(turn\s+)?(on|off)\s+at\s+(\d{1,2}:\d{2})/gi)];
  if (strictMatches.length > 0) {
    strictMatches.forEach((m) => {
      const actionWord = m[2].toLowerCase(); // "on" or "off"
      results.push({ time: m[3], device: deviceId, action: actionWord === "on" });
    });
    return results;
  }

  // Try format 2: "at HH:MM" — only add if intent is clear (isOn XOR isOff)
  const fullText = `${auto.action} ${auto.name} ${auto.trigger}`;
  const timeMatches = [...fullText.matchAll(/at\s+(\d{1,2}:\d{2})/gi)];
  if (timeMatches.length > 0 && (isOn || isOff) && !(isOn && isOff)) {
    timeMatches.forEach((m) => {
      results.push({ time: m[1], device: deviceId, action: isOn });
    });
    return results;
  }

  // Try format 3: "at H AM/PM" — only add if intent is clear (isOn XOR isOff)
  const ampmMatches = [...fullText.matchAll(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi)];
  if (ampmMatches.length > 0 && (isOn || isOff) && !(isOn && isOff)) {
    ampmMatches.forEach((m) => {
      let h = parseInt(m[1]);
      const mins = m[2] ? parseInt(m[2]) : 0;
      const period = m[3].toLowerCase();
      if (period === "pm" && h !== 12) h += 12;
      if (period === "am" && h === 12) h = 0;
      const time = `${String(h).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
      results.push({ time, device: deviceId, action: isOn });
    });
    return results;
  }

  // Try format 4: top-level time field stored in DB — only if intent is unambiguous
  if (auto.time && (isOn || isOff) && !(isOn && isOff)) {
    results.push({ time: auto.time, device: deviceId, action: isOn });
    return results;
  }

  return results;
}

// ─── Main Page ────────────────────────────────────────────
export default function Home() {
  const [houseState, setHouseState] = useState<HouseState>({
    devices: initialDevices,
    time: "00:00",
    audioEvents: [],
  });
  const [isThinking, setIsThinking]   = useState(false);
  const [reasoning, setReasoning]     = useState({ message: "Waiting for activity...", detail: "" });
  const [suggested, setSuggested]     = useState<SuggestedAutomation[]>([]);
  const [active, setActive]           = useState<ActiveAutomation[]>([]);
  const [patterns, setPatterns]       = useState<RoutinePattern[]>([]);
  const [pendingAutomationAsk, setPendingAutomationAsk] = useState<string | null>(null);
  const [toast, setToast]             = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  // Scheduled voice commands — fired when time slider reaches targetMinutes
  const [pendingCommands, setPendingCommands] = useState<{ deviceId: DeviceId; state: boolean; targetMinutes: number }[]>([]);
  // Tracks the slider-minute at which each device was turned ON — used for anomaly detection
  const [deviceOnTimes, setDeviceOnTimes] = useState<Partial<Record<DeviceId, number>>>({});
  const [currentDay, setCurrentDay] = useState(1);
  const currentDayRef = useRef(1);
  useEffect(() => { currentDayRef.current = currentDay; }, [currentDay]);
  // Queue of automation actions for today, sorted by time
  const [dailyQueue, setDailyQueue] = useState<{ time: string; device: DeviceId; action: boolean }[]>([]);
  const dailyQueueRef = useRef(dailyQueue);
  useEffect(() => { dailyQueueRef.current = dailyQueue; }, [dailyQueue]);
  // Track which queue items have already fired today (by "device_time" key) — reset on day change
  const firedTodayRef = useRef<Set<string>>(new Set());

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
      .then((d) => {
        if (d.success && d.automations?.length) {
          // Only load user-approved automations into active state
          const approved = d.automations.filter((a: ActiveAutomation) => a.userApproved);
          setActive(approved);
          const queue = approved
            .flatMap((auto: ActiveAutomation) => buildQueueFromAutomation(auto, DEVICE_CONFIG))
            .sort((a: { time: string }, b: { time: string }) => a.time.localeCompare(b.time));
          if (queue.length > 0) setDailyQueue(queue);
        }
      })
      .catch(() => {});
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

    if (!matched) return;
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
    const isCurrentlyOn = latestStateRef.current.devices[deviceId];
    const toHHMM = (m: number) => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;

    // 1. Log to PossibleAutomations — outside setState to avoid duplicate calls
    fetch("/api/possible-automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device: deviceId,
        action: isCurrentlyOn ? "off" : "on",
        time: toHHMM(currentMinutes),
        day: currentDayRef.current,
      }),
    }).catch(() => {});

    // 2. If turning OFF a tracked device → also save the on/off session pair
    if (isCurrentlyOn) {
      setDeviceOnTimes((prev) => {
        if (prev[deviceId] !== undefined) {
          const onMinutes = prev[deviceId]!;
          fetch("/api/event/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              device: deviceId,
              on_time: toHHMM(onMinutes),
              off_time: toHHMM(currentMinutes),
              duration_minutes: currentMinutes >= onMinutes ? currentMinutes - onMinutes : currentMinutes + 1440 - onMinutes,
              day: currentDayRef.current,
            }),
          }).catch(() => {});
        }
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    } else {
      setDeviceOnTimes((prev) => ({ ...prev, [deviceId]: currentMinutes }));
    }

    // 3. Toggle device state
    setHouseState((prev) => ({
      ...prev,
      devices: { ...prev.devices, [deviceId]: !prev.devices[deviceId] },
    }));
  }, []);

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
      const [h, m] = latestStateRef.current.time.split(":").map(Number);
      const currentMinutes = h * 60 + m;
      const toHHMM = (mins: number) => `${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;

      if (state) {
        // Turning ON — track start time
        setDeviceOnTimes((prev) => ({ ...prev, [deviceId]: currentMinutes }));
      } else {
        // Turning OFF — save session pair if we tracked an ON time
        setDeviceOnTimes((prev) => {
          if (prev[deviceId] !== undefined) {
            const onMinutes = prev[deviceId]!;
            fetch("/api/event/session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                device: deviceId,
                on_time: toHHMM(onMinutes),
                off_time: toHHMM(currentMinutes),
                duration_minutes: currentMinutes >= onMinutes ? currentMinutes - onMinutes : currentMinutes + 1440 - onMinutes,
                day: currentDayRef.current,
              }),
            }).catch(() => {});
          }
          const next = { ...prev };
          delete next[deviceId];
          return next;
        });
      }
      setHouseState((prev) => ({
        ...prev,
        devices: { ...prev.devices, [deviceId]: state },
      }));
    }
  }, [showToast]);

  // ── Log voice-executed device events to PossibleAutomations ──
  const handleLogVoiceDeviceEvent = useCallback((deviceId: DeviceId, action: "on" | "off") => {
    const [h, m] = latestStateRef.current.time.split(":").map(Number);
    const toHHMM = (mins: number) => `${String(Math.floor(mins/60)).padStart(2,"0")}:${String(mins%60).padStart(2,"0")}`;
    fetch("/api/possible-automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device: deviceId,
        action,
        time: toHHMM(h * 60 + m),
        day: currentDayRef.current,
      }),
    }).catch(() => {});
  }, []);

  // ── Handle AI response from voice controller ───────────
  const handleVoiceAIResponse = useCallback((message: string, detail: string) => {
    setReasoningAndSpeak({ message, detail });
  }, [setReasoningAndSpeak]);

  // ── Handle automation update from voice command ────────
  // Called when LLM returns action_type="automation_update" with updated_automations list
  const handleVoiceAutomationUpdate = useCallback(async (updatedAutomations: ActiveAutomation[]) => {
    // Voice-requested automations are always user-approved
    // Extract time from action text and store in time field for reliable queue building
    const voiceApproved = updatedAutomations.map((a) => {
      // Try to extract time from action string e.g. "turn on at 07:00" or "on at 7 AM"
      let extractedTime: string | undefined;
      const strictMatch = a.action.match(/(on|off)\s+at\s+(\d{1,2}:\d{2})/i);
      if (strictMatch) {
        extractedTime = strictMatch[2];
      } else {
        const ampmMatch = a.action.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
        if (ampmMatch) {
          let h = parseInt(ampmMatch[1]);
          const mins = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0;
          if (ampmMatch[3].toLowerCase() === "pm" && h !== 12) h += 12;
          if (ampmMatch[3].toLowerCase() === "am" && h === 12) h = 0;
          extractedTime = `${String(h).padStart(2,"0")}:${String(mins).padStart(2,"0")}`;
        } else {
          const hhmmMatch = a.action.match(/at\s+(\d{1,2}:\d{2})/i);
          if (hhmmMatch) extractedTime = hhmmMatch[1];
        }
      }
      return { ...a, userApproved: true, ...(extractedTime ? { time: extractedTime } : {}) };
    });

    // Merge: keep existing automations, update/add voice ones
    // Dedupe by signature (device + on/off + time) — LLM sometimes returns duplicates
    const sigOf = (a: ActiveAutomation): string => {
      const isOn = a.action.toLowerCase().includes("on at") ||
                   a.action.toLowerCase().startsWith("on ") ||
                   a.action.toLowerCase().includes("turn on");
      const timeMatch = a.action.match(/(\d{1,2}:\d{2})/) || (a.time ? [a.time, a.time] : null);
      const time = timeMatch ? timeMatch[1] : "";
      const dev = a.device || a.name.toLowerCase();
      return `${dev}_${isOn ? "on" : "off"}_${time}`;
    };

    const merged = [...activeRef.current];
    voiceApproved.forEach((va) => {
      const vaSig = sigOf(va);
      const idx = merged.findIndex((a) => sigOf(a) === vaSig);
      if (idx >= 0) {
        merged[idx] = va; // same device + action + time → update, no duplicate
      } else {
        merged.push(va); // genuinely new automation
      }
    });

    // 1. Update frontend state
    setActive(merged);

    // 2. Persist to DynamoDB via PATCH (full replace)
    try {
      await fetch("/api/automations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automations: merged }),
      });
    } catch { /* silent */ }

    // 3. Rebuild dailyQueue from merged automations
    const queue = merged
      .flatMap(auto => buildQueueFromAutomation(auto, DEVICE_CONFIG))
      .sort((a, b) => a.time.localeCompare(b.time));
    setDailyQueue(queue as { time: string; device: DeviceId; action: boolean }[]);
  }, []);

  // ── Optimistic "Automate This" with POST + rollback ────
  const handleAutomateThis = useCallback(async (automation: SuggestedAutomation) => {
    const newActive: ActiveAutomation = {
      id: automation.id,
      name: automation.name,
      trigger: automation.trigger,
      action: automation.action,
      reasoning: automation.reasoning,
      userApproved: true,
      ...(automation.device ? { device: automation.device } : {}),
      ...(automation.time ? { time: automation.time } : {}),
    };
    setActive((prev) => {
      const updated = [...prev, newActive];

      // Immediately add to dailyQueue so it works same day
      const queue = updated
        .filter(a => a.userApproved)
        .flatMap(auto => buildQueueFromAutomation(auto, DEVICE_CONFIG))
        .sort((a, b) => a.time.localeCompare(b.time));
      setDailyQueue(queue as { time: string; device: DeviceId; action: boolean }[]);

      return updated;
    });
    setSuggested((prev) => prev.filter((x) => x.id !== automation.id));
    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...newActive }),
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

  // ── Day change — advance/retreat day, call day-start LLM, build queue ──
  const handleDayChange = useCallback(async (newDay: number) => {
    if (newDay < 1) return;
    setCurrentDay(newDay);
    firedTodayRef.current = new Set();
    setHouseState((prev) => ({ ...prev, time: "00:00", audioEvents: [] }));
    setReasoning({ message: `Day ${newDay} starting... Alexa is analyzing patterns.`, detail: "" });

    // ── STEP 1: Fetch fresh active automations from DB and build queue ──
    try {
      const automRes = await fetch("/api/automations");
      const automData = await automRes.json();
      if (automData.success && automData.automations?.length > 0) {
        // Only load user-approved automations into active state
        const approved = automData.automations.filter((a: ActiveAutomation) => a.userApproved);
        setActive(approved);
        const queue = approved
          .flatMap((auto: ActiveAutomation) => buildQueueFromAutomation(auto, DEVICE_CONFIG))
          .sort((a: { time: string }, b: { time: string }) => a.time.localeCompare(b.time));
        setDailyQueue(queue as { time: string; device: DeviceId; action: boolean }[]);
      }
    } catch { /* silent — use existing activeRef if fetch fails */ }

    // ── STEP 2: Call day-start for LLM suggestions ──
    try {
      const res = await fetch("/api/day-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: newDay }),
      });
      const data = await res.json();
      if (data.success && data.automations?.length > 0) {
        // LLM suggestions → suggested panel only, filter already-active
        const activeIds = new Set(activeRef.current.map((a) => a.id));
        const activeNames = new Set(activeRef.current.map((a) => a.name.toLowerCase()));
        const newSuggested = data.automations
          .map((a: { id: string; name: string; trigger: string; action: string; reasoning: string; device?: string; schedule?: { action: string; time: string }[] }) => ({
            id: a.id,
            name: a.name,
            trigger: a.trigger ?? `Day ${newDay}`,
            action: a.schedule ? a.schedule.map((s: { action: string; time: string }) => `${s.action} at ${s.time}`).join(", ") : a.action,
            reasoning: a.reasoning,
            device: a.device,
            time: a.schedule?.[0]?.time,
          }))
          .filter((a: { id: string; name: string }) =>
            !activeIds.has(a.id) && !activeNames.has(a.name.toLowerCase())
          );
        setSuggested(newSuggested);
        const msg = newSuggested.length > 0
          ? `Day ${newDay} ready. ${newSuggested.length} new automation${newSuggested.length > 1 ? "s" : ""} suggested — check the suggestions panel.`
          : `Day ${newDay} ready. Your ${activeRef.current.length} automation${activeRef.current.length > 1 ? "s are" : " is"} scheduled.`;
        speak(msg);
        setReasoning({ message: msg, detail: newSuggested.map((a: { name: string }) => a.name).join(", ") });
      } else {
        const msg = `Day ${newDay} ready. ${activeRef.current.length > 0 ? `${activeRef.current.length} automation${activeRef.current.length > 1 ? "s" : ""} scheduled.` : "Keep using devices manually — I'm learning your patterns."}`;
        speak(msg);
        setReasoning({ message: msg, detail: "" });
      }
    } catch {
      setReasoning({ message: `Day ${newDay} started.`, detail: "" });
    }
  }, [speak]);

  // ── Hardcoded power/heating appliance overuse checker ──
  const DEVICE_THRESHOLDS: Partial<Record<DeviceId, { maxMinutes: number; label: string }>> = {
    geyser:          { maxMinutes: 30,  label: "Geyser" },
    induction:       { maxMinutes: 60,  label: "Induction" },
    microwave:       { maxMinutes: 30,  label: "Microwave" },
    ac:              { maxMinutes: 120, label: "AC" },
    washing_machine: { maxMinutes: 90,  label: "Washing Machine" },
    water_motor:     { maxMinutes: 30,  label: "Water Motor" },
  };
  const warnedDevicesRef = useRef<Set<DeviceId>>(new Set());

  const checkDeviceOveruse = useCallback((currentMinutes: number) => {
    Object.entries(DEVICE_THRESHOLDS).forEach(([deviceId, config]) => {
      const id = deviceId as DeviceId;
      const onSince = deviceOnTimes[id];
      if (onSince === undefined) {
        warnedDevicesRef.current.delete(id);
        return;
      }
      if (warnedDevicesRef.current.has(id)) return;
      const onForMinutes = currentMinutes >= onSince
        ? currentMinutes - onSince
        : currentMinutes + 1440 - onSince;
      if (onForMinutes >= config.maxMinutes) {
        warnedDevicesRef.current.add(id);
        const hrs = Math.floor(onForMinutes / 60);
        const mins = onForMinutes % 60;
        const duration = hrs > 0
          ? `${hrs} hour${hrs > 1 ? "s" : ""}${mins > 0 ? ` ${mins} minutes` : ""}`
          : `${mins} minutes`;
        const msg = `${config.label} has been on for ${duration}. You may want to switch it off.`;
        speak(msg);
        setReasoning({ message: `⚠️ ${msg}`, detail: "Power usage alert — hardcoded safety check." });
      }
    });
  }, [deviceOnTimes, speak]);

  // ── Time slider ────────────────────────────────────────
  // Full 24h range (0–1439), time-period greetings, pending command execution, checkAutomations
  const handleTimeChange = useCallback((minutes: number) => {
    const h    = Math.floor(minutes / 60);
    const m    = minutes % 60;
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

    // Fire daily queue items whose time the slider has crossed
    const queueTriggered: typeof dailyQueue = [];
    dailyQueueRef.current.forEach((item) => {
      const [ih, im] = item.time.split(":").map(Number);
      const itemMinutes = ih * 60 + im;
      const fireKey = `${item.device}_${item.time}`;
      // Trigger only if within window AND not already fired today
      if (minutes >= itemMinutes && minutes <= itemMinutes + 15 && !firedTodayRef.current.has(fireKey)) {
        queueTriggered.push(item);
        firedTodayRef.current.add(fireKey);
      }
    });
    if (queueTriggered.length > 0) {
      // Do NOT remove from dailyQueue — items stay so they can fire next day too
      queueTriggered.forEach((item) => {
        const label = DEVICE_CONFIG[item.device]?.label ?? item.device;
        const msg = `Turning ${item.action ? "on" : "off"} ${label} as part of your daily routine.`;
        speak(msg);
        setReasoning({ message: `🤖 ${msg}`, detail: "Automated by Alexa based on learned patterns." });
      });
    }

    // Fire pending voice commands whose target time the slider has reached
    const triggered: typeof pendingCommands = [];
    const remaining: typeof pendingCommands = [];
    pendingCommandsRef.current.forEach((cmd) => {
      if (minutes >= cmd.targetMinutes && minutes <= cmd.targetMinutes + 15) {
        triggered.push(cmd);
      } else {
        remaining.push(cmd);
      }
    });
    if (triggered.length > 0) {
      setPendingCommands(remaining);
      triggered.forEach((cmd) => {
        const label = DEVICE_CONFIG[cmd.deviceId]?.label ?? cmd.deviceId;
        const action = cmd.state ? "on" : "off";
        const msg = `Turning ${action} the ${label} as scheduled.`;
        speak(msg);
        setReasoning({ message: `⏰ ${msg}`, detail: "Scheduled voice command executed." });
      });
    }

    // Update time in state
    setHouseState((prev) => {
      const nextDevices = { ...prev.devices };
      triggered.forEach((cmd) => { nextDevices[cmd.deviceId] = cmd.state; });
      queueTriggered.forEach((item) => { nextDevices[item.device] = item.action; });
      return { ...prev, devices: nextDevices, time };
    });

    // Check active automations when slider moves
    checkAutomations(minutes);
    // Check for power/heating appliance overuse (hardcoded, no LLM)
    checkDeviceOveruse(minutes);
  }, [checkAutomations, checkDeviceOveruse, speak, showToast]);

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
        .nav-slider-wrap{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;min-width:0}
        .time-label{font-size:13px;font-weight:700;color:var(--amber);white-space:nowrap;min-width:90px;text-align:center}
        .nav-right{flex-shrink:0;display:flex;align-items:center;gap:10px}

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
        <span className="nav-brand">⚡ Alexa companion</span>

        {/* Day arrows */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => handleDayChange(currentDay - 1)}
            disabled={currentDay <= 1}
            style={{ background: "var(--muted)", border: "none", borderRadius: 6, width: 28, height: 28, cursor: currentDay <= 1 ? "not-allowed" : "pointer", color: "var(--text)", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", opacity: currentDay <= 1 ? 0.4 : 1 }}
            title="Previous day"
          >◀</button>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--blue)", whiteSpace: "nowrap", minWidth: 52, textAlign: "center" }}>Day {currentDay}</span>
          <button
            onClick={() => handleDayChange(currentDay + 1)}
            style={{ background: "var(--muted)", border: "none", borderRadius: 6, width: 28, height: 28, cursor: "pointer", color: "var(--text)", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}
            title="Next day"
          >▶</button>
        </div>

        {/* Time arrows */}
        <div className="nav-slider-wrap">
          <button
            onClick={() => handleTimeChange(Math.max(0, timeMinutes - 15))}
            style={{ background: "var(--muted)", border: "none", borderRadius: 6, width: 28, height: 28, cursor: "pointer", color: "var(--text)", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            title="Previous 15 min"
          >◀</button>
          <span className="time-label" style={{ minWidth: 90, textAlign: "center" }}>{formatTimeDisplay(houseState.time)}</span>
          <button
            onClick={() => handleTimeChange(Math.min(1439, timeMinutes + 15))}
            style={{ background: "var(--muted)", border: "none", borderRadius: 6, width: 28, height: 28, cursor: "pointer", color: "var(--text)", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            title="Next 15 min"
          >▶</button>
        </div>

        <div className="nav-right">
          <AlexaVoiceController
            houseState={houseState}
            onDeviceCommand={handleDeviceCommand}
            onAIResponse={handleVoiceAIResponse}
            activeAutomations={active}
            onAutomationUpdate={handleVoiceAutomationUpdate}
            onLogDeviceEvent={handleLogVoiceDeviceEvent}
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
              suggested.map((a, i) => (
                <div key={`${a.id}_${i}`} className="auto-item">
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
              active.map((a, i) => (
                <div key={`${a.id}_${i}`} className="active-item">
                  <div className="active-item-left">
                    <span className="active-dot"></span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                      <span className="active-name">{a.name}</span>
                      {(() => {
                        // Get actual scheduled times from queue builder
                        const queueItems = buildQueueFromAutomation(a, DEVICE_CONFIG);
                        if (queueItems.length > 0) {
                          return (
                            <span style={{ fontSize: 10, color: "var(--amber)", fontWeight: 600 }}>
                              ⏰ {queueItems.map(q => {
                                const [h, m] = q.time.split(":").map(Number);
                                const ampm = h < 12 ? "AM" : "PM";
                                const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                                return `${q.action ? "ON" : "OFF"} at ${h12}:${String(m).padStart(2,"0")} ${ampm}`;
                              }).join(" · ")}
                            </span>
                          );
                        }
                        // Fallback to keyword-based label
                        const label = getAutomationTimeLabel(a);
                        return label ? (
                          <span style={{ fontSize: 10, color: "var(--amber)", fontWeight: 600 }}>⏰ {label}</span>
                        ) : null;
                      })()}
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
