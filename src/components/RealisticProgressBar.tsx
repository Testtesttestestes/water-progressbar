import React, { useEffect, useRef } from 'react';
import { Vec2 } from '../sph/mathtype.js';
import * as Renderer from '../sph/renderer.js';
import * as SPH from '../sph/sph.js';

interface RealisticProgressBarProps {
  progress: number; // от 0.0 до 1.0
  isWaving?: boolean;
  className?: string;
}

export const RealisticProgressBar: React.FC<RealisticProgressBarProps> = ({ progress, isWaving = false, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);
  const isWavingRef = useRef(isWaving);
  const waveAmplitudeRef = useRef(0.0);
  const timeRef = useRef(0.0);

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

    let gl = canvas.getContext('webgl2');
    if (!gl) {
        console.error('WebGL2 unsupported.');
        return;
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
        console.error('WebGL2-extention "EXT_color_buffer_float" unsupported.');
        return;
    }

    const R0 = 8;
    const dp = R0 / 64;
    const fluidDomainR = 0.95 * R0;

    const createParticlesCapsule = () => {
        let pos = [];
        let capA = {x: -6.0, y: 0.0};
        let capB = {x: 6.0, y: 0.0};
        let capRadius = 1.5;
        
        let minX = -7.5;
        let maxX = 7.5;
        let minY = -1.5;
        let maxY = 1.5;
        
        for (let x = minX; x <= maxX; x += dp * 0.85) {
            for (let y = minY; y <= maxY; y += dp * 0.85) {
                let paX = x - capA.x, paY = y - capA.y;
                let baX = capB.x - capA.x, baY = capB.y - capA.y;
                let dotPaBa = paX * baX + paY * baY;
                let dotBaBa = baX * baX + baY * baY;
                let h = Math.max(0, Math.min(1, dotPaBa / dotBaBa));
                let distX = paX - baX * h;
                let distY = paY - baY * h;
                let dist = Math.sqrt(distX * distX + distY * distY);
                
                // Fill up to 50% so there is room for the water to move
                if (dist < capRadius - dp && x < 0.0) {
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
        SPH.init(gl, dp, fluidDomainR, createParticlesCapsule());
        Renderer.init(gl, canvas, dp/2, new Vec2(-R0), new Vec2(R0));
        Renderer.setRenderingSimulationArea(new Vec2(-R0), new Vec2(R0));

        const loop = (currentTime: number) => {
            const dt = (currentTime - lastTime) / 1000;
            lastTime = currentTime;

            // Resize canvas to match display size
            const displayWidth = canvas.clientWidth;
            const displayHeight = canvas.clientHeight;
            if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
                canvas.width = displayWidth;
                canvas.height = displayHeight;
            }

            const targetAmplitude = isWavingRef.current ? 1.0 : 0.0;
            waveAmplitudeRef.current += (targetAmplitude - waveAmplitudeRef.current) * 0.05;
            timeRef.current += dt;

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
    };
  }, []);

  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100px', maxWidth: '600px', margin: '0 auto' }}>
      <canvas 
        ref={canvasRef} 
        style={{ width: '100%', height: '100%', display: 'block' }} 
      />
    </div>
  );
};
