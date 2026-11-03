import { COMMON } from './shaders';
import { PingPong, Program, Target, TexFormat, VS_FULLSCREEN, drawFullscreen, UniformValue } from './gl';

// Частицы узкой полосы у поверхности: гибрид «частицы + сетка».
//
//   Narrow Band FLIP (Ferstl, Ando, Wojtan, Westermann, Thuerey, 2016): частицы живут
//   только в полосе шириной BAND ячеек у поверхности, глубже вода — на сетке.
//   Перенос скоростей — APIC (Jiang et al., 2015): у частицы, кроме скорости, есть
//   её градиент C, поэтому передача частица ↔ сетка почти не теряет вращения и не
//   шумит, как FLIP.
//   Форма воды в полосе — по частицам (усреднённое ядро Zhu & Bridson, 2005), так
//   что тонкие языки и капли не «съедаются» сеткой, а летят дальше.
//
// Состояние частицы: P = (x, y, vx, vy), C = (∂u/∂x, ∂u/∂y, ∂v/∂x, ∂v/∂y),
//                    M = (жива, зерно, возраст, —). Всё в системе колбы.

export const BAND = 3.0;          // ширина полосы, ячеек
const RADIUS = 0.55;              // радиус частицы, ячеек
const KERNEL = 2.0;               // радиус ядра Zhu–Bridson, ячеек
const TARGET_PER_CELL = 4;
export const PARTICLE_ROW = 256;
const PW = PARTICLE_ROW;

