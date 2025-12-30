export enum AppMode {
    SCANNING = 'SCANNING',
    PAUSED = 'PAUSED',
    ANALYZING = 'ANALYZING',
    SETTINGS = 'SETTINGS'
  }
  
  export interface TTSConfig {
    rate: number;
    pitch: number;
    volume: number;
  }
  
  export interface OCRResult {
    text: string;
    confidence: number;
  }
  
  export interface GeminiResponse {
    text: string;
    error?: string;
  }