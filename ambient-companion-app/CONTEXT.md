# Alexa Ambient Companion — Full Project Context

> **READ THIS FIRST.** You are an implementation agent on this project. You are NOT the architect. Every decision about what to build, what the AI should do, how the system should behave, and what the product vision is — has already been decided. Your job is to implement exactly what is described here, ask before making any structural changes, and never hallucinate features that are not in this document.

---

## 1. The Problem Statement (Amazon Hackathon PS1)

**Theme:** Context-Aware Smart Home for Indian Households

**What Amazon asked for:**
> Indian homes have unique rhythms — morning pooja, pressure cooker schedules, water motor timings, power cuts, tuition hours, evening chai. Today's smart devices still need explicit commands. Build an AI system using Bedrock that understands household context and anticipates actions — not just responds to them.

**Three valid approaches they mentioned:**
1. Audio-Aware Home (sense sounds → classify → act)
2. Routine Learning & Auto-Scenes (observe patterns → suggest automations)
3. Conversational Home Controller (natural language → action)

**We are building all three.** They are not separate features — they are three input channels feeding one unified AI brain.

**Judging criteria (what Amazon scores):**
1. Customer obsession — solves a real, repetitive Indian household problem
2. Bedrock/AI usage — intelligence is in the LLM, not hardcoded rules
3. Scale architecture — how would this work for millions of homes
4. Privacy & safety — AI cannot make dangerous autonomous decisions
5. Future vision — what could this become with Amazon's resources

---

## 2. Our Vision

This is a **simulator/prototype** of what an Amazon Echo device would do if it had ambient intelligence. The UI is purely for demonstration — in production, this runs headlessly on an Echo device.

**Core philosophy:** The LLM is the brain. We give it sensory data (device states, audio events, time) and memory (recent history, learned patterns), and it decides what to do. We do NOT hardcode rules like "if baby cries 3 times, suggest lullaby." The AI reasons over context and decides.

**The experience we want to demo:**
- Judge sees a floor plan of an Indian home
- Devices glow on/off as they're toggled
- Time slider simulates different parts of the day
- AI reasoning panel shows live "Alexa is thinking..." with explanations
- YAMNet microphone detects real sounds (baby cry, pressure cooker, doorbell)
- After repeated patterns, AI suggests automations
- User accepts → automation becomes active
- At the right time, Alexa proactively asks "Should I activate your Morning Geyser Routine?"
- User says "Alexa yes" → done

---

## 3. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Next.js 16 + React + TypeScript | `src/app/page.tsx` is the entire UI |
| Styling | Inline CSS in `<style>` tag | Dark theme, custom variables. Do NOT use Tailwind classes for layout — the CSS is already written |
| AI/LLM | Groq (`llama-3.3-70b-versatile`) | Fast inference, key in `.env.local`. Bedrock is the production target but not configured yet |
| Database | AWS DynamoDB (`HouseholdLogs` table) | Stores state snapshots + AI decisions. Falls back to mock data if not configured |
| Audio ML | TensorFlow.js + YAMNet (521 classes) | Runs in-browser, no server needed |
| Voice | Web Speech API (browser-native) | For wake word + TTS. Chrome only |
| Deployment | Vercel-ready (Next.js serverless) | API routes deploy as Lambda functions |

**Environment variables (in `.env.local`):**
```
GROQ_API_KEY=gsk_...       # Real key, working
AWS_ACCESS_KEY_ID=...       # Real key, working
AWS_SECRET_ACCESS_KEY=...   # Real key, working
AWS_REGION=us-east-1
```

---

## 4. File Structure

```
src/
  app/
    page.tsx                 ← ENTIRE frontend UI (React, ~440 lines)
    layout.tsx               ← Minimal wrapper, dark theme
    globals.css              ← Tailwind imports + dark body override
    api/
      event/route.ts         ← MAIN AI endpoint. Accepts houseState, returns AI decision
      routines/route.ts      ← Aggregates DynamoDB history into pattern summaries
      logs/route.ts          ← Returns recent logs for display
      seed/route.ts          ← Pre-seeds DynamoDB with 5 days of realistic history
  components/
    YAMNetAudioMonitor.tsx   ← In-browser audio classification (TensorFlow.js)
    ui/                      ← shadcn components (button, card, sonner)
  lib/
    dynamodb.ts              ← DynamoDB client
    utils.ts                 ← clsx/tailwind-merge utility
```

---

## 5. The Three Entry Points (How Data Flows Into The AI)

### Entry Point 1: Device State Change
User clicks a device on the floor plan → React state updates → debounce 800ms → POST `/api/event` with full `houseState`.

