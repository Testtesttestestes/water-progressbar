/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { RealisticProgressBar } from './components/RealisticProgressBar';

export default function App() {
  const [progress, setProgress] = useState(0.5);
  const [isWaving, setIsWaving] = useState(false);
  const [tiltAngle, setTiltAngle] = useState(0);
  const [flaskWidth, setFlaskWidth] = useState(10);
  const [flaskHeight, setFlaskHeight] = useState(3);

  return (
  <div className="relative h-screen w-full overflow-hidden bg-gradient-to-br from-indigo-950 via-purple-900 to-black">
    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-30 select-none">
      <h1 className="text-[12vw] font-black text-white mix-blend-overlay leading-none tracking-tighter">WATER</h1>
      <h1 className="text-[12vw] font-black text-white mix-blend-overlay leading-none tracking-tighter">SHADER</h1>
    </div>

    <div
      className="absolute left-1/2 top-1/2 z-0 -translate-x-1/2 -translate-y-1/2 transition-all duration-300"
      style={{
        width: `${(flaskWidth + 6) * 35}px`,
        height: `${(flaskHeight + 6) * 35}px`,
      }}
    >
      <RealisticProgressBar
        progress={progress}
        isWaving={isWaving}
        tiltAngle={tiltAngle}
        flaskWidth={flaskWidth}
        flaskHeight={flaskHeight}
        className="h-full w-full"
      />
    </div>

    {/* 2. Слой интерфейса — только маленькая плашка внизу */}
    <div className="absolute bottom-6 left-1/2 z-20 w-[90%] max-w-md -translate-x-1/2">
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

          <div>
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/60">
              <span>Tilt</span>
              <span>{Math.round((tiltAngle * 180) / Math.PI)}°</span>
            </div>
            <input
              type="range"
              min={(-30 * Math.PI) / 180}
              max={(30 * Math.PI) / 180}
              step={0.005}
              value={tiltAngle}
              onChange={(e) => setTiltAngle(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/60">
              <span>Flask Width</span>
              <span>{flaskWidth.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={6}
              max={14}
              step={0.1}
              value={flaskWidth}
              onChange={(e) => setFlaskWidth(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/60">
              <span>Flask Height</span>
              <span>{flaskHeight.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={2}
              max={7}
              step={0.1}
              value={flaskHeight}
              onChange={(e) => setFlaskHeight(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
            />
          </div>

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
