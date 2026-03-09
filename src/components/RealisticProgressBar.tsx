import React, { useEffect, useRef } from 'react';

const vertexShaderSource = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision highp float;

  uniform vec2 u_resolution;
  uniform float u_time;
  uniform float u_progress;

  // Функция для генерации процедурного фона (сетка)
  vec3 getBackground(vec2 uv) {
      // Имитируем легкий виньетный фон с сеткой
      vec2 grid = fract(uv * 20.0);
      float line = smoothstep(0.9, 1.0, grid.x) + smoothstep(0.9, 1.0, grid.y);
      vec3 bgColor = mix(vec3(0.95, 0.95, 0.97), vec3(0.8, 0.82, 0.85), length(uv - 0.5));
      return mix(bgColor, vec3(0.6, 0.65, 0.7), clamp(line, 0.0, 1.0));
  }

  // SDF капсулы (колба)
  float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
      vec2 pa = p - a, ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h) - r;
  }

  void main() {
      // Истинные UV координаты экрана (для фона)
      vec2 screenUV = gl_FragCoord.xy / u_resolution.xy;
      
      // Координаты для геометрии
      vec2 p = screenUV * 2.0 - 1.0;
      p.x *= u_resolution.x / u_resolution.y;

      // Параметры колбы
      vec2 pA = vec2(-1.2, 0.0);
      vec2 pB = vec2(1.2, 0.0);
      float radius = 0.25;

      float dGlass = sdCapsule(p, pA, pB, radius);

      // Вода (пока математическая, без FBO)
      float fillTargetX = mix(pA.x - radius, pB.x + radius, u_progress);
      float wave = sin(p.x * 8.0 + u_time * 3.0) * 0.03 + sin(p.x * 15.0 - u_time * 2.0) * 0.015;
      float splash = exp(-20.0 * pow(p.x - fillTargetX, 2.0)) * 0.05 * sin(u_time * 12.0);
      float waterSurfaceX = fillTargetX + wave + splash;
      float dWater = p.x - waterSurfaceX;

      // --- ОПТИКА И ИСКАЖЕНИЯ (РЕФРАКЦИЯ) ---
      vec2 distortedUV = screenUV;
      
      if (dGlass < 0.0) {
          // Имитация толщины стекла (чем ближе к краю SDF, тем сильнее искажение)
          float glassThickness = 1.0 - pow(abs(dGlass) / radius, 0.5);
          
          // Нормаль стекла (фейковая, основанная на позиции)
          vec2 glassNormal = normalize(vec2(0.0, p.y));
          
          if (dWater < 0.0) {
              // Мы под водой. Вода преломляет сильнее стекла
              vec2 waterNormal = normalize(vec2(-1.0, (wave + splash) * 10.0));
              distortedUV += waterNormal * 0.05 * glassThickness; // Искажение воды
              distortedUV += glassNormal * 0.08; // Искажение цилиндра
          } else {
              // Мы в пустом стекле (воздух)
              distortedUV += glassNormal * 0.03; 
          }
      }

      // --- ХРОМАТИЧЕСКААЯ АБЕРРАЦИЯ ---
      // Берем фон три раза с небольшим смещением для RGB каналов
      float r = getBackground(distortedUV - vec2(0.003, 0.0)).r;
      float g = getBackground(distortedUV).g;
      float b = getBackground(distortedUV + vec2(0.003, 0.0)).b;
      vec3 col = vec3(r, g, b);

      // --- ЦВЕТА И БЛИКИ ---
      if (dGlass < 0.0) {
          if (dWater < 0.0) {
              // Тонируем воду
              float depth = clamp((waterSurfaceX - p.x) * 0.5, 0.0, 1.0);
              vec3 waterColor = mix(vec3(0.3, 0.8, 1.0), vec3(0.0, 0.4, 0.8), depth);
              col = mix(col, waterColor, 0.6); // 60% прозрачности воды

              // Поверхностное натяжение (пенка)
              if (abs(dWater) < 0.015) {
                  col += vec3(0.5);
              }
          } else {
              // Тонируем стекло
              col = mix(col, vec3(0.9, 0.95, 1.0), 0.1);
          }

          // Жесткий студийный блик сверху
          float highlightTop = smoothstep(0.015, 0.0, abs(p.y - (radius - 0.06)));
          col += highlightTop * 0.8;

          // Френель (затемнение по краям стекла)
          float edgeShadow = smoothstep(0.0, -0.04, dGlass);
          col *= mix(0.6, 1.0, edgeShadow);
      }

      // Сглаживание краев колбы
      float aa = smoothstep(0.0, 0.01, dGlass);
      vec3 finalBg = getBackground(screenUV); // Оригинальный неискаженный фон
      col = mix(col, finalBg, aa);

      gl_FragColor = vec4(col, 1.0);
  }
`;

interface RealisticProgressBarProps {
  progress: number; // от 0.0 до 1.0
  className?: string;
}

export const RealisticProgressBar: React.FC<RealisticProgressBarProps> = ({ progress, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl');
    if (!gl) {
      console.error('WebGL not supported');
      return;
    }

    // Create shaders
    const createShader = (gl: WebGLRenderingContext, type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    if (!vertexShader || !fragmentShader) return;

    // Create program
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return;
    }

    gl.useProgram(program);

    // Set up geometry (a full-screen quad)
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const positions = [
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
      -1.0,  1.0,
       1.0, -1.0,
       1.0,  1.0,
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    const positionAttributeLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    // Get uniform locations
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const progressLocation = gl.getUniformLocation(program, 'u_progress');

    let animationFrameId: number;
    const startTime = performance.now();

    const render = (time: number) => {
      // Resize canvas to match display size
      const displayWidth = canvas.clientWidth;
      const displayHeight = canvas.clientHeight;
      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      }

      gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
      gl.uniform1f(timeLocation, (time - startTime) * 0.001);
      gl.uniform1f(progressLocation, progressRef.current);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteBuffer(positionBuffer);
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
