import { NextResponse } from "next/server";
import { dynamoDb } from "@/lib/dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Default fallback response
    let action_type = "info";
    let message = "Event logged successfully.";
    let physical_action: string | null = null;

    if (body.classification === "baby_crying") {
      action_type = "alert";
      message = "Detected a baby crying. Playing a soothing lullaby.";
      physical_action = "lullaby";
    } else if (body.classification === "pressure_cooker_whistle") {
      action_type = "alert";
      message = "Kitchen safety: Pressure cooker whistle detected 3 times.";
    } else if (body.classification === "water_motor_on") {
      action_type = "info";
      message = "Routine logged: Water motor turned on.";
    }

    let eventDescription = body.classification;
    if (body.classification === "repetitive_kya_kya") {
      eventDescription = "Elderly person repeatedly saying 'Kya? Kya?' (Hindi for 'What? What?') because they are struggling to hear the TV.";
    } else if (body.classification === "rapid_typing_sighs") {
      eventDescription = "Someone is typing rapidly and sighing loudly, indicating high stress or frustration with work.";
    }

    const timeOfDay = body.timeOfDay || "2 PM";
    const homeState = body.homeState || "quiet";

    const prompt = `
You are an advanced Ambient Companion brain for an Indian household. Your job is to act like a truly intelligent smart home that understands household rhythms and anticipates actions based on Acoustic Event Detection, without needing explicit voice commands.

Household Context:
- Time of Day: ${timeOfDay}
- Home Status: ${homeState}

Trigger Event Detected: ${eventDescription}

Analyze the event given the context.
1. If it is late at night (e.g., 3 AM) or everyone is sleeping, and a baby cries, prioritize quiet, ambient smart home actions (like playing a lullaby).
2. If it is a safety hazard (e.g., pressure cooker whistle), alert the user immediately or suggest turning off the stove.
3. Observe routine patterns (e.g. water motor running).

Rules for action_type:
- "family_connect": Use this if the event indicates someone is struggling emotionally or physically (e.g., Hearing Struggle, High Stress).
- "alert": Use this if there is a safety issue (like cooker whistle), or if the smart home is taking an immediate physical action (like playing a lullaby).
- "info": Use this for mundane logs (like water motor) or recognizing a pattern.

Rules for target_profile (WHO gets notified):
- For "family_connect", you MUST specify a family member who should check in (e.g., "Son (Rahul)").
- For all other events, set it to "everyone".

Rules for physical_action:
- If the event is a baby crying in the middle of the night, set physical_action to "lullaby". Otherwise set it to null.

Return ONLY a valid JSON object with keys:
- action_type (must be "alert", "family_connect", or "info")
- target_profile (e.g. "Son (Rahul)", "everyone")
- message (A short 1-2 sentence UI message describing your observation or action.)
- physical_action (String like "lullaby" or null)

Do not wrap in markdown blocks. Return raw JSON only.
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
                source: "home",
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
                source: "home",
                target: "everyone",
                engine: "groq"
              }
            }));
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
          throw new Error(`Gemini API error: ${geminiResponse.status} - ${errorDetails}`);
        }

        const geminiData = await geminiResponse.json();
        let aiContent = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

        aiContent = aiContent.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
        const aiDecision = JSON.parse(aiContent);

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
      message: message,
      target_profile: "everyone",
      physical_action: physical_action,
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
        await dynamoDb.send(new PutCommand({
          TableName: "HouseholdLogs",
          Item: {
            id: timestamp.toString() + "trig",
            timestamp: timestamp,
            message: `Detected: ${body.classification}`,
            time: displayTime,
            type: "trigger",
            source: "home",
            target: "everyone"
          }
        }));

        await dynamoDb.send(new PutCommand({
          TableName: "HouseholdLogs",
          Item: {
            id: timestamp.toString() + "res",
            timestamp: timestamp + 1,
            message: `AI Action: ${message}`,
            time: displayTime,
            type: action_type,
            source: "home",
            target: "everyone",
            engine: "mock"
          }
        }));
      } catch (dbError) {
        console.error("DynamoDB Write Error:", dbError);
      }
    }

    return NextResponse.json({
      success: true,
      data: responsePayload,
      source: "mock",
    });
  } catch (error) {
    console.error("Unhandled route error:", error);
    return NextResponse.json({ success: false, error: "Failed to process event" }, { status: 500 });
  }
}