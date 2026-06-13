"use client";

import { useState, useEffect, useRef } from "react";
import * as tf from "@tensorflow/tfjs";
import * as speechCommands from "@tensorflow-models/speech-commands";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { Button } from "./ui/button";

interface LiveAudioMonitorProps {
  onEventDetected: (classification: string, label: string) => void;
}

export function LiveAudioMonitor({ onEventDetected }: LiveAudioMonitorProps) {
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [detectedWord, setDetectedWord] = useState<string | null>(null);
  const recognizerRef = useRef<speechCommands.SpeechCommandRecognizer | null>(null);

  useEffect(() => {
    // Cleanup on unmount
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
      const recognizer = speechCommands.create("BROWSER_FFT");
      await recognizer.ensureModelLoaded();
      recognizerRef.current = recognizer;
      console.log("Model loaded successfully");
    } catch (error) {
      console.error("Failed to load model:", error);
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
          // Find the word with the highest probability
          const maxScoreIndex = result.scores.indexOf(Math.max(...(result.scores as Float32Array)));
          const word = words[maxScoreIndex];
          const score = result.scores[maxScoreIndex];

          // Ignore background noise or low confidence
          if (word !== "background_noise" && word !== "unknown" && score > 0.85) {
            setDetectedWord(word);
            
            // Map specific words to our hackathon demo events!
            // In a real scenario, this would be YAMNet detecting "baby_crying"
            if (word === "up" || word === "stop") {
              onEventDetected("baby_crying", "Baby Crying Detected (Edge AI)");
              // Pause listening briefly to avoid duplicate triggers
              recognizerRef.current?.stopListening();
              setIsListening(false);
            } else if (word === "go" || word === "right") {
              onEventDetected("pressure_cooker_whistle", "Cooker Whistle (Edge AI)");
              recognizerRef.current?.stopListening();
              setIsListening(false);
            } else if (word === "yes") {
                onEventDetected("water_motor_on", "Water Motor On (Edge AI)");
                recognizerRef.current?.stopListening();
                setIsListening(false);
            }
          }
        },
        {
          includeSpectrogram: false,
          probabilityThreshold: 0.85,
          invokeCallbackOnNoiseAndUnknown: false,
          overlapFactor: 0.5,
        }
      );
    }
  };

  const stopListening = async () => {
    if (recognizerRef.current && isListening) {
      await recognizerRef.current.stopListening();
      setIsListening(false);
      setDetectedWord(null);
    }
  };

  return (
    <div className="pt-4 mt-2 border-t flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
            Status: {isLoading ? <span className="text-blue-500 animate-pulse">Loading Model...</span> : isListening ? <span className="text-red-500 font-bold">Listening...</span> : "Idle"}
        </span>
        {detectedWord && (
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
            Last heard: {detectedWord}
          </span>
        )}
      </div>
      <Button
        variant={isListening ? "destructive" : "outline"}
        className="w-full rounded-sm"
        onClick={isListening ? stopListening : startListening}
        disabled={isLoading}
      >
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Initializing Edge AI...
          </>
        ) : isListening ? (
          <>
            <MicOff className="w-4 h-4 mr-2" />
            Stop Edge AI Mic
          </>
        ) : (
          <>
            <Mic className="w-4 h-4 mr-2" />
            Start Live Mic (Edge AI)
          </>
        )}
      </Button>
      <p className="text-[10px] text-gray-400 leading-tight">
        *Using TF.js Speech Commands for demo. Say "up/stop" for Baby Crying, "go/right" for Whistle.
      </p>
    </div>
  );
}
