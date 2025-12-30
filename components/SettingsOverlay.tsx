import React from 'react';
import { TTSConfig } from '../types';

interface SettingsOverlayProps {
  config: TTSConfig;
  onChange: (newConfig: TTSConfig) => void;
  onClose: () => void;
}

const SettingsOverlay: React.FC<SettingsOverlayProps> = ({ config, onChange, onClose }) => {
  const handleRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...config, rate: parseFloat(e.target.value) });
  };

  const handlePitchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange({ ...config, pitch: parseFloat(e.target.value) });
  };

  return (
    <div 
      className="fixed inset-0 z-50 bg-black text-yellow-400 p-6 flex flex-col justify-center gap-8"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <h2 className="text-4xl font-bold mb-4 border-b-2 border-yellow-400 pb-2">Settings</h2>
      
      <div className="flex flex-col gap-2">
        <label htmlFor="rate" className="text-2xl font-semibold">Speed: {config.rate.toFixed(1)}x</label>
        <input
          id="rate"
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={config.rate}
          onChange={handleRateChange}
          className="w-full h-12 accent-yellow-400"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="pitch" className="text-2xl font-semibold">Pitch: {config.pitch.toFixed(1)}</label>
        <input
          id="pitch"
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={config.pitch}
          onChange={handlePitchChange}
          className="w-full h-12 accent-yellow-400"
        />
      </div>

      <button
        onClick={onClose}
        className="mt-8 bg-yellow-400 text-black text-2xl font-bold py-6 rounded-xl hover:bg-yellow-300 active:scale-95 transition-transform"
        aria-label="Close Settings"
      >
        Done
      </button>
    </div>
  );
};

export default SettingsOverlay;