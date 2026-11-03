import { COMMON } from './shaders';
import { PingPong, Program, Target, VS_FULLSCREEN, drawFullscreen, UniformValue } from './gl';
import { PARTICLE_ROW } from './particles';
import type { FluidSolver } from './solver';

// Белая вода: брызги, пена и пузыри — вторичные частицы
// (Ihmsen, Akinci, Akinci, Teschner, «Unified Spray, Foam and Bubbles for
// Particle-Based Fluids», 2012).
//
// Источники — частицы полосы у поверхности (particles.ts). Для каждой считаем три
// «потенциала» по сетке:
//   захват воздуха  I_ta = Σ |v_ij|·(1 − v̂_ij·x̂_ij)·W(x_ij) — встречные потоки
//                   (обрушение гребня, удар о стенку) затягивают воздух;
//   гребень волны   I_wc = κ·[v̂·n ≥ 0.6] — выпуклая поверхность, уходящая в воздух;
//   энергия         E_k = ½|v|².
// Сколько рождается: n = Φ(E_k)·(k_ta·Φ(I_ta) + k_wc·Φ(I_wc))·Δt, Φ — линейная
// «ступенька» между порогами.
//
// Вид частицы — по положению относительно воды (у Ihmsen — по числу соседей):
//   над водой — брызги (баллистика под тяжестью);
//   у поверхности — пена (несёт течение, держится на поверхности, тает);
//   в толще — пузырь (всплывает, течение увлекает его за собой); всплыв — пена.
//
// Состояние: A = (x, y, vx, vy), B = (вид: 0 — нет, 1 — брызги, 2 — пена, 3 — пузырь,
//            остаток жизни, зерно, радиус).

const SLOTS_PER_EMITTER = 2;

// Потенциалы в ячейках у поверхности: (I_ta, I_wc, E_k, —).
const FS_POTENTIAL = `${COMMON}
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform sampler2D uGeo;
vec2 cellVel(ivec2 c) { return sampleVel(uVel, cellCenter(c)); }
float phiAt(ivec2 c) { return cellAt(uPhi, c); }
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float phi = phiAt(c);
    if (texelFetch(uGeo, c, 0).z <= 0.0 || phi > 1.5 * uH || phi < -4.0 * uH) { o = vec4(0.0); return; }
    vec2 x = cellCenter(c);
    vec2 v = cellVel(c);
    // Захват воздуха: соседи в радиусе 2h, только водные.
    float ta = 0.0;
    for (int dy = -2; dy <= 2; dy++)
        for (int dx = -2; dx <= 2; dx++) {
            if (dx == 0 && dy == 0) continue;
            ivec2 q = c + ivec2(dx, dy);
            if (phiAt(q) > 0.0 || texelFetch(uGeo, clamp(q, ivec2(0), uN - 1), 0).z <= 0.0) continue;
            vec2 xij = x - cellCenter(q);
            float r = length(xij);
            float w = max(1.0 - r / (2.0 * uH), 0.0);
            vec2 vij = v - cellVel(q);
            float sv = length(vij);
            if (sv < 1e-5) continue;
            ta += sv * (1.0 - dot(vij / sv, xij / r)) * w;
        }
    // Гребень: кривизна поверхности (дивергенция нормали) по разностям через 2 ячейки.
    float wc = 0.0;
    if (abs(phi) < 1.5 * uH) {
        ivec2 ex = ivec2(1, 0), ey = ivec2(0, 1);
        vec2 g = vec2(phiAt(c + ex) - phiAt(c - ex), phiAt(c + ey) - phiAt(c - ey));
        vec2 n = g / max(length(g), 1e-6);
        vec2 nR = normalize(vec2(phiAt(c + 2 * ex) - phi, phiAt(c + ex + ey) - phiAt(c + ex - ey)) + 1e-6);
        vec2 nL = normalize(vec2(phi - phiAt(c - 2 * ex), phiAt(c - ex + ey) - phiAt(c - ex - ey)) + 1e-6);
        vec2 nT = normalize(vec2(phiAt(c + ex + ey) - phiAt(c - ex + ey), phiAt(c + 2 * ey) - phi) + 1e-6);
        vec2 nB = normalize(vec2(phiAt(c + ex - ey) - phiAt(c - ex - ey), phi - phiAt(c - 2 * ey)) + 1e-6);
        float kappa = ((nR.x - nL.x) + (nT.y - nB.y)) / (2.0 * uH);
        float sv = length(v);
        if (kappa > 0.0 && sv > 1e-4 && dot(v / sv, n) >= 0.6) wc = kappa;
    }
    o = vec4(ta, wc, 0.5 * dot(v, v), 0.0);
}`;

