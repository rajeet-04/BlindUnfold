import React, { useState, useEffect, useRef, useCallback } from 'react';
import CameraFeed, { CameraHandle } from './components/CameraFeed';
import { initializeOCR, recognizeText } from './services/ocrService';
import { speak, stopSpeaking, isSpeaking } from './services/ttsService';
import { analyzeScene, readHandwriting } from './services/geminiService';
import { startGuidance, stopGuidance, setGuidanceDensity } from './services/audioGuidanceService';
import { VoiceCommander } from './services/voiceCommandService';
import { AppMode, TTSConfig } from './types';

// Motion Thresholds
const MOTION_THRESHOLD_RESET = 0.15; // 15% change -> Moving to new target
const MOTION_THRESHOLD_STABLE = 0.05; // 5% change -> Stable (Reading)

// Dictionary of common words to validate meaningful text
const COMMON_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "it", "for", "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their", "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "when", "make", "can", "like", "time", "no", "just", "him", "know", "take", "people", "into", "year", "your", "good", "some", "could", "them", "see", "other", "than", "then", "now", "look", "only", "come", "its", "over", "think", "also", "back", "after", "use", "two", "how", "our", "work", "first", "well", "way", "even", "new", "want", "because", "any", "these", "give", "day", "most", "us", "exit", "menu", "start", "stop", "open", "close", "help", "danger", "caution", "warning", "info", "enter", "push", "pull"
]);

const isMeaningfulText = (text: string, confidence: number): boolean => {
  const clean = text.trim();
  if (clean.length < 2) return false;

  // Check for presence of Hindi (Devanagari), Bengali, or Urdu (Arabic) characters
  // Devanagari: \u0900-\u097F
  // Bengali: \u0980-\u09FF
  // Arabic (Urdu): \u0600-\u06FF
  const nonLatinRegex = /[\u0900-\u097F\u0980-\u09FF\u0600-\u06FF]/;
  
  if (nonLatinRegex.test(clean)) {
      // For these languages, we skip the English-specific heuristics (dictionary, alpha-numeric ratio)
      // We rely primarily on confidence. 
      return confidence >= 50;
  }

  // 1. Calculate Symbol Density (English/Latin Logic)
  // Count valid alpha-numeric characters
  const alphaNumericCount = clean.replace(/[^a-zA-Z0-9]/g, '').length;
  // If almost no letters/numbers, it's noise (e.g. "||--__")
  if (alphaNumericCount < clean.length * 0.5) return false;

  // 2. Dictionary / Structure Check
  // Check if any word in the text exists in our common dictionary
  const words = clean.toLowerCase().split(/[\s,.!?]+/);
  const hasCommonWord = words.some(w => COMMON_WORDS.has(w));
  
  // 3. Dynamic Confidence Threshold
  // If we recognize a common word, we trust the OCR more (lower threshold)
  // If it's unknown text, we require higher confidence to avoid reading garbage
  const threshold = hasCommonWord ? 40 : 60;

  return confidence >= threshold;
};

// Levenshtein distance for fuzzy string comparison
const levenshtein = (a: string, b: string): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          Math.min(matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1) // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
};

const isTextSimilar = (text1: string, text2: string, threshold = 0.8): boolean => {
    // Normalize: allow alphanumeric and the specific language ranges we support
    // This prevents non-latin scripts from being stripped out during comparison
    const normalize = (t: string) => t.toLowerCase().replace(/[^\w\u0600-\u06FF\u0900-\u097F\u0980-\u09FF]/g, '');
    const s1 = normalize(text1);
    const s2 = normalize(text2);
    
    if (!s1 || !s2) return false;
    if (s1 === s2) return true;

    // Check for subset/superset to prevent restarts on minor OCR framing changes
    if (s1.includes(s2) || s2.includes(s1)) return true;

    const distance = levenshtein(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);
    const similarity = 1 - (distance / maxLength);
    
    return similarity >= threshold;
};

