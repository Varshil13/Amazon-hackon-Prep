import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Default fallback response
    let action_type = "info";
    let message = "Event logged successfully.";
    let suggested_cart_items: Array<{
      id?: string;
      name: string;
      price: string;
    }> | null = null;

    if (body.classification === "baby_crying") {
      action_type = "commerce";
      message = "Detected a baby crying. Might need some supplies.";
      suggested_cart_items = [
        {
          id: "1",
          name: "Pampers Swaddlers Diapers",
          price: "$24.99",
        },
        {
          id: "2",
          name: "Amazon Elements Baby Wipes",
          price: "$8.99",
        },
      ];
    } else if (body.classification === "pressure_cooker_whistle") {
      
      message =
        "Kitchen safety: Pressure cooker whistle detected 3 times.";
    } else if (body.classification === "water_motor_on") {
      
      message = "Routine logged: Water motor turned on.";
    }

    const timeOfDay = body.timeOfDay || "2 PM";
    const homeState = body.homeState || "quiet";

    const prompt = `
You are the advanced Alexa Ambient Companion brain. Your job is to act like a truly intelligent and empathetic smart home that adapts to the time of day, the status of the house, and the emotional/physical needs of the residents.

Household Context:
- Time of Day: ${timeOfDay}
- Home Status: ${homeState}
- Event occurred in the house of: ${body.sourceProfile}

Trigger Event Detected: ${body.classification}

Analyze the event given the context. Be creative, genuinely helpful, and EMPATHETIC.
1. The person experiencing the event is the person whose house it occurred in (${body.sourceProfile}). They are the "victim" or subject of the event.
2. If it is late at night (e.g., 3 AM) or everyone is sleeping, prioritize quiet, ambient smart home actions.
3. If it is daytime and there is a baby need, suggest buying supplies.
4. If it is a safety hazard (e.g., pressure cooker whistle), alert the user immediately.
5. If the event indicates ${body.sourceProfile} is struggling (e.g., repeatedly saying "Kya?", increasing TV volume, sounding lonely, or highly stressed), show EMPATHY. You MUST notify their family members, NOT the person experiencing it.

Rules for action_type:
- "family_connect": Use this if ${body.sourceProfile} is lonely, struggling, stressed, or needs a family check-in.
- "commerce": Use this if the event relates to a baby crying or running out of supplies (unless it is the middle of the night). You MUST include suggested_cart_items for this.
- "alert": Use this if there is a safety issue (like cooker whistle), or if the smart home is taking an immediate physical action (like playing a lullaby).
- "info": Use this for mundane logs (like water motor).

If it is the middle of the night and a baby cries, use action_type "alert" and your message MUST contain the word "lullaby" so the audio system can trigger.

Rules for target_profile (WHO should receive the notification):
- For "commerce", "alert", or "info" events, the target_profile SHOULD BE ${body.sourceProfile} (the person whose house it happened in) or "everyone".
- ONLY if it is an empathy/family_connect event, the target_profile MUST NOT be ${body.sourceProfile}. Instead:
   - If sourceProfile is "parents", target_profile should be "children".
   - If sourceProfile is "children", target_profile should be "parents".
   - If sourceProfile is "partner", target_profile should be "partner" (the other partner).

Return ONLY a valid JSON object with keys:
- action_type (must be "commerce", "alert", "family_connect", or "info")
- target_profile (must be "children", "partner", "parents", or "everyone")
- message (A short 1-2 sentence UI message describing what you are doing. E.g., "${body.sourceProfile} is struggling to hear the TV. Suggesting you check in and drop a voice note.")
- suggested_cart_items (Array of objects with "name" and "price" if action_type is "commerce", otherwise null)

Do not wrap in markdown blocks.
Return raw JSON only.
`;

    // =========================================================================
    // GROQ API (Primary - Blazing Fast)
    // =========================================================================

    if (
      process.env.GROQ_API_KEY &&
      process.env.GROQ_API_KEY !== "paste_your_groq_key_here"
    ) {
      try {
        const groqResponse = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            },
            body: JSON.stringify({
              messages: [
                {
                  role: "system",
                  content: "You are a smart home assistant. Output only JSON.",
                },
                {
                  role: "user",
                  content: prompt,
                },
              ],
              model: "llama-3.1-8b-instant",
              temperature: 0.1,
            }),
          }
        );

        if (!groqResponse.ok) {
          const errorDetails = await groqResponse.text();
          throw new Error(`Groq API error: ${groqResponse.status} - ${errorDetails}`);
        }

        const groqData = await groqResponse.json();
        let aiContent = groqData?.choices?.[0]?.message?.content?.trim() || "";

        aiContent = aiContent.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
        const aiDecision = JSON.parse(aiContent);

        // Guardrail: AI sometimes hallucinates target_profile for commerce. Force it to stay at the source.
        if (aiDecision.action_type === "commerce" || aiDecision.action_type === "alert") {
           aiDecision.target_profile = body.sourceProfile || "everyone";
        }

        // --- DYNAMODB LOGGING ---
        if (
          process.env.AWS_ACCESS_KEY_ID &&
          process.env.AWS_ACCESS_KEY_ID !== "paste_your_access_key_here" &&
          process.env.AWS_ACCESS_KEY_ID !== "dummy"
        ) {
          const timestamp = Date.now();
          const displayTime = timeOfDay.split(' ').slice(0, 2).join(' ');
          try {
            await dynamoDb.send(new PutCommand({
              TableName: "HouseholdLogs",
              Item: {
                id: timestamp.toString() + "trig",
                timestamp: timestamp,
                message: `Detected: ${body.classification}`,
                time: displayTime,
                type: "trigger",
                source: body.sourceProfile || "unknown",
                target: "everyone"
              }
            }));
            await dynamoDb.send(new PutCommand({
              TableName: "HouseholdLogs",
              Item: {
                id: timestamp.toString() + "res",
                timestamp: timestamp + 1,
                message: `AI Action: ${aiDecision.message}`,
                time: displayTime,
                type: aiDecision.action_type,
                source: body.sourceProfile || "unknown",
                target: aiDecision.target_profile || "everyone",
                engine: "groq"
              }
            }));
            console.log("Logged to DynamoDB");
          } catch (e) { console.error("DB Error", e); }
        }

        return NextResponse.json({
          success: true,
          data: aiDecision,
          source: "groq",
        });
      } catch (err) {
        console.error("Groq failed, falling back:", err);
      }
    }

    // =========================================================================
    // GEMINI API (Fallback)
    // =========================================================================

    if (
      process.env.GEMINI_API_KEY &&
      process.env.GEMINI_API_KEY !== "paste_your_gemini_key_here"
    ) {
      try {
        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: prompt,
                    },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json",
              },
            }),
          }
        );

        if (!geminiResponse.ok) {
          const errorDetails = await geminiResponse.text();
          console.error("GEMINI REJECTION DETAILS:", errorDetails);
          throw new Error(`Gemini API error: ${geminiResponse.status} - ${errorDetails}`);
        }

        const geminiData = await geminiResponse.json();

        let aiContent =
          geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

        // Remove markdown fences if model returns them
        aiContent = aiContent
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        const aiDecision = JSON.parse(aiContent);

        // Guardrail: AI sometimes hallucinates target_profile for commerce. Force it to stay at the source.
        if (aiDecision.action_type === "commerce" || aiDecision.action_type === "alert") {
           aiDecision.target_profile = body.sourceProfile || "everyone";
        }

        return NextResponse.json({
          success: true,
          data: aiDecision,
          source: "gemini",
        });
      } catch (err) {
        console.error("Gemini failed, falling back to mock response:", err);
      }
    }

    // =========================================================================
    // MOCK FALLBACK
    // =========================================================================

    await new Promise((resolve) => setTimeout(resolve, 800));

    const responsePayload = {
      action_type: action_type,
      target_profile: "everyone",
      message: message,
      suggested_cart_items: suggested_cart_items,
    };

    // --- DYNAMODB LOGGING ---
    if (
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_ACCESS_KEY_ID !== "paste_your_access_key_here" &&
      process.env.AWS_ACCESS_KEY_ID !== "dummy"
    ) {
      const timestamp = Date.now();
      const displayTime = timeOfDay.split(' ').slice(0, 2).join(' ');

      try {
        // Log the Trigger
        await dynamoDb.send(new PutCommand({
          TableName: "HouseholdLogs",
          Item: {
            id: timestamp.toString() + "trig",
            timestamp: timestamp,
            message: `Detected: ${body.classification}`,
            time: displayTime,
            type: "trigger",
            source: body.sourceProfile || "unknown",
            target: "everyone"
          }
        }));

        // Log the AI Action
        await dynamoDb.send(new PutCommand({
          TableName: "HouseholdLogs",
          Item: {
            id: timestamp.toString() + "res",
            timestamp: timestamp + 1, // ensure it sorts after trigger
            message: `AI Action: ${message}`,
            time: displayTime,
            type: action_type,
            source: body.sourceProfile || "unknown",
            target: "everyone",
            engine: "mock"
          }
        }));
        console.log("Successfully logged to DynamoDB");
      } catch (dbError) {
        console.error("DynamoDB Write Error:", dbError);
        // Don't fail the API call if DB logging fails during hackathon
      }
    }

    return NextResponse.json({
      success: true,
      data: responsePayload,
      source: "mock",
    });
  } catch (error) {
    console.error("Unhandled route error:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to process event",
      },
      {
        status: 500,
      }
    );
  }
}