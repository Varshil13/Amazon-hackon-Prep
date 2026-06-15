import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const DEVICE_MANIFEST = `AVAILABLE DEVICES IN THIS HOME:
- Bedroom: ceiling_light, night_light, geyser, ac, ceiling_fan
- Kitchen: kitchen_light, induction, microwave
- Living Room: tv, ceiling_fan, main_light
- Study Room: ceiling_light, desk_lamp, ceiling_fan
- Utility/Balcony: water_motor, washing_machine`;

const SYSTEM_PROMPT = `You are an autonomous companion intelligence agent for an Indian household.
You observe the full state of the home — which devices are on, what time it is, recent audio events — and decide the single most helpful proactive action.

Your job is NOT to respond to commands. Your job is to ANTICIPATE needs.

${DEVICE_MANIFEST}

ABSOLUTE SAFETY RULES — you cannot override these:
- Never suggest automating any heating appliance (geyser, water heater, room heater, induction, microwave, iron, boiler) as a scheduled routine
- You MAY and SHOULD raise an anomaly alert if a heating appliance has been on for an unusually long time
- Never suggest automating door locks, security systems, or gas valves
- When uncertain, use action_type "info" — doing nothing is safer than doing something wrong
- Never expose one family member's private activity to another without clear safety justification

WHEN TO USE EACH action_type:
- routine_suggestion: when you see a pattern worth automating (especially if PRE-DETECTED PATTERN MATCHES are provided — always act on those)
- alert: safety/urgent issues (smoke, baby crying, glass breaking, pressure cooker unattended)
- anomaly: unusual activity (especially if PRE-DETECTED ANOMALIES are provided — always act on those)
- family_connect: family care need
- info: nothing meaningful happening — use sparingly

INDIAN HOUSEHOLD CONTEXT:
Morning puja bells, pressure cooker whistles, water motor cycles, study hours, evening chai, power cuts, doorbell, baby care, elderly needs.`;

