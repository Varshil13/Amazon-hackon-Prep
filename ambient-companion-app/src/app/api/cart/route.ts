import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const profile = searchParams.get("profile") || "parents";

  if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID === "paste_your_access_key_here" || process.env.AWS_ACCESS_KEY_ID === "dummy") {
    return NextResponse.json({ success: false, reason: "No AWS keys configured" });
  }

  try {
    const params = {
      TableName: "HouseholdLogs",
      // In a real app we'd use Query with an index, but Scan is fine for hackathon
    };
    const data = await dynamoDb.send(new ScanCommand(params));
    
    const cartItems = (data.Items || [])
      .filter((item) => item.type === "cart_item" && item.target === profile)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((item) => ({ name: item.message, price: item.price }));
    
    return NextResponse.json({ success: true, cartItems });
  } catch (error: any) {
    console.error("DynamoDB GET Cart Error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID === "paste_your_access_key_here" || process.env.AWS_ACCESS_KEY_ID === "dummy") {
    return NextResponse.json({ success: false, reason: "No AWS keys configured" });
  }

  try {
    const body = await request.json();
    const timestamp = Date.now();

    await dynamoDb.send(new PutCommand({
      TableName: "HouseholdLogs",
      Item: {
        id: timestamp.toString() + "cart",
        timestamp: timestamp,
        message: body.item.name,
        price: body.item.price,
        type: "cart_item",
        source: body.profile,
        target: body.profile // profile it belongs to
      }
    }));

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DynamoDB POST Cart Error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
