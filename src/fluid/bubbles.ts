import { COMMON } from './shaders';
import { PingPong, Program, VS_FULLSCREEN, drawFullscreen, UniformValue } from './gl';
import type { FluidSolver } from './solver';

// Пузырьки воздуха: частицы на GPU в системе колбы.
//   — «прилипшие» к передней и задней стенкам (в проекции — где угодно в колбе),
//     кластерами у торцов и ниже середины; видны, только когда их покрывает вода;
//   — свободные: всплывают от мест зарождения и от поверхности при сильном
//     волнении, их несёт поле скорости решателя; у поверхности лопаются.
//
//   — пена у мениска: несколько пузырьков держатся на поверхности у торцов.
//
// Состояние: A = (x, y, радиус, вид: 0 — нет, 1 — свободный, 2 — прилипший, 3 — пена),
//            B = (зерно, возраст, срок жизни, —).

const W = 32;
const H = 16;
export const BUBBLE_COUNT = W * H;
const ATTACHED = 260;
const FOAM = 24;
const SEEPS = 6;

const FS_UPDATE = `${COMMON}
layout(location = 1) out vec4 o1;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform float uDt;
uniform float uSeed;
uniform vec2 uUp;
uniform int uAttached;
uniform float uSeepChance;      // вероятность за кадр, что мёртвый слот станет пузырьком из источника
uniform float uSurfaceChance;   // то же для пузырька у поверхности (волнение)
uniform vec2 uSeeps[${SEEPS}];

float rnd(float index, float k) { return fract(sin(index * 12.9898 + uSeed * 78.233 + k * 37.719) * 43758.5453); }

void main() {
    ivec2 id = ivec2(gl_FragCoord.xy);
    float index = float(id.y * ${W} + id.x);
    vec4 A = texelFetch(uA, id, 0);
    vec4 B = texelFetch(uB, id, 0);

    if (int(index) < uAttached) { o = A; o1 = B; return; }   // прилипшие неподвижны
    if (A.w > 2.5) {
        // Пена: держится на поверхности у своего торца (шаг Ньютона к φ = 0 вдоль «вверх»).
        vec2 p = vec2(B.w, A.y);
        // Каждый пузырёк пены — на своей глубине под поверхностью: получается кучка.
        float sink = (0.3 + 1.8 * B.x) * abs(A.z);
        for (int k = 0; k < 3; k++) p -= uUp * (sampleCell(uPhi, p) + sink);
        float sd = cavitySd(p);
        float alive = (sampleCell(uPhi, p + uUp * 0.2) > 0.0 && sd < -abs(A.z)) ? 1.0 : 0.0;
        // Радиус в A.z храним всегда, а видимость — знаком: скрытая пена с отрицательным радиусом.
        o = vec4(p, abs(A.z) * (alive > 0.5 ? 1.0 : -1.0), 3.0);
        o1 = B;
        return;
    }

    if (A.w > 0.5) {
        // Скорость всплытия мелкого пузырька растёт с радиусом; лёгкое «виляние».
        float rise = clamp(9.0 * A.z, 0.05, 0.5) * 2.4;
        vec2 side = vec2(-uUp.y, uUp.x);
        float wobble = sin(B.y * (9.0 + 5.0 * B.x) + B.x * 6.283) * 0.25 * rise;
        vec2 vel = sampleVel(uVel, A.xy) + uUp * rise + side * wobble;
        A.xy += uDt * vel;
        B.y += uDt;
        float sd = cavitySd(A.xy);
        if (sd > -A.z) {
            vec2 e = vec2(0.002, 0.0);
            vec2 n = normalize(vec2(cavitySd(A.xy + e.xy) - cavitySd(A.xy - e.xy), cavitySd(A.xy + e.yx) - cavitySd(A.xy - e.yx)));
            A.xy -= n * (sd + A.z);
        }
        // У поверхности (или в воздухе) пузырёк лопается; заодно ограничиваем срок жизни.
        if (sampleCell(uPhi, A.xy) > -0.6 * A.z || B.y > B.z) A.w = 0.0;
        o = A; o1 = B;
        return;
    }

    // Мёртвый слот: может родиться новый пузырёк.
    float r = mix(0.012, 0.038, pow(rnd(index, 1.0), 2.5));
    if (rnd(index, 2.0) < uSeepChance) {
        vec2 p = uSeeps[int(rnd(index, 3.0) * float(${SEEPS})) % ${SEEPS}] + (vec2(rnd(index, 4.0), rnd(index, 5.0)) - 0.5) * 0.08;
        if (sampleCell(uPhi, p) < -2.0 * r && cavitySd(p) < -r) {
            o = vec4(p, r, 1.0);
            o1 = vec4(rnd(index, 6.0), 0.0, mix(3.0, 9.0, rnd(index, 7.0)), 0.0);
            return;
        }
    }
    if (rnd(index, 8.0) < uSurfaceChance) {
        vec2 p = (vec2(rnd(index, 9.0), rnd(index, 10.0)) * 2.0 - 1.0) * uCavityHalf;
        float phi = sampleCell(uPhi, p);
        if (phi < -0.04 && phi > -0.4 && cavitySd(p) < -r) {
            o = vec4(p, r * 0.8, 1.0);
            o1 = vec4(rnd(index, 11.0), 0.0, mix(1.5, 5.0, rnd(index, 12.0)), 0.0);
            return;
        }
    }
    o = A; o1 = B;
}`;

