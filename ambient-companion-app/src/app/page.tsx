"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import dynamic from "next/dynamic";

const TeachableAudioMonitor = dynamic(
  () => import("@/components/TeachableAudioMonitor").then((mod) => mod.TeachableAudioMonitor),
  { ssr: false }
);
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Bell, Activity, ShieldAlert, Zap, Settings, Mic, Heart } from "lucide-react";

export default function Home() {
  const [logs, setLogs] = useState<{ id: string, message: string, time: string, type: string, source?: string, target?: string, engine?: string }[]>([]);
  const [isListening, setIsListening] = useState(false);
  
  // Phase 2: Dynamic Context State
  const [timeOfDay, setTimeOfDay] = useState("2:00 PM");
  const [homeState, setHomeState] = useState("quiet");
  
  // Phase 4: Real-time DB Polling for Cross-Browser Sync
  useEffect(() => {
    const fetchData = async () => {
      try {
        const resLogs = await fetch("/api/logs");
        const dataLogs = await resLogs.json();
        if (dataLogs.success && dataLogs.logs) {
          setLogs(dataLogs.logs);
        }
      } catch (err) {
        // ignore errors if not set up
      }
    };
    
    fetchData();

    // Poll every 3 seconds
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, []);

  const triggerEvent = async (classification: string, label: string) => {
    const displayTime = timeOfDay.split(' ').slice(0, 2).join(' '); // Extracts just "2:00 PM" from "2:00 PM (Afternoon)"

    try {
      // Show loading pulse on the Mic icon temporarily
      setIsListening(true);
      
      const response = await fetch("/api/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          classification, 
          source: "simulator",
          timeOfDay,
          homeState
        }),
      });
      const data = await response.json();
      setIsListening(false);

      if (data.success) {
        const { action_type, message, target_profile, physical_action } = data.data;

        // ALWAYS log the event
        const newTriggerLog = {
          id: Date.now().toString() + "trig",
          message: `Detected: ${label}`,
          time: displayTime,
          type: "trigger",
          source: "home",
          target: "everyone"
        };

        const newResponseLog = {
          id: Date.now().toString() + "res",
          message: `AI Action: ${message}`,
          time: displayTime,
          type: action_type,
          source: "home",
          target: target_profile || "everyone",
          engine: data.source || "mock"
        };

        setLogs((prev) => [newResponseLog, newTriggerLog, ...prev]);

        // Smart Home Action: Play Audio if the AI explicitly decides to play a lullaby
        if (physical_action === "lullaby") {
          // Using Web Audio API because it is natively supported by all browsers instantly without network requests
          try {
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            const ctx = new AudioContext();
            
            // Play a soothing C Major chord (C, E, G) 3 times
            const repeats = 3;
            const delayBetweenStrums = 2.0; // Seconds
            
            for (let r = 0; r < repeats; r++) {
              const timeOffset = r * delayBetweenStrums;
              
              [261.63, 329.63, 392.00].forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = freq;
                
                const startTime = ctx.currentTime + timeOffset + (i * 0.2); // Strum effect
                
                // Fade out gently like a music box
                gain.gain.setValueAtTime(0, startTime);
                gain.gain.linearRampToValueAtTime(0.3, startTime + 0.1);
                gain.gain.exponentialRampToValueAtTime(0.01, startTime + 1.8);
                
                osc.connect(gain);
                gain.connect(ctx.destination);
                
                osc.start(startTime);
                osc.stop(startTime + 2);
              });
            }
          } catch (e) {
            console.error("Web Audio API failed:", e);
          }
        }

        // EMPATHY RULE for popups
        if (action_type === "alert") {
          toast.custom((t) => (
            <div className="bg-white border-l-4 border-red-600 shadow-xl p-4 flex gap-3 w-[356px] rounded-sm pointer-events-auto">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5 animate-pulse" />
              <div className="flex-1">
                <h4 className="text-red-700 font-bold text-sm">Safety Alert</h4>
                <p className="text-xs text-gray-700 mt-1">{message}</p>
                <button 
                  className="mt-3 text-amazon-link text-xs hover:underline font-medium"
                  onClick={() => toast.dismiss(t)}
                >
                  Acknowledge
                </button>
              </div>
            </div>
          ), { duration: 8000 });
        } else if (action_type === "family_connect") {
          toast.custom((t) => (
            <div className="bg-white border-l-4 border-purple-500 shadow-xl p-4 flex gap-3 w-[356px] rounded-sm pointer-events-auto">
              <Heart className="w-5 h-5 text-purple-500 shrink-0 mt-0.5 animate-pulse" />
              <div className="flex-1">
                <h4 className="text-purple-700 font-bold text-sm">Empathy Notification Routed</h4>
                <p className="text-xs text-purple-900 mt-1 mb-2 bg-purple-50 p-1.5 rounded border border-purple-100">
                  📲 Sent silently to: <strong>{target_profile || "Family Member"}</strong>
                </p>
                <p className="text-xs text-gray-600">{message}</p>
              </div>
            </div>
          ), { duration: 8000 });
        } else {
          toast.custom((t) => (
            <div className="bg-white border-l-4 border-amazon-link shadow-xl p-4 flex gap-3 w-[356px] rounded-sm pointer-events-auto">
              <Bell className="w-5 h-5 text-amazon-link shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="text-amazon-black font-bold text-sm">Activity Logged</h4>
                <p className="text-xs text-gray-700 mt-1">{message}</p>
              </div>
            </div>
          ), { duration: 4000 });
        }
      }
    } catch (error) {
      setIsListening(false);
      toast.error("Failed to process event");
    }
  };

  return (
    <div className="min-h-screen bg-amazon-bgmain font-sans text-amazon-textprimary relative">
      {/* Top Navigation */}
      <header className="bg-amazon-black text-white p-4 flex items-center justify-between sticky top-0 z-40 shadow-sm">
        <div className="flex items-center gap-2">
          <Zap className="text-amazon-orange w-6 h-6" />
          <h1 className="text-xl font-bold tracking-tight">Alexa Ambient Companion</h1>
        </div>
        <div className="flex items-center gap-4">
          <Settings className="w-5 h-5 text-white cursor-pointer hover:text-gray-300" />
        </div>
      </header>

      {/* Sub Navigation */}
      <div className="bg-amazon-navy text-white px-4 py-2 flex gap-4 text-sm font-medium overflow-x-auto whitespace-nowrap">
        <span className="cursor-pointer hover:text-amazon-orange">Today&apos;s Insights</span>
        <span className="cursor-pointer hover:text-amazon-orange">Family Care</span>
        <span className="cursor-pointer hover:text-amazon-orange">Routines</span>
        <span className="cursor-pointer hover:text-amazon-orange">Safety</span>
      </div>

      <main className="max-w-6xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Column: Context & Simulator */}
        <div className="lg:col-span-1 space-y-6">
          
          {/* Phase 2: Dynamic Context Panel */}
          <Card className="rounded-md border-0 shadow-sm overflow-hidden">
            <CardHeader className="bg-gray-50 border-b pb-4">
              <CardTitle className="text-lg flex items-center gap-2">

                <Settings className="w-5 h-5 text-gray-500" />
                Household Context
              </CardTitle>
              <CardDescription>
                Change these settings to see how AI logic adapts dynamically.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 flex flex-col gap-5">
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 block">Time of Day</label>
                <select 
                  className="w-full border border-gray-300 rounded-sm text-sm p-2 bg-white text-black outline-none focus:border-amazon-orange focus:ring-1 focus:ring-amazon-orange transition-all"
                  value={timeOfDay}
                  onChange={(e) => setTimeOfDay(e.target.value)}
                >
                  <option>2:00 PM (Afternoon)</option>
                  <option>8:00 AM (Morning Rush)</option>
                  <option>8:00 PM (Evening/Bedtime)</option>
                  <option>3:00 AM (Middle of the Night)</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 block">Home Status</label>
                <select 
                  className="w-full border border-gray-300 rounded-sm text-sm p-2 bg-white text-black outline-none focus:border-amazon-orange focus:ring-1 focus:ring-amazon-orange transition-all"
                  value={homeState}
                  onChange={(e) => setHomeState(e.target.value)}
                >
                  <option value="quiet">Quiet (Normal)</option>
                  <option value="sleeping">Everyone is sleeping</option>
                  <option value="away">Empty (Away Mode)</option>
                  <option value="noisy">Very Noisy / Party</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Edge AI Simulator */}
          <Card className="rounded-md border-0 shadow-sm overflow-hidden">
            <CardHeader className="bg-gray-50 border-b pb-4">
              <CardTitle className="text-lg flex items-center gap-2">                
                <div className="relative">
                  <Mic className={`w-5 h-5 ${isListening ? "text-red-500" : "text-gray-400"}`} />
                  {isListening && (
                    <span className="absolute inset-0 rounded-full border-2 border-red-500 animate-ping"></span>
                  )}
                </div>
                Edge AI Simulation
              </CardTitle>
              <CardDescription>
                Trigger events to simulate the real-time acoustic pipeline.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 flex flex-col gap-3">
              <Button 
                className="bg-amazon-yellow text-black hover:bg-amazon-orange rounded-sm shadow-sm font-medium justify-start transition-colors"
                onClick={() => triggerEvent("baby_crying", "Baby Crying Detected")}
              >
                <Activity className="w-4 h-4 mr-2" />
                Trigger: Baby Crying
              </Button>
              <Button 
                className="bg-white border border-gray-300 text-black hover:bg-gray-50 rounded-sm shadow-sm font-medium justify-start transition-colors"
                onClick={() => triggerEvent("pressure_cooker_whistle", "Cooker Whistle (x3)")}
              >
                <ShieldAlert className="w-4 h-4 mr-2 text-red-500" />
                Trigger: Cooker Whistle
              </Button>
              <Button 
                className="bg-white border border-gray-300 text-black hover:bg-gray-50 rounded-sm shadow-sm font-medium justify-start transition-colors"
                onClick={() => triggerEvent("water_motor_on", "Water Motor On")}
              >
                <Bell className="w-4 h-4 mr-2 text-blue-500" />
                Trigger: Water Motor
              </Button>
              <Button 
                className="bg-white border border-gray-300 text-black hover:bg-purple-50 rounded-sm shadow-sm font-medium justify-start transition-colors"
                onClick={() => triggerEvent("repetitive_kya_kya", "Elderly: 'Kya? Kya?' (TV Vol increasing)")}
              >
                <Heart className="w-4 h-4 mr-2 text-purple-500" />
                Trigger: Hearing Struggle
              </Button>
              <Button 
                className="bg-white border border-gray-300 text-black hover:bg-blue-50 rounded-sm shadow-sm font-medium justify-start transition-colors"
                onClick={() => triggerEvent("rapid_typing_sighs", "Partner: High Stress (Rapid Typing & Sighs)")}
              >
                <Activity className="w-4 h-4 mr-2 text-blue-500" />
                Trigger: High Stress
              </Button>

              <TeachableAudioMonitor onEventDetected={triggerEvent} />
            </CardContent>
          </Card>


        </div>

        {/* Right Column: Dashboard & Logs */}
        <div className="lg:col-span-2 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Card className="rounded-md border-0 shadow-sm bg-white hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-gray-500 font-normal">Active Automations</CardTitle>
                <p className="text-2xl font-bold">3</p>
              </CardHeader>
            </Card>
            <Card className="rounded-md border-0 shadow-sm bg-white hover:shadow-md transition-shadow">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-gray-500 font-normal">Safety Status</CardTitle>
                <p className="text-2xl font-bold text-green-600 flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full bg-green-500 animate-pulse"></span>
                  Secure
                </p>
              </CardHeader>
            </Card>
          </div>

          <Card className="rounded-md border-0 shadow-sm min-h-[400px]">
            <CardHeader className="border-b bg-gray-50 rounded-t-md">
              <CardTitle>Household Event Timeline</CardTitle>
              <CardDescription>Real-time log of events and AI proactive decisions</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {logs.length === 0 ? (
                <div className="p-12 text-center text-gray-500 flex flex-col items-center">
                  <Activity className="w-12 h-12 text-gray-300 mb-4" />
                  <p>No events recorded yet.</p>
                  <p className="text-sm mt-1">Press a trigger button to simulate audio input.</p>
                </div>
              ) : (
                <ul className="divide-y max-h-[500px] overflow-y-auto">
                  {logs.map((log) => (
                    <li key={log.id} className="p-4 flex flex-col gap-1 hover:bg-gray-50 transition-colors group">
                      <div className="flex justify-between items-start">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400 font-medium">{log.time}</span>
                        </div>
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                          log.type === "trigger" ? "bg-gray-100 text-gray-600" :
                          log.type === "alert" ? "bg-red-100 text-red-700" :
                          log.type === "commerce" ? "bg-blue-100 text-blue-700" :
                          log.type === "family_connect" ? "bg-purple-100 text-purple-700" :
                          "bg-green-100 text-green-700"
                        }`}>
                          {log.type.toUpperCase()}
                        </span>
                      </div>
                      <span className={`font-medium text-sm ${log.type === 'alert' ? 'text-red-600' : log.type === 'family_connect' ? 'text-purple-600' : log.type === 'commerce' ? 'text-amazon-orange' : log.type === 'trigger' ? 'text-gray-500 text-xs font-bold uppercase tracking-wider' : 'text-gray-900'}`}>
                        {log.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </main>



      <Toaster position="top-center" richColors />
    </div>
  );
}
