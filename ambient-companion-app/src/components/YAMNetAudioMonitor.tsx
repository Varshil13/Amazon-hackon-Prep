"use client";

import { useState, useEffect, useRef } from "react";
import * as tf from "@tensorflow/tfjs";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { Button } from "./ui/button";

interface YAMNetAudioMonitorProps {
  onEventDetected: (classification: string, label: string) => void;
}

export function YAMNetAudioMonitor({ onEventDetected }: YAMNetAudioMonitorProps) {
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [detectedEvent, setDetectedEvent] = useState<string | null>(null);
  
  const modelRef = useRef<tf.GraphModel | null>(null);
  const classMapRef = useRef<string[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastTriggerTime = useRef<number>(0);
  const audioBufferRef = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    return () => {
      stopListening();
    };
  }, []);

  const loadClassMap = async () => {
    try {
      const response = await fetch("https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv");
      const text = await response.text();
      const lines = text.trim().split("\n");
      const classes = [];
      // Skip header
      for (let i = 1; i < lines.length; i++) {
        // Format: index,mid,display_name
        const parts = lines[i].split(",");
        // handle cases where display_name might have quotes, though standard CSV doesn't here mostly
        const name = parts.slice(2).join(",").replace(/"/g, "").trim();
        classes.push(name);
      }
      classMapRef.current = classes;
    } catch (e) {
      console.error("Failed to load class map", e);
    }
  };

  const initModel = async () => {
    setIsLoading(true);
    try {
      await tf.ready();
      const loadedModel = await tf.loadGraphModel("https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1", { fromTFHub: true });
      modelRef.current = loadedModel;
      await loadClassMap();
      console.log("YAMNet Model loaded successfully.");
    } catch (error) {
      console.error("Failed to load YAMNet:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const runPrediction = async (buffer: Float32Array) => {
    if (!modelRef.current || classMapRef.current.length === 0) return;

    // YAMNet expects a 1D float32 tensor of waveform
    const tensor = tf.tensor1d(buffer);
    
    try {
      const outputs = modelRef.current.predict(tensor) as tf.Tensor | tf.Tensor[];
      // The first output is the scores: [num_frames, 521]
      const scoresTensor = Array.isArray(outputs) ? outputs[0] : outputs;
      
      // Calculate max over all frames for each class
      const maxScores = tf.max(scoresTensor, 0);
      const scoresArray = await maxScores.data();
      
      // Find the class with the highest score
      let maxScore = -1;
      let maxIndex = -1;
      
      for (let i = 0; i < scoresArray.length; i++) {
        if (scoresArray[i] > maxScore) {
          maxScore = scoresArray[i];
          maxIndex = i;
        }
      }

      if (maxScore > 0.4) { // YAMNet confidence threshold
        const label = classMapRef.current[maxIndex];
        
        // Log all prominent sounds internally
        if (maxScore > 0.6) {
           console.log(`Ambient Sound Detected: ${label} (Confidence: ${(maxScore * 100).toFixed(1)}%)`);
        }
        
        const now = Date.now();
        // Cooldown of 5 seconds to prevent spamming
        if (now - lastTriggerTime.current > 5000) {
          const lowerLabel = label.toLowerCase();
          
          if (lowerLabel.includes("baby") || lowerLabel.includes("cry")) {
            setDetectedEvent(label);
            onEventDetected("baby_crying", "Baby Crying Detected (YAMNet)");
            lastTriggerTime.current = now;
          } else if (lowerLabel.includes("whistle")) {
            setDetectedEvent(label);
            onEventDetected("pressure_cooker_whistle", "Cooker Whistle (YAMNet)");
            lastTriggerTime.current = now;
          } else if (lowerLabel.includes("motor") || lowerLabel.includes("mechanisms") || lowerLabel.includes("engine")) {
            setDetectedEvent(label);
            onEventDetected("water_motor_on", "Motor Sound Detected (YAMNet)");
            lastTriggerTime.current = now;
          }
        }
      }
      
      tf.dispose([tensor, outputs, maxScores, scoresTensor]);
    } catch (e) {
      console.error(e);
      tf.dispose(tensor);
    }
  };

  const startListening = async () => {
    if (!modelRef.current) {
      await initModel();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000 // YAMNet requires 16kHz
      });
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // Deprecated but highly reliable for hackathons
      const processor = audioCtx.createScriptProcessor(8192, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const channelData = e.inputBuffer.getChannelData(0);
        
        const newBuffer = new Float32Array(audioBufferRef.current.length + channelData.length);
        newBuffer.set(audioBufferRef.current, 0);
        newBuffer.set(channelData, audioBufferRef.current.length);
        
        // Keep the last 15600 samples (~0.975s) as required by YAMNet
        if (newBuffer.length >= 15600) {
          const slice = newBuffer.slice(newBuffer.length - 15600);
          audioBufferRef.current = slice;
          runPrediction(slice);
        } else {
          audioBufferRef.current = newBuffer;
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination); // Required for Safari/Chrome to fire events

      setIsListening(true);
    } catch (err) {
      console.error("Microphone access denied or error:", err);
    }
  };

  const stopListening = () => {
    if (processorRef.current && audioCtxRef.current) {
      processorRef.current.disconnect();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close();
    }
    setIsListening(false);
    setDetectedEvent(null);
  };

  return (
    <div className="pt-4 mt-2 border-t flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
            Status: {isLoading ? <span className="text-blue-500 animate-pulse">Loading YAMNet...</span> : isListening ? <span className="text-red-500 font-bold animate-pulse">24/7 Monitoring...</span> : "Idle"}
        </span>
        {detectedEvent && (
          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded truncate max-w-[150px]">
            Latest: {detectedEvent}
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
            Initializing YAMNet...
          </>
        ) : isListening ? (
          <>
            <MicOff className="w-4 h-4 mr-2" />
            Stop 24/7 Monitoring
          </>
        ) : (
          <>
            <Mic className="w-4 h-4 mr-2" />
            Start Full Audio Monitoring (YAMNet)
          </>
        )}
      </Button>
      <p className="text-[10px] text-gray-400 leading-tight">
        *Running real-time YAMNet inference locally. Logs 521 audio classes continuously.
      </p>
    </div>
  );
}