/** Детерминированный ГПСЧ (для раскладки прилипших пузырьков). */
const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export class Bubbles {
  readonly state: PingPong;
  private program: Program;
  private seeps: number[] = [];
  private frame = 0;

  constructor(private gl: WebGL2RenderingContext, private solver: FluidSolver, seed = 7) {
    this.state = new PingPong(gl, W, H, ['RGBA32F', 'RGBA32F']);
    this.program = new Program(gl, VS_FULLSCREEN, FS_UPDATE);

    const rand = mulberry(seed);
    const [cx, cy] = solver.cavityHalf;
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
    // Кластеры у торцов и чуть ниже середины — как столбики пузырьков на стекле.
    const clusters: [number, number, number][] = [];
    for (let k = 0; k < SEEPS; k++) {
      const end = k < 4 ? (k % 2 === 0 ? -1 : 1) : (rand() - 0.5) * 0.6;
      const x = end * cx * (k < 4 ? 0.62 + 0.3 * rand() : 1);
      const y = -cy * (0.15 + 0.55 * rand());
      clusters.push([x, y, 0.6 + rand()]);
      this.seeps.push(x, -cy * 0.9 + 0.1 * rand());
    }
    const a = new Float32Array(W * H * 4);
    const b = new Float32Array(W * H * 4);
    const r = solver.cavityRadius;
    const inside = (x: number, y: number, margin: number) => {
      const qx = Math.abs(x) - cx + r, qy = Math.abs(y) - cy + r;
      return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r < -margin;
    };
    // Пена у торцов: x запоминаем в B.w, по y пузырёк сам находит поверхность.
    for (let i = ATTACHED; i < ATTACHED + FOAM; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const x = side * (cx - 0.05 - 0.3 * Math.pow(rand(), 1.8));
      a.set([x, 0, 0.02 + 0.03 * rand(), 3], 4 * i);
      b.set([rand(), 0, 1, x], 4 * i);
    }
    for (let i = 0; i < ATTACHED; i++) {
      const [ux, uy, weight] = clusters[Math.floor(rand() * clusters.length)];
      let x = 0, y = 0, radius = 0;
      for (let tries = 0; tries < 20; tries++) {
        // Облако: шире по горизонтали, вытянуто по вертикали; часть — одиночки по всей колбе.
        const lone = rand() < 0.18;
        x = lone ? (rand() * 2 - 1) * cx : ux + gauss() * 0.3 * weight;
        y = lone ? -cy + rand() * 1.6 * cy : uy + gauss() * 0.5 * weight;
        radius = 0.02 + 0.035 * Math.pow(rand(), 2.2);
        if (inside(x, y, radius + 0.02)) break;
      }
      a.set([x, y, radius, 2], 4 * i);
      b.set([rand(), 0, 1e9, 0], 4 * i);
    }
    for (const t of [this.state.read, this.state.write]) {
      t.upload(a, 0);
      t.upload(b, 1);
    }
  }

  update(dt: number, up: [number, number], agitation: number) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.state.write.bind();
    this.frame++;
    const uniforms: Record<string, UniformValue> = {
      ...this.solver.gridUniforms(),
      uA: this.state.read.textures[0], uB: this.state.read.textures[1],
      uVel: this.solver.vel.read.texture, uPhi: this.solver.phi.read.texture,
      uDt: dt, uSeed: (this.frame * 0.618034) % 97, uUp: up, uAttached: ATTACHED,
      uSeepChance: 0.0035, uSurfaceChance: Math.min(0.02, 0.004 * agitation),
      uSeeps: this.seeps,
    };
    this.program.use(uniforms);
    drawFullscreen(gl);
    this.state.swap();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get texture(): WebGLTexture {
    return this.state.read.textures[0];
  }

  dispose() {
    this.state.dispose();
    this.program.dispose();
  }
}
