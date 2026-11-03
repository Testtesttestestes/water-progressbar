import { COMMON } from './shaders';
import { PingPong, Program, VS_FULLSCREEN, drawFullscreen, UniformValue } from './gl';
import type { FluidSolver } from './solver';

// Брызги и капли на стекле: частицы на GPU в системе колбы.
//
//   — брызги (вид 1): рождаются там, где поверхность быстро уходит в воздух
//     (нормальная к поверхности скорость больше порога), дальше летят
//     баллистически под эффективной тяжестью колбы. Падают обратно в воду —
//     сливаются; долетают до стекла — остаются на нём каплей;
//   — капли на стекле (вид 2): ещё и там, откуда вода только что ушла —
//     плёнка на стекле при отступании рвётся на капли (dewetting). Мелкие
//     держатся (гистерезис краевого угла), крупные сползают по тяжести;
//     понемногу испаряются, а накрытые водой снова становятся водой.
//
// Состояние: A = (x, y, vx, vy), B = (радиус, вид, возраст, срок),
//            C = (зерно, время до стекла, начальный радиус, —).
// Отдельно — «влажность» стекла по сетке решателя: 1 под водой, дальше
// спадает за WET_TIME секунд после того, как вода ушла.

const W = 32;
const H = 16;
export const SPRAY_COUNT = W * H;
const WET_TIME = 1.2;

// Мокрым считаем только стекло, которого вода реально касалась: ячейки полости
// (в стекле φ лишь продолжено и может «показывать» воду там, где её не было).
const FS_WET = `${COMMON}
uniform sampler2D uPhi;
uniform sampler2D uWet;
uniform sampler2D uGeo;
uniform float uDt;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float phi = texelFetch(uPhi, c, 0).x;
    float w = texelFetch(uWet, c, 0).x;
    bool cavity = texelFetch(uGeo, c, 0).z > 0.0;
    o = vec4(cavity && phi < 0.0 ? 1.0 : max(w - uDt / ${WET_TIME.toFixed(2)}, 0.0));
}`;

