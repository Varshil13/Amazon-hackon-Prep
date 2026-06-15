import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { getPossibleAutomations } from "@/app/api/possible-automations/route";

const ACTIVE_TABLE = "ActiveAutomations";

const isAwsConfigured = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_ACCESS_KEY_ID !== "paste_your_access_key_here" &&
  process.env.AWS_ACCESS_KEY_ID !== "dummy"
);

// Called when user advances to a new day.
// Fetches last 3 days from PossibleAutomations, sends to LLM,
// LLM decides what to put in ActiveAutomations for today.
export async function POST(request: Request) {
  const { day } = await request.json().catch(() => ({ day: 1 }));

  // 1. Fetch last 3 days of possible automations (direct call — same server, no HTTP hop)
  let events: { device: string; action: string; time: string; day: number }[] = [];
  try {
    events = await getPossibleAutomations(day);
  } catch (e) { console.error("Failed to fetch possible automations:", e); }

  if (events.length === 0) {
    return NextResponse.json({ success: true, message: "No events yet — nothing to learn from.", automations: [] });
  }

  // Pre-filter: only keep device+action combos that appear on at least 2 CONSECUTIVE days
  //    at the same or similar time (within 30 min).
  //    e.g. Day4+Day5 → suggest on Day6. Day4+Day6 (not consecutive) → do NOT suggest.
  const groupedByDevice: Record<string, { day: number; action: string; time: string }[]> = {};
  events.forEach((e) => {
    if (!groupedByDevice[e.device]) groupedByDevice[e.device] = [];
    groupedByDevice[e.device].push({ day: e.day, action: e.action, time: e.time });
  });

  const toMinutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

  const qualifiedDevices: Record<string, { action: string; time: string; days: number[] }[]> = {};

  for (const [device, evts] of Object.entries(groupedByDevice)) {
    const qualified: { action: string; time: string; days: number[] }[] = [];

    for (const actionType of ["on", "off"]) {
      const filtered = evts
        .filter((e) => e.action === actionType)
        .sort((a, b) => a.day - b.day); // sort by day ascending

      // Check for consecutive day pairs with similar time
      for (let i = 0; i < filtered.length - 1; i++) {
        const curr = filtered[i];
        const next = filtered[i + 1];

        // Must be consecutive days
        if (next.day !== curr.day + 1) continue;

        // Must be within ±30 min
        const timeDiff = Math.abs(toMinutes(next.time) - toMinutes(curr.time));
        if (timeDiff > 30) continue;

        // Qualified — use the most recent day's actual time (no averaging)
        qualified.push({ action: actionType, time: next.time, days: [curr.day, next.day] });
      }
    }

    if (qualified.length > 0) qualifiedDevices[device] = qualified;
  }

  // If no device has a qualifying consecutive pattern, return early
  if (Object.keys(qualifiedDevices).length === 0) {
    return NextResponse.json({ success: true, message: "Not enough consistent consecutive patterns yet.", automations: [] });
  }

  // Build automations directly from qualifiedDevices — don't let LLM decide times
  // LLM only provides name and reasoning (cosmetic fields)
  const directAutomations = Object.entries(qualifiedDevices).map(([device, patterns]) => {
    const schedule = patterns.map((p) => ({ action: p.action, time: p.time }));
    return {
      id: `auto_${device}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: device.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      device,
      schedule,
      reasoning: `Consistent pattern detected on ${patterns[0].days.map(d => `Day ${d}`).join(" and ")}`,
    };
  });

  // Call LLM only for friendly name and reasoning — times and device are already correct
  const SYSTEM = `You are a smart home assistant. Given device usage patterns, provide a friendly name and one-sentence reasoning for each automation. Do not change device IDs or schedule times.`;

  const USER = `Provide friendly names and reasoning for these automations. Return ONLY a raw JSON array:
${directAutomations.map(a => `- device: "${a.device}", schedule: ${JSON.stringify(a.schedule)}`).join("\n")}

[
  {
    "id": "auto_<device_id>",
    "name": "friendly name like 'Morning Bedroom Fan'",
    "device": "<exact device_id — do not change>",
    "schedule": <exact schedule from above — do not change>,
    "reasoning": "1 sentence"
  }
]`;

  let automations: {
    id: string; name: string; device: string;
    schedule: { action: string; time: string }[];
    reasoning: string;
  }[] = [];

  // Shared: call any OpenAI-compatible endpoint
  const callLLM = async (baseUrl: string, model: string, apiKey?: string): Promise<typeof automations> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
        model,
        temperature: 0.1,
        max_tokens: 1024,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content?.trim() || "[]";
    content = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    return JSON.parse(content);
  };

  // Tier 1: Groq cloud (primary)
  if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "paste_your_groq_key_here") {
    try {
      const result = await callLLM("https://api.groq.com/openai", "llama-3.1-8b-instant", process.env.GROQ_API_KEY);
      if (Array.isArray(result)) {
        automations = result;
      }
    } catch (e) { console.warn("[day-start] Groq unavailable, trying local LLM:", (e as Error).message); }
  }

  // Tier 2: Local LM Studio (fallback)
  if (automations.length === 0) {
    const localUrl   = process.env.LOCAL_LLM_URL   || "http://127.0.0.1:1234";
    const localModel = process.env.LOCAL_LLM_MODEL || "meta-llama-3.1-8b-instruct";
    try {
      const result = await callLLM(localUrl, localModel);
      if (Array.isArray(result)) {
        automations = result;
      }
    } catch (e) { console.error("[day-start] Local LLM also failed:", (e as Error).message); }
  }

  // Post-process: always use exact times and device IDs from directAutomations
  // LLM only contributed name and reasoning — override everything else
  automations = directAutomations.map((direct) => {
    const llmMatch = automations.find((a) =>
      a.device === direct.device ||
      a.device?.toLowerCase().includes(direct.device.replace(/_/g, " ")) ||
      direct.device.includes(a.device?.toLowerCase() ?? "")
    );
    return {
      ...direct,
      name: llmMatch?.name || direct.name,
      reasoning: llmMatch?.reasoning || direct.reasoning,
    };
  });

  // 4. Write to ActiveAutomations (replace only llm-learned entries, preserve user-approved)
  if (isAwsConfigured && automations.length > 0) {
    try {
      // Delete only LLM-learned (non-user-approved) automations
      const existing = await dynamoDb.send(new ScanCommand({ TableName: ACTIVE_TABLE }));
      await Promise.all(
        (existing.Items || [])
          .filter((item) => !item.userApproved)
          .map((item) =>
            dynamoDb.send(new DeleteCommand({ TableName: ACTIVE_TABLE, Key: { id: item.id } }))
          )
      );
      // Write new LLM-suggested ones (userApproved: false — pending user approval)
      await Promise.all(
        automations.map((auto) =>
          dynamoDb.send(new PutCommand({
            TableName: ACTIVE_TABLE,
            Item: {
              ...auto,
              day,
              source: "llm_learned",
              trigger: `Day ${day}`,
              action: auto.schedule.map((s) => `${s.action} at ${s.time}`).join(", "),
              userApproved: false,
            },
          }))
        )
      );
    } catch (e) { console.error("DynamoDB write failed:", e); }
  }

  return NextResponse.json({ success: true, automations, day });
}
