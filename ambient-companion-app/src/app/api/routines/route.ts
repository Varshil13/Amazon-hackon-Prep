import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

export async function GET() {
  if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID === "paste_your_access_key_here" || process.env.AWS_ACCESS_KEY_ID === "dummy") {
    // Return mock data if AWS is not configured
    return NextResponse.json({
      success: true,
      routines: [
        { event: "water_motor_on", occurrences: 5, typical_window: "Morning", confidence: "high" },
        { event: "pressure_cooker_whistle", occurrences: 3, typical_window: "Afternoon", confidence: "medium" },
        { event: "morning_puja_bell", occurrences: 4, typical_window: "Morning", confidence: "high" },
        { event: "study_hour_silence", occurrences: 3, typical_window: "Evening", confidence: "medium" }
      ]
    });
  }

  try {
    const params = {
      TableName: "HouseholdLogs",
    };
    const data = await dynamoDb.send(new ScanCommand(params));
    
    const triggers = (data.Items || []).filter(item => item.type === "trigger");

    // Group by classification
    const grouped: Record<string, { occurrences: number, windows: Record<string, number> }> = {};

    triggers.forEach(item => {
      // item.message looks like "Detected: water_motor_on" or "Detected: Water Motor On"
      // Wait, triggerEvent passes "Detected: label", let's extract the event type from the database.
      // We should really group by classification, but the DB only stores 'message'.
      // Wait, we can group by the 'message' directly since it contains the trigger name.
      const eventName = item.message.replace("Detected: ", "").trim();
      
      if (!grouped[eventName]) {
        grouped[eventName] = { occurrences: 0, windows: { "Morning": 0, "Afternoon": 0, "Evening": 0, "Night": 0 } };
      }
      
      grouped[eventName].occurrences += 1;
      
      // Attempt to infer time window from item.time (e.g., "7:00 AM")
      const timeStr = item.time || "";
      let window = "Day";
      if (timeStr.includes("AM")) {
        const hour = parseInt(timeStr.split(":")[0]);
        if (hour >= 5 && hour < 12) window = "Morning";
        else window = "Night";
      } else if (timeStr.includes("PM")) {
        const hour = parseInt(timeStr.split(":")[0]);
        if (hour === 12 || (hour >= 1 && hour < 5)) window = "Afternoon";
        else if (hour >= 5 && hour < 9) window = "Evening";
        else window = "Night";
      }

      if (grouped[eventName].windows[window] !== undefined) {
          grouped[eventName].windows[window] += 1;
      }
    });

    const routines = Object.keys(grouped).map(eventName => {
      const g = grouped[eventName];
      // Find most common window
      let maxWindow = "Morning";
      let maxCount = 0;
      Object.entries(g.windows).forEach(([w, count]) => {
        if (count > maxCount) {
          maxCount = count;
          maxWindow = w;
        }
      });

      let confidence = "low";
      if (g.occurrences >= 5) confidence = "high";
      else if (g.occurrences >= 3) confidence = "medium";

      return {
        event: eventName,
        occurrences: g.occurrences,
        typical_window: maxWindow,
        confidence
      };
    });

    // Sort by occurrences
    routines.sort((a, b) => b.occurrences - a.occurrences);

    return NextResponse.json({ success: true, routines });
  } catch (error: any) {
    console.error("DynamoDB GET Routines Error:", error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
