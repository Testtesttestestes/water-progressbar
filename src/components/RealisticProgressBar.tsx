import React, { useEffect, useRef } from 'react';
import * as GLU from '../sph/glutils.js';
import { Vec2 } from '../sph/mathtype.js';
import * as Renderer from '../sph/renderer.js';
import * as SPH from '../sph/sph.js';

interface RealisticProgressBarProps {
  progress: number; // от 0.0 до 1.0
  isWaving?: boolean;
  tiltAngle?: number;
  className?: string;
  meshQuality?: 'high' | 'balanced' | 'low';
  particleScale?: number;
  gravityScale?: number;
  flaskWidth?: number;
  flaskHeight?: number;
  /** Скорость наполнения: доля полной колбы в секунду. */
  fillSpeed?: number;
}

const FLASK_MOTION = {
  offsetXAmp: 1.0,
  offsetXFreq: 0.8,
  angleAmp: 0.15,
  angleFreq: 1.2,
};

const FLASK_CENTER_Y = 3.0;
// Время выхода раскачивания на полную амплитуду и обратно, с.
const WAVE_RAMP_TIME = 0.6;
const TILT_SMOOTHING_TIME = 0.18;
// Не больше стольких шагов за кадр: на медленной машине симуляция замедляется,
// но остаётся согласованной, а не «догоняет» всё более длинными кадрами.
const MAX_STEPS_PER_FRAME = 12;

// Поза колбы и её скорости в момент t (аналитически, без конечных разностей).
const getContainerKinematics = (t: number, waveAmplitude: number, tilt: number, tiltVelocity: number) => {
  const wx = FLASK_MOTION.offsetXFreq;
  const wa = FLASK_MOTION.angleFreq;
  const offsetX = Math.sin(t * wx) * FLASK_MOTION.offsetXAmp * waveAmplitude;
  const velX = Math.cos(t * wx) * wx * FLASK_MOTION.offsetXAmp * waveAmplitude;
  const angle = Math.sin(t * wa) * FLASK_MOTION.angleAmp * waveAmplitude + tilt;
  const angularVelocity = Math.cos(t * wa) * wa * FLASK_MOTION.angleAmp * waveAmplitude + tiltVelocity;
  return {
    position: new Vec2(offsetX, FLASK_CENTER_Y),
    velocity: new Vec2(velX, 0),
    angle,
    angularVelocity,
  };
};

const MESH_QUALITY_FACTORS: Record<NonNullable<RealisticProgressBarProps['meshQuality']>, number> = {
  high: 4,
  balanced: 2,
  low: 1,
};