const FS_UPDATE = `${COMMON}
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform sampler2D uWet;
uniform float uDt;
uniform float uSeed;
uniform vec2 uAccel;          // эффективная тяжесть в системе колбы
uniform float uGravity;       // её модуль при земной тяжести (для скоростей)
uniform float uSplashSpeed;   // порог нормальной скорости поверхности
uniform float uSplashChance;
uniform float uDewetChance;

float rnd(float index, float k) { return fract(sin(index * 12.9898 + uSeed * 78.233 + k * 37.719) * 43758.5453); }
vec2 cavityNormal(vec2 p) {
    vec2 e = vec2(0.002, 0.0);
    return normalize(vec2(cavitySd(p + e.xy) - cavitySd(p - e.xy), cavitySd(p + e.yx) - cavitySd(p - e.yx)) + 1e-9);
}
vec2 phiGrad(vec2 p) {
    vec2 e = vec2(uH, 0.0);
    return vec2(sampleCell(uPhi, p + e.xy) - sampleCell(uPhi, p - e.xy), sampleCell(uPhi, p + e.yx) - sampleCell(uPhi, p - e.yx)) / (2.0 * uH);
}

void main() {
    ivec2 id = ivec2(gl_FragCoord.xy);
    float index = float(id.y * ${W} + id.x);
    vec4 A = texelFetch(uA, id, 0);
    vec4 B = texelFetch(uB, id, 0);
    vec4 C = texelFetch(uC, id, 0);
    float kind = B.y;

    if (kind > 0.5 && kind < 1.5) {
        // Полёт: тяжесть + слабое сопротивление воздуха (капля в миллиметры).
        A.zw = A.zw * exp(-0.4 * uDt) + uAccel * uDt;
        A.xy += A.zw * uDt;
        B.z += uDt;
        float sd = cavitySd(A.xy);
        if (sampleCell(uPhi, A.xy) < 0.0) {
            B.y = 0.0;                                   // упала в воду — слилась
        } else if (sd > -B.x && dot(cavityNormal(A.xy), -uAccel) > 0.35 * length(uAccel)) {
            // Потолок (стекло смотрит вниз): капля не прилипает — отскакивает и падает.
            // Раньше прилипала и скользила по потолку — выглядело как «магнит».
            vec2 n = cavityNormal(A.xy);
            A.xy -= n * (sd + B.x);
            float vn = dot(A.zw, n);
            if (vn > 0.0) A.zw -= n * vn * 1.5;
        } else if (sd > -B.x || B.z > C.y) {
            // Долетела до стекла: торец или дно контура, передняя/задняя стенка.
            if (sd > -B.x) A.xy -= cavityNormal(A.xy) * (sd + B.x);
            A.zw = vec2(0.0);
            B.y = 2.0; B.z = 0.0; B.w = mix(6.0, 16.0, C.x);
            B.x *= 1.25;                                 // на стекле капля растекается
            C.z = B.x;
        }
        o = A; o1 = B; o2 = C;
        return;
    }
    if (kind > 1.5) {
        B.z += uDt;
        // Капля держится, пока мала; крупная сползает по тяжести (на стекле
        // скорость — сантиметры в секунду, растёт с размером).
        float g = length(uAccel);
        float rc = 0.035;
        float slide = clamp((B.x - rc) / rc, 0.0, 2.0) * 0.45 * g / max(uGravity, 1.0);
        vec2 dir = g > 1e-4 ? uAccel / g : vec2(0.0);
        A.zw = dir * slide;
        A.xy += A.zw * uDt;
        float sd = cavitySd(A.xy);
        if (sd > -B.x) {
            vec2 n = cavityNormal(A.xy);
            A.xy -= n * (sd + B.x);
            // Под потолком капля не держится: срывается и падает брызгой.
            if (dot(n, -uAccel) > 0.35 * g) { B.y = 1.0; C.y = 1e9; A.zw = vec2(0.0); }
        }
        // Испарение: радиус уменьшается к концу срока.
        B.x = C.z * sqrt(max(1.0 - B.z / B.w, 0.0));
        if (B.z > B.w || B.x < 0.004 || sampleCell(uPhi, A.xy) < 0.3 * B.x) B.y = 0.0;
        o = A; o1 = B; o2 = C;
        return;
    }

    // Мёртвый слот: новая капля — брызга с быстрой поверхности или остаток плёнки.
    vec2 p = (vec2(rnd(index, 1.0), rnd(index, 2.0)) * 2.0 - 1.0) * uCavityHalf;
    float phi = sampleCell(uPhi, p);
    float sd = cavitySd(p);
    o = A; o1 = B; o2 = C;
    if (sd > -0.06) return;
    if (abs(phi) < 1.5 * uH) {
        vec2 n = phiGrad(p);
        float ln = length(n);
        if (ln < 1e-4) return;
        n /= ln;
        vec2 v = sampleVel(uVel, p);
        float vn = dot(v, n);
        float excess = (vn - uSplashSpeed) / uSplashSpeed;
        if (excess > 0.0 && rnd(index, 3.0) < uSplashChance * min(excess, 1.0)) {
            float r = mix(0.007, 0.03, pow(rnd(index, 4.0), 2.2));
            vec2 t = vec2(-n.y, n.x);
            vec2 v0 = v * mix(0.6, 1.05, rnd(index, 5.0)) + t * (rnd(index, 6.0) - 0.5) * 0.5 * vn + n * 0.25 * vn * rnd(index, 7.0);
            o = vec4(p + n * (1.5 * uH + r), v0);
            o1 = vec4(r, 1.0, 0.0, 0.0);
            o2 = vec4(rnd(index, 8.0), mix(0.04, 0.5, rnd(index, 9.0)), r, 0.0);
        }
        return;
    }
    // Плёнка рвётся там, где вода отступила заметно (дальше трёх ячеек).
    // Влажность — по самой ячейке (без размазывания на соседей): капля появляется
    // только там, где вода действительно была.
    float wet = cellAt(uWet, ivec2(floor((p - uOrigin) / uH)));
    if (phi > 3.0 * uH && wet > 0.02 && rnd(index, 10.0) < uDewetChance * wet) {
        float r = mix(0.012, 0.07, pow(rnd(index, 11.0), 1.6));
        if (sd > -r) return;
        o = vec4(p, 0.0, 0.0);
        o1 = vec4(r, 2.0, 0.0, mix(8.0, 25.0, rnd(index, 12.0)));
        o2 = vec4(rnd(index, 13.0), 0.0, r, 0.0);
    }
}`;