function buildHouseStateDescription(houseState: {
  devices: Record<string, boolean>;
  time: string;
  audioEvents: { roomId: string; type: string; label: string }[];
}) {
  const devicesOn = Object.entries(houseState.devices)
    .filter(([, on]) => on)
    .map(([id]) => id.replace(/_/g, " "))
    .join(", ") || "none";

  const devicesOff = Object.entries(houseState.devices)
    .filter(([, on]) => !on)
    .map(([id]) => id.replace(/_/g, " "))
    .join(", ");

  const audioDesc = houseState.audioEvents.length > 0
    ? houseState.audioEvents.map((e) => `- ${e.roomId}: ${e.label} (${e.type})`).join("\n")
    : "- none";

  return `CURRENT HOME STATE (Time: ${houseState.time}):
Devices ON: ${devicesOn}
Devices OFF: ${devicesOff}

AUDIO EVENTS DETECTED:
${audioDesc}`;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { houseState, sourceProfile = "parents", voiceCommand } = body;
    const preTargetTime: string | null = body.preTargetTime ?? null;

    // Support legacy single-classification calls for backward compat
    const isLegacy = !houseState && body.classification;
    const effectiveHouseState = isLegacy
      ? { devices: {}, time: body.timeOfDay || "12:00", audioEvents: [{ roomId: "living", type: "info", label: body.classification }] }
      : houseState;

    const isAwsConfigured = !!(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_ACCESS_KEY_ID !== "paste_your_access_key_here" &&
      process.env.AWS_ACCESS_KEY_ID !== "dummy"
    );

    // 1. Short-term memory & 2. Routine profile (Merged Scan)
    // OPTIMIZATION: Skip DynamoDB scan entirely for voice commands.
    // Voice commands only need the current house state — not historical patterns.
    // This saves 3-8s of network round-trip to AWS on every voice interaction.
    let shortTermMemory: { time: string; message: string }[] = [
      { time: "recently", message: "morning_puja_bell detected" },
      { time: "recently", message: "water_motor turned on" },
      { time: "earlier",  message: "bedroom_light turned on" },
    ];
    let routineProfile: { event: string; occurrences: number; typical_window: string; confidence: string }[] = [
      { event: "water_motor_on",          occurrences: 5, typical_window: "Morning",   confidence: "high" },
      { event: "morning_puja_bell",        occurrences: 4, typical_window: "Morning",   confidence: "high" },
      { event: "pressure_cooker_whistle",  occurrences: 3, typical_window: "Afternoon", confidence: "medium" },
      { event: "study_hour_silence",       occurrences: 3, typical_window: "Evening",   confidence: "medium" },
    ];
    let sessionSummary: { device: string; sessions: number; mode_on: string | null; mode_off: string | null; typical_duration: number | null }[] = [];

    // Only hit DynamoDB for companion/proactive events — not for voice commands
    if (isAwsConfigured && !voiceCommand) {
      const t0 = Date.now();
      try {
        const data = await dynamoDb.send(new ScanCommand({ TableName: "HouseholdLogs" }));
        console.log(`[perf] DynamoDB scan: ${Date.now() - t0}ms`);
        const allItems = data.Items || [];
        
        // Short-term memory
        const recentItems = allItems
          .filter((i) => i.type === "trigger" || i.type === "state_snapshot")
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 8);
        if (recentItems.length > 0) {
          shortTermMemory = recentItems.map((i) => ({ time: i.time || "recently", message: i.message }));
        }

        // Routine profile
        const triggers = allItems.filter((i) => i.type === "trigger");
        if (triggers.length > 0) {
          const grouped: Record<string, { occurrences: number; windows: Record<string, number> }> = {};
          triggers.forEach((item) => {
            const name = (item.message || "").replace("Detected: ", "").trim();
            if (!grouped[name]) grouped[name] = { occurrences: 0, windows: { Morning: 0, Afternoon: 0, Evening: 0, Night: 0 } };
            grouped[name].occurrences++;
            const t = item.time || "";
            let w = "Morning";
            if (t.includes("AM")) { const h = parseInt(t); w = h >= 5 && h < 12 ? "Morning" : "Night"; }
            else if (t.includes("PM")) { const h = parseInt(t); w = h === 12 || h < 5 ? "Afternoon" : h < 9 ? "Evening" : "Night"; }
            if (grouped[name].windows[w] !== undefined) grouped[name].windows[w]++;
          });
          routineProfile = Object.entries(grouped).map(([event, g]) => {
            const maxWindow = Object.entries(g.windows).sort((a, b) => b[1] - a[1])[0][0];
            const confidence = g.occurrences >= 5 ? "high" : g.occurrences >= 3 ? "medium" : "low";
            return { event, occurrences: g.occurrences, typical_window: maxWindow, confidence };
          });
        }

        // Session pairs — mode aggregation (mode = most common discrete slot)
        const sessionItems = allItems.filter((i) => i.type === "device_session");
        if (sessionItems.length > 0) {
          const sg: Record<string, { on: string[]; off: string[]; dur: number[] }> = {};
          sessionItems.forEach((i) => {
            if (!i.device) return;
            if (!sg[i.device]) sg[i.device] = { on: [], off: [], dur: [] };
            if (i.on_time)  sg[i.device].on.push(i.on_time);
            if (i.off_time) sg[i.device].off.push(i.off_time);
            if (i.duration_minutes) sg[i.device].dur.push(Number(i.duration_minutes));
          });
          const modeOf = (arr: string[]) => {
            const f: Record<string, number> = {};
            arr.forEach((v) => { f[v] = (f[v] || 0) + 1; });
            return arr.length ? Object.entries(f).sort((a, b) => b[1] - a[1])[0][0] : null;
          };
          sessionSummary = Object.entries(sg)
            .filter(([, g]) => g.on.length >= 2)
            .map(([device, g]) => ({
              device,
              sessions: g.on.length,
              mode_on: modeOf(g.on),
              mode_off: modeOf(g.off),
              typical_duration: g.dur.length
                ? parseInt(modeOf(g.dur.map((d) => String(Math.round(d / 15) * 15))) ?? "0")
                : null,
            }));
        }
      } catch (e) { console.error("DynamoDB scan failed:", e); }
    }

    // 3. Build prompt — include pre-computed anomaly observations
    const houseDesc = buildHouseStateDescription(effectiveHouseState);
    const memoryDesc = shortTermMemory.map((m) => `- ${m.time}: ${m.message}`).join("\n");
    const routineDesc = routineProfile.map((r) =>
      `- "${r.event}" occurs ${r.occurrences}x, typically ${r.typical_window} (${r.confidence} confidence)`
    ).join("\n");

    const sessionDesc = sessionSummary.length > 0
      ? "\nDEVICE USAGE SESSIONS (on/off pairs learned, times are modal 15-min slots):\n" +
        sessionSummary.map((s) =>
          `- "${s.device}": ${s.sessions} sessions, typically ON at ${s.mode_on ?? "?"}, OFF at ${s.mode_off ?? "?"} (~${s.typical_duration ?? "?"}min)`
        ).join("\n")
      : "";

    // ── Device on-time context — let the AI decide what's anomalous ──────────
    // Send how long each device has been on; AI decides if it's unusual
    const [currentH, currentM] = (effectiveHouseState.time || "00:00").split(":").map(Number);
    const currentTotal = currentH * 60 + currentM;
    const deviceOnTimes: Record<string, number> = body.deviceOnTimes || {};
    const devicesOnNow = Object.entries(effectiveHouseState.devices || {})
      .filter(([, on]) => on).map(([id]) => id);

    // Build on-time descriptions for devices that have a tracked start time
    const deviceOnTimeLines: string[] = [];
    for (const deviceId of devicesOnNow) {
      if (!(deviceId in deviceOnTimes)) continue;
      const onSince = deviceOnTimes[deviceId];
      const onFor = currentTotal >= onSince ? currentTotal - onSince : currentTotal + 1440 - onSince;
      deviceOnTimeLines.push(`- "${deviceId.replace(/_/g, " ")}": ON for ${onFor} min (turned on at ${Math.floor(onSince/60).toString().padStart(2,"0")}:${(onSince%60).toString().padStart(2,"0")})`);
    }

    const deviceOnTimeSection = deviceOnTimeLines.length > 0
      ? `\nDEVICE ON-TIME TRACKING (decide if any are anomalous):\n${deviceOnTimeLines.join("\n")}\n`
      : "";

    const patternSection = "";

    // Inject voice command section when present (Entry Point 3)
    // Uses device_commands[] EXCLUSIVELY — never the singular device_command.
    // Each array item: { deviceId, state, delay_minutes }
    //   delay_minutes=0  → execute immediately
    //   delay_minutes>0  → schedule for that many minutes later
    // Compound commands ("turn on X and turn it off at 7 AM") require TWO items in the array.
    const voiceSection = voiceCommand
      ? `
VOICE COMMAND FROM USER: "${voiceCommand}"

You are in VOICE COMMAND MODE. Respond to this command directly and helpfully.

CURRENT ACTIVE AUTOMATIONS:
${body.activeAutomations && body.activeAutomations.length > 0
  ? body.activeAutomations.map((a: { id: string; name: string; trigger: string; action: string; reasoning: string }) =>
      `- id: "${a.id}" | name: "${a.name}" | trigger: "${a.trigger}" | action: "${a.action}"`
    ).join("\n")
  : "- none"}

AUTOMATION INTENT DETECTION:
If the voice command is about automations — such as changing schedules, cancelling/removing an automation, adding a new routine, modifying times, or any phrase implying a recurring action (e.g. "every morning", "always", "daily", "from now on", "automatically", "routine", "stop automating", "don't automate", "every day", "each day") — then:
- Set action_type to "automation_update"
- Return "updated_automations" as the full new list (merge/modify/add/delete as needed based on what the user said)
- Match the user's intent to existing automations by device name or action similarity — if same device/action exists, update it; otherwise add new
- If user says to remove/cancel, exclude that automation from the list
- Each automation in updated_automations must have: id (keep existing or generate new like "auto_<device>_<timestamp>"), name, trigger (time/condition), action (ONLY what the user explicitly asked — do NOT add off time if user only said turn on), reasoning
- IMPORTANT: action field format must be EXACTLY "on at HH:MM" or "off at HH:MM" — do NOT add both on and off unless user explicitly mentioned both
- IMPORTANT: "turn on daily at X" and "turn off daily at Y" are TWO SEPARATE automations with different ids — never merge them into one

CRITICAL RULES — READ CAREFULLY:
- "turn on X", "turn off X", "switch on X", "switch off X" WITHOUT any recurring word = action_type "voice_command_execute" with device_commands, NOT automation_update
- "turn on X at HH:MM" (one-time, no recurring word) = action_type "voice_command_execute" with target_time in device_commands
- ONLY use "automation_update" when user says "every day", "daily", "always", "from now on", "automatically", "routine", "schedule it", "every morning/evening/night"
- ALWAYS include "device_commands" as a JSON array — empty [] only if truly no device action
- Do NOT include a "device_command" field — only "device_commands" array
- For questions: answer in "message", device_commands: []
- Immediate device action: { "deviceId": "...", "state": true, "target_time": "now" }
- Scheduled one-time: { "deviceId": "...", "state": false, "target_time": "07:00" }
- Compound: [ {"deviceId":"X","state":true,"target_time":"now"}, {"deviceId":"X","state":false,"target_time":"07:00"} ]
- target_time = "now" OR 24h string like "07:00", "13:30", "22:00"
- Current time is ${effectiveHouseState.time}
- Available deviceIds: bedroom_light, night_light, geyser, ac, bedroom_fan, kitchen_light, induction, microwave, tv, living_fan, living_light, study_ceiling_light, study_lamp, study_fan, water_motor, washing_machine
`
      : "";

    // For voice commands, use a focused minimal prompt — avoids model getting distracted by context
    const VOICE_USER_PROMPT = voiceCommand ? `The user said: "${voiceCommand}"
Current time: ${effectiveHouseState.time}

EXISTING ACTIVE AUTOMATIONS:
${body.activeAutomations && body.activeAutomations.length > 0
  ? body.activeAutomations.map((a: { id: string; name: string; action: string }) => `- id: "${a.id}" | name: "${a.name}" | action: "${a.action}"`).join("\n")
  : "- none"}

STEP 1 — Detect intent:
- AUTOMATION (action_type="automation_update"): ONLY if command contains "everyday", "every day", "daily", "always", "from now on", "automatically", "each day", "every morning/evening/night", "schedule it daily", "recurring"
- ONE-TIME SCHEDULED (action_type="voice_command_execute"): "turn on X at 7 PM", "turn on X after 10 minutes", "turn on X in 30 minutes", "turn on X at HH:MM" — calculate target_time as HH:MM based on current time
- ONE-TIME IMMEDIATE (action_type="voice_command_execute"): "turn on X", "turn off X", "switch on X" — use target_time "now"

TIME CALCULATION for scheduled commands:
- Current time is ${effectiveHouseState.time}
- "after X minutes" or "in X minutes" → add X minutes to current time, convert to HH:MM (24h format)
- "at H AM/PM" → convert to HH:MM 24h format
- Example: current time 07:00, "after 30 minutes" → target_time = "07:30"
- Example: current time 07:00, "at 8 PM" → target_time = "20:00"

STEP 2 — Respond with ONLY raw JSON (no markdown):

For ONE-TIME commands:
{
  "action_type": "voice_command_execute",
  "target_profile": "everyone",
  "message": "1 sentence confirming what you did",
  "reasoning": "direct command",
  "suggested_automation": null,
  "updated_automations": null,
  "device_commands": [{ "deviceId": "exact_id", "state": true, "target_time": "now" }]
}

For AUTOMATION requests:
{
  "action_type": "automation_update",
  "target_profile": "everyone",
  "message": "1 sentence confirming automation created",
  "reasoning": "user requested recurring automation",
  "suggested_automation": null,
  "updated_automations": [{ "id": "auto_<device>_<timestamp>", "name": "friendly name", "trigger": "time or condition", "action": "on at HH:MM", "reasoning": "user requested" }],
  "device_commands": []
}

Available deviceIds: bedroom_light, night_light, geyser, ac, bedroom_fan, kitchen_light, induction, microwave, tv, living_fan, living_light, study_ceiling_light, study_lamp, study_fan, water_motor, washing_machine
action field in updated_automations must be EXACTLY "on at HH:MM" or "off at HH:MM" only — nothing else.
Keep existing automations in updated_automations list and add/modify as needed.` : null;

    const USER_PROMPT = voiceCommand && VOICE_USER_PROMPT ? VOICE_USER_PROMPT : `${houseDesc}

SHORT-TERM MEMORY (recent activity):
${memoryDesc}

ESTABLISHED HOUSEHOLD PATTERNS:
${routineDesc}
${sessionDesc}
${deviceOnTimeSection}${patternSection}
Profile context: ${sourceProfile}
${voiceSection}
Decide the single most helpful proactive action. Respond with ONLY raw JSON (no markdown, no extra text):
{
  "action_type": "routine_suggestion" | "alert" | "family_connect" | "info" | "anomaly" | "voice_command_execute" | "automation_update",
  "target_profile": "parents" | "children" | "partner" | "everyone",
  "message": "1-2 sentence warm helpful message",
  "reasoning": "1 sentence: why you chose this action",
  "suggested_automation": { "name": "string", "trigger": "string", "action": "string" } | null,
  "updated_automations": [ { "id": "string", "name": "string", "trigger": "string", "action": "string", "reasoning": "string" } ] | null,
  "device_commands": []
}

action_type guide: routine_suggestion=pattern worth automating, alert=safety/urgent, family_connect=family care needed, anomaly=unusual activity, info=routine log, voice_command_execute=direct spoken command, automation_update=user wants to change/add/remove recurring automations.
updated_automations: only set when action_type is "automation_update" — full replacement list of active automations.
device_commands: always an array. Empty [] for non-device actions. Each item: { "deviceId": string, "state": boolean, "target_time": "now" | "HH:MM" }`;


    // 4. Call AI — 3-tier priority system
    //    Tier 1: Local LM Studio / Gemma 4 (free, no rate limits, runs on GPU)
    //    Tier 2: Groq cloud (automatic fallback if local model is offline)
    //    Tier 3: Hardcoded stub (last resort — keeps the app alive with no AI)
    let aiDecision: {
      action_type: string;
      target_profile: string;
      message: string;
      reasoning: string;
      suggested_automation: { name: string; trigger: string; action: string } | null;
      device_commands: { deviceId: string; state: boolean; delay_minutes: number }[];
      device_command?: { deviceId: string; state: boolean; delay_minutes?: number } | null;
    } | null = null;

    // ── Shared: call any OpenAI-compatible endpoint ───────────────────────────
    const callLLM = async (baseUrl: string, model: string, apiKey?: string) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      // For voice commands, use a focused system prompt — companion prompt confuses smaller models
      const systemContent = voiceCommand
        ? `You are a smart home voice assistant. Execute device commands directly.
Available deviceIds: bedroom_light, night_light, geyser, ac, bedroom_fan, kitchen_light, induction, microwave, tv, living_fan, living_light, study_ceiling_light, study_lamp, study_fan, water_motor, washing_machine.
Always respond with valid JSON only. No markdown.`
        : SYSTEM_PROMPT;

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: [
            { role: "system", content: systemContent },
            { role: "user",   content: USER_PROMPT   },
          ],
          model,
          temperature: 0.2,
          max_tokens: 512,
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      let raw = data?.choices?.[0]?.message?.content?.trim() || "";
      raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
      return JSON.parse(raw);
    };

    // ── Shared: normalize device_commands[] regardless of LLM output shape ───
    const normalize = (d: NonNullable<typeof aiDecision>) => {
      const arr: { deviceId: string; state: boolean; delay_minutes: number }[] =
        Array.isArray(d.device_commands)
          ? d.device_commands.map((c) => ({ ...c, delay_minutes: c.delay_minutes ?? 0 }))
          : [];
      const singular = (d as any).device_command;
      if (singular?.deviceId) {
        const dup = arr.some((c) => c.deviceId === singular.deviceId && c.state === !!singular.state);
        if (!dup) arr.push({ deviceId: singular.deviceId, state: !!singular.state, delay_minutes: singular.delay_minutes ?? 0 });
      }
      d.device_commands = arr;
      delete (d as any).device_command;
      return d;
    };

    // ── Tier 1: Local LM Studio ────────────────────────────────────
    const localUrl   = process.env.LOCAL_LLM_URL   || "http://127.0.0.1:1234";
    const localModel = process.env.LOCAL_LLM_MODEL || "gemma-4-e2b-it-qat";
    try {
      const result = await callLLM(localUrl, localModel);
      if (result) { aiDecision = normalize(result); console.log(`[AI] Local (${localModel}) OK`); }
    } catch (e) {
      console.warn("[AI] Local model unavailable, trying Groq:", (e as Error).message);
    }

    // ── Tier 2: Groq cloud fallback ───────────────────────────────────────────
    if (!aiDecision && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "paste_your_groq_key_here") {
      try {
        const result = await callLLM("https://api.groq.com/openai", "llama-3.1-8b-instant", process.env.GROQ_API_KEY);
        if (result) { aiDecision = normalize(result); console.log("[AI] Groq response:", JSON.stringify(result)); }
      } catch (e) {
        console.warn("[AI] Groq also failed:", (e as Error).message);
      }
    }

    // ── Override target_time with pre-calculated value if frontend detected a delay ──
    // Also fix state if LLM got it wrong — trust the command text over LLM
    if (aiDecision && voiceCommand && Array.isArray(aiDecision.device_commands) && aiDecision.device_commands.length > 0) {
      const lower = voiceCommand.toLowerCase();
      const cmdIsOn  = lower.includes("turn on") || lower.includes("switch on") || lower.includes("enable") || lower.includes("start");
      const cmdIsOff = lower.includes("turn off") || lower.includes("switch off") || lower.includes("disable") || lower.includes("stop");
      aiDecision.device_commands = aiDecision.device_commands.map((cmd) => ({
        ...cmd,
        ...(preTargetTime ? { target_time: preTargetTime } : {}),
        // Correct state only if command unambiguously says on or off
        ...(cmdIsOn && !cmdIsOff ? { state: true } : {}),
        ...(cmdIsOff && !cmdIsOn ? { state: false } : {}),
      }));
    }

    // ── Fix automation_update action text to match the voice command intent ──
    // LLM sometimes returns "on at HH:MM" when user said "off" (and vice versa)
    // IMPORTANT: only correct NEW automations — never rewrite existing ones (they have their own intent)
    if (aiDecision && voiceCommand && aiDecision.action_type === "automation_update" && Array.isArray((aiDecision as any).updated_automations)) {
      const lower = voiceCommand.toLowerCase();
      const cmdIsOn  = lower.includes("turn on") || lower.includes("switch on") || lower.includes("enable") || lower.includes("start");
      const cmdIsOff = lower.includes("turn off") || lower.includes("switch off") || lower.includes("disable") || lower.includes("stop");
      const intendedAction = cmdIsOff && !cmdIsOn ? "off" : cmdIsOn && !cmdIsOff ? "on" : null;

      // Build a set of existing automation ids — don't touch these
      const existingIds = new Set((body.activeAutomations || []).map((a: { id: string }) => a.id));

      if (intendedAction) {
        (aiDecision as any).updated_automations = (aiDecision as any).updated_automations.map((a: { id: string; name: string; trigger: string; action: string; reasoning: string }) => {
          // Skip existing automations — only fix newly created ones
          if (existingIds.has(a.id)) return a;

          const timeMatch = a.action.match(/(\d{1,2}:\d{2})/);
          const ampmMatch = a.action.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
          let timeStr: string | null = timeMatch ? timeMatch[1] : null;
          if (!timeStr && ampmMatch) {
            let h = parseInt(ampmMatch[1]);
            const mins = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0;
            if (ampmMatch[3].toLowerCase() === "pm" && h !== 12) h += 12;
            if (ampmMatch[3].toLowerCase() === "am" && h === 12) h = 0;
            timeStr = `${String(h).padStart(2,"0")}:${String(mins).padStart(2,"0")}`;
          }
          const aIsOn = /\bon\s+at\b|turn\s+on/i.test(a.action);
          const aIsOff = /\boff\s+at\b|turn\s+off/i.test(a.action);
          if (timeStr && ((intendedAction === "off" && aIsOn && !aIsOff) || (intendedAction === "on" && aIsOff && !aIsOn))) {
            const newName = a.name.replace(/\b(on|off)\b/gi, intendedAction === "on" ? "On" : "Off");
            return { ...a, action: `${intendedAction} at ${timeStr}`, name: newName };
          }
          return a;
        });
      }
    }

    // ── Tier 3: Hardcoded stub ────────────────────────────────────────────────
    if (!aiDecision) {
      aiDecision = {
        action_type: "info",
        target_profile: "everyone",
        message: "Event logged.",
        reasoning: "No AI available.",
        suggested_automation: null,
        device_commands: [],
      };
    }
    if (!Array.isArray(aiDecision.device_commands)) aiDecision.device_commands = [];

    // 6. Safety guardrail (post-processing)
    // 6. Safety guardrail — only block if the ACTION TARGET device itself is dangerous
    // (not just any mention of a dangerous word in the action string)
    if (aiDecision.suggested_automation?.action) {
      const dangerous = ["geyser", "heater", "induction", "microwave", "oven", "boiler", "iron"];
      const action = aiDecision.suggested_automation.action.toLowerCase();
      // Extract the verb phrase + first device mention (e.g. "turn on induction")
      // Block only when the action is directly controlling a dangerous device
      const isDirectlyAutomating = dangerous.some((kw) => {
        const idx = action.indexOf(kw);
        if (idx === -1) return false;
        // Check that a turn-on/activate verb appears before the device name
        const before = action.slice(0, idx);
        return before.includes("turn on") || before.includes("switch on") ||
               before.includes("activate") || before.includes("enable") ||
               before.includes("start");
      });
      if (isDirectlyAutomating) {
        aiDecision.suggested_automation = null;
        if (aiDecision.action_type === "routine_suggestion") {
          aiDecision.action_type = "info";
        }
        aiDecision.message = "I noticed a pattern, but I can't automate heating appliances for safety reasons.";
      }
    }

    // 7. Log to DynamoDB
    if (isAwsConfigured) {
      const ts = Date.now();
      const displayTime = effectiveHouseState.time;
      const devicesOn = Object.entries(effectiveHouseState.devices || {})
        .filter(([, on]) => on).map(([id]) => id).join(",");
      try {
        await dynamoDb.send(new PutCommand({
          TableName: "HouseholdLogs",
          Item: {
            id: ts + "snap", timestamp: ts, type: "state_snapshot",
            time: displayTime, message: `State: ON=[${devicesOn}]`,
            source: sourceProfile, target: "everyone",
          },
        }));
        await dynamoDb.send(new PutCommand({
          TableName: "HouseholdLogs",
          Item: {
            id: ts + "res", timestamp: ts + 1, type: aiDecision.action_type,
            time: displayTime, message: `AI: ${aiDecision.message}`,
            reasoning: aiDecision.reasoning,
            source: sourceProfile, target: aiDecision.target_profile, engine: "groq",
          },
        }));
      } catch (e) { console.error("DynamoDB log error:", e); }
    }

    return NextResponse.json({ success: true, data: aiDecision });
  } catch (error) {
    console.error("Event route error:", error);
    return NextResponse.json({ success: false, error: "Failed to process event" }, { status: 500 });
  }
}
