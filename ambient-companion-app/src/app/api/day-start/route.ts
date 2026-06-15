import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

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

  // 1. Fetch last 3 days of possible automations
  let events: { device: string; action: string; time: string; day: number }[] = [];
  try {
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000";
    const res = await fetch(`${baseUrl}/api/possible-automations?day=${day}`, { cache: "no-store" });
    const data = await res.json();
    if (data.success) events = data.events;
  } catch (e) { console.error("Failed to fetch possible automations:", e); }

  if (events.length === 0) {
    return NextResponse.json({ success: true, message: "No events yet — nothing to learn from.", automations: [] });
  }

  // 2. Format events as readable table for LLM
  const groupedByDevice: Record<string, { day: number; action: string; time: string }[]> = {};
  events.forEach((e) => {
    if (!groupedByDevice[e.device]) groupedByDevice[e.device] = [];
    groupedByDevice[e.device].push({ day: e.day, action: e.action, time: e.time });
  });

  const eventSummary = Object.entries(groupedByDevice).map(([device, evts]) => {
    const lines = evts.map((e) => `  Day ${e.day}: ${e.action.toUpperCase()} at ${e.time}`).join("\n");
    return `${device}:\n${lines}`;
  }).join("\n\n");

  // 3. Call LLM
  const SYSTEM = `You are an automation learning agent for an Indian smart home.
You are given manual device usage data from the last 3 days.
Your job: identify consistent patterns and create automation schedules for today.

RULES:
- Only suggest automating a device if the same action (on or off) happened at the same or very similar time (within 30 min) on at least 2 of the 3 days.
- Never automate heating appliances: geyser, induction, microwave, boiler, iron.
- Return a JSON array of automation objects — one per device that has a learnable pattern.
- If no pattern exists for a device, do not include it.
- Keep it minimal and practical.`;

  const USER = `Today is Day ${day}. Here is the manual usage data from the last 3 days:

${eventSummary}

Based on this, create today's automation schedule.
Respond with ONLY a raw JSON array (no markdown):
[
  {
    "id": "auto_bedroom_light",
    "name": "string — friendly name",
    "device": "exact_device_id",
    "schedule": [
      { "action": "on" | "off", "time": "HH:MM" }
    ],
    "reasoning": "1 sentence why you chose this"
  }
]

Return [] if no patterns are strong enough to automate.`;

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

  // Tier 1: Local LM Studio
  const localUrl   = process.env.LOCAL_LLM_URL   || "http://127.0.0.1:1234";
  const localModel = process.env.LOCAL_LLM_MODEL || "meta-llama-3.1-8b-instruct";
  try {
    const result = await callLLM(localUrl, localModel);
    if (Array.isArray(result)) {
      automations = result;
      console.log(`[day-start] Local LLM OK — ${automations.length} automations`);
    }
  } catch (e) {
    console.warn("[day-start] Local LLM unavailable, trying Groq:", (e as Error).message);
    // Tier 2: Groq fallback
    if (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== "paste_your_groq_key_here") {
      try {
        const result = await callLLM("https://api.groq.com/openai", "llama-3.3-70b-versatile", process.env.GROQ_API_KEY);
        if (Array.isArray(result)) {
          automations = result;
          console.log(`[day-start] Groq fallback OK — ${automations.length} automations`);
        }
      } catch (e2) { console.error("[day-start] Groq also failed:", (e2 as Error).message); }
    }
  }

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
