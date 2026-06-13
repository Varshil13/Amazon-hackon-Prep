import { NextResponse } from "next/server";

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

    const prompt = `
You are the Alexa Ambient Companion brain.

Household context:
The home is currently quiet.
It is 2 PM.

Trigger event detected: ${body.classification}.

Based on this, what proactive action should the smart home take?

Rules for classification:
- If the event relates to running out of supplies or baby needs (like "baby_crying"), return action_type "commerce" and suggest relevant products to buy.
- If the event is a safety hazard or requires immediate attention (like "pressure_cooker_whistle"), return action_type "alert".
- For mundane tasks (like "water_motor_on"), return action_type "info".

Return ONLY a valid JSON object with keys:
- action_type (must be "commerce", "alert", or "info")
- message (a short 1 sentence UI message)
- suggested_cart_items (array of objects with "name" and "price" if commerce, otherwise null)

Do not wrap in markdown blocks.
Return raw JSON only.
`;

    // =========================================================================
    // GROQ API
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
              model: "groq/compound",
              temperature: 0.1,
            }),
          }
        );

        if (!groqResponse.ok) {
          const errorDetails = await groqResponse.text();

          console.error(
            "GROQ REJECTION DETAILS:",
            errorDetails
          );

          throw new Error(
            `Groq API error: ${groqResponse.status} - ${errorDetails}`
          );
        }

        const groqData = await groqResponse.json();

        let aiContent =
          groqData?.choices?.[0]?.message?.content?.trim() || "";

        // Remove markdown fences if model returns them
        aiContent = aiContent
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        let aiDecision;

        try {
          aiDecision = JSON.parse(aiContent);
        } catch (parseError) {
          console.error(
            "Failed to parse Groq JSON:",
            aiContent
          );
          throw parseError;
        }

        return NextResponse.json({
          success: true,
          data: aiDecision,
          source: "groq",
        });
      } catch (err) {
        console.error(
          "Groq failed, falling back to mock response:",
          err
        );
      }
    }

    // =========================================================================
    // MOCK FALLBACK
    // =========================================================================

    await new Promise((resolve) => setTimeout(resolve, 800));

    return NextResponse.json({
      success: true,
      data: {
        action_type,
        message,
        suggested_cart_items,
      },
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