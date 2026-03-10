/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef } from 'react';
import { RealisticProgressBar } from './components/RealisticProgressBar';
import { GlassEffect } from '@liquid-svg-glass/react';

export default function App() {
  const [progress, setProgress] = useState(0.5);
  const [isWaving, setIsWaving] = useState(false);
  const [tiltAngle, setTiltAngle] = useState(0);
  const [flaskWidth, setFlaskWidth] = useState(10);
  const [flaskHeight, setFlaskHeight] = useState(3);
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-gradient-to-br from-indigo-950 via-purple-900 to-black">
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-40 select-none">
        <h1 className="text-[14vw] font-black text-white mix-blend-overlay leading-none tracking-tighter">WATER</h1>
        <h1 className="text-[14vw] font-black text-white mix-blend-overlay leading-none tracking-tighter">SHADER</h1>
      </div>

      <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
        <div
          ref={containerRef}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 origin-center transition-all duration-300"
          style={{
            width: `${flaskWidth * 35}px`,
            height: `${flaskHeight * 35}px`,
          }}
        >
          <GlassEffect preset="dock" className="h-full w-full" style={{ borderRadius: '28px' }} />
        </div>

        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
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
            containerRef={containerRef}
          />
        </div>
      </div>

      <div className="absolute bottom-6 left-1/2 z-20 w-[90%] max-w-md -translate-x-1/2">
        <div className="rounded-3xl border border-white/10 bg-black/40 p-5 shadow-2xl backdrop-blur-md">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <h1 className="text-lg font-medium leading-none text-white">Water Shader</h1>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-white/50">WebGL SPH</p>
            </div>
            <div className="text-sm font-mono text-white/80">{Math.round(progress * 100)}%</div>
          </div>
          <div className="space-y-4">
            <input type="range" min="0" max="1" step="0.01" value={progress} onChange={(e) => setProgress(parseFloat(e.target.value))} className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-white/10 accent-white" />
            <div>
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/60"><span>Tilt</span><span>{Math.round((tiltAngle * 180) / Math.PI)}°</span></div>
              <input type="range" min={(-30 * Math.PI) / 180} max={(30 * Math.PI) / 180} step={0.005} value={tiltAngle} onChange={(e) => setTiltAngle(parseFloat(e.target.value))} className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-white/10 accent-white" />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/60"><span>Flask Width</span><span>{flaskWidth.toFixed(1)}</span></div>
              <input type="range" min={6} max={14} step={0.1} value={flaskWidth} onChange={(e) => setFlaskWidth(parseFloat(e.target.value))} className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-white/10 accent-white" />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/60"><span>Flask Height</span><span>{flaskHeight.toFixed(1)}</span></div>
              <input type="range" min={2} max={7} step={0.1} value={flaskHeight} onChange={(e) => setFlaskHeight(parseFloat(e.target.value))} className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-white/10 accent-white" />
            </div>
            <button onClick={() => setIsWaving(!isWaving)} className={`w-full rounded-2xl py-2.5 text-xs font-bold uppercase tracking-widest transition-all ${isWaving ? 'scale-[0.98] bg-white text-black' : 'border border-white/10 bg-white/10 text-white hover:bg-white/20'}`}>
              {isWaving ? 'Stop Waves' : 'Generate Waves'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
