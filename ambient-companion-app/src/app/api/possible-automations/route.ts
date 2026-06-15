import { NextResponse } from "next/server";
import { dynamoDb, isAwsConfigured } from "@/lib/dynamodb";
import { PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = "PossibleAutomations";

// POST — log a manual device toggle event
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { device, action, time, day } = body;
  if (!device || !action || !time || day === undefined) {
    return NextResponse.json({ success: false, error: "Missing fields" }, { status: 400 });
  }
  if (!isAwsConfigured) return NextResponse.json({ success: true, note: "AWS not configured" });

  try {
    await dynamoDb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        id: `${device}_${day}_${time}_${action}_${Date.now()}`,
        device,
        action,   // "on" | "off"
        time,     // "HH:MM"
        day,      // number 1,2,3...
        timestamp: Date.now(),
      },
    }));
    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}

export type PossibleAutomationEvent = { device: string; action: string; time: string; day: number };

// Shared data accessor — fetch last 3 days of events for the given day.
// Called directly by GET below and by the day-start route (same server, no HTTP hop).
export async function getPossibleAutomations(currentDay: number): Promise<PossibleAutomationEvent[]> {
  const fromDay = Math.max(1, currentDay - 2); // only previous 2 days (e.g. day 6 → check day 4, 5)

  if (!isAwsConfigured) {
    // Mock: simulate 3 days of manual usage
    return [
      { device: "bedroom_light", action: "on",  time: "07:00", day: currentDay - 2 },
      { device: "bedroom_light", action: "off", time: "22:00", day: currentDay - 2 },
      { device: "water_motor",   action: "on",  time: "07:15", day: currentDay - 2 },
      { device: "water_motor",   action: "off", time: "07:30", day: currentDay - 2 },
      { device: "bedroom_light", action: "on",  time: "07:00", day: currentDay - 1 },
      { device: "bedroom_light", action: "off", time: "22:00", day: currentDay - 1 },
      { device: "water_motor",   action: "on",  time: "07:15", day: currentDay - 1 },
      { device: "water_motor",   action: "off", time: "07:30", day: currentDay - 1 },
      { device: "study_lamp",    action: "on",  time: "18:00", day: currentDay - 1 },
      { device: "study_lamp",    action: "off", time: "21:00", day: currentDay - 1 },
      { device: "bedroom_light", action: "on",  time: "07:00", day: currentDay },
      { device: "water_motor",   action: "on",  time: "07:15", day: currentDay },
      { device: "water_motor",   action: "off", time: "07:30", day: currentDay },
    ];
  }

  const data = await dynamoDb.send(new ScanCommand({ TableName: TABLE }));
  return (data.Items || [])
    .filter((i) => i.day >= fromDay && i.day <= currentDay)
    .map((i) => ({ device: i.device, action: i.action, time: i.time, day: i.day }))
    .sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

// GET — fetch last 3 days of events, grouped by device
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const currentDay = parseInt(searchParams.get("day") || "1");

  try {
    const events = await getPossibleAutomations(currentDay);
    return NextResponse.json({ success: true, events });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}


// DELETE — clear all records
export async function DELETE() {
  if (!isAwsConfigured) return NextResponse.json({ success: true, note: "AWS not configured" });
  try {
    const data = await dynamoDb.send(new ScanCommand({ TableName: TABLE }));
    await Promise.all(
      (data.Items || []).map((item) =>
        dynamoDb.send(new DeleteCommand({ TableName: TABLE, Key: { id: item.id } }))
      )
    );
    return NextResponse.json({ success: true, deleted: data.Items?.length ?? 0 });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
