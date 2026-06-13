"use client";

import { useState, useEffect, useRef } from "react";
import * as tf from "@tensorflow/tfjs";
import * as speechCommands from "@tensorflow-models/speech-commands";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { Button } from "./ui/button";

interface TeachableAudioMonitorProps {
  onEventDetected: (classification: string, label: string) => void;
}

export function TeachableAudioMonitor({ onEventDetected }: TeachableAudioMonitorProps) {
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [detectedEvent, setDetectedEvent] = useState<string | null>(null);
  const recognizerRef = useRef<speechCommands.SpeechCommandRecognizer | null>(null);
  const lastTriggerTime = useRef<number>(0);

  // YOUR CUSTOM MODEL URL!
  const URL = "https://teachablemachine.withgoogle.com/models/wTZMCYKaL/";

  useEffect(() => {
    return () => {
      if (recognizerRef.current && isListening) {
        recognizerRef.current.stopListening();
      }
    };
  }, [isListening]);

  const initModel = async () => {
    setIsLoading(true);
    try {
      await tf.ready();
      const checkpointURL = URL + "model.json";
      const metadataURL = URL + "metadata.json";

      const recognizer = speechCommands.create(
        "BROWSER_FFT",
        undefined,
        checkpointURL,
        metadataURL
      );
      await recognizer.ensureModelLoaded();
      recognizerRef.current = recognizer;
      console.log("Teachable Machine Model loaded successfully.");
    } catch (error) {
      console.error("Failed to load TM model:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const startListening = async () => {
    if (!recognizerRef.current) {
      await initModel();
    }

    if (recognizerRef.current) {
      setIsListening(true);
      
      recognizerRef.current.listen(
        async (result) => {
          const words = recognizerRef.current!.wordLabels();
          const scores = result.scores as Float32Array;
          
          let maxScore = -1;
          let maxIndex = -1;
          for (let i = 0; i < scores.length; i++) {
            if (scores[i] > maxScore) {
              maxScore = scores[i];
              maxIndex = i;
            }
          }

          const label = words[maxIndex];

          // Log internally if confidence is decent, just to see what it's hearing
          if (maxScore > 0.6 && label !== "Background Noise") {
             console.log(`Custom Ambient Sound: ${label} (Confidence: ${(maxScore * 100).toFixed(1)}%)`);
          }

          // Trigger logic
          // Only trigger if highly confident and not background noise
          if (maxScore > 0.85 && label !== "Background Noise") {
            const now = Date.now();
            
            // 5 second cooldown to prevent spamming the backend
            if (now - lastTriggerTime.current > 5000) {
                setDetectedEvent(label);
                
                const lowerLabel = label.toLowerCase();
                
                // Route the custom TM labels to the backend classifications
                if (lowerLabel.includes("baby") || lowerLabel.includes("cry")) {
                  onEventDetected("baby_crying", "Baby Crying Detected");
                  lastTriggerTime.current = now;
                } else if (lowerLabel.includes("cooker") || lowerLabel.includes("whistle")) {
                  onEventDetected("pressure_cooker_whistle", "Cooker Whistle Detected");
                  lastTriggerTime.current = now;
                } else if (lowerLabel.includes("motor") || lowerLabel.includes("pump")) {
                  onEventDetected("water_motor_on", "Water Motor Detected");
                  lastTriggerTime.current = now;
                } else {
                  // Fallback for any other custom sounds you added!
                  onEventDetected("info", `Detected: ${label}`);
                  lastTriggerTime.current = now;
                }
            }
          }
        },
        {
          includeSpectrogram: false,
          probabilityThreshold: 0.75,
          invokeCallbackOnNoiseAndUnknown: true,
          overlapFactor: 0.5,
        }
      );
    }
  };

  const stopListening = async () => {
    if (recognizerRef.current && isListening) {
      await recognizerRef.current.stopListening();
      setIsListening(false);
      setDetectedEvent(null);
    }
  };

  return (
    <div className="pt-4 mt-2 border-t flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
            Status: {isLoading ? <span className="text-blue-500 animate-pulse">Loading Model...</span> : isListening ? <span className="text-red-500 font-bold animate-pulse">Listening 24/7...</span> : "Idle"}
        </span>
        {detectedEvent && (
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded truncate max-w-[150px]">
            Latest: {detectedEvent}
          </span>
        )}
      </div>
      <Button
        variant={isListening ? "destructive" : "outline"}
        className="w-full rounded-sm bg-indigo-600 text-white hover:bg-indigo-700"
        onClick={isListening ? stopListening : startListening}
        disabled={isLoading}
      >
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Initializing Custom AI...
          </>
        ) : isListening ? (
          <>
            <MicOff className="w-4 h-4 mr-2" />
            Stop Custom Model
          </>
        ) : (
          <>
            <Mic className="w-4 h-4 mr-2" />
            Start Custom Indian Audio AI
          </>
        )}
      </Button>
      <p className="text-[10px] text-gray-400 leading-tight">
        *Running your exact Teachable Machine model locally. 24/7 Monitoring.
      </p>
    </div>
  );
}
