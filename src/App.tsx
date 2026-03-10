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
  const [particleScale, setParticleScale] = useState(1);
  const [gravityScale, setGravityScale] = useState(1);
  const [flaskWidth, setFlaskWidth] = useState(10);
  const [flaskHeight, setFlaskHeight] = useState(3);

  return (
  <div className="relative h-screen w-full overflow-hidden bg-gray-900">
    {/* 1. Слой с водой (Канвас) — занимает весь экран на заднем плане */}
    <div className="absolute inset-0 z-0">
      <RealisticProgressBar
        progress={progress}
        isWaving={isWaving}
        tiltAngle={tiltAngle}
        particleScale={particleScale}
        gravityScale={gravityScale}
        flaskWidth={flaskWidth}
        flaskHeight={flaskHeight}
      />
    </div>

    {/* 2. Слой интерфейса — только маленькая плашка внизу */}
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-md z-10">
      <div className="max-h-[calc(100vh-3rem)] overflow-y-auto bg-black/40 backdrop-blur-md p-5 rounded-3xl border border-white/10 shadow-2xl">
        
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
              <span>Particle Scale</span>
              <span>{particleScale.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min="0.1"
              max="1.5"
              step="0.01"
              value={particleScale}
              onChange={(e) => setParticleScale(parseFloat(e.target.value))}
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
              min="4"
              max="18"
              step="0.1"
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
              min="1.6"
              max="10"
              step="0.1"
              value={flaskHeight}
              onChange={(e) => setFlaskHeight(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
            />
          </div>
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
              <span>Gravity</span>
              <span>{gravityScale.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={gravityScale}
              onChange={(e) => setGravityScale(parseFloat(e.target.value))}
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
