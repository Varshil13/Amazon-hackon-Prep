# Alexa companion Companion (Prototype)

This is the prototype for the Amazon HackOn submission. The companion Companion listens for environmental audio cues (like a baby crying, water motor running, or pressure cooker whistle) and proactively suggests intelligent smart-home actions or commerce items.

## 🚀 Features
- **Interactive Simulator**: A frontend dashboard built with Next.js to simulate audio events without hardware.
- **Dynamic AI Decision Engine**: Powered by Groq (Llama 3) to analyze household context (e.g. time of day) and trigger the correct response.
- **Dynamic Context Panel (Phase 2)**: Simulates different times of day (e.g., 3:00 AM vs 2:00 PM) so the AI adapts its decisions (e.g., dimming lights vs suggesting diapers).
- **Amazon Cart Drawer (Phase 2)**: Fully mocked shopping cart slide-out that stores the items suggested by the AI.
- **Smart UI Notifications**: Elegant, Amazon-styled toast notifications for Alerts, Information, and Commerce/Shopping Cart additions.
- **Fail-safe Fallbacks**: Fully functional even without API keys via a robust mock-data pipeline, guaranteeing a crash-free demo on stage.

---

## 🛠 Getting Started

### 1. Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed on your machine.

### 2. Install Dependencies
Clone the repository and install the required NPM packages:
```bash
npm install
```

### 3. Setup Environment Variables
To enable the live AI engine, you need a Groq API key.
Create a new file named `.env.local` in the root of the `companion-companion-app` folder (next to `package.json`).

Copy and paste the following into the file:
```env
# Groq API Key for live AI Generation
GROQ_API_KEY=your_groq_api_key_here

# (Optional) Amazon Bedrock Keys for later phases
AWS_ACCESS_KEY_ID=paste_your_access_key_here
AWS_SECRET_ACCESS_KEY=paste_your_secret_key_here
AWS_REGION=us-east-1
```
*Note: If you do not provide a valid Groq key, the app will automatically fall back to mock AI data so the UI still functions perfectly.*

### 4. Run the Development Server
Start the Next.js server:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser to view the simulator dashboard.

---

## 🧠 How it Works
1. **Trigger an Event:** Click one of the buttons on the Simulator dashboard (e.g., "Trigger: Baby Crying").
2. **AI Processing:** The frontend sends the event to `/api/event/route.ts`. The Groq API analyzes the event alongside current household context (e.g. "It is quiet, 2 PM").
3. **Response Rendering:** The backend returns a structured JSON payload with an `action_type`. The frontend dynamically pops up an Amazon-styled notification based on whether it is `commerce`, `alert`, or `info`.

## 📦 Tech Stack
- **Framework**: Next.js (App Router)
- **Styling**: Tailwind CSS v4 & custom Amazon design tokens
- **Components**: Shadcn UI + Sonner (for Toasts)
- **AI Integration**: Groq API (Llama 3) & AWS Bedrock (SDK)