### Entry Point 2: YAMNet Audio Event
Browser mic running continuously → YAMNet classifies sound every ~1 second → **sustained detection buffer** confirms sound is real (e.g., baby crying needs 4 detections in 8 seconds, glass break fires immediately) → `handleAudioEvent()` is called → audio event added to `houseState.audioEvents` → POST `/api/event` immediately (no debounce for audio).

### Entry Point 3: Alexa Voice Trigger (NOT YET IMPLEMENTED)
User says "Alexa" → wake word detected via Web Speech API → continuous recognition starts → user speaks command → transcript sent to `/api/event` with `trigger_type: "voice"` → LLM parses command and returns `voice_command_execute` action type → frontend executes device toggle → TTS speaks confirmation.

**This is the next thing to implement. See Section 9.**

---

## 6. What The AI Gets (The Full Context)

Every `/api/event` call builds this context for the LLM:

```
CURRENT HOME STATE (Time: 07:00):
Devices ON: bedroom_light, geyser
Devices OFF: kitchen_light, induction, microwave, tv, fan, living_light, study_lamp, water_motor, washing_machine

AUDIO EVENTS DETECTED:
- bedroom: baby_crying (attention)

SHORT-TERM MEMORY (last 8 events from DynamoDB):
- 06:45: State: ON=[bedroom_light]
- 06:50: State: ON=[bedroom_light,geyser]
- 06:55: Detected: morning_puja_bell

ESTABLISHED HOUSEHOLD PATTERNS (aggregated from DynamoDB history):
- "water_motor_on" occurs 5x, typically Morning (high confidence)
- "morning_puja_bell" occurs 4x, typically Morning (high confidence)
- "pressure_cooker_whistle" occurs 3x, typically Afternoon (medium confidence)
```

The LLM returns:
```json
{
  "action_type": "routine_suggestion | alert | family_connect | info | anomaly",
  "target_profile": "parents | children | partner | everyone",
  "message": "user-facing message",
  "reasoning": "why the AI decided this",
  "suggested_automation": { "name": "...", "trigger": "...", "action": "..." } | null
}
```

---

## 7. Safety Guardrails (Non-Negotiable)

Two layers. Both must stay:

**Layer 1 — System prompt (LLM instruction):**
The LLM is told never to suggest automating heating appliances, door locks, security systems, or gas valves.

**Layer 2 — Post-processing code (in `event/route.ts`):**
After AI responds, our code checks `suggested_automation.action` for keywords: `["geyser", "heater", "induction", "microwave", "oven", "boiler", "iron", "lock", "gas"]`. If found, `suggested_automation` is set to null and a safety message is appended. **Never remove this.**

---

## 8. The Automation Loop (How Routines Work)

1. DynamoDB accumulates state snapshots over time (or is pre-seeded via `/api/seed`)
2. On every API call, the routines aggregation runs — counts occurrences by time window, returns raw data
3. LLM receives this data and **decides on its own** whether a pattern is worth suggesting as an automation
4. If `action_type === "routine_suggestion"`, a card appears in the "Suggested Automations" sidebar panel
5. User clicks "Automate This" → moves to `acceptedAutomations` state array
6. A `setInterval` runs every 60 seconds in the browser, checks each accepted automation's name for time keywords (morning/evening/etc.), and when the time slider matches, speaks via `speechSynthesis`: "Should I activate your Morning Geyser Routine?"
7. "Yes, do it" button appears in AI Reasoning card → user confirms → TTS says "Done!"

**IMPORTANT:** There is NO hardcoded threshold like "after 3 occurrences suggest routine." The LLM decides. The count is just raw data we pass to it.

---

## 9. What Is NOT Yet Implemented (Pending Tasks)

### 🔴 PRIORITY 1: Alexa Voice Trigger Component

Build `src/components/AlexaVoiceController.tsx` as a "use client" component.

**Behavior:**
- Always-on Web Speech API listening for the keyword "Alexa" in the transcript
- When "Alexa" detected: play a short chime sound (Web Audio API, simple 880Hz beep for 200ms), switch to command recording mode
- Record next full utterance (ends on silence, ~3-4 seconds)
- Send to `/api/event` with this payload shape:
  ```json
  {
    "houseState": "<current house state>",
    "sourceProfile": "parents",
    "voiceCommand": "turn off the kitchen light in 10 minutes"
  }
  ```
- The `/api/event` route already handles this — the LLM will return `action_type: "voice_command_execute"` with a `device_command` field
- Frontend reads `device_command` and executes the device toggle (with optional delay via setTimeout)
- TTS speaks the `message` field from the AI response

**The component needs:**
- A prop: `houseState: HouseState` and `onDeviceCommand: (deviceId: DeviceId, state: boolean, delayMs: number) => void`
- The mic button in the navbar (`<button className="mic-btn">🎤</button>`) should be replaced with this component's output
- Visual states: idle (gray mic), listening for wake word (dim pulse), heard "Alexa" (bright blue pulse + chime), recording command (red pulse)