const App: React.FC = () => {
  // Start in PAUSED mode for Hold-to-Scan interaction
  const [mode, setMode] = useState<AppMode>(AppMode.PAUSED);
  const [lastText, setLastText] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('Initializing...');
  const [ttsConfig, setTTSConfig] = useState<TTSConfig>({ rate: 1.1, pitch: 1.0, volume: 1.0 }); 
  const [isFlashActive, setFlashActive] = useState<boolean>(false);
  const [isGuidanceOn, setIsGuidanceOn] = useState<boolean>(false);
  const [isVoiceControlOn, setIsVoiceControlOn] = useState<boolean>(false);
  
  const cameraRef = useRef<CameraHandle>(null);
  const intervalRef = useRef<number | null>(null);
  const guidanceIntervalRef = useRef<number | null>(null);
  const isProcessingRef = useRef<boolean>(false);
  const voiceCommanderRef = useRef<VoiceCommander | null>(null);
  
  // Ref to track mode inside async functions to prevent race conditions
  const latestModeRef = useRef<AppMode>(AppMode.PAUSED);

  // Gesture Tracking
  const pointerStartY = useRef<number>(0);

  useEffect(() => {
    latestModeRef.current = mode;
  }, [mode]);

  // --- Voice Control Logic ---
  const handleVoiceCommand = useCallback((command: string) => {
    if (navigator.vibrate) navigator.vibrate(50);

    switch (command) {
        case 'STOP':
            stopScanning();
            stopSpeaking();
            speak("Stopped.", ttsConfig);
            break;
        case 'READ':
            if (latestModeRef.current !== AppMode.SCANNING) {
                setMode(AppMode.SCANNING);
                setStatusMessage("Scanning...");
                speak("Scanning.", ttsConfig);
            }
            break;
        case 'DESCRIBE':
            handleDetailedAnalysis();
            break;
        case 'HANDWRITING':
            handleHandwritingRead();
            break;
        case 'LOUDER':
            setTTSConfig(c => {
                const newVol = Math.min(c.volume + 0.2, 1.0);
                speak("Louder.", { ...c, volume: newVol });
                return { ...c, volume: newVol };
            });
            break;
        case 'QUIETER':
            setTTSConfig(c => {
                const newVol = Math.max(c.volume - 0.2, 0.1);
                speak("Quieter.", { ...c, volume: newVol });
                return { ...c, volume: newVol };
            });
            break;
        case 'FASTER':
            setTTSConfig(c => {
                const newRate = Math.min(c.rate + 0.2, 2.0);
                speak("Faster.", { ...c, rate: newRate });
                return { ...c, rate: newRate };
            });
            break;
        case 'SLOWER':
            setTTSConfig(c => {
                const newRate = Math.max(c.rate - 0.2, 0.5);
                speak("Slower.", { ...c, rate: newRate });
                return { ...c, rate: newRate };
            });
            break;
        case 'HELP':
            speak("Voice commands are: Read, Stop, Describe Scene, Read Handwriting, Louder, Slower, and Help.", ttsConfig);
            break;
        default:
            break;
    }
  }, [ttsConfig]);

  useEffect(() => {
    initializeOCR().then(() => {
      setStatusMessage("Hold to scan. Swipe up for handwriting.");
      speak("Ready. Hold screen to scan.", ttsConfig);
    });

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          await navigator.wakeLock.request('screen');
        }
      } catch (err) {
        console.warn("Wake Lock failed", err);
      }
    };
    requestWakeLock();
    
    voiceCommanderRef.current = new VoiceCommander(handleVoiceCommand);

    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      if (voiceCommanderRef.current) voiceCommanderRef.current.stop();
      stopSpeaking();
      stopGuidance();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  // --- Voice Control Toggle ---
  useEffect(() => {
      if (!voiceCommanderRef.current) return;
      if (isVoiceControlOn) {
          voiceCommanderRef.current.start();
      } else {
          voiceCommanderRef.current.stop();
      }
  }, [isVoiceControlOn]);

  const toggleVoiceControl = (e: React.MouseEvent | React.PointerEvent) => {
      e.stopPropagation();
      const newState = !isVoiceControlOn;
      setIsVoiceControlOn(newState);
      speak(newState ? "Voice control on." : "Voice control off.", ttsConfig);
  };

  // --- Audio Guidance Loop ---
  useEffect(() => {
    if (guidanceIntervalRef.current) clearInterval(guidanceIntervalRef.current);
    if (isGuidanceOn) {
        startGuidance();
        guidanceIntervalRef.current = window.setInterval(() => {
            if (cameraRef.current) {
                const density = cameraRef.current.getTextDensity();
                setGuidanceDensity(density);
            }
        }, 150);
    } else {
        stopGuidance();
    }
    return () => {
        if (guidanceIntervalRef.current) clearInterval(guidanceIntervalRef.current);
        stopGuidance();
    };
  }, [isGuidanceOn]);

  const toggleGuidance = (e: React.MouseEvent | React.PointerEvent) => {
      e.stopPropagation();
      const newState = !isGuidanceOn;
      setIsGuidanceOn(newState);
      if (newState) {
          speak("Guidance on.", ttsConfig);
      } else {
          speak("Guidance off.", ttsConfig);
      }
  };

  // --- Scanning Interval Logic ---
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (mode === AppMode.SCANNING) {
      intervalRef.current = window.setInterval(async () => {
        if (!cameraRef.current) return;
        const motionScore = cameraRef.current.getMotionScore();
        if (motionScore > MOTION_THRESHOLD_RESET) return; 

        if (motionScore < MOTION_THRESHOLD_STABLE && !isProcessingRef.current) {
           performScan();
        }
      }, 200);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [mode]);

  const performScan = async () => {
      if (!cameraRef.current) return;
      
      const base64Image = cameraRef.current.captureFrame();
      if (!base64Image) return;

      const dataUrl = `data:image/jpeg;base64,${base64Image}`;
      isProcessingRef.current = true;
      setStatusMessage("Scanning...");

      try {
        const { text, confidence } = await recognizeText(dataUrl);
        if (latestModeRef.current !== AppMode.SCANNING) return;

        if (text && isMeaningfulText(text, confidence)) {
            const currentlySpeaking = isSpeaking();
            const threshold = currentlySpeaking ? 0.4 : 0.7;
            const similar = isTextSimilar(text, lastText, threshold);

            if (!similar) {
                setStatusMessage("Reading...");
                setLastText(text); 
                if (navigator.vibrate) navigator.vibrate(100);
                setFlashActive(true);
                setTimeout(() => setFlashActive(false), 300);
                speak(text, ttsConfig);
            } else {
                setStatusMessage("Reading...");
            }
        } else {
            if (!isSpeaking()) {
                setStatusMessage("No text detected");
            }
        }
      } catch (e) {
        console.error("Scan error", e);
      } finally {
        isProcessingRef.current = false;
      }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (mode === AppMode.ANALYZING) return; // Removed SETTINGS check
    try {
        (e.target as Element).setPointerCapture(e.pointerId);
    } catch (err) {
        console.warn("Pointer capture failed", err);
    }
    pointerStartY.current = e.clientY;
    setLastText(''); 
    setMode(AppMode.SCANNING);
    setStatusMessage("Scanning...");
    if (navigator.vibrate) navigator.vibrate(20);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (mode === AppMode.ANALYZING) return;
    try {
        (e.target as Element).releasePointerCapture(e.pointerId);
    } catch (err) { }

    const diff = pointerStartY.current - e.clientY;
    const threshold = Math.min(window.innerHeight * 0.15, 150);

    if (diff > threshold) {
        handleHandwritingRead();
    } else {
        stopScanning();
    }
  };

  const stopScanning = () => {
    if (mode === AppMode.ANALYZING) return;
    setMode(AppMode.PAUSED);
    setStatusMessage("Hold to scan. Swipe up for handwriting.");
  };

  const handleHandwritingRead = async () => {
      if (!cameraRef.current) return;
      setMode(AppMode.ANALYZING);
      stopSpeaking(); 
      speak("Reading handwriting...", ttsConfig);
      if (navigator.vibrate) navigator.vibrate([50, 50, 50]);

      const base64 = cameraRef.current.captureFrame();
      if (base64) {
        const text = await readHandwriting(base64);
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        speak(text, ttsConfig);
      } else {
        speak("Capture failed.", ttsConfig);
      }
      setMode(AppMode.PAUSED);
      setStatusMessage("Hold to scan. Swipe up for handwriting.");
  };

  const handleDetailedAnalysis = async () => {
    if (!cameraRef.current) return;
    setMode(AppMode.ANALYZING);
    stopSpeaking();
    speak("Analyzing scene...", ttsConfig);
    
    const base64 = cameraRef.current.captureFrame();
    if (base64) {
      const description = await analyzeScene(base64);
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      speak(description, ttsConfig);
    } else {
      speak("Capture failed.", ttsConfig);
    }
    setMode(AppMode.PAUSED); 
    setStatusMessage("Hold to scan. Swipe up for handwriting.");
  };

  const isAnalyzing = mode === AppMode.ANALYZING;
  
  return (
    <main 
      className="relative h-screen w-screen bg-black overflow-hidden select-none touch-manipulation flex flex-col"
      role="main"
    >
      <CameraFeed 
        ref={cameraRef}
        isActive={true} 
        onStreamReady={() => {}} 
        onError={(err) => setStatusMessage(err)}
      />

      {/* Reading Flash Overlay (Yellow) */}
      <div 
        className={`absolute inset-0 z-30 pointer-events-none bg-yellow-500 transition-opacity duration-200 ${isFlashActive ? 'opacity-40' : 'opacity-0'}`}
        aria-hidden="true"
      />

      {/* Analyzing Overlay (Blue Pulse) */}
      <div 
        className={`absolute inset-0 z-30 pointer-events-none bg-blue-900/40 backdrop-blur-[1px] transition-opacity duration-500 ${isAnalyzing ? 'opacity-100 animate-pulse' : 'opacity-0'}`}
        aria-hidden="true"
      />

      {/* --- EXTRA LARGE ACCESSIBILITY TOOLBAR --- */}
      <div className="relative z-50 flex flex-row w-full h-32 border-b-4 border-black shadow-lg">
        {/* Audio Guide Toggle */}
        <button
          onClick={toggleGuidance}
          onPointerDown={(e) => e.stopPropagation()}
          className={`flex-1 flex flex-col items-center justify-center border-r-4 border-black transition-colors duration-200
            ${isGuidanceOn ? 'bg-yellow-400 text-black' : 'bg-zinc-800 text-gray-300'}
          `}
          role="switch"
          aria-checked={isGuidanceOn}
          aria-label="Toggle Audio Guidance"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mb-2" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
          <span className="text-xl font-black uppercase tracking-wider">Guide</span>
        </button>

        {/* Voice Command Toggle */}
        <button
          onClick={toggleVoiceControl}
          onPointerDown={(e) => e.stopPropagation()}
          className={`flex-1 flex flex-col items-center justify-center transition-colors duration-200
            ${isVoiceControlOn ? 'bg-yellow-400 text-black' : 'bg-zinc-800 text-gray-300'}
          `}
          role="switch"
          aria-checked={isVoiceControlOn}
          aria-label="Toggle Voice Control"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className={`h-12 w-12 mb-2 ${isVoiceControlOn ? 'animate-pulse' : ''}`} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
          </svg>
          <span className="text-xl font-black uppercase tracking-wider">Voice</span>
        </button>
      </div>

      {/* Main Interaction Layer: Hold to Scan */}
      {/* Occupies the remaining space below the toolbar */}
      <div 
        className="relative flex-1 z-20 cursor-pointer w-full"
        style={{ touchAction: 'none' }} 
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={stopScanning}
        onPointerLeave={stopScanning}
        onDoubleClick={handleDetailedAnalysis}
        role="button"
        aria-label="Scan area. Hold anywhere below the toolbar to read text. Swipe up for handwriting."
        tabIndex={0}
      >
        {/* Invisible hit area, visual is handled by CameraFeed background */}
      </div>

      {/* High Contrast Status Footer */}
      <div 
        className={`relative w-full p-6 bg-black/90 border-t-8 flex flex-col items-center justify-center z-40 transition-colors duration-300 min-h-[160px]
            ${isAnalyzing ? 'border-blue-500' : 'border-yellow-400'}
        `}
        aria-live="polite"
      >
        <p className={`text-3xl font-black text-center transition-colors duration-300 ${isAnalyzing ? 'text-blue-400' : 'text-yellow-400'}`}>
          {isAnalyzing ? "Analyzing..." : statusMessage}
        </p>
        {lastText && !isAnalyzing && (
           <p className="text-white text-xl mt-3 line-clamp-3 font-medium opacity-90 text-center px-4">
             "{lastText}"
           </p>
        )}
      </div>

    </main>
  );
};

export default App;