import { NextRequest, NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { ScanCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = "ActiveAutomations";

const isAwsConfigured =
  !!process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_ACCESS_KEY_ID !== "paste_your_access_key_here" &&
  process.env.AWS_ACCESS_KEY_ID !== "dummy";

export async function GET() {
  if (!isAwsConfigured) {
    return NextResponse.json({ success: true, automations: [] });
  }
  try {
    const data = await dynamoDb.send(new ScanCommand({ TableName: TABLE }));
    const automations = (data.Items || []).map((item) => ({
      id: item.id,
      name: item.name,
      trigger: item.trigger,
      action: item.action,
      reasoning: item.reasoning,
      userApproved: item.userApproved ?? false,
      time: item.time ?? null,
      device: item.device ?? null,
    }));
    return NextResponse.json({ success: true, automations });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { id, name, trigger, action, reasoning } = body;
  if (!id || !name || !trigger || !action || !reasoning) {
    return NextResponse.json(
      { success: false, error: "Missing required fields" },
      { status: 400 }
    );
  }
  if (!isAwsConfigured) {
    return NextResponse.json({ success: true });
  }
  try {
    await dynamoDb.send(
      new PutCommand({ TableName: TABLE, Item: { id, name, trigger, action, reasoning, userApproved: body.userApproved ?? false, ...(body.time ? { time: body.time } : {}), ...(body.device ? { device: body.device } : {}) } })
    );
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
  }
  if (!isAwsConfigured) {
    return NextResponse.json({ success: true });
  }
  try {
    await dynamoDb.send(new DeleteCommand({ TableName: TABLE, Key: { id } }));
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// PATCH — replace entire ActiveAutomations list (used after voice-driven automation edits)
export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { automations } = body;
  if (!Array.isArray(automations)) {
    return NextResponse.json({ success: false, error: "automations array required" }, { status: 400 });
  }
  if (!isAwsConfigured) {
    return NextResponse.json({ success: true });
  }
  try {
    // Delete all existing
    const existing = await dynamoDb.send(new ScanCommand({ TableName: TABLE }));
    await Promise.all(
      (existing.Items || []).map((item) =>
        dynamoDb.send(new DeleteCommand({ TableName: TABLE, Key: { id: item.id } }))
      )
    );
    // Write the new list
    await Promise.all(
      automations.map((a: { id: string; name: string; trigger: string; action: string; reasoning: string; userApproved?: boolean; time?: string; device?: string }) =>
        dynamoDb.send(new PutCommand({ TableName: TABLE, Item: { id: a.id, name: a.name, trigger: a.trigger, action: a.action, reasoning: a.reasoning, userApproved: a.userApproved ?? false, ...(a.time ? { time: a.time } : {}), ...(a.device ? { device: a.device } : {}) } }))
      )
    );
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
