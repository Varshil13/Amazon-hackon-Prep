import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

export async function GET() {
  if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID === "paste_your_access_key_here" || process.env.AWS_ACCESS_KEY_ID === "dummy") {
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
