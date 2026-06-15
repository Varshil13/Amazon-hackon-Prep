import { NextResponse } from "next/server";
import { dynamoDb, isAwsConfigured } from "@/lib/dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

// Mode: most frequently occurring value in an array
function mode(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const freq: Record<string, number> = {};
  arr.forEach((v) => { freq[v] = (freq[v] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

function timeToWindow(t: string): string {
  // t is "HH:MM" (24h) or legacy "H:MM AM/PM"
  let h: number;
  if (t.includes("AM") || t.includes("PM")) {
    h = parseInt(t.split(":")[0]);
    if (t.includes("PM") && h !== 12) h += 12;
    if (t.includes("AM") && h === 12) h = 0;
  } else {
    h = parseInt(t.split(":")[0]);
  }
  if (h >= 5  && h < 12) return "Morning";
  if (h >= 12 && h < 17) return "Afternoon";
  if (h >= 17 && h < 21) return "Evening";
  return "Night";
}

const MOCK_ROUTINES = [
  { event: "water_motor_on", occurrences: 5, typical_window: "Morning", confidence: "high" },
  { event: "pressure_cooker_whistle", occurrences: 3, typical_window: "Afternoon", confidence: "medium" },
  { event: "morning_puja_bell", occurrences: 4, typical_window: "Morning", confidence: "high" },
  { event: "study_hour_silence", occurrences: 3, typical_window: "Evening", confidence: "medium" },
];

const MOCK_SESSIONS = [
  { device: "water_motor", sessions: 5, mode_on: "07:15", mode_off: "07:30", typical_duration: 15 },
  { device: "study_lamp",  sessions: 4, mode_on: "18:00", mode_off: "21:00", typical_duration: 180 },
];

export async function GET() {
  if (!isAwsConfigured) {
    return NextResponse.json({ success: true, routines: [], sessions: [] });
  }

  try {
    const data = await dynamoDb.send(new ScanCommand({ TableName: "HouseholdLogs" }));
    const items = data.Items || [];

    // ── 1. Trigger-based routines (existing logic) ──────────
    const triggers = items.filter((i) => i.type === "trigger");
    const grouped: Record<string, { occurrences: number; windows: Record<string, number> }> = {};
    triggers.forEach((item) => {
      const name = (item.message || "").replace("Detected: ", "").trim();
      if (!grouped[name]) grouped[name] = { occurrences: 0, windows: { Morning: 0, Afternoon: 0, Evening: 0, Night: 0 } };
      grouped[name].occurrences++;
      const w = timeToWindow(item.time || "12:00");
      if (grouped[name].windows[w] !== undefined) grouped[name].windows[w]++;
    });
    const routines = Object.entries(grouped)
      .map(([event, g]) => {
        const maxWindow = Object.entries(g.windows).sort((a, b) => b[1] - a[1])[0][0];
        const confidence = g.occurrences >= 5 ? "high" : g.occurrences >= 3 ? "medium" : "low";
        return { event, occurrences: g.occurrences, typical_window: maxWindow, confidence };
      })
      .sort((a, b) => b.occurrences - a.occurrences);

    // ── 2. Device session pairs — mode aggregation ──────────
    // Group by device
    const sessionItems = items.filter((i) => i.type === "device_session");
    const sessionGroups: Record<string, { on_times: string[]; off_times: string[]; durations: number[] }> = {};
    sessionItems.forEach((item) => {
      const d = item.device as string;
      if (!d) return;
      if (!sessionGroups[d]) sessionGroups[d] = { on_times: [], off_times: [], durations: [] };
      if (item.on_time)  sessionGroups[d].on_times.push(item.on_time);
      if (item.off_time) sessionGroups[d].off_times.push(item.off_time);
      if (item.duration_minutes) sessionGroups[d].durations.push(Number(item.duration_minutes));
    });

    const sessions = Object.entries(sessionGroups)
      .filter(([, g]) => g.on_times.length >= 2) // need at least 2 sessions to call it a pattern
      .map(([device, g]) => {
        const modeOn  = mode(g.on_times);
        const modeOff = mode(g.off_times);
        // Mode duration: round durations to nearest 15 then take mode
        const roundedDurations = g.durations.map((d) => Math.round(d / 15) * 15);
        const typicalDuration = mode(roundedDurations.map(String));
        return {
          device,
          sessions: g.on_times.length,
          mode_on:  modeOn,
          mode_off: modeOff,
          typical_duration: typicalDuration ? parseInt(typicalDuration) : null,
        };
      })
      .sort((a, b) => b.sessions - a.sessions);

    return NextResponse.json({ success: true, routines, sessions });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
