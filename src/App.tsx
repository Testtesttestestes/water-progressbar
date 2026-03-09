import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createWaterProgressBar,
  type WaterProgressBarInstance,
  type WaterProgressBarOptions,
} from './api/waterProgressBarApi';

const px = (value: number) => `${Math.max(40, Math.round(value))}px`;

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<WaterProgressBarInstance | null>(null);

  const [progress, setProgress] = useState(0.5);
  const [isWaving, setIsWaving] = useState(false);
  const [tiltAngleDeg, setTiltAngleDeg] = useState(0);
  const [width, setWidth] = useState(480);
  const [height, setHeight] = useState(150);
  const [top, setTop] = useState('24px');
  const [left, setLeft] = useState('24px');
  const [meshQuality, setMeshQuality] = useState<'high' | 'balanced' | 'low'>('balanced');

  const options = useMemo<WaterProgressBarOptions>(
    () => ({
      progress,
      isWaving,
      tiltAngle: (tiltAngleDeg * Math.PI) / 180,
      width: px(width),
      height: px(height),
      top,
      left,
      position: 'absolute',
      meshQuality,
      borderRadius: '999px',
      wrapperClassName: 'shadow-[0_10px_30px_rgba(0,0,0,0.35)]',
    }),
    [height, isWaving, left, meshQuality, progress, tiltAngleDeg, top, width],
  );

  useEffect(() => {
    if (!instanceRef.current || !mountRef.current) {
      return;
    }
    instanceRef.current.update(options);
  }, [options]);


  useEffect(() => {
    if (!mountRef.current || instanceRef.current) return;
    instanceRef.current = createWaterProgressBar(mountRef.current, options);
    // intentionally once at startup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, []);

  const createCapsule = () => {
    if (!mountRef.current) return;
    instanceRef.current?.destroy();
    instanceRef.current = createWaterProgressBar(mountRef.current, options);
  };

  const destroyCapsule = () => {
    instanceRef.current?.destroy();
    instanceRef.current = null;
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white p-6 md:p-10">
      <h1 className="text-2xl font-semibold mb-2">Water ProgressBar API sandbox</h1>
      <p className="text-sm text-slate-300 mb-6">
        Тестовый стенд для создания/внедрения капсулы через подключаемый TypeScript API.
      </p>

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-4">
          <label className="block text-xs uppercase text-slate-300">
            Progress ({Math.round(progress * 100)}%)
            <input
              className="w-full mt-1"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
            />
          </label>

          <label className="block text-xs uppercase text-slate-300">
            Tilt ({tiltAngleDeg}°)
            <input
              className="w-full mt-1"
              type="range"
              min={-45}
              max={45}
              step={1}
              value={tiltAngleDeg}
              onChange={(e) => setTiltAngleDeg(Number(e.target.value))}
            />
          </label>

          <label className="block text-xs uppercase text-slate-300">
            Width ({px(width)})
            <input
              className="w-full mt-1"
              type="range"
              min={240}
              max={900}
              step={10}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </label>

          <label className="block text-xs uppercase text-slate-300">
            Height ({px(height)})
            <input
              className="w-full mt-1"
              type="range"
              min={70}
              max={300}
              step={5}
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </label>

          <div className="grid grid-cols-2 gap-3 text-xs uppercase text-slate-300">
            <label className="block">
              Top
              <input
                className="w-full mt-1 rounded bg-white/10 px-2 py-1"
                value={top}
                onChange={(e) => setTop(e.target.value)}
              />
            </label>
            <label className="block">
              Left
              <input
                className="w-full mt-1 rounded bg-white/10 px-2 py-1"
                value={left}
                onChange={(e) => setLeft(e.target.value)}
              />
            </label>
          </div>

          <label className="block text-xs uppercase text-slate-300">
            Mesh quality
            <select
              className="w-full mt-1 rounded bg-white/10 px-2 py-1"
              value={meshQuality}
              onChange={(e) => setMeshQuality(e.target.value as 'high' | 'balanced' | 'low')}
            >
              <option value="high">high</option>
              <option value="balanced">balanced</option>
              <option value="low">low</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <button className="rounded bg-emerald-500/90 py-2 text-sm font-medium" onClick={createCapsule}>
              Create capsule
            </button>
            <button className="rounded bg-rose-500/90 py-2 text-sm font-medium" onClick={destroyCapsule}>
              Destroy capsule
            </button>
            <button
              className="col-span-2 rounded bg-sky-500/90 py-2 text-sm font-medium"
              onClick={() => setIsWaving((v) => !v)}
            >
              {isWaving ? 'Stop wave motion' : 'Start wave motion'}
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-4">
          <p className="mb-2 text-sm text-slate-300">Площадка для внедрения через API</p>
          <div ref={mountRef} className="relative h-[480px] rounded-xl bg-black/30 overflow-hidden" />
        </div>
      </div>
    </div>
  );
}
