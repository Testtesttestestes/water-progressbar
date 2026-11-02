import React, { useEffect, useRef } from 'react';
import { FluidSolver } from '../fluid/solver';
import { FluidRenderer } from '../fluid/renderer';
import { Bubbles } from '../fluid/bubbles';
import { Spray } from '../fluid/spray';
import { EARTH_GRAVITY, FlaskMotion, rotate, sloshingFrequency } from '../fluid/motion';
import { BackgroundTexture, createFallbackBackground, loadBackground } from '../fluid/background';

interface RealisticProgressBarProps {
  /** Доля воды 0..1. */
  progress: number;
  isWaving?: boolean;
  /** Наклон в радианах (плюс — правый конец вниз). */
  tiltAngle?: number;
  className?: string;
  /** Разрешение сетки решателя: 1 — 64 ячейки поперёк колбы. */
  resolution?: number;
  /** Множитель земной тяжести (0 — невесомость). */
  gravityScale?: number;
  flaskWidth?: number;
  flaskHeight?: number;
  /** Скорость наполнения: доля полной колбы в секунду. */
  fillSpeed?: number;
}

const BACKGROUND_URL = 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?q=80&w=2000&auto=format&fit=crop';
const FLASK_CENTER_Y = 3.0;
const VIEW_HEIGHT = 12.0;
// Шаг решателя и предел шагов за кадр: на медленной машине симуляция замедляется,
// но остаётся согласованной, а не «догоняет» всё более длинными кадрами.
const SIM_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 4;

export const RealisticProgressBar: React.FC<RealisticProgressBarProps> = ({
  progress,
  isWaving = false,
  tiltAngle = 0,
  className,
  resolution = 1,
  gravityScale = 1,
  flaskWidth = 10,
  flaskHeight = 3,
  fillSpeed = 0.35,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Значения пропсов, которые меняются без пересоздания симуляции.
  const live = useRef({ progress, isWaving, tiltAngle, gravityScale, fillSpeed });
  live.current = { progress, isWaving, tiltAngle, gravityScale, fillSpeed };

  const halfX = Math.max(1.5, flaskWidth / 2);
  const halfY = Math.max(0.8, flaskHeight / 2);
  const radius = Math.min(halfX, halfY) * 0.5;
  const glass = Math.min(0.11, 0.08 * halfY);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    if (!gl) {
      console.error('WebGL2 unsupported.');
      return;
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      console.error('WebGL2 extension "EXT_color_buffer_float" unsupported.');
      return;
    }

    const { progress: p0, tiltAngle: tilt0 } = live.current;
    let fill = Math.min(Math.max(p0, 0), 1);
    const motion = new FlaskMotion(tilt0, FLASK_CENTER_Y);
    const angle0 = -tilt0;

    let solver: FluidSolver, bubbles: Bubbles, spray: Spray, renderer: FluidRenderer;
    try {
      solver = new FluidSolver(gl, {
        halfSize: [halfX, halfY], radius, glass,
        rows: Math.round(64 * Math.min(Math.max(resolution, 0.5), 2)),
        initialFill: fill, initialUp: rotate(-angle0, [0, 1]),
      });
      bubbles = new Bubbles(gl, solver);
      spray = new Spray(gl, solver);
      renderer = new FluidRenderer(gl);
    } catch (e) {
      console.error(e);
      return;
    }

    let background: BackgroundTexture = createFallbackBackground(gl);
    let disposed = false;
    loadBackground(gl, BACKGROUND_URL)
      .then((bg) => {
        if (disposed) {
          gl.deleteTexture(bg.texture);
          return;
        }
        gl.deleteTexture(background.texture);
        background = bg;
      })
      .catch(() => { /* остаётся запасной градиент */ });

    let frame = 0;
    let last: number | null = null;
    let accumulator = 0;
    let simTime = 0;
    // Сглаженное волнение воды: растит рябь (каустики) и пузырьки у поверхности.
    let waviness = 0;
    let kin = motion.step(0, { waving: false, tilt: tilt0, resonance: 1 });

    const loop = (now: number) => {
      if (disposed) return;
      const frameDt = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const params = live.current;
      const g = EARTH_GRAVITY * Math.max(params.gravityScale, 0);
      accumulator += frameDt;
      let steps = Math.floor(accumulator / SIM_DT);
      if (steps > MAX_STEPS_PER_FRAME) {
        steps = MAX_STEPS_PER_FRAME;
        accumulator = 0;
      } else accumulator -= steps * SIM_DT;

      for (let i = 0; i < steps; i++) {
        const target = Math.min(Math.max(params.progress, 0), 1);
        const maxDelta = Math.max(params.fillSpeed, 0.01) * SIM_DT;
        fill += Math.min(Math.max(target - fill, -2 * maxDelta), maxDelta);

        const resonance = 0.92 * sloshingFrequency(g, solver.cavityHalf[0], fill * 2 * solver.cavityHalf[1]);
        kin = motion.step(SIM_DT, { waving: params.isWaving, tilt: params.tiltAngle, resonance });
        // Тяжесть минус ускорение колбы — в систему колбы.
        const accel = rotate(-kin.angle, [-kin.accel[0], -g - kin.accel[1]]);
        solver.step({ dt: SIM_DT, accel, omega: kin.omega, omegaDot: kin.omegaDot, fill });
        // Волнение для пузырьков у поверхности: угловое ускорение и тряска относительно g.
        const agitation = (Math.abs(kin.omegaDot) * solver.cavityHalf[0] + Math.hypot(kin.accel[0], kin.accel[1])) / Math.max(g, 1);
        bubbles.update(SIM_DT, rotate(-kin.angle, [0, 1]), 40 * agitation);
        spray.update(SIM_DT, accel, EARTH_GRAVITY);
        waviness += (Math.min(25 * agitation, 2) - waviness) * (1 - Math.exp(-SIM_DT / 1.5));
        simTime += SIM_DT;
      }

      renderer.render({
        solver, bubbles, spray,
        background: background.texture, backgroundSize: background.size,
        width: canvas.width, height: canvas.height,
        flask: { position: kin.position, angle: kin.angle, halfSize: [halfX, halfY], radius, glass, up: rotate(-kin.angle, [0, 1]) },
        camera: { center: [0, 0], height: VIEW_HEIGHT },
        time: simTime,
        gravity: g,
        agitation: waviness,
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      gl.deleteTexture(background.texture);
      solver.dispose();
      bubbles.dispose();
      spray.dispose();
      renderer.dispose();
    };
  }, [halfX, halfY, radius, glass, resolution]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        display: 'block',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
};
