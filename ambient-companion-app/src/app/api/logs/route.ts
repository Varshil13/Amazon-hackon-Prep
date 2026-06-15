import { NextResponse } from "next/server";
import { dynamoDb, isAwsConfigured } from "@/lib/dynamodb";
import { ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

export async function GET() {
  if (!isAwsConfigured) {
    // If DynamoDB is not configured yet, tell frontend to rely on local state
    return NextResponse.json({ success: false, reason: "No AWS keys configured" });
  }

  try {
    const params = {
      TableName: "HouseholdLogs",
    };
    const data = await dynamoDb.send(new ScanCommand(params));
    
    // Sort by timestamp descending
    const logs = (data.Items || []).sort((a, b) => b.timestamp - a.timestamp);
    
    return NextResponse.json({ success: true, logs });
  } catch (error: any) {
    console.error("DynamoDB GET Error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  if (!isAwsConfigured) {
    return NextResponse.json({ success: false, reason: "No AWS keys configured" });
  }
  try {
    const data = await dynamoDb.send(new ScanCommand({ TableName: "HouseholdLogs" }));
    await Promise.all(
      (data.Items || []).map((item) =>
        dynamoDb.send(new DeleteCommand({ TableName: "HouseholdLogs", Key: { id: item.id } }))
      )
    );
    return NextResponse.json({ success: true, deleted: data.Items?.length ?? 0 });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
