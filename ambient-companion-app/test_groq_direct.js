const fs = require('fs');
const https = require('https');

const SYSTEM_PROMPT = `You are an autonomous ambient intelligence agent for an Indian household.
You observe the full state of the home — which devices are on, what time it is, recent audio events — and decide the single most helpful proactive action.

Your job is NOT to respond to commands. Your job is to ANTICIPATE needs.

AVAILABLE DEVICES IN THIS HOME:
- Bedroom: ceiling_light, night_light, geyser, ac, ceiling_fan
- Kitchen: kitchen_light, induction, microwave
- Living Room: tv, ceiling_fan, main_light
- Study Room: ceiling_light, desk_lamp, ceiling_fan
- Utility/Balcony: water_motor, washing_machine

ABSOLUTE SAFETY RULES — you cannot override these:
- Never suggest automating any heating appliance (geyser, water heater, room heater, induction, microwave, iron, boiler)
- Never suggest automating door locks, security systems, or gas valves
- When uncertain, use action_type "info" — doing nothing is safer than doing something wrong
- Never expose one family member's private activity to another without clear safety justification

INDIAN HOUSEHOLD CONTEXT:
You understand: morning puja (bell sounds), pressure cooker whistles, water motor cycles, study hours, evening chai, power cuts, doorbell, baby care, elderly needs.`;

const USER_PROMPT = `CURRENT HOME STATE (Time: 06:00):
Devices ON: none
Devices OFF: bedroom_light, night_light, geyser, ac, bedroom_fan, kitchen_light, induction, microwave, tv, living_fan, living_light, study_ceiling_light, study_lamp, study_fan, water_motor, washing_machine

AUDIO EVENTS DETECTED:
- none

SHORT-TERM MEMORY (recent activity):
- recently: morning_puja_bell detected
- recently: water_motor turned on
- earlier: bedroom_light turned on

ESTABLISHED HOUSEHOLD PATTERNS:
- "water_motor_on" occurs 5x, typically Morning (high confidence)
- "morning_puja_bell" occurs 4x, typically Morning (high confidence)
- "pressure_cooker_whistle" occurs 3x, typically Afternoon (medium confidence)
- "study_hour_silence" occurs 3x, typically Evening (medium confidence)

Profile context: parents

VOICE COMMAND FROM USER: "what is the time right now"
This is a direct spoken command. Return action_type "voice_command_execute" and populate device_commands array.
Available deviceId values: bedroom_light, night_light, geyser, ac, bedroom_fan, kitchen_light, induction, microwave, tv, living_fan, living_light, study_ceiling_light, study_lamp, study_fan, water_motor, washing_machine

Decide the single most helpful proactive action. Respond with ONLY raw JSON:
{
  "action_type": "routine_suggestion" | "alert" | "family_connect" | "info" | "anomaly" | "voice_command_execute",
  "target_profile": "parents" | "children" | "partner" | "everyone",
  "message": "1-2 sentence warm helpful message",
  "reasoning": "1 sentence: why you chose this action",
  "suggested_automation": { "name": "string", "trigger": "string", "action": "string" } | null,
  "device_commands": [{ "deviceId": "string", "state": true, "delay_minutes": 0 }] | []
}

action_type: routine_suggestion=pattern worth automating, alert=safety/urgent, family_connect=family check needed, anomaly=unusual activity, info=routine log, voice_command_execute=direct spoken command from user
target_profile for family_connect: use the OTHER profile (if parents is parents, target is children)
For voice_command_execute: populate the device_commands array. Each item must set deviceId to exact device, state=true for on/false for off, delay_minutes=0 for immediate. Leave array empty for non-device commands.`;

async function run() {
  const payload = JSON.stringify({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: USER_PROMPT },
    ],
    model: "llama-3.3-70b-versatile",
    temperature: 0.2,
  });

  const env = fs.readFileSync('.env.local', 'utf8');
  const groqKey = env.match(/GROQ_API_KEY=(.*)/)[1].trim();

  const options = {
    hostname: 'api.groq.com',
    port: 443,
    path: '/openai/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + groqKey,
      'Content-Length': payload.length
    }
  };

  const req = https.request(options, res => {
    let d = '';
    res.on('data', chunk => { d += chunk; });
    res.on('end', () => {
      console.log('Status:', res.statusCode);
      if (res.statusCode !== 200) {
         console.log('Error payload:', d);
         return;
      }
      const groqData = JSON.parse(d);
      let content = groqData?.choices?.[0]?.message?.content?.trim() || "";
      console.log("Raw output:\n", content);
      try {
        content = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
        const j = JSON.parse(content);
        console.log("Parsed JSON successfully:", j);
      } catch(e) {
        console.error("Failed to parse JSON:", e);
      }
    });
  });

  req.on('error', error => { console.error(error); });
  req.write(payload);
  req.end();
}
run();