const FS_UPDATE = `${COMMON}
layout(location = 1) out vec4 o1;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uEmitP;      // частицы полосы: (x, y, vx, vy)
uniform sampler2D uEmitM;      // (жива, …)
uniform int uEmitCount;
uniform sampler2D uPotential;
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform vec2 uAccel;           // эффективная тяжесть в системе колбы
uniform float uDt;
uniform float uSeed;
uniform vec2 uTauTA;           // пороги Φ
uniform vec2 uTauWC;
uniform vec2 uTauK;
uniform float uKTA;            // частиц на источник в секунду при Φ = 1
uniform float uKWC;
uniform float uRise;           // скорость всплытия мелкого пузыря
float rnd(float index, float k) { return fract(sin(index * 12.9898 + uSeed * 78.233 + k * 37.719) * 43758.5453); }
float clampPhi(float I, vec2 tau) { return (min(I, tau.y) - min(I, tau.x)) / (tau.y - tau.x); }
vec2 cavityNormal(vec2 p) {
    vec2 e = vec2(0.002, 0.0);
    return normalize(vec2(cavitySd(p + e.xy) - cavitySd(p - e.xy), cavitySd(p + e.yx) - cavitySd(p - e.yx)) + 1e-9);
}
vec2 phiNormal(vec2 p) {
    vec2 e = vec2(uH, 0.0);
    vec2 g = vec2(sampleCell(uPhi, p + e.xy) - sampleCell(uPhi, p - e.xy), sampleCell(uPhi, p + e.yx) - sampleCell(uPhi, p - e.yx));
    return g / max(length(g), 1e-6);
}
void main() {
    ivec2 id = ivec2(gl_FragCoord.xy);
    float index = float(id.y * ${PARTICLE_ROW} + id.x);
    vec4 A = texelFetch(uA, id, 0);
    vec4 B = texelFetch(uB, id, 0);
    float g = length(uAccel);
    vec2 up = g > 1e-4 ? -uAccel / g : vec2(0.0, 1.0);

    if (B.x > 0.5) {
        float phi = sampleCell(uPhi, A.xy);
        // Вид по положению; гистерезис, чтобы частица у границы не мигала.
        float kind = B.x;
        if (phi > 1.2 * uH) kind = 1.0;
        else if (phi < -1.2 * uH) kind = 3.0;
        else if (abs(phi) < 0.8 * uH) kind = 2.0;
        vec2 vf = sampleVel(uVel, A.xy);
        if (kind < 1.5) {
            // Брызги: тяжесть и лёгкое сопротивление воздуха.
            A.zw = A.zw * exp(-0.6 * uDt) + uAccel * uDt;
            A.xy += A.zw * uDt;
        } else if (kind < 2.5) {
            // Пена: плывёт с поверхностью и держится на ней.
            A.zw = vf;
            A.xy += vf * uDt - phiNormal(A.xy) * phi * min(1.0, 6.0 * uDt);
            B.y -= uDt;
        } else {
            // Пузырь: всплывает и увлекается течением (сопротивление ~ разности скоростей).
            vec2 target = vf + up * uRise;
            A.zw = mix(A.zw, target, 1.0 - exp(-8.0 * uDt));
            A.xy += A.zw * uDt;
        }
        B.x = kind;
        // Брызги и пузыри тоже не вечны: без этого их копилось бы бесконечно.
        if (kind != 2.0) B.y -= 0.25 * uDt;
        float sd = cavitySd(A.xy);
        if (sd > -B.w) {
            vec2 n = cavityNormal(A.xy);
            A.xy -= n * (sd + B.w);
            float vn = dot(A.zw, n);
            if (vn > 0.0) A.zw -= n * vn * 1.6;   // брызга отскакивает и теряет скорость
        }
        if (B.y <= 0.0) B.x = 0.0;
        o = A; o1 = B;
        return;
    }

    o = A; o1 = B;
    // Пустой слот: его источник — частица полосы с тем же номером (по кругу).
    int e = int(index) % uEmitCount;
    ivec2 eid = ivec2(e % ${PARTICLE_ROW}, e / ${PARTICLE_ROW});
    if (texelFetch(uEmitM, eid, 0).x < 0.5) return;
    vec4 P = texelFetch(uEmitP, eid, 0);
    ivec2 cell = clamp(ivec2(floor((P.xy - uOrigin) / uH)), ivec2(0), uN - 1);
    vec4 pot = texelFetch(uPotential, cell, 0);
    float n = clampPhi(pot.z, uTauK) * (uKTA * clampPhi(pot.x, uTauTA) + uKWC * clampPhi(pot.y, uTauWC)) * uDt;
    if (rnd(index, 1.0) >= n / float(${SLOTS_PER_EMITTER})) return;
    // Новая частица — в «цилиндре» вокруг источника вдоль его скорости.
    float sv = length(P.zw);
    vec2 ev = sv > 1e-4 ? P.zw / sv : up;
    vec2 ep = vec2(-ev.y, ev.x);
    float a = rnd(index, 2.0) - 0.5, b = rnd(index, 3.0);
    vec2 x = P.xy + ep * a * uH + ev * b * sv * uDt;
    vec2 v = P.zw + ep * a * 0.35 * sv + up * 0.15 * sv * rnd(index, 4.0);
    float r = mix(0.25, 0.6, rnd(index, 5.0)) * uH;
    if (cavitySd(x) > -r) return;
    float phi = sampleCell(uPhi, x);
    float kind = phi > 1.2 * uH ? 1.0 : (phi < -1.2 * uH ? 3.0 : 2.0);
    o = vec4(x, v);
    o1 = vec4(kind, mix(1.5, 4.5, rnd(index, 6.0)), rnd(index, 7.0), r);
}`;

