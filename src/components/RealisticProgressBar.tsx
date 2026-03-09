import React, { useEffect, useRef } from 'react';
import * as GLU from '../sph/glutils.js';
import { Vec2 } from '../sph/mathtype.js';
import * as Renderer from '../sph/renderer.js';
import * as SPH from '../sph/sph.js';

interface RealisticProgressBarProps {
  progress: number; // от 0.0 до 1.0
  isWaving?: boolean;
  className?: string;
  meshQuality?: 'high' | 'balanced' | 'low';
}

const MESH_QUALITY_FACTORS: Record<NonNullable<RealisticProgressBarProps['meshQuality']>, number> = {
  high: 4,
  balanced: 2,
  low: 1,
};

export const RealisticProgressBar: React.FC<RealisticProgressBarProps> = ({
  progress,
  isWaving = false,
  className,
  meshQuality = 'balanced',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);
  const isWavingRef = useRef(isWaving);
  const waveAmplitudeRef = useRef(0.0);
  const timeRef = useRef(0.0);
  const prevContainerPosRef = useRef(new Vec2(0.0, 3.0));
  const prevContainerVelRef = useRef(new Vec2(0.0, 0.0));
  const prevAngleRef = useRef(0.0);
  const prevAngularVelRef = useRef(0.0);
  const prevVelSignRef = useRef(0);
  const reverseImpulseRef = useRef(0.0);

  useEffect(() => {
    progressRef.current = progress;
    SPH.injectWater(progress);
  }, [progress]);

  useEffect(() => {
    isWavingRef.current = isWaving;
  }, [isWaving]);

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
    const dp = 8 / 64;
    const fluidDomainR = 0.95 * R0;

    const createParticlesRoundedBox = () => {
        let pos = [];
        let boxSize = {x: 5.0, y: 1.5};
        let boxRadius = 0.8;
        
        let minX = -7.5;
        let maxX = 7.5;
        let minY = -1.0;
        let maxY = 5.0;
        
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
    let lastTime = performance.now();

    const initAsync = async () => {
        const bgUrl = 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?q=80&w=2000&auto=format&fit=crop';
        const [bgTex] = await Promise.all([
            GLU.loadTexture(gl, bgUrl),
            SPH.loadShaderFilesAsync(), 
            Renderer.loadShaderFilesAsync()
        ]);
        
        Renderer.setBackgroundTexture(bgTex);
        SPH.init(gl, dp, fluidDomainR, createParticlesRoundedBox());
        Renderer.init(gl, canvas, dp, new Vec2(-R0), new Vec2(R0), {
          meshSizeQualityFactor: MESH_QUALITY_FACTORS[meshQuality],
        });
        Renderer.setRenderingSimulationArea(new Vec2(-R0), new Vec2(R0));

        const loop = (currentTime: number) => {
            const dt = Math.max((currentTime - lastTime) / 1000, 1e-4);
            lastTime = currentTime;

            // Resize canvas to match display size with device pixel ratio
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const displayWidth = Math.floor(canvas.clientWidth * dpr);
            const displayHeight = Math.floor(canvas.clientHeight * dpr);
            if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
                canvas.width = displayWidth;
                canvas.height = displayHeight;
            }

            const targetAmplitude = isWavingRef.current ? 1.0 : 0.0;
            waveAmplitudeRef.current += (targetAmplitude - waveAmplitudeRef.current) * 0.05;
            timeRef.current += dt;

            const amplitude = waveAmplitudeRef.current;
            const t = timeRef.current;
            const angle = Math.sin(t * 1.2) * 0.15 * amplitude;
            const offsetX = Math.sin(t * 0.8) * 1.0 * amplitude;
            const containerPos = new Vec2(offsetX, 3.0);

            const containerVel = Vec2.mul(1 / dt, Vec2.sub(containerPos, prevContainerPosRef.current));
            const containerAcc = Vec2.mul(1 / dt, Vec2.sub(containerVel, prevContainerVelRef.current));
            const angularVel = (angle - prevAngleRef.current) / dt;
            const angularAcc = (angularVel - prevAngularVelRef.current) / dt;

            const currentVelSign = Math.sign(containerVel.x);
            const previousVelSign = prevVelSignRef.current;
            if (currentVelSign !== 0 && previousVelSign !== 0 && currentVelSign !== previousVelSign) {
              const deltaV = Math.abs(containerVel.x - prevContainerVelRef.current.x);
              reverseImpulseRef.current = Math.max(reverseImpulseRef.current, deltaV * 1.5);
            }
            if (currentVelSign !== 0) prevVelSignRef.current = currentVelSign;

            reverseImpulseRef.current *= Math.exp(-dt * 16.0);

            SPH.setContainerKinematics({
              position: containerPos,
              velocity: containerVel,
              acceleration: containerAcc,
              angle,
              angularVelocity: angularVel,
              angularAcceleration: angularAcc,
              reverseImpulse: reverseImpulseRef.current,
            });

            prevContainerPosRef.current = containerPos;
            prevContainerVelRef.current = containerVel;
            prevAngleRef.current = angle;
            prevAngularVelRef.current = angularVel;

            SPH.setAnimationParams(timeRef.current, waveAmplitudeRef.current);
            Renderer.setAnimationParams(timeRef.current, waveAmplitudeRef.current);

            for (let i = 0; i < 8; i++) SPH.step();

            SPH.visualize(Renderer.renderWater);

            animationFrameId = requestAnimationFrame(loop);
        };
        animationFrameId = requestAnimationFrame(loop);
    };

    initAsync();

    return () => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

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
