import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';

interface CameraFeedProps {
  isActive: boolean;
  onStreamReady: () => void;
  onError: (error: string) => void;
}

export interface CameraHandle {
  captureFrame: () => string | null;
  getMotionScore: () => number;
  getTextDensity: () => number;
}

const CameraFeed = forwardRef<CameraHandle, CameraFeedProps>(({ isActive, onStreamReady, onError }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Motion detection & Density analysis refs
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const prevFrameRef = useRef<Uint8ClampedArray | null>(null);

  useImperativeHandle(ref, () => ({
    captureFrame: () => {
      if (!videoRef.current || !canvasRef.current) return null;
      
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return null;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Return base64 jpeg
        return canvas.toDataURL('image/jpeg', 0.7).split(',')[1]; // Return raw base64 data
      }
      return null;
    },
    getMotionScore: () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return 1.0; 
        
        if (!analysisCanvasRef.current) {
            analysisCanvasRef.current = document.createElement('canvas');
            analysisCanvasRef.current.width = 64;
            analysisCanvasRef.current.height = 64;
        }
        
        const canvas = analysisCanvasRef.current;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return 0;
        
        ctx.drawImage(videoRef.current, 0, 0, 64, 64);
        const imageData = ctx.getImageData(0, 0, 64, 64);
        const data = imageData.data;
        
        let diff = 0;
        const prev = prevFrameRef.current;
        
        if (prev) {
            for (let i = 0; i < data.length; i += 4) {
                 diff += Math.abs(data[i] - prev[i]) + Math.abs(data[i+1] - prev[i+1]) + Math.abs(data[i+2] - prev[i+2]);
            }
        }
        
        prevFrameRef.current = new Uint8ClampedArray(data);
        
        if (!prev) return 1.0; 
        
        const maxPossibleDiff = 4096 * 765;
        return diff / maxPossibleDiff;
    },
    getTextDensity: () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return 0;
        
        // Use the shared analysis canvas (lazy init)
        if (!analysisCanvasRef.current) {
             analysisCanvasRef.current = document.createElement('canvas');
             analysisCanvasRef.current.width = 64; 
             analysisCanvasRef.current.height = 64;
        }

        const canvas = analysisCanvasRef.current;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return 0;

        // Draw center crop only to focus on where the user is pointing
        const v = videoRef.current;
        // Draw the center 50% of the video onto the 64x64 canvas
        ctx.drawImage(v, v.videoWidth * 0.25, v.videoHeight * 0.25, v.videoWidth * 0.5, v.videoHeight * 0.5, 0, 0, 64, 64);

        const imageData = ctx.getImageData(0, 0, 64, 64);
        const data = imageData.data;
        let edgeScore = 0;

        // Simple edge detection: |pixel - right_neighbor|
        // Only checking Luminance helps performance
        // Step 4 for RGBA
        for (let i = 0; i < data.length - 4; i += 4) {
            // Approx luminance sum
            const lum1 = (data[i] + data[i+1] + data[i+2]);
            const lum2 = (data[i+4] + data[i+5] + data[i+6]);
            
            const diff = Math.abs(lum1 - lum2);
            // Threshold for "edge" (sensitivity)
            // Text creates high contrast edges
            if (diff > 50) { 
                edgeScore++;
            }
        }
        
        // Normalize score
        // 64x64 = 4096 pixels. If 1/4 of pixels are edges, that's dense text.
        // Cap at 1.0
        return Math.min(edgeScore / 800, 1.0); 
    }
  }));

  useEffect(() => {
    const startCamera = async () => {
      try {
        if (!isActive) {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
            return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        
        streamRef.current = stream;
        
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play();
            onStreamReady();
          };
        }
      } catch (err) {
        console.error("Camera access error:", err);
        onError("Camera access denied or unavailable.");
      }
    };

    startCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, [isActive, onStreamReady, onError]);

  return (
    <div className="absolute inset-0 z-0 bg-black overflow-hidden" aria-hidden="true">
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="w-full h-full object-cover opacity-80"
      />
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
});

export default CameraFeed;