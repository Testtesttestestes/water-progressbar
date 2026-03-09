/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { RealisticProgressBar } from './components/RealisticProgressBar';

export default function App() {
  const [progress, setProgress] = useState(0.5);
  const [isWaving, setIsWaving] = useState(false);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8">
      <RealisticProgressBar progress={progress} isWaving={isWaving} />
      
      <div className="w-full max-w-2xl space-y-12 bg-black/20 backdrop-blur-md p-12 rounded-3xl border border-white/10 shadow-2xl relative z-10">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-medium text-white tracking-tight">Realistic Water Shader</h1>
          <p className="text-white/60">WebGL SPH Simulation</p>
        </div>

        <div className="h-32" /> {/* Spacer for the capsule area */}

        <div className="space-y-4 max-w-md mx-auto">
          <div className="flex justify-between text-sm font-medium text-white/50">
            <span>0%</span>
            <span>{Math.round(progress * 100)}%</span>
            <span>100%</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={progress}
            onChange={(e) => setProgress(parseFloat(e.target.value))}
            className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
          />
          <div className="flex justify-center pt-4">
            <button
              onClick={() => setIsWaving(!isWaving)}
              className={`px-6 py-2 rounded-full font-medium transition-all duration-300 ${
                isWaving 
                  ? 'bg-white text-black hover:bg-white/90 scale-105' 
                  : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'
              }`}
            >
              {isWaving ? 'Stop Waves' : 'Generate Waves'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
