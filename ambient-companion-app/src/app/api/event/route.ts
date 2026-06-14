import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const DEVICE_MANIFEST = `AVAILABLE DEVICES IN THIS HOME:
- Bedroom: ceiling_light, night_light, geyser, ac, ceiling_fan
- Kitchen: kitchen_light, induction, microwave
- Living Room: tv, ceiling_fan, main_light
- Study Room: ceiling_light, desk_lamp, ceiling_fan
- Utility/Balcony: water_motor, washing_machine`;

const SYSTEM_PROMPT = `You are an autonomous ambient intelligence agent for an Indian household.
You observe the full state of the home — which devices are on, what time it is, recent audio events — and decide the single most helpful proactive action.

Your job is NOT to respond to commands. Your job is to ANTICIPATE needs.

${DEVICE_MANIFEST}

ABSOLUTE SAFETY RULES — you cannot override these:
- Never suggest automating any heating appliance (geyser, water heater, room heater, induction, microwave, iron, boiler)
- Never suggest automating door locks, security systems, or gas valves
- When uncertain, use action_type "info" — doing nothing is safer than doing something wrong
- Never expose one family member's private activity to another without clear safety justification

INDIAN HOUSEHOLD CONTEXT:
You understand: morning puja (bell sounds), pressure cooker whistles, water motor cycles, study hours, evening chai, power cuts, doorbell, baby care, elderly needs.`;

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

    // 1. Short-term memory
    let shortTermMemory: { time: string; message: string }[] = [
      { time: "recently", message: "morning_puja_bell detected" },
      { time: "recently", message: "water_motor turned on" },
      { time: "earlier",  message: "bedroom_light turned on" },
    ];

    if (isAwsConfigured) {
      try {
        const data = await dynamoDb.send(new ScanCommand({ TableName: "HouseholdLogs" }));
        const items = (data.Items || [])
          .filter((i) => i.type === "trigger" || i.type === "state_snapshot")
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 8);
        if (items.length > 0) {
          shortTermMemory = items.map((i) => ({ time: i.time || "recently", message: i.message }));
        }
      } catch (e) { console.error("Short-term memory fetch failed:", e); }
    }

    // 2. Routine profile
    let routineProfile: { event: string; occurrences: number; typical_window: string; confidence: string }[] = [
      { event: "water_motor_on",          occurrences: 5, typical_window: "Morning",   confidence: "high" },
      { event: "morning_puja_bell",        occurrences: 4, typical_window: "Morning",   confidence: "high" },
      { event: "pressure_cooker_whistle",  occurrences: 3, typical_window: "Afternoon", confidence: "medium" },
      { event: "study_hour_silence",       occurrences: 3, typical_window: "Evening",   confidence: "medium" },
    ];

    if (isAwsConfigured) {
      try {
        const data = await dynamoDb.send(new ScanCommand({ TableName: "HouseholdLogs" }));
        const triggers = (data.Items || []).filter((i) => i.type === "trigger");
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
      } catch (e) { console.error("Routine profile fetch failed:", e); }
    }

    // 3. Build prompt
    const houseDesc = buildHouseStateDescription(effectiveHouseState);
    const memoryDesc = shortTermMemory.map((m) => `- ${m.time}: ${m.message}`).join("\n");
    const routineDesc = routineProfile.map((r) =>
      `- "${r.event}" occurs ${r.occurrences}x, typically ${r.typical_window} (${r.confidence} confidence)`
    ).join("\n");

    // Inject voice command section when present (Entry Point 3)
    const voiceSection = voiceCommand
      ? `\nVOICE COMMAND FROM USER: "${voiceCommand}"\nThis is a direct spoken command. Return action_type "voice_command_execute" and populate device_command.\nAvailable deviceId values: bedroom_light, night_light, geyser, ac, bedroom_fan, kitchen_light, induction, microwave, tv, living_fan, living_light, study_ceiling_light, study_lamp, study_fan, water_motor, washing_machine\n`
      : "";

    const USER_PROMPT = `${houseDesc}

SHORT-TERM MEMORY (recent activity):
${memoryDesc}

ESTABLISHED HOUSEHOLD PATTERNS:
${routineDesc}

Profile context: ${sourceProfile}
${voiceSection}
Decide the single most helpful proactive action. Respond with ONLY raw JSON:
{
  "action_type": "routine_suggestion" | "alert" | "family_connect" | "info" | "anomaly" | "voice_command_execute",
  "target_profile": "parents" | "children" | "partner" | "everyone",
  "message": "1-2 sentence warm helpful message",
  "reasoning": "1 sentence: why you chose this action",
  "suggested_automation": { "name": "string", "trigger": "string", "action": "string" } | null,
  "device_command": { "deviceId": "string", "state": true, "delay_minutes": 0 } | null
}

action_type: routine_suggestion=pattern worth automating, alert=safety/urgent, family_connect=family check needed, anomaly=unusual activity, info=routine log, voice_command_execute=direct spoken command from user
target_profile for family_connect: use the OTHER profile (if ${sourceProfile} is parents, target is children)
For voice_command_execute: set device_command.deviceId to exact device, state=true for on/false for off, delay_minutes=0 for immediate. Set device_command to null for non-device commands.`;

    // 4. Call LM Studio (local, OpenAI-compatible)
    let aiDecision: {
      action_type: string;
      target_profile: string;
      message: string;
      reasoning: string;
      suggested_automation: { name: string; trigger: string; action: string } | null;
    } | null = null;

    try {
      const res = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: USER_PROMPT },
          ],
          model: "meta-llama-3.1-8b-instruct",
          temperature: 0.2,
        }),
      });
      if (res.ok) {
        const lmData = await res.json();
        let content = lmData?.choices?.[0]?.message?.content?.trim() || "";
        content = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
        aiDecision = JSON.parse(content);
      }
    } catch (e) { console.error("LM Studio call failed (is it running on 1234?):", e); }

    // 5. Fallback
    if (!aiDecision) {
      aiDecision = {
        action_type: "info",
        target_profile: "everyone",
        message: "Event logged.",
        reasoning: "No patterns established yet.",
        suggested_automation: null,
      };
    }

    // 6. Safety guardrail (post-processing)
    if (aiDecision.suggested_automation?.action) {
      const dangerous = ["geyser", "heater", "induction", "microwave", "oven", "boiler", "iron", "lock", "gas"];
      if (dangerous.some((kw) => aiDecision!.suggested_automation!.action.toLowerCase().includes(kw))) {
        aiDecision.suggested_automation = null;
        aiDecision.message += " (Safety guardrail: cannot automate this device type.)";
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