export const RealisticProgressBar: React.FC<RealisticProgressBarProps> = ({
  progress,
  isWaving = false,
  tiltAngle = 0,
  className,
  meshQuality = 'low',
  particleScale = 1,
  gravityScale = 1,
  flaskWidth = 10,
  flaskHeight = 3,
  fillSpeed = 0.35,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);
  const isWavingRef = useRef(isWaving);
  const waveAmplitudeRef = useRef(0.0);
  const timeRef = useRef(0.0);
  const tiltAngleRef = useRef(tiltAngle);
  const gravityScaleRef = useRef(gravityScale);
  const smoothedTiltAngleRef = useRef(tiltAngle);

  const flaskHalfSize = {
    x: Math.max(1.5, flaskWidth / 2),
    y: Math.max(0.8, flaskHeight / 2),
  };
  const flaskRadius = Math.min(flaskHalfSize.x, flaskHalfSize.y) * 0.5;

  useEffect(() => {
    progressRef.current = progress;
    SPH.injectWater(progress);
  }, [progress]);

  useEffect(() => {
    isWavingRef.current = isWaving;
  }, [isWaving]);

  useEffect(() => {
    tiltAngleRef.current = tiltAngle;
  }, [tiltAngle]);

  useEffect(() => {
    gravityScaleRef.current = gravityScale;
    SPH.setGravityScale(gravityScale);
  }, [gravityScale]);

  useEffect(() => {
    SPH.setFillSpeed(fillSpeed);
  }, [fillSpeed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseMove = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        
        let clipX = (x / canvas.width) * 2 - 1;
        let clipY = -((y / canvas.height) * 2 - 1);
        
        const simPos = Renderer.clipPosToSimPos(new Vec2(clipX, clipY));
        SPH.setPointerPos(simPos);
    };

    const handleMouseLeave = () => {
        SPH.setPointerPos(new Vec2(0, 0));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);

    let gl = canvas.getContext('webgl2');
    if (!gl) {
        console.error('WebGL2 unsupported.');
        return;
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
        console.error('WebGL2-extention "EXT_color_buffer_float" unsupported.');
        return;
    }

    const R0 = 12;
    const baseDp = 8 / 64;
    const safeParticleScale = Math.max(0.35, particleScale);
    const dp = baseDp * safeParticleScale;
    const fluidDomainR = 0.95 * R0;

    const createParticlesRoundedBox = () => {
        let pos = [];
        let boxSize = flaskHalfSize;
        let boxRadius = flaskRadius;
        
        let minX = -flaskHalfSize.x - 2.0;
        let maxX = flaskHalfSize.x + 2.0;
        let minY = 3.0 - flaskHalfSize.y - 2.0;
        let maxY = 3.0 + flaskHalfSize.y + 2.0;
        
        const sdRoundedBox = (px: number, py: number, bx: number, by: number, r: number) => {
            let qx = Math.abs(px) - bx + r;
            let qy = Math.abs(py) - by + r;
            let extX = Math.max(qx, 0);
            let extY = Math.max(qy, 0);
            return Math.min(Math.max(qx, qy), 0.0) + Math.sqrt(extX * extX + extY * extY) - r;
        };

        for (let x = minX; x <= maxX; x += dp * 1.05) {
            for (let y = minY; y <= maxY; y += dp * 1.05) {
                let dist = sdRoundedBox(x, y - 3.0, boxSize.x, boxSize.y, boxRadius);
                
                // Fill the volume
                if (dist < -dp * 0.5) {
                    pos.push(x, y);
                }
            }
        }
        return pos;
    };

    let animationFrameId: number;
    let isDisposed = false;
    let lastTime: number | null = null;

    const initAsync = async () => {
        SPH.setGravityScale(gravityScaleRef.current);
        SPH.setFlaskShape({ boxHalfSize: flaskHalfSize, radius: flaskRadius });
        const bgUrl = 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?q=80&w=2000&auto=format&fit=crop';
        // Без сети картинка не загрузится — тогда рисуем на запасном градиенте,
        // а не оставляем пустой холст.
        const [bgTex] = await Promise.all([
            GLU.loadTexture(gl, bgUrl).catch(() => GLU.createFallbackBackground(gl)),
            SPH.loadShaderFilesAsync(), 
            Renderer.loadShaderFilesAsync()
        ]);

        if (isDisposed) return;
        
        Renderer.setBackgroundTexture(bgTex);
        SPH.init(gl, dp, fluidDomainR, createParticlesRoundedBox());
        Renderer.init(gl, canvas, dp, new Vec2(-R0), new Vec2(R0), {
          meshSizeQualityFactor: MESH_QUALITY_FACTORS[meshQuality],
        });
        Renderer.setRenderingSimulationArea(new Vec2(-R0), new Vec2(R0));
        lastTime = null;
        let simAccumulator = 0;
        const simDt = SPH.timeStep();

        const loop = (currentTime: number) => {
            if (isDisposed) return;

            if (lastTime === null) {
              lastTime = currentTime;
            }

            const dt = (currentTime - lastTime) / 1000;
            lastTime = currentTime;

            // Resize canvas to match display size with device pixel ratio
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const displayWidth = Math.floor(canvas.clientWidth * dpr);
            const displayHeight = Math.floor(canvas.clientHeight * dpr);
            if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
                canvas.width = displayWidth;
                canvas.height = displayHeight;
            }

            // Реальное время → время симуляции. Каждый шаг двигает колбу ровно на simDt,
            // поэтому скорость стенок, которую видит вода, совпадает с их реальным
            // смещением — даже если кадр пришёл с опозданием.
            simAccumulator += Math.min(Math.max(dt, 0), 0.1);
            let steps = Math.floor(simAccumulator / simDt);
            if (steps > MAX_STEPS_PER_FRAME) {
              steps = MAX_STEPS_PER_FRAME;
              simAccumulator = 0;
            } else {
              simAccumulator -= steps * simDt;
            }

            const targetAmplitude = isWavingRef.current ? 1.0 : 0.0;
            const waveLerp = 1.0 - Math.exp(-simDt / WAVE_RAMP_TIME);
            const tiltLerp = 1.0 - Math.exp(-simDt / TILT_SMOOTHING_TIME);

            let kin = getContainerKinematics(timeRef.current, waveAmplitudeRef.current, smoothedTiltAngleRef.current, 0);
            for (let i = 0; i < steps; i++) {
              timeRef.current += simDt;
              waveAmplitudeRef.current += (targetAmplitude - waveAmplitudeRef.current) * waveLerp;
              const tiltError = tiltAngleRef.current - smoothedTiltAngleRef.current;
              smoothedTiltAngleRef.current += tiltError * tiltLerp;
              // Скорость экспоненциального сглаживания: dθ/dt = (цель − θ) / τ.
              const tiltVelocity = (tiltAngleRef.current - smoothedTiltAngleRef.current) / TILT_SMOOTHING_TIME;

              kin = getContainerKinematics(timeRef.current, waveAmplitudeRef.current, smoothedTiltAngleRef.current, tiltVelocity);
              SPH.setAnimationParams(timeRef.current, waveAmplitudeRef.current);
              SPH.setContainerKinematics(kin);
              SPH.step();
            }

            Renderer.setAnimationParams(timeRef.current, waveAmplitudeRef.current, kin.position, kin.angle, { boxHalfSize: new Vec2(flaskHalfSize.x, flaskHalfSize.y), radius: flaskRadius });

            SPH.visualize(Renderer.renderWater);

            animationFrameId = requestAnimationFrame(loop);
        };
        animationFrameId = requestAnimationFrame(loop);
    };

    initAsync();

    return () => {
        isDisposed = true;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [meshQuality, particleScale, flaskWidth, flaskHeight]);

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
        pointerEvents: 'none'
      }} 
    />
  );
};