// Частицы рисуются точками: номер вершины → тексель состояния.
const VS_POINTS_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uP;
uniform sampler2D uM;
uniform ivec2 uN;
uniform float uH;
uniform vec2 uOrigin;
uniform vec2 uTargetSize;   // размер цели в текселях
uniform vec2 uTexelOffset;  // где центр текселя (0,0) в координатах сетки (в ячейках)
uniform float uPointSize;
out vec2 vPos;
out vec4 vP;
out vec4 vC;
void emit(vec2 texelOfParticle) {
    // Центр спрайта — тексель, в котором частица, спрайт накрывает соседей.
    vec2 t = floor(texelOfParticle) + 0.5;
    gl_Position = vec4(t / uTargetSize * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = uPointSize;
}
`;

const VS_SPLAT = `${VS_POINTS_HEAD}
uniform sampler2D uC;
void main() {
    ivec2 id = ivec2(gl_VertexID % ${PW}, gl_VertexID / ${PW});
    vec4 M = texelFetch(uM, id, 0);
    vP = texelFetch(uP, id, 0);
    vC = texelFetch(uC, id, 0);
    vPos = vP.xy;
    if (M.x < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; return; }
    // Координаты частицы в текселях цели.
    emit((vP.xy - uOrigin) / uH - uTexelOffset);
}`;

// Скорость на грани MAC: (Σw·u, Σw) для граней u и v одного индекса.
// Ядро — «шатёр» шириной в ячейку, у APIC к скорости частицы добавляется C·(x_f − x_p).
const FS_SPLAT_VEL = `#version 300 es
precision highp float;
uniform float uH;
uniform vec2 uOrigin;
in vec2 vPos;
in vec4 vP;
in vec4 vC;
out vec4 o;
float tent(vec2 d) { vec2 w = max(1.0 - abs(d) / uH, 0.0); return w.x * w.y; }
void main() {
    vec2 f = floor(gl_FragCoord.xy);
    vec2 pu = uOrigin + vec2(f.x, f.y + 0.5) * uH;    // грань u
    vec2 pv = uOrigin + vec2(f.x + 0.5, f.y) * uH;    // грань v
    float wu = tent(pu - vPos), wv = tent(pv - vPos);
    if (wu + wv <= 0.0) discard;
    float u = vP.z + dot(vC.xy, pu - vPos);
    float v = vP.w + dot(vC.zw, pv - vPos);
    o = vec4(wu * u, wu, wv * v, wv);
}`;

// Поверхность по частицам (Zhu & Bridson): в каждой ячейке Σk, Σk·(x_p − x_c), и
// число частиц в самой ячейке; k(s) = (1 − s²/R²)³.
const FS_SPLAT_SURFACE = `#version 300 es
precision highp float;
uniform float uH;
uniform vec2 uOrigin;
in vec2 vPos;
in vec4 vP;
in vec4 vC;
out vec4 o;
void main() {
    vec2 f = floor(gl_FragCoord.xy);
    vec2 c = uOrigin + (f + 0.5) * uH;
    vec2 d = vPos - c;
    float R = ${KERNEL.toFixed(1)} * uH;
    float s = dot(d, d) / (R * R);
    if (s >= 1.0) discard;
    float k = pow(1.0 - s, 3.0);
    bool own = all(lessThanEqual(abs(d), vec2(0.5 * uH)));
    o = vec4(k, k * d / uH, own ? 1.0 : 0.0);
}`;

// Сетка ← частицы: в полосе скорость грани — от частиц, иначе — перенесённая сеткой.
const FS_MERGE_VEL = `${COMMON}
uniform sampler2D uVel;
uniform sampler2D uSplat;
uniform sampler2D uGeo;
void main() {
    ivec2 f = ivec2(gl_FragCoord.xy);
    vec2 v = texelFetch(uVel, f, 0).xy;
    vec4 s = texelFetch(uSplat, f, 0);
    vec4 geo = texelFetch(uGeo, f, 0);
    // Плавный переход: при малом весе (край полосы) смешиваем с сеточной скоростью.
    float au = clamp(s.y / 0.3, 0.0, 1.0), av = clamp(s.w / 0.3, 0.0, 1.0);
    if (s.y > 1e-6) v.x = mix(v.x, s.x / s.y, au);
    if (s.w > 1e-6) v.y = mix(v.y, s.z / s.w, av);
    if (geo.x <= 0.0) v.x = 0.0;
    if (geo.y <= 0.0) v.y = 0.0;
    o = vec4(v, 0.0, 1.0);
}`;

// φ: глубже полосы — сеточный; в полосе — объединение сеточного и частичного
// (тонкие языки держатся частицами, глубина — сеткой).
const FS_MERGE_PHI = `${COMMON}
uniform sampler2D uPhi;
uniform sampler2D uSurface;
uniform sampler2D uGeo;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float phi = texelFetch(uPhi, c, 0).x;
    vec4 s = texelFetch(uSurface, c, 0);
    if (texelFetch(uGeo, c, 0).z <= 0.0 || s.x < 1e-5 || phi < -${BAND.toFixed(1)} * uH) { o = vec4(phi); return; }
    vec2 mean = s.yz / s.x * uH;                    // средняя точка частиц относительно центра
    float particlePhi = length(mean) - ${RADIUS.toFixed(2)} * uH;
    o = vec4(min(phi, particlePhi));
}`;

// Сетка → частицы (APIC) и перенос: скорость и её градиент из сетки после
// проекции, затем шаг по траектории (RK2), у стекла частица выталкивается внутрь.
// Здесь же — уход и рождение частиц: полоса следует за поверхностью.
const FS_UPDATE = `${COMMON}
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D uP;
uniform sampler2D uC;
uniform sampler2D uM;
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform sampler2D uSurface;
uniform sampler2D uGeo;
uniform float uDt;
uniform float uSeed;
uniform float uSeedChance;
uniform int uAdvect;
float rnd(float index, float k) { return fract(sin(index * 12.9898 + uSeed * 78.233 + k * 37.719) * 43758.5453); }
vec2 cavityNormal(vec2 p) {
    vec2 e = vec2(0.002, 0.0);
    return normalize(vec2(cavitySd(p + e.xy) - cavitySd(p - e.xy), cavitySd(p + e.yx) - cavitySd(p - e.yx)) + 1e-9);
}
// У стекла скорость берём на ячейку глубже в полости: грань на самой стенке
// закрыта (скорость 0), и интерполяция с ней гасила отрыв от стекла — частицы
// скользили по потолку и не падали. Убираем только движение в стекло.
vec2 insideWall(vec2 p) {
    float sd = cavitySd(p);
    return sd > -uH ? p - cavityNormal(p) * (sd + uH) : p;
}
vec2 wallVel(vec2 p) {
    vec2 v = sampleVel(uVel, insideWall(p));
    float sd = cavitySd(p);
    if (sd > -uH) {
        vec2 n = cavityNormal(p);
        float vn = dot(v, n);
        if (vn > 0.0) v -= n * vn * smoothstep(-uH, -0.3 * uH, sd);
    }
    return v;
}
mat2 gradVel(vec2 p) {
    float e = 0.5 * uH;
    vec2 dx = (sampleVel(uVel, p + vec2(e, 0.0)) - sampleVel(uVel, p - vec2(e, 0.0))) / (2.0 * e);
    vec2 dy = (sampleVel(uVel, p + vec2(0.0, e)) - sampleVel(uVel, p - vec2(0.0, e))) / (2.0 * e);
    return mat2(dx, dy);   // столбцы: ∂/∂x, ∂/∂y
}
void main() {
    ivec2 id = ivec2(gl_FragCoord.xy);
    float index = float(id.y * ${PW} + id.x);
    vec4 P = texelFetch(uP, id, 0);
    vec4 C = texelFetch(uC, id, 0);
    vec4 M = texelFetch(uM, id, 0);

    if (M.x > 0.5) {
        if (uAdvect == 1) {
            vec2 v = wallVel(P.xy);
            mat2 g = gradVel(insideWall(P.xy));
            P.zw = v;
            C = vec4(g[0].x, g[1].x, g[0].y, g[1].y);
            vec2 mid = P.xy + 0.5 * uDt * v;
            P.xy += uDt * wallVel(mid);
            float sd = cavitySd(P.xy);
            float margin = 0.3 * uH;
            if (sd > -margin) {
                vec2 n = cavityNormal(P.xy);
                P.xy -= n * (sd + margin);
                float vn = dot(P.zw, n);
                if (vn > 0.0) P.zw -= n * vn;
            }
            M.z += uDt;
        } else {
            // Уход: в воздухе (вода ушла по поправке объёма), глубоко под полосой,
            // в слишком густой кучке.
            float phi = sampleCell(uPhi, P.xy);
            ivec2 cell = ivec2(floor((P.xy - uOrigin) / uH));
            float crowd = texelFetch(uSurface, clamp(cell, ivec2(0), uN - 1), 0).w;
            if (phi > 0.3 * uH || phi < -(${BAND.toFixed(1)} + 1.0) * uH || cavitySd(P.xy) > 0.0
                || (crowd > ${2 * TARGET_PER_CELL}.0 && rnd(index, 1.0) < 0.3)) M.x = 0.0;
        }
        o = P; o1 = C; o2 = M;
        return;
    }
    o = P; o1 = C; o2 = M;
    if (uAdvect == 1) return;
    // Рождение: случайная ячейка полосы, где частиц меньше нормы.
    ivec2 cell = ivec2(floor(vec2(rnd(index, 2.0), rnd(index, 3.0)) * vec2(uN)));
    cell = clamp(cell, ivec2(0), uN - 1);
    if (texelFetch(uGeo, cell, 0).z < 0.99) return;
    float count = texelFetch(uSurface, cell, 0).w;
    if (count >= ${TARGET_PER_CELL}.0 || rnd(index, 4.0) > uSeedChance * (1.0 - count / ${TARGET_PER_CELL}.0)) return;
    vec2 p = cellCenter(cell) + (vec2(rnd(index, 5.0), rnd(index, 6.0)) - 0.5) * uH;
    float phi = sampleCell(uPhi, p);
    if (phi > -0.45 * uH || phi < -${BAND.toFixed(1)} * uH) return;
    mat2 g = gradVel(p);
    o = vec4(p, sampleVel(uVel, p));
    o1 = vec4(g[0].x, g[1].x, g[0].y, g[1].y);
    o2 = vec4(1.0, rnd(index, 7.0), 0.0, 0.0);
}`;

export class BandParticles {
  readonly state: PingPong;
  readonly count: number;
  private velSplat: Target;
  readonly surface: Target;
  private splatVel: Program;
  private splatSurface: Program;
  private mergeVelProgram: Program;
  private mergePhiProgram: Program;
  private update: Program;
  private frame = 0;
  private format: TexFormat;

  constructor(
    private gl: WebGL2RenderingContext,
    private grid: { nx: number; ny: number; h: number; origin: [number, number]; common: () => Record<string, UniformValue> },
  ) {
    // Сложение в float32-цели — расширение EXT_float_blend; без него — half float.
    this.format = gl.getExtension('EXT_float_blend') ? 'RGBA32F' : 'RGBA16F';
    const slots = Math.max(8192, 64 * grid.nx);
    const ph = Math.ceil(slots / PW);
    this.count = PW * ph;
    this.state = new PingPong(gl, PW, ph, ['RGBA32F', 'RGBA32F', 'RGBA32F']);
    this.velSplat = new Target(gl, grid.nx + 1, grid.ny + 1, [this.format]);
    this.surface = new Target(gl, grid.nx, grid.ny, [this.format]);
    this.splatVel = new Program(gl, VS_SPLAT, FS_SPLAT_VEL);
    this.splatSurface = new Program(gl, VS_SPLAT, FS_SPLAT_SURFACE);
    this.mergeVelProgram = new Program(gl, VS_FULLSCREEN, FS_MERGE_VEL);
    this.mergePhiProgram = new Program(gl, VS_FULLSCREEN, FS_MERGE_PHI);
    this.update = new Program(gl, VS_FULLSCREEN, FS_UPDATE);
    const zero = new Float32Array(PW * ph * 4);
    for (const t of [this.state.read, this.state.write]) for (let i = 0; i < 3; i++) t.upload(zero, i);
  }

  private splat(program: Program, target: Target, texelOffset: [number, number], pointSize: number) {
    const gl = this.gl;
    target.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);
    const [P, C, M] = this.state.read.textures;
    program.use({
      uP: P, uC: C, uM: M, uN: [this.grid.nx, this.grid.ny], uH: this.grid.h, uOrigin: this.grid.origin,
      uTargetSize: [target.width, target.height], uTexelOffset: texelOffset, uPointSize: pointSize,
    });
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.disable(gl.BLEND);
  }

  /** Скорости частиц → грани сетки; результат пишется в out. */
  mergeVelocity(vel: WebGLTexture, geo: WebGLTexture, out: Target) {
    // Тексель f держит грани u (f.x, f.y+½) и v (f.x+½, f.y): все грани, до которых
    // дотягивается ядро частицы, — в квадрате 3×3 вокруг её ячейки.
    this.splat(this.splatVel, this.velSplat, [0.0, 0.0], 3);
    out.bind();
    this.mergeVelProgram.use({ ...this.grid.common(), uVel: vel, uSplat: this.velSplat.texture, uGeo: geo });
    drawFullscreen(this.gl);
  }

  /** Поверхность по частицам и объединение с сеточным φ. */
  mergePhi(phi: WebGLTexture, geo: WebGLTexture, out: Target) {
    this.splat(this.splatSurface, this.surface, [0.0, 0.0], 2 * Math.ceil(KERNEL) + 1);
    out.bind();
    this.mergePhiProgram.use({ ...this.grid.common(), uPhi: phi, uSurface: this.surface.texture, uGeo: geo });
    drawFullscreen(this.gl);
  }

  private pass(advect: boolean, extra: Record<string, UniformValue>) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.state.write.bind();
    const [P, C, M] = this.state.read.textures;
    this.update.use({
      ...this.grid.common(), uP: P, uC: C, uM: M, uSurface: this.surface.texture,
      uSeed: (this.frame * 0.618034) % 97, uAdvect: advect ? 1 : 0, ...extra,
    });
    drawFullscreen(gl);
    this.state.swap();
  }

  /** Уход и рождение частиц по итоговому φ шага (полоса следует за поверхностью). */
  maintain(phi: WebGLTexture, vel: WebGLTexture, geo: WebGLTexture, seedChance = 0.5) {
    this.frame++;
    this.pass(false, { uPhi: phi, uVel: vel, uGeo: geo, uDt: 0, uSeedChance: seedChance });
  }

  /** Сетка → частицы (APIC) и перенос по скорости после проекции. */
  advect(vel: WebGLTexture, phi: WebGLTexture, geo: WebGLTexture, dt: number) {
    this.pass(true, { uPhi: phi, uVel: vel, uGeo: geo, uDt: dt, uSeedChance: 0 });
  }

  get textures(): WebGLTexture[] {
    return this.state.read.textures;
  }

  dispose() {
    this.state.dispose();
    this.velSplat.dispose();
    this.surface.dispose();
    [this.splatVel, this.splatSurface, this.mergeVelProgram, this.mergePhiProgram, this.update].forEach((p) => p.dispose());
  }
}
