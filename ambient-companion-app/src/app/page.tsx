"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { Bell, ShoppingCart, Activity, ShieldAlert, Zap, Settings, Mic } from "lucide-react";

export default function Home() {
  const [logs, setLogs] = useState<{ id: string, message: string, time: string, type: string }[]>([]);
  const [isListening, setIsListening] = useState(false);

  const triggerEvent = async (classification: string, label: string) => {
    const newLog = {
      id: Date.now().toString(),
      message: `Triggered: ${label}`,
      time: new Date().toLocaleTimeString(),
      type: "trigger"
    };
    setLogs((prev) => [newLog, ...prev]);

    try {
      const response = await fetch("/api/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classification, source: "simulator" }),
      });
      const data = await response.json();

      if (data.success) {
        const { action_type, message, suggested_cart_items } = data.data;

        // Log the AI response
        setLogs((prev) => [
          {
            id: Date.now().toString() + "res",
            message: `AI Response: ${message}`,
            time: new Date().toLocaleTimeString(),
            type: action_type
          },
          ...prev
        ]);

        if (action_type === "commerce") {
          toast.custom((t) => (
            <div className="bg-white border border-gray-200 shadow-xl p-4 flex gap-4 w-[356px] rounded-sm pointer-events-auto">
              <div className="bg-gray-100 w-16 h-16 rounded flex flex-col items-center justify-center text-2xl border border-gray-200 shrink-0">
                🍼
              </div>
              <div className="flex-1">
                <h4 className="text-amazon-link font-medium text-sm hover:underline cursor-pointer">
                  {suggested_cart_items?.[0]?.name || "Baby Supplies"}
                </h4>
                <p className="text-xs text-gray-500 mt-1">{message}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-amazon-textprimary font-bold text-sm">
                    {suggested_cart_items?.[0]?.price || "$24.99"}
                  </span>
                  <span className="text-xs text-gray-500 bg-gray-100 px-1 py-0.5 rounded">Prime</span>
                </div>
                <div className="mt-3">
                  <Button 
                    className="bg-amazon-yellow hover:bg-amazon-orange text-black w-full h-8 text-xs font-medium rounded-sm shadow-sm"
                    onClick={() => toast.dismiss(t)}
                  >
                    Add to Cart
                  </Button>
                </div>
              </div>
            </div>
          ), { duration: 8000 });
        } else if (action_type === "alert") {
          toast.custom((t) => (
            <div className="bg-white border-l-4 border-red-600 shadow-xl p-4 flex gap-3 w-[356px] rounded-sm pointer-events-auto">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
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
      toast.error("Failed to process event");
    }
  };

  return (
    <div className="min-h-screen bg-amazon-bgmain font-sans text-amazon-textprimary">
      {/* Top Navigation */}
      <header className="bg-amazon-black text-white p-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="text-amazon-orange w-6 h-6" />
          <h1 className="text-xl font-bold tracking-tight">Alexa Ambient Companion</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1">
            <ShoppingCart className="w-5 h-5 text-white" />
            <span className="font-medium">Cart</span>
          </div>
          <Settings className="w-5 h-5 text-white" />
        </div>
      </header>

      {/* Sub Navigation */}
      <div className="bg-amazon-navy text-white px-4 py-2 flex gap-4 text-sm font-medium">
        <span>Today's Insights</span>
        <span>Family Care</span>
        <span>Routines</span>
        <span>Safety</span>
      </div>

      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Left Column: Simulator Panel */}
        <div className="md:col-span-1 space-y-6">
          <Card className="rounded-md border-0 shadow-sm">
            <CardHeader className="bg-gray-50 border-b pb-4 rounded-t-md">
              <CardTitle className="text-lg flex items-center gap-2">
                <Mic className={isListening ? "text-red-500 animate-pulse" : "text-gray-400"} />
                Edge AI Simulation
              </CardTitle>
              <CardDescription>
                Trigger events to simulate the real-time acoustic pipeline.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-6 flex flex-col gap-3">
              <Button 
                className="bg-amazon-yellow text-black hover:bg-amazon-orange rounded-sm shadow-sm font-medium justify-start"
                onClick={() => triggerEvent("baby_crying", "Baby Crying Detected")}
              >
                <Activity className="w-4 h-4 mr-2" />
                Trigger: Baby Crying
              </Button>
              <Button 
                className="bg-white border border-gray-300 text-black hover:bg-gray-50 rounded-sm shadow-sm font-medium justify-start"
                onClick={() => triggerEvent("pressure_cooker_whistle", "Cooker Whistle (x3)")}
              >
                <ShieldAlert className="w-4 h-4 mr-2 text-red-500" />
                Trigger: Cooker Whistle
              </Button>
              <Button 
                className="bg-white border border-gray-300 text-black hover:bg-gray-50 rounded-sm shadow-sm font-medium justify-start"
                onClick={() => triggerEvent("water_motor_on", "Water Motor On")}
              >
                <Bell className="w-4 h-4 mr-2 text-blue-500" />
                Trigger: Water Motor
              </Button>
              
              <div className="pt-4 mt-2 border-t">
                <Button 
                  variant="outline" 
                  className="w-full rounded-sm"
                  onClick={() => setIsListening(!isListening)}
                >
                  {isListening ? "Stop Live Mic (Mock)" : "Start Live Mic (Mock)"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Dashboard & Logs */}
        <div className="md:col-span-2 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Card className="rounded-md border-0 shadow-sm bg-white">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-gray-500 font-normal">Active Automations</CardTitle>
                <p className="text-2xl font-bold">3</p>
              </CardHeader>
            </Card>
            <Card className="rounded-md border-0 shadow-sm bg-white">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-gray-500 font-normal">Safety Status</CardTitle>
                <p className="text-2xl font-bold text-green-600">Secure</p>
              </CardHeader>
            </Card>
          </div>

          <Card className="rounded-md border-0 shadow-sm min-h-[400px]">
            <CardHeader className="border-b bg-gray-50 rounded-t-md">
              <CardTitle>Household Event Stream</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {logs.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  No events recorded yet. Press a trigger button.
                </div>
              ) : (
                <ul className="divide-y">
                  {logs.map((log) => (
                    <li key={log.id} className="p-4 flex flex-col gap-1 hover:bg-gray-50">
                      <div className="flex justify-between items-center">
                        <span className={`font-medium ${log.type === 'alert' ? 'text-red-600' : log.type === 'commerce' ? 'text-amazon-link' : 'text-gray-900'}`}>
                          {log.message}
                        </span>
                        <span className="text-xs text-gray-500">{log.time}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
      <Toaster position="top-right" richColors />
    </div>
  );
}
