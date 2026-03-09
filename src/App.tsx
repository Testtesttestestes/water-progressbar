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
  <div className="relative h-screen w-full overflow-hidden bg-gray-900">
    {/* 1. Слой с водой (Канвас) — занимает весь экран на заднем плане */}
    <div className="absolute inset-0 z-0">
      <RealisticProgressBar progress={progress} isWaving={isWaving} />
    </div>

    {/* 2. Слой интерфейса — только маленькая плашка внизу */}
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-md z-10">
      <div className="bg-black/40 backdrop-blur-md p-5 rounded-3xl border border-white/10 shadow-2xl">
        
        {/* Заголовок и описание в одну строку для экономии места */}
        <div className="flex justify-between items-end mb-4">
          <div>
            <h1 className="text-lg font-medium text-white leading-none">Water Shader</h1>
            <p className="text-[10px] text-white/50 mt-1 uppercase tracking-wider">WebGL SPH</p>
          </div>
          <div className="text-sm font-mono text-white/80">
            {Math.round(progress * 100)}%
          </div>
        </div>

        <div className="space-y-4">
          {/* Ползунок */}
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={progress}
            onChange={(e) => setProgress(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
          />

          {/* Кнопка */}
          <button
            onClick={() => setIsWaving(!isWaving)}
            className={`w-full py-2.5 rounded-2xl text-xs font-bold uppercase tracking-widest transition-all ${
              isWaving 
                ? 'bg-white text-black scale-[0.98]' 
                : 'bg-white/10 text-white border border-white/10 hover:bg-white/20'
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