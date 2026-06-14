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

interface SuggestedAutomation { id: string; name: string; trigger: string; action: string; reasoning: string; }
interface ActiveAutomation { id: string; name: string; trigger: string; action: string; reasoning: string; }
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
function getAutomationTimeLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("morning"))   return "6:00 AM";
  if (n.includes("afternoon")) return "12:00 PM";
  if (n.includes("evening"))   return "5:00 PM";
  if (n.includes("night"))     return "8:00 PM";
  return "";
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
    { event: "water_motor",           occurrences: 5, typical_window: "Morning",   confidence: "high" },
    { event: "morning_puja_bell",     occurrences: 4, typical_window: "Morning",   confidence: "high" },
    { event: "pressure_cooker_whistle", occurrences: 3, typical_window: "Afternoon", confidence: "medium" },
    { event: "study_hour_silence",    occurrences: 3, typical_window: "Evening",   confidence: "medium" },
  ]);
  const [pendingAutomationAsk, setPendingAutomationAsk] = useState<string | null>(null);
  const [toast, setToast]             = useState<{ message: string; type: "success" | "error" } | null>(null);
  const [isSeedLoading, setIsSeedLoading] = useState(false);

  const debounceRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestStateRef = useRef(houseState);
  latestStateRef.current = houseState;
  const activeRef      = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  // ── Toast helper ───────────────────────────────────────
  const showToast = useCallback((message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // Load patterns from DynamoDB on mount
  useEffect(() => {
    fetch("/api/routines")
      .then((r) => r.json())
      .then((d) => { if (d.success && d.routines?.length) setPatterns(d.routines); })
      .catch(() => {});
  }, []);

  // Load persisted active automations from DynamoDB on mount
  useEffect(() => {
    fetch("/api/automations")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.automations?.length) {
          setActive(d.automations);
        }
      })
      .catch(() => {}); // silent failure on load
  }, []);

  // ── Automation proactive checker (runs every 60s) ──────
  // Checks accepted automations against current time slider.
  // Speaks TTS prompt and shows confirmation buttons.
  useEffect(() => {
    const checker = setInterval(() => {
      if (activeRef.current.length === 0) return;
      const [hStr, mStr] = latestStateRef.current.time.split(":").map(Number);
      const currentMinutes = hStr * 60 + mStr;

      activeRef.current.forEach((automation) => {
        const name = automation.name.toLowerCase();
        let triggerWindow: [number, number] | null = null;
        if (name.includes("morning"))   triggerWindow = [360, 540];
        else if (name.includes("afternoon")) triggerWindow = [720, 900];
        else if (name.includes("evening"))   triggerWindow = [1020, 1200];
        else if (name.includes("night"))     triggerWindow = [1200, 1380];

        if (!triggerWindow) return;
        const [start] = triggerWindow;
        const nearWindowStart = currentMinutes >= start - 15 && currentMinutes <= start + 30;
        if (!nearWindowStart) return;

        const speakTts = (text: string) => {
          if (typeof window === "undefined" || !window.speechSynthesis) return;
          window.speechSynthesis.cancel();
          const utt = new SpeechSynthesisUtterance(text);
          utt.rate = 0.95; utt.pitch = 1.0;
          window.speechSynthesis.speak(utt);
        };

        speakTts(`I noticed it's time for your ${automation.name}. Should I activate it now?`);
        setReasoning({
          message: `🔔 Time for: ${automation.name}. Should I activate it?`,
          detail: 'Tap "Yes, do it" below or say "Alexa yes" to confirm.',
        });
        setPendingAutomationAsk(automation.id);
      });
    }, 60000);

    return () => clearInterval(checker);
  }, []);

  // ── Entry Point 1 & 2: POST state to AI ───────────────
  // Called on device toggle (debounced 800ms) and audio event (immediate).
  const sendStateToAI = useCallback(async (state: HouseState) => {
    setIsThinking(true);
    setReasoning((p) => ({ ...p, message: "Thinking..." }));
    try {
      const res = await fetch("/api/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ houseState: state, sourceProfile: "parents" }),
      });
      const data = await res.json();
      if (data.success) {
        const { message, reasoning: r, action_type, suggested_automation } = data.data;
        setReasoning({ message, detail: r || "" });
        if (action_type === "routine_suggestion" && suggested_automation) {
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
  }, []);

  // ── Device toggle (Entry Point 1) ──────────────────────
  const toggleDevice = useCallback((deviceId: DeviceId) => {
    setHouseState((prev) => {
      const next = { ...prev, devices: { ...prev.devices, [deviceId]: !prev.devices[deviceId] } };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => sendStateToAI(next), 800);
      return next;
    });
  }, [sendStateToAI]);

  // ── Handle device command from AlexaVoiceController ────
  // Supports optional delay (e.g. "turn off kitchen light in 10 minutes")
  const handleDeviceCommand = useCallback((deviceId: DeviceId, state: boolean, delayMs: number) => {
    const applyToggle = () =>
      setHouseState((prev) => ({
        ...prev,
        devices: { ...prev.devices, [deviceId]: state },
      }));

    if (delayMs > 0) {
      setTimeout(applyToggle, delayMs);
    } else {
      applyToggle();
    }
  }, []);

  // ── Handle AI response from voice controller ────────────
  // Updates the reasoning panel so the judge can see what Alexa decided.
  const handleVoiceAIResponse = useCallback((message: string, detail: string) => {
    setReasoning({ message, detail });
  }, []);

  // ── Optimistic remove with rollback (Req 7.1, 7.2, 7.3) ──
  const handleRemoveAutomation = useCallback(async (automationId: string) => {
    let removedItem: ActiveAutomation | undefined;
    let removedIndex = -1;

    setActive((prev) => {
      removedIndex = prev.findIndex((x) => x.id === automationId);
      removedItem = prev[removedIndex];
      return prev.filter((x) => x.id !== automationId);
    });

    try {
      const res = await fetch(`/api/automations?id=${encodeURIComponent(automationId)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (data.success) {
        showToast("Automation removed.");
      } else {
        throw new Error(data.error || "Server error");
      }
    } catch {
      // Rollback — restore at original position
      if (removedItem !== undefined) {
        const item = removedItem;
        const idx = removedIndex;
        setActive((prev) => {
          const next = [...prev];
          next.splice(idx, 0, item);
          return next;
        });
      }
      showToast("Failed to remove automation. Please try again.", "error");
    }
  }, [showToast]);

  // ── Seed demo data (for presentation resets) ───────────
  const handleSeed = useCallback(async () => {
    setIsSeedLoading(true);
    try {
      const res  = await fetch("/api/seed?force=true");
      const data = await res.json();
      if (data.success) {
        showToast(data.message || "Demo data seeded!", "success");
        // Refresh patterns panel
        fetch("/api/routines")
          .then((r) => r.json())
          .then((d) => { if (d.success && d.routines?.length) setPatterns(d.routines); })
          .catch(() => {});
      } else {
        showToast(data.reason || data.error || "Seed failed", "error");
      }
    } catch {
      showToast("Network error — check connection", "error");
    }
    setIsSeedLoading(false);
  }, [showToast]);

  // ── Time slider ────────────────────────────────────────
  const handleTimeChange = useCallback((minutes: number) => {
    const h    = Math.floor(minutes / 60);
    const m    = minutes % 60;
    const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    setHouseState((prev) => {
      const next = { ...prev, time };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => sendStateToAI(next), 800);
      return next;
    });
  }, [sendStateToAI]);

  // ── Automate This — optimistic add with POST rollback ─
  const handleAutomateThis = useCallback(async (automation: SuggestedAutomation) => {
    const newActive: ActiveAutomation = {
      id: automation.id,
      name: automation.name,
      trigger: automation.trigger,
      action: automation.action,
      reasoning: automation.reasoning,
    };

    // Optimistic update
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

  // ── Entry Point 2: YAMNet audio event handler ──────────
  // Called by YAMNetAudioMonitor when a sustained sound is confirmed.
  // Fires immediately (no debounce) to /api/event.
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
      sendStateToAI(next); // Immediate — no debounce for audio
      return next;
    });

    // Clear room flash after 8s
    setTimeout(() => {
      setHouseState((prev) => ({ ...prev, audioEvents: [] }));
    }, 8000);
  }, [sendStateToAI]);

  // ── Room alert CSS class ───────────────────────────────
  const getRoomAlertClass = (roomId: RoomId) => {
    const ev = houseState.audioEvents.find((e) => e.roomId === roomId);
    if (!ev) return "";
    return ev.type === "danger"
      ? "room-alert-danger"
      : ev.type === "attention"
      ? "room-alert-attention"
      : "room-alert-info";
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

        /* Seed Demo button — small, amber-tinted, not prominent */
        .seed-btn{
          height:28px;padding:0 10px;
          background:rgba(245,158,11,0.08);
          border:1px solid rgba(245,158,11,0.25);
          border-radius:6px;cursor:pointer;
          font-size:11px;font-weight:600;color:var(--amber);
          display:flex;align-items:center;gap:5px;
          transition:background .2s,border-color .2s;white-space:nowrap
        }
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

        {/* Time slider — simulates time of day for demo */}
        <div className="nav-slider-wrap">
          <span className="time-label">{formatTimeDisplay(houseState.time)}</span>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <input
              type="range" min={360} max={1380} step={15}
              value={timeMinutes}
              onChange={(e) => handleTimeChange(parseInt(e.target.value))}
              style={{ flex: 1, height: 4, accentColor: "#f59e0b", cursor: "pointer" }}
            />
            <div className="time-range-labels"><span>6:00 AM</span><span>11:00 PM</span></div>
          </div>
        </div>

        <div className="nav-right">
          {/* Seed Demo Data — small utility button for presentation resets */}
          <button
            className="seed-btn"
            onClick={handleSeed}
            disabled={isSeedLoading}
            title="Seed 5 days of realistic household data into DynamoDB"
          >
            {isSeedLoading ? "⏳" : "🌱"} {isSeedLoading ? "Seeding..." : "Seed Demo"}
          </button>

          {/* Entry Point 3: Alexa Voice Controller */}
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
                  {houseState.audioEvents
                    .find((e) => e.roomId === room.id)
                    ?.label.replace(/_/g, " ") || "Alert"}
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

          {/* Card 1: AI Reasoning panel */}
          <div className="sidebar-card">
            <div className="card-title">
              <span className="pulse-dot" style={{ opacity: isThinking ? 1 : 0.3 }}></span>
              🧠 Alexa is Thinking...
            </div>
            <p className="card-body">{reasoning.message}</p>
            {reasoning.detail && (
              <p className="card-body-detail">💡 {reasoning.detail}</p>
            )}
            {/* Automation confirmation buttons (shown after proactive TTS ask) */}
            {pendingAutomationAsk && (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  className="btn-green"
                  onClick={() => {
                    const auto = active.find((a) => a.id === pendingAutomationAsk);
                    if (auto) {
                      setReasoning({ message: `✅ ${auto.name} activated!`, detail: "Automation executed." });
                      if (window.speechSynthesis) {
                        window.speechSynthesis.cancel();
                        const utt = new SpeechSynthesisUtterance(`Done! I've activated your ${auto.name}.`);
                        window.speechSynthesis.speak(utt);
                      }
                    }
                    setPendingAutomationAsk(null);
                  }}
                >
                  Yes, do it
                </button>
                <button
                  className="btn-muted"
                  onClick={() => {
                    setPendingAutomationAsk(null);
                    setReasoning({ message: "Okay, skipping this time.", detail: "" });
                  }}
                >
                  Skip
                </button>
              </div>
            )}
          </div>

          {/* Card 2: Suggested Automations */}
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
                    <button
                      className="btn-green"
                      onClick={() => handleAutomateThis(a)}
                    >
                      Automate This
                    </button>
                    <button
                      className="btn-muted"
                      onClick={() => setSuggested((p) => p.filter((x) => x.id !== a.id))}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Card 3: Active Automations */}
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
                      {getAutomationTimeLabel(a.name) && (
                        <span style={{ fontSize: 10, color: "var(--amber)", fontWeight: 600 }}>
                          ⏰ {getAutomationTimeLabel(a.name)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="btn-remove"
                    onClick={() => handleRemoveAutomation(a.id)}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Card 4: Household Patterns (from DynamoDB aggregation) */}
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

          {/* Card 5: Entry Point 2 — YAMNet Audio Monitor */}
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
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            background: toast.type === "success" ? "var(--green)" : "var(--red)",
            color: "#fff",
            padding: "12px 20px",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            zIndex: 9999,
            boxShadow: "0 4px 28px rgba(0,0,0,0.55)",
            animation: "toastIn 0.3s ease",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {toast.type === "success" ? "✅" : "❌"} {toast.message}
        </div>
      )}
    </>
  );
}