export class Whitewater {
  readonly state: PingPong;
  readonly count: number;
  private potential: Target;
  private potentialProgram: Program;
  private updateProgram: Program;
  private frame = 0;

  constructor(private gl: WebGL2RenderingContext, private solver: FluidSolver) {
    const emitters = solver.particles ? solver.particles.count : 0;
    const rows = Math.max(1, Math.ceil((emitters * SLOTS_PER_EMITTER) / PARTICLE_ROW));
    this.count = PARTICLE_ROW * rows;
    this.state = new PingPong(gl, PARTICLE_ROW, rows, ['RGBA32F', 'RGBA32F']);
    this.potential = new Target(gl, solver.nx, solver.ny, ['RGBA32F']);
    this.potentialProgram = new Program(gl, VS_FULLSCREEN, FS_POTENTIAL);
    this.updateProgram = new Program(gl, VS_FULLSCREEN, FS_UPDATE);
    const zero = new Float32Array(this.count * 4);
    for (const t of [this.state.read, this.state.write]) for (let i = 0; i < 2; i++) t.upload(zero, i);
  }

  /** Потенциалы Ihmsen по сетке (для отладки и настройки порогов). */
  get potentialTarget(): Target {
    return this.potential;
  }

  /**
   * @param accel эффективная тяжесть в системе колбы
   * @param gravity земная тяжесть в единицах сцены (масштаб порогов)
   */
  update(dt: number, accel: [number, number], gravity: number) {
    const particles = this.solver.particles;
    if (!particles) return;
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.frame++;
    const grid = this.solver.gridUniforms();
    this.potential.bind();
    this.potentialProgram.use({ ...grid, uVel: this.solver.vel.read.texture, uPhi: this.solver.phi.read.texture, uGeo: this.solver.geo.texture });
    drawFullscreen(gl);

    // Пороги — в физических единицах: земная тяжесть 9.81 м/с² задаёт масштаб
    // «единиц на метр». Вода пенится, когда течёт быстрее ~0.3 м/с (обрушение
    // гребня, удар о стенку), к ~0.9 м/с — в полную силу; медленный плеск — нет.
    const perMeter = Math.max(gravity, 1) / 9.81;
    const vScale = Math.sqrt(Math.max(gravity, 1) * this.solver.cavityHalf[1] * 2);
    const vMin = 0.3 * perMeter, vMax = 0.9 * perMeter;
    const [eP, , eM] = particles.textures;
    this.state.write.bind();
    const uniforms: Record<string, UniformValue> = {
      ...grid,
      uA: this.state.read.textures[0], uB: this.state.read.textures[1],
      uEmitP: eP, uEmitM: eM, uEmitCount: particles.count,
      uPotential: this.potential.texture, uVel: this.solver.vel.read.texture, uPhi: this.solver.phi.read.texture,
      uAccel: accel, uDt: dt, uSeed: (this.frame * 0.618034) % 97,
      uTauTA: [0.12 * vScale, 0.6 * vScale],
      uTauWC: [2.0 / this.solver.cavityHalf[1], 12.0 / this.solver.cavityHalf[1]],
      uTauK: [0.5 * vMin * vMin, 0.5 * vMax * vMax],
      // Пузырёк в пару миллиметров всплывает со скоростью ~0.2 м/с.
      uKTA: 8, uKWC: 14, uRise: 0.2 * perMeter,
    };
    this.updateProgram.use(uniforms);
    drawFullscreen(gl);
    this.state.swap();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Убрать пену, брызги и пузыри. */
  reset() {
    const zero = new Float32Array(this.count * 4);
    for (const t of [this.state.read, this.state.write]) for (let i = 0; i < 2; i++) t.upload(zero, i);
  }

  get textures(): WebGLTexture[] {
    return this.state.read.textures;
  }

  dispose() {
    this.state.dispose();
    this.potential.dispose();
    this.potentialProgram.dispose();
    this.updateProgram.dispose();
  }
}