**Important:** Web Speech API only works in Chrome. This is fine for demo. Add a note in the UI if browser is not Chrome.

**The `/api/event` route needs one addition for voice commands:**
Add this to the USER_PROMPT when `voiceCommand` is present:
```
VOICE COMMAND FROM USER: "${voiceCommand}"
If this is a direct device command, return action_type "voice_command_execute" and include:
"device_command": { "deviceId": "kitchen_light", "state": false, "delay_minutes": 10 }
```

### 🟡 PRIORITY 2: Demo Seed Button

Add a small "Seed Demo Data" button somewhere in the UI (small, not prominent) that calls `/api/seed` when clicked. This is for the demo — so we can reset and reseed DynamoDB data during the presentation without opening a browser URL. Show a success/error toast after.

### 🟡 PRIORITY 3: YAMNet UI Reskin

The YAMNet component uses Tailwind classes (`text-sm`, `text-blue-500`, `animate-pulse`, etc.) which clash with the dark theme CSS. It also uses shadcn `<Button>` component with `variant="destructive"`. Reskin it to use the same CSS variables as the rest of the UI (`--bg`, `--surface`, `--amber`, etc.) using inline styles. The functionality should not change at all — just the appearance.

---

## 10. What The Demo Script Looks Like

**Step 1 — Establish context:**
"This is Alexa Ambient. It's a smart home AI that doesn't wait for commands — it learns from your home's rhythms."

**Step 2 — Show device control:**
Toggle bedroom light → geyser ON. Time slider at 7AM. AI reasoning panel updates. If DynamoDB is seeded, AI should say something like "I've noticed you turn on the bedroom light and geyser every morning around 7AM."

**Step 3 — Show routine suggestion:**
After a few toggles, AI returns `routine_suggestion`. Card appears in sidebar. Say: "Alexa noticed a pattern and is suggesting an automation."

**Step 4 — Accept automation:**
Click "Automate This". Moves to Active Automations. Say: "The user has approved this. Now Alexa will proactively ask next time."

**Step 5 — Show audio intelligence:**
Enable YAMNet mic. Make a sound or simulate one. Room flashes with colored border. AI reasoning updates with what it detected and what it decided to do.

**Step 6 — Show voice trigger (if implemented):**
Say "Alexa turn off the kitchen light." Mic button pulses blue. AI executes the command. TTS confirms.

**Step 7 — Future vision:**
"With Amazon's infrastructure, this ships on every Echo device in India. The AI trains on aggregate anonymized patterns from millions of homes while keeping individual data on-device."

---

## 11. Constraints & Rules For Implementation Agent

1. **Do not add new npm packages** without checking `package.json` first and asking if the package is truly needed.
2. **Do not change the CSS architecture.** The UI uses inline `<style>` tags with CSS variables. Do not switch to Tailwind classes for layout/theme — only for shadcn components where necessary.
3. **Do not change the DynamoDB table name** (`HouseholdLogs`). It already has data.
4. **Do not change the AI prompt structure** in `event/route.ts` without confirming with the architect.
5. **Run `npm run build` after every change.** If it fails, fix it before reporting done.
6. **Do not hallucinate features.** If something is not in this document, it has not been decided. Ask first.
7. **The LLM decides everything.** Never add `if (count > 3) suggestRoutine()` style logic. Pass data to the LLM and let it reason.
8. **Safety guardrails in `event/route.ts` are sacred.** Never remove or weaken them.
9. **The floor plan layout grid is final.** Bedroom + Kitchen (row 1), Living Room wide (row 2), Study + Utility (row 3). Do not restructure the room layout.
10. **Always read the file before editing it.**

---

## 12. Quick Reference: Key State Shape

```typescript
// House state — this is what gets sent to the AI on every change
interface HouseState {
  devices: {
    bedroom_light: boolean; night_light: boolean; geyser: boolean; ac: boolean; bedroom_fan: boolean;
    kitchen_light: boolean; induction: boolean; microwave: boolean;
    tv: boolean; living_fan: boolean; living_light: boolean;
    study_ceiling_light: boolean; study_lamp: boolean; study_fan: boolean;
    water_motor: boolean; washing_machine: boolean;
  };
  time: string;          // "07:00" (24h)
  audioEvents: {
    roomId: "bedroom" | "kitchen" | "living" | "study" | "utility";
    type: "danger" | "attention" | "info";
    label: string;       // e.g. "baby_crying"
  }[];
}
```

---

## 13. Before You Start Any Task

1. Read the relevant file(s) completely first
2. Identify exactly what lines need to change
3. Make the minimal change needed — do not refactor unrelated code
4. Run `npm run build`
5. Report what you changed, what the build result was, and if anything looks off

You are the hands. The architect makes the decisions.
