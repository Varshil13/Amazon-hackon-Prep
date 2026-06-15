import { NextResponse } from "next/server";
import { dynamoDb, isAwsConfigured } from "@/lib/dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

export async function POST(request: Request) {
  try {
    const { device, on_time, off_time, duration_minutes, day } = await request.json();
    if (!device || !on_time || !off_time) {
      return NextResponse.json({ success: false, error: "Missing fields" }, { status: 400 });
    }

    if (!isAwsConfigured) {
      return NextResponse.json({ success: true, note: "AWS not configured, pair not saved" });
    }

    await dynamoDb.send(new PutCommand({
      TableName: "HouseholdLogs",
      Item: {
        id: `pair_${device}_${Date.now()}`,
        timestamp: Date.now(),
        type: "device_session",
        device,
        on_time,
        off_time,
        duration_minutes,
        day: day ?? null,
        source: "parents",
      },
    }));

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("Session save error:", e);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