export class Spray {
  readonly state: PingPong;
  private wet: PingPong;
  private updateProgram: Program;
  private wetProgram: Program;
  private frame = 0;

  constructor(private gl: WebGL2RenderingContext, private solver: FluidSolver) {
    this.state = new PingPong(gl, W, H, ['RGBA32F', 'RGBA32F', 'RGBA32F']);
    this.wet = new PingPong(gl, solver.nx, solver.ny, ['R16F']);
    this.updateProgram = new Program(gl, VS_FULLSCREEN, FS_UPDATE);
    this.wetProgram = new Program(gl, VS_FULLSCREEN, FS_WET);
    const zero = new Float32Array(W * H * 4);
    for (const t of [this.state.read, this.state.write]) for (let i = 0; i < 3; i++) t.upload(zero, i);
    // Начальная влажность: под водой стекло мокрое, выше — сухое (заполнит первый шаг).
    for (const t of [this.wet.read, this.wet.write]) {
      t.bind();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * @param accel эффективная тяжесть в системе колбы (как у решателя)
   * @param gravity модуль земной тяжести в единицах сцены
   */
  update(dt: number, accel: [number, number], gravity: number) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.frame++;
    const grid = this.solver.gridUniforms();

    this.wet.write.bind();
    this.wetProgram.use({ ...grid, uPhi: this.solver.phi.read.texture, uWet: this.wet.read.texture, uGeo: this.solver.geo.texture, uDt: dt });
    drawFullscreen(gl);
    this.wet.swap();

    this.state.write.bind();
    const [cx, cy] = this.solver.cavityHalf;
    const uniforms: Record<string, UniformValue> = {
      ...grid,
      uA: this.state.read.textures[0], uB: this.state.read.textures[1], uC: this.state.read.textures[2],
      uVel: this.solver.vel.read.texture, uPhi: this.solver.phi.read.texture, uWet: this.wet.read.texture,
      uDt: dt, uSeed: (this.frame * 0.618034) % 97, uAccel: accel, uGravity: gravity,
      // Порог: скорость, с которой волна высотой в треть колбы бросает воду вверх.
      uSplashSpeed: Math.max(0.5 * Math.sqrt(Math.max(gravity, 1) * Math.min(cx, cy) * 0.6), 0.5),
      uSplashChance: 0.35, uDewetChance: 0.03,
    };
    this.updateProgram.use(uniforms);
    drawFullscreen(gl);
    this.state.swap();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Убрать капли и брызги, стекло снова сухое. */
  reset() {
    const gl = this.gl;
    const zero = new Float32Array(W * H * 4);
    for (const t of [this.state.read, this.state.write]) for (let i = 0; i < 3; i++) t.upload(zero, i);
    for (const t of [this.wet.read, this.wet.write]) {
      t.bind();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get textures(): WebGLTexture[] {
    return this.state.read.textures;
  }

  dispose() {
    this.state.dispose();
    this.wet.dispose();
    this.updateProgram.dispose();
    this.wetProgram.dispose();
  }
}
