import React, { useEffect, useRef } from 'react';
import { Vec2 } from '../sph/mathtype.js';
import * as Renderer from '../sph/renderer.js';
import * as SPH from '../sph/sph.js';

interface RealisticProgressBarProps {
  progress: number;
  isWaving?: boolean;
  tiltAngle?: number;
  flaskWidth?: number;
  flaskHeight?: number;
  className?: string;
  meshQuality?: 'high' | 'balanced' | 'low';
}

type KinematicSample = {
  time: number;
  pos: Vec2;
  vel: Vec2;
  acc: Vec2;
  angle: number;
  angVel: number;
  angAcc: number;
};

const FLASK_MOTION = {
  offsetXAmp: 1.0,
  offsetXFreq: 0.8,
  angleAmp: 0.15,
  angleFreq: 1.2,
};

const getContainerPose = (time: number, waveAmplitude: number) => {
  const offsetX = Math.sin(time * FLASK_MOTION.offsetXFreq) * FLASK_MOTION.offsetXAmp * waveAmplitude;
  const dynamicAngle = Math.sin(time * FLASK_MOTION.angleFreq) * FLASK_MOTION.angleAmp * waveAmplitude;
  return { position: new Vec2(offsetX, 3.0), angle: dynamicAngle };
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
  flaskWidth = 10,
  flaskHeight = 3,
  className,
  meshQuality = 'low',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glassRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(progress);
  const isWavingRef = useRef(isWaving);
  const waveAmplitudeRef = useRef(0.0);
  const timeRef = useRef(0.0);
  const tiltAngleRef = useRef(tiltAngle);
  const smoothedTiltAngleRef = useRef(tiltAngle);
  const kinematicPrevRef = useRef<KinematicSample | null>(null);
  const reverseImpulseRef = useRef({ strength: 0.0, age: 1e6, deltaV: new Vec2(0, 0) });

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
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const clipX = (x / canvas.width) * 2 - 1;
      const clipY = -((y / canvas.height) * 2 - 1);

      const simPos = Renderer.clipPosToSimPos(new Vec2(clipX, clipY));
      SPH.setPointerPos(simPos);
    };

    const handleMouseLeave = () => {
      SPH.setPointerPos(new Vec2(0, 0));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseleave', handleMouseLeave);

    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
    if (!gl) {
      console.error('WebGL2 unsupported.');
      return;
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      console.error('WebGL2-extention "EXT_color_buffer_float" unsupported.');
      return;
    }

    const dp = 8 / 64;
    const boxRadius = 0.8;

    // 1. ВЫЧИСЛЕНИЕ ДИНАМИЧЕСКИХ ГРАНИЦ ДЛЯ WEBGL (Чтобы вода никогда не обрезалась)
    // Считаем диагональ колбы от её центра. Это максимальное расстояние, на которое могут улететь частицы при повороте.
    const maxRadius = Math.sqrt(Math.pow(flaskWidth / 2, 2) + Math.pow(flaskHeight / 2, 2));
    const safeMargin = 4.0; // Запас для волн и брызг
    const simMaxBound = maxRadius + safeMargin;
    const fluidDomainR = simMaxBound * 1.5; // Скрытые границы физики SPH

    const createParticlesRoundedBox = () => {
      const pos = [];
      const boxSize = { x: flaskWidth / 2, y: flaskHeight / 2 };

      const minX = -boxSize.x - 2.0;
      const maxX = boxSize.x + 2.0;
      const minY = 3.0 - boxSize.y - 2.0;
      const maxY = 3.0 + boxSize.y + 2.0;

      const sdRoundedBox = (px: number, py: number, bx: number, by: number, r: number) => {
        const qx = Math.abs(px) - bx + r;
        const qy = Math.abs(py) - by + r;
        const extX = Math.max(qx, 0);
        const extY = Math.max(qy, 0);
        return Math.min(Math.max(qx, qy), 0.0) + Math.sqrt(extX * extX + extY * extY) - r;
      };

      for (let x = minX; x <= maxX; x += dp * 1.05) {
        for (let y = minY; y <= maxY; y += dp * 1.05) {
          const dist = sdRoundedBox(x, y - 3.0, boxSize.x, boxSize.y, boxRadius);
          if (dist < -dp * 0.5) {
            pos.push(x, y);
          }
        }
      }
      return pos;
    };

    let animationFrameId: number;
    let lastTime = performance.now();

    const initAsync = async () => {
      await Promise.all([SPH.loadShaderFilesAsync(), Renderer.loadShaderFilesAsync()]);

      // Инициализируем SPH с динамической границей физики
      SPH.init(gl, dp, fluidDomainR, createParticlesRoundedBox());
      SPH.setContainerSize(new Vec2(flaskWidth, flaskHeight));

      // 2. ИСПРАВЛЕНИЕ "ПУСТОТЫ" (CLIPPING)
      // Инициализируем рендер с запасом, перекрывающим любые повороты
      const simMin = new Vec2(-simMaxBound, 3.0 - simMaxBound);
      const simMax = new Vec2(simMaxBound, 3.0 + simMaxBound);

      Renderer.init(gl, canvas, dp, simMin, simMax, {
        meshSizeQualityFactor: MESH_QUALITY_FACTORS[meshQuality],
      });
      Renderer.setContainerSize(new Vec2(flaskWidth, flaskHeight));

      const loop = (currentTime: number) => {
        const dt = (currentTime - lastTime) / 1000;
        lastTime = currentTime;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const displayWidth = Math.floor(canvas.clientWidth * dpr);
        const displayHeight = Math.floor(canvas.clientHeight * dpr);
        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
          canvas.width = displayWidth;
          canvas.height = displayHeight;
        }

        const aspect = canvas.clientWidth / canvas.clientHeight;

        // Камера охватывает область так, чтобы вместить всю диагональ колбы
        const viewTargetSize = (maxRadius + 1.0) * 2;
        let viewW = viewTargetSize;
        let viewH = viewTargetSize;

        if (aspect > 1) {
          viewW = viewH * aspect;
        } else {
          viewH = viewW / aspect;
        }

        Renderer.setRenderingSimulationArea(
          new Vec2(-viewW / 2, 3.0 - viewH / 2),
          new Vec2(viewW / 2, 3.0 + viewH / 2),
        );

        const targetAmplitude = isWavingRef.current ? 1.0 : 0.0;
        waveAmplitudeRef.current += (targetAmplitude - waveAmplitudeRef.current) * 0.05;
        timeRef.current += dt;

        const tiltSmoothingTime = 0.18;
        const tiltLerp = 1.0 - Math.exp(-Math.max(dt, 0) / tiltSmoothingTime);
        smoothedTiltAngleRef.current += (tiltAngleRef.current - smoothedTiltAngleRef.current) * tiltLerp;

        const safeDt = Math.max(dt, 1e-4);
        const pose = getContainerPose(timeRef.current, waveAmplitudeRef.current);
        pose.angle += smoothedTiltAngleRef.current;

        // 3. ПИКСЕЛЬНАЯ СИНХРОНИЗАЦИЯ КОЛБЫ (Как вы и предлагали)
        if (glassRef.current) {
          // Высчитываем сколько пикселей помещается в 1 юните симуляции
          const scale = canvas.clientHeight / viewH;

          // Строгие размеры в пикселях, чтобы вращение не ломало пропорции
          const pxWidth = flaskWidth * scale;
          const pxHeight = flaskHeight * scale;
          const pxRadius = boxRadius * scale;

          const pxOffsetX = pose.position.x * scale;
          // Позиция Y зафиксирована на 3.0, но если она будет анимироваться - стекло последует за ней
          const pxOffsetY = (3.0 - pose.position.y) * scale;

          const degAngle = pose.angle * (180 / Math.PI);

          glassRef.current.style.width = `${pxWidth}px`;
          glassRef.current.style.height = `${pxHeight}px`;
          glassRef.current.style.borderRadius = `${pxRadius}px`;

          // will-change помогает аппаратному ускорению избежать подёргиваний
          glassRef.current.style.willChange = 'transform';
          glassRef.current.style.transform = `translate(${pxOffsetX}px, ${pxOffsetY}px) rotate(${-degAngle}deg)`;
        }

        const prev = kinematicPrevRef.current;
        let velocity = new Vec2(0, 0);
        let acceleration = new Vec2(0, 0);
        let angularVelocity = 0.0;
        let angularAcceleration = 0.0;

        if (prev) {
          velocity = Vec2.mul(1 / safeDt, Vec2.sub(pose.position, prev.pos));
          angularVelocity = (pose.angle - prev.angle) / safeDt;
          acceleration = Vec2.mul(1 / safeDt, Vec2.sub(velocity, prev.vel));
          angularAcceleration = (angularVelocity - prev.angVel) / safeDt;

          const speedSignPrev = Math.sign(prev.vel.x);
          const speedSignCurr = Math.sign(velocity.x);
          const hasReverse = speedSignPrev !== 0 && speedSignCurr !== 0 && speedSignPrev !== speedSignCurr;
          if (hasReverse) {
            const deltaV = Vec2.sub(velocity, prev.vel);
            reverseImpulseRef.current = { strength: Vec2.length(deltaV), age: 0.0, deltaV };
          }
        }
        reverseImpulseRef.current.age += safeDt;

        kinematicPrevRef.current = {
          time: timeRef.current,
          pos: pose.position,
          vel: velocity,
          acc: acceleration,
          angle: pose.angle,
          angVel: angularVelocity,
          angAcc: angularAcceleration,
        };

        SPH.setAnimationParams(timeRef.current, waveAmplitudeRef.current);
        SPH.setContainerKinematics({
          position: pose.position,
          velocity,
          acceleration,
          angle: pose.angle,
          angularVelocity,
          angularAcceleration,
          reverseImpulseStrength: reverseImpulseRef.current.strength,
          reverseImpulseAge: reverseImpulseRef.current.age,
          reverseDeltaV: reverseImpulseRef.current.deltaV,
        });
        Renderer.setAnimationParams(timeRef.current, waveAmplitudeRef.current, pose.position, pose.angle);

        for (let i = 0; i < 8; i++) SPH.step();
        SPH.visualize(Renderer.renderWater);

        animationFrameId = requestAnimationFrame(loop);
      };
      animationFrameId = requestAnimationFrame(loop);
    };

    initAsync();

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [flaskHeight, flaskWidth, meshQuality]);

  return (
    <div className={`relative w-full h-full overflow-hidden flex items-center justify-center ${className || ''}`}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-0 pointer-events-auto"
        style={{ width: '100%', height: '100%', display: 'block' }}
      />

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
        <div
          ref={glassRef}
          className="relative border-[rgba(255,255,255,0.15)] border-2 transition-none"
          style={{
            boxShadow:
              'inset 0 0 var(--shadow-blur, 20px) var(--shadow-spread, -5px) var(--shadow-color, rgba(255,255,255,0.45))',
            transformOrigin: 'center center',
          }}
        >
          <div className="absolute top-0 left-2 right-2 h-[2px] bg-white opacity-20 rounded-full blur-[1px]"></div>
        </div>
      </div>
    </div>
  );
};
