import { Program, Target, VS_FULLSCREEN, drawFullscreen } from './gl';
import { COMMON } from './shaders';
import type { FluidSolver } from './solver';

// Каустики на задней стенке колбы — нити света в толще воды.
//
// Это не узор: свет падает сверху, преломляется на поверхности воды по закону
// Снеллиуса и попадает на заднюю стенку. Неровная поверхность сводит лучи —
// где пучок сжимается, становится светлее, на складках отображения лучей
// (якобиан → 0) возникают яркие нити (Berry & Upstill, «Catastrophe optics», 1980).
// Яркость считаем как отношение площадей ячеек пучка до и после преломления
// (метод Evan Wallace для WebGL: производные во фрагментном шейдере).
//
// Поверхность = реальная форма воды из решателя + мелкая рябь с дисперсией
// гравитационно-капиллярных волн ω² = g·k + (σ/ρ)·k³. Поэтому форма, длина,
// блеск и направление нитей зависят от волн, угла света и глубины до стенки.
//
// Стекло: свет сначала проходит стенку колбы (сечение круглое, стенка тонкая —
// местами плоская пластинка), и доля прошедшего света зависит от угла падения
// (формулы Френеля). Второй путь — сквозь стенку ниже уровня воды, минуя
// поверхность: там ряби нет, а круглая стенка с водой сводит свет в полосу.
// При наклоне колбы оба пути смещаются: где-то нити меняют угол, где-то их
// заливает ровный свет из-под воды. Источник протяжённый (несколько
// направлений), поэтому у теней есть полутень, а складки мягче с глубиной.
//
// Приёмник — задняя стенка в координатах (u — вдоль поверхности, d — глубина под ней).

const RIPPLES = 16;
const MESH_U = 220;
const MESH_Z = 90;
const WALL_U = 220;
const WALL_D = 48;
// Направления света: центр и кольцо вокруг него (угловой радиус ~0.17 рад).
const LIGHT_DIR: [number, number, number] = [0.3, -1.0, -0.85];
const LIGHTS: [number, number, number][] = (() => {
  const l = Math.hypot(...LIGHT_DIR);
  const d = LIGHT_DIR.map((v) => v / l) as [number, number, number];
  // Базис, перпендикулярный направлению.
  const a = [d[1] * 0 - d[2] * 1, d[2] * 0 - d[0] * 0, d[0] * 1 - d[1] * 0];
  const al = Math.hypot(a[0], a[1], a[2]);
  const e1 = a.map((v) => v / al);
  const e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
  const out: [number, number, number][] = [d];
  for (let i = 0; i < 4; i++) {
    const t = (Math.PI / 2) * i + 0.4, r = 0.17;
    out.push([0, 1, 2].map((k) => d[k] + r * (Math.cos(t) * e1[k] + Math.sin(t) * e2[k])) as [number, number, number]);
  }
  return out;
})();
export const CAUSTIC_W = 512;
export const CAUSTIC_H = 160;

// Высота поверхности вдоль колбы: для каждого u ищем границу воды по линии «вверх».
const FS_PROFILE = `${COMMON}
uniform sampler2D uPhi;
uniform vec2 uUp;
uniform float uReach;
uniform int uColumns;
void main() {
    float u = mix(-uCavityHalf.x, uCavityHalf.x, (gl_FragCoord.x - 0.5) / float(uColumns - 1));
    vec2 side = vec2(uUp.y, -uUp.x);
    float prev = sampleCell(uPhi, side * u + uUp * uReach);
    float s = uReach, found = 0.0;
    const int STEPS = 96;
    for (int k = 1; k <= STEPS; k++) {
        float sk = uReach - 2.0 * uReach * float(k) / float(STEPS);
        float p = sampleCell(uPhi, side * u + uUp * sk);
        if (prev > 0.0 && p <= 0.0 && cavitySd(side * u + uUp * sk) < 0.0) { s = sk + (2.0 * uReach / float(STEPS)) * p / (p - prev); found = 1.0; break; }
        prev = p;
    }
    // Столбец целиком в воде (вода упёрлась в стекло): «поверхность» — верх
    // полости; света через поверхность здесь нет, но через стекло — есть.
    float full = 0.0;
    if (found < 0.5) {
        for (int k = 0; k <= STEPS; k++) {
            float sk = uReach - 2.0 * uReach * float(k) / float(STEPS);
            vec2 q = side * u + uUp * sk;
            if (cavitySd(q) < 0.0) {
                // Уточняем верх полости делением отрезка пополам.
                float hi = sk + 2.0 * uReach / float(STEPS), lo = sk;
                for (int b = 0; b < 12; b++) {
                    float mid = 0.5 * (hi + lo);
                    if (cavitySd(side * u + uUp * mid) < 0.0) lo = mid; else hi = mid;
                }
                if (sampleCell(uPhi, side * u + uUp * (lo - 0.08)) < 0.0) { s = lo; full = 1.0; }
                break;
            }
        }
    }
    o = vec4(s, found, full, 0.0);
}`;

const VS_HEAD = `#version 300 es
precision highp float;
uniform sampler2D uProfile;
uniform float uHalfU;
uniform float uDepth;      // глубина колбы «в экран» (расстояние до задней стенки)
uniform float uMaxD;       // глубина приёмника (вниз от поверхности)
uniform vec3 uLight;       // направление света (вниз), система (u, вверх, к зрителю)
uniform vec4 uWaves[${RIPPLES}];   // (kx, kz, ω, амплитуда)
uniform float uPhase[${RIPPLES}];
uniform float uTime;
uniform float uLightWeight;   // доля этого направления в протяжённом источнике
// Стекло колбы: свет проходит верхнюю стенку до воды.
uniform vec2 uSide;        // «вдоль поверхности» в системе колбы
uniform vec2 uUpL;         // «вверх» в системе колбы
uniform vec2 uCavityHalf;
uniform float uCavityRadius;
uniform float uGlass;
out vec2 vOld;
out vec2 vNew;
out vec3 vHit;
out float vWeight;

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
// Колба в объёме: контур — скруглённый прямоугольник, сечение поперёк — круглое.
float sdFlask(vec3 p, float grow) {
    float R = 0.5 * uDepth + grow;
    vec2 e = vec2(sdRoundedBox(p.xy, uCavityHalf + grow, uCavityRadius + grow) + R, abs(p.z) - 0.0);
    return min(max(e.x, e.y), 0.0) + length(max(e, 0.0)) - R;
}
vec3 flaskNormal(vec3 p, float grow) {
    vec2 h = vec2(0.003, 0.0);
    return normalize(vec3(sdFlask(p + h.xyy, grow) - sdFlask(p - h.xyy, grow),
                          sdFlask(p + h.yxy, grow) - sdFlask(p - h.yxy, grow),
                          sdFlask(p + h.yyx, grow) - sdFlask(p - h.yyx, grow)));
}
// Пропускание границы по формулам Френеля (неполяризованный свет), eta = n1/n2.
float fresnelT(float cosI, float eta) {
    cosI = clamp(cosI, 0.0, 1.0);
    float sin2T = eta * eta * (1.0 - cosI * cosI);
    if (sin2T >= 1.0) return 0.0;
    float cosT = sqrt(1.0 - sin2T);
    float rs = (eta * cosI - cosT) / (eta * cosI + cosT);
    float rp = (eta * cosT - cosI) / (eta * cosT + cosI);
    return 1.0 - 0.5 * (rs * rs + rp * rp);
}

// Где по z кончается полость на высоте точки xy (сечение колбы круглое).
float halfWidthZ(vec2 xy) {
    float R = 0.5 * uDepth;
    float ex = max(sdRoundedBox(xy, uCavityHalf, uCavityRadius) + R, 0.0);
    return sqrt(max(R * R - ex * ex, 0.0));
}

// Свет, дошедший до точки p внутри колбы (система колбы), прошёл стенку там,
// где луч назад к источнику выходит из полости. Тонкая стенка постоянной
// толщины — местами плоскопараллельная пластинка: направление луча она почти
// не меняет, а вот доля прошедшего света сильно зависит от угла (Френель):
// где свет падает на скруглённое стекло полого, он в основном отражается.
// Возвращает долю прошедшей энергии.
float throughGlass(vec3 p, vec3 L) {
    vec3 q = p;
    for (int k = 0; k < 32; k++) {
        float d = -sdFlask(q, 0.0);
        if (d < 2e-3) break;
        q -= L * max(d, 0.006);
    }
    vec3 n = flaskNormal(q, 0.0);
    float cosO = dot(n, -L);
    if (cosO <= 0.0) return 0.0;
    float cosG = sqrt(1.0 - (1.0 - cosO * cosO) / 2.25);
    return fresnelT(cosO, 1.0 / 1.5) * fresnelT(cosG, 1.5);
}

// Профиль хранится в RG32F: линейная фильтрация float-текстур есть не везде,
// поэтому интерполируем сами. x — высота поверхности, y — найдена ли граница,
// z — столбец целиком в воде (тогда x — верх полости).
vec3 profileAt(float u) {
    float t = clamp((u + uHalfU) / (2.0 * uHalfU), 0.0, 1.0) * float(${CAUSTIC_W - 1});
    int i = int(floor(t));
    vec3 a = texelFetch(uProfile, ivec2(i, 0), 0).xyz;
    vec3 b = texelFetch(uProfile, ivec2(min(i + 1, ${CAUSTIC_W - 1}), 0), 0).xyz;
    return mix(a, b, t - float(i));
}
float surfaceAt(float u) { return profileAt(u).x; }

// Луч от точки поверхности (u0, z0): где он попал бы на плоскую заднюю стенку
// (опорная карта для нормировки: так ложится свет на ровной воде).
vec2 hit(float u0, float z0, vec3 n, vec3 L) {
    vec3 T = refract(L, n, 1.0 / 1.333);
    float t = (-0.5 * uDepth - z0) / min(T.z, -1e-3);
    return vec2(u0 + t * T.x, -t * T.y);
}

// Приёмник — задняя стенка (плоскость z = −R за водой): луч в воде (система
// колбы) доводим до неё и переводим точку в (u, глубина под поверхностью), как её
// видит основной проход. Плоскость, а не круглое сечение: в плоском виде колбы
// задняя стенка и есть то, что видно сквозь воду.
vec3 landPoint;
vec3 land(vec3 p, vec3 T) {
    float t = (-0.5 * uDepth - p.z) / min(T.z, -1e-3);
    vec3 q = p + T * t;
    landPoint = q;
    float u = dot(q.xy, uSide);
    float depth = surfaceAt(u) - dot(q.xy, uUpL);
    return vec3(u, max(depth, 0.0), 1.0);
}
vec3 toFlask(vec3 v) { return vec3(uSide * v.x + uUpL * v.y, v.z); }
`;

const VS_MESH = VS_HEAD + `
void main() {
    int quad = gl_VertexID / 6, corner = gl_VertexID % 6;
    int qi = quad % ${MESH_U}, qj = quad / ${MESH_U};
    ivec2 offs[6] = ivec2[6](ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 0), ivec2(1, 1), ivec2(0, 1));
    ivec2 g = ivec2(qi, qj) + offs[corner];
    float u0 = mix(-uHalfU, uHalfU, float(g.x) / float(${MESH_U}));
    float z0 = mix(-0.5 * uDepth, 0.5 * uDepth, float(g.y) / float(${MESH_Z}));

    // Наклон поверхности: волны из решателя (по u) + рябь (по u и z).
    float e = 0.02;
    float dhdu = (surfaceAt(u0 + e) - surfaceAt(u0 - e)) / (2.0 * e);
    float dhdz = 0.0;
    for (int i = 0; i < ${RIPPLES}; i++) {
        vec4 w = uWaves[i];
        float s = sin(w.x * u0 + w.y * z0 - w.z * uTime + uPhase[i]);
        dhdu -= w.x * w.w * s;
        dhdz -= w.y * w.w * s;
    }
    vec3 n = normalize(vec3(-dhdu, 1.0, -dhdz));
    // Свет в систему колбы → через стекло → обратно в систему «вдоль поверхности/вверх».
    vec3 Lw = normalize(uLight);
    vec3 Lf = vec3(uSide * Lw.x + uUpL * Lw.y, Lw.z);
    vec3 prof = profileAt(u0);
    float full = prof.z;
    vec3 pf = vec3(uSide * u0 + uUpL * (prof.x - 0.08 * full), z0);
    // Поверхность в сетке занимает всю глубину приёмника; для стекла берём ту же
    // долю ширины настоящего (круглого) сечения на этой высоте.
    vec3 pg = vec3(pf.xy, z0 / (0.5 * uDepth) * 0.97 * halfWidthZ(pf.xy));
    float glassT = throughGlass(pg, Lf);
    float waterT = fresnelT(dot(n, -Lw), 1.0 / 1.333);
    if (full > 0.5) {
        // Вода упёрлась в стекло: свободной поверхности нет, ряби тоже. Свет идёт
        // стекло → вода, преломляясь по нормали стекла (пластинка: как воздух → вода).
        vec2 e2 = vec2(0.003, 0.0);
        vec2 gxy = vec2(sdRoundedBox(pf.xy + e2.xy, uCavityHalf, uCavityRadius) - sdRoundedBox(pf.xy - e2.xy, uCavityHalf, uCavityRadius),
                        sdRoundedBox(pf.xy + e2.yx, uCavityHalf, uCavityRadius) - sdRoundedBox(pf.xy - e2.yx, uCavityHalf, uCavityRadius));
        gxy = normalize(gxy + 1e-9);
        n = normalize(vec3(dot(gxy, uSide), dot(gxy, uUpL), 0.0));
        float cosO = max(dot(n, -Lw), 0.0);
        float cosG = sqrt(1.0 - (1.0 - cosO * cosO) / 2.25);
        glassT = cosO > 0.0 ? fresnelT(cosO, 1.0 / 1.5) : 0.0;
        waterT = fresnelT(cosG, 1.5 / 1.333);
    }
    float inside = smoothstep(0.0, 0.06, -sdRoundedBox(pf.xy, uCavityHalf, uCavityRadius)) * clamp(prof.y + full, 0.0, 1.0);
    vec3 Lin = Lw;
    vec3 landed = land(pf, toFlask(refract(Lin, n, 1.0 / 1.333)));
    vNew = landed.xy;
    vHit = landPoint;
    vOld = hit(u0, z0, vec3(0.0, 1.0, 0.0), Lw);
    // Нормируем на типичное пропускание стекла и поверхности при отвесном свете.
    vWeight = uLightWeight * inside * landed.z * glassT * waterT / 0.88;
    vec2 clip = vec2(vNew.x / uHalfU, 1.0 - 2.0 * vNew.y / uMaxD);
    gl_Position = vec4(clip, 0.0, 1.0);
}`;

const VS_WALL = VS_HEAD + `
void main() {
    // Второй путь света: через стенку колбы ниже уровня воды, минуя поверхность.
    // Здесь нет ряби — свет ровный, но стекло со слоем воды за ним работает как
    // толстая цилиндрическая линза: где-то пучок сводится в полосу, где-то
    // стенка отвёрнута от света или ловит полное отражение — там тень.
    int quad = gl_VertexID / 6, corner = gl_VertexID % 6;
    int qi = quad % ${WALL_U}, qj = quad / ${WALL_U};
    // Две половины сетки: передняя (z > 0) и задняя (z < 0) стороны стенки.
    // Освещена любая часть выпуклой стенки, повёрнутая к свету.
    float zSide = qj < ${WALL_D} ? 1.0 : -1.0;
    qj = qj % ${WALL_D};
    ivec2 offs[6] = ivec2[6](ivec2(0, 0), ivec2(1, 0), ivec2(0, 1), ivec2(1, 0), ivec2(1, 1), ivec2(0, 1));
    ivec2 cell = ivec2(qi, qj) + offs[corner];
    float u = mix(-uHalfU, uHalfU, float(cell.x) / float(${WALL_U}));
    float d = uMaxD * float(cell.y) / float(${WALL_D});          // глубина под поверхностью
    float y = surfaceAt(u) - d;
    vec2 xy = uSide * u + uUpL * y;                                // точка в системе колбы
    float R = 0.5 * uDepth;
    float ex = sdRoundedBox(xy, uCavityHalf, uCavityRadius) + R;
    vec3 prof = profileAt(u);
    float weight = (ex < R - 0.02 && d > 0.02) ? clamp(prof.y + prof.z, 0.0, 1.0) : 0.0;
    ex = clamp(ex, 0.0, R - 0.02);
    // Внешняя поверхность стенки (z > 0 — к зрителю, откуда светит).
    float zOut = zSide * sqrt(max((R + uGlass) * (R + uGlass) - ex * ex, 0.0));
    vec3 po = vec3(xy, zOut);
    vec3 Lw = normalize(uLight);
    vec3 Lf = vec3(uSide * Lw.x + uUpL * Lw.y, Lw.z);
    vec3 no = flaskNormal(po, uGlass);
    // В столбце, где вода у верхнего стекла, свет сверху уже учтён сеткой поверхности.
    weight *= 1.0 - prof.z * smoothstep(0.35, 0.7, dot(no.xy, uUpL));
    float cosO = dot(no, -Lf);
    if (cosO <= 0.0) weight = 0.0;
    // Стенка — пластинка: стекло → вода с той же нормалью. Направление в воде
    // то же, что дал бы прямой переход воздух → вода; потери — на двух границах.
    vec3 t1 = refract(Lf, no, 1.0 / 1.5);
    vec3 t2 = refract(t1, no, 1.5 / 1.333);
    float cosG = dot(-t1, no);
    vec3 pi = po - no * uGlass;
    if (dot(t2, t2) < 1e-6) { weight = 0.0; t2 = Lf; }
    weight *= fresnelT(cosO, 1.0 / 1.5) * fresnelT(cosG, 1.5 / 1.333) * (1.0 - smoothstep(0.7, 1.0, d / uMaxD));
    vec3 landed = land(pi - no * 0.01, normalize(t2));
    vNew = landed.xy;
    vHit = landPoint;
    weight *= landed.z;
    // Опорная карта — тот же луч, будто вошёл через ровную поверхность: нормировка
    // та же, что у поверхностной сетки (1 = свет «как на плоской воде»).
    float tb = d / Lw.y;                                           // назад вдоль луча до уровня воды
    vOld = hit(u + Lw.x * tb, zOut + Lw.z * tb, vec3(0.0, 1.0, 0.0), Lw);
    vWeight = uLightWeight * weight / 0.88;
    vec2 clip = vec2(vNew.x / uHalfU, 1.0 - 2.0 * vNew.y / uMaxD);
    gl_Position = vec4(clip, 0.0, 1.0);
}`;

const FS_MESH = `#version 300 es
precision highp float;
in vec2 vOld;
in vec2 vNew;
in vec3 vHit;
in float vWeight;
out vec4 outColor;
void main() {
    // Отношение площадей до/после преломления: >1 там, где пучок сжался.
    float before = abs(dFdx(vOld).x * dFdy(vOld).y - dFdx(vOld).y * dFdy(vOld).x);
    float after = length(cross(dFdx(vHit), dFdy(vHit)));
    float ratio = before / max(after, before * 0.02 + 1e-12);
    outColor = vec4(ratio * vWeight, 0.0, 0.0, 1.0);
}`;

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export class Caustics {
  readonly target: Target;
  /** Высота поверхности вдоль колбы (x — высота по «вверх», y — нашлась ли граница, z — столбец в воде). */
  readonly profile: Target;
  private profileProgram: Program;
  private meshProgram: Program;
  private wallProgram: Program;
  private waves: number[] = [];
  private phases: number[] = [];
  private slopes: number[] = [];
  readonly maxDepth: number;
  readonly depth: number;

  constructor(private gl: WebGL2RenderingContext, private solver: FluidSolver, private glass = 0.1, seed = 5) {
    this.target = new Target(gl, CAUSTIC_W, CAUSTIC_H, ['RGBA16F'], true);
    this.profile = new Target(gl, CAUSTIC_W, 1, ['RGBA32F']);
    this.profileProgram = new Program(gl, VS_FULLSCREEN, FS_PROFILE);
    this.meshProgram = new Program(gl, VS_MESH, FS_MESH);
    this.wallProgram = new Program(gl, VS_WALL, FS_MESH);
    // Колба в сечении примерно круглая: глубина до задней стенки ~ её высота.
    this.depth = 1.8 * solver.cavityHalf[1];
    this.maxDepth = 2 * solver.cavityHalf[1];

    const rand = mulberry(seed);
    for (let i = 0; i < RIPPLES; i++) {
      // Длины волн ряби ~2.5 … 12 см (единица ≈ 6 см), направления — любые.
      // Луч фокусируется на расстоянии f ≈ 1/((1 − 1/n)·κ), κ = крутизна·2π/λ:
      // на спокойной воде пологая рябь даёт лишь мягкие, редкие складки света.
      const lambda = 0.4 + 1.6 * Math.pow(rand(), 1.2);
      const k = (2 * Math.PI) / lambda;
      const dir = 2 * Math.PI * rand();
      this.waves.push(k * Math.cos(dir), k * Math.sin(dir), 0, 0);
      this.phases.push(2 * Math.PI * rand());
      // Крутизна волны: длинные волны чуть круче (спектр убывает к мелким).
      this.slopes.push(0.003 + 0.007 * rand());
    }
  }

  /**
   * @param up «вверх» в системе колбы
   * @param g тяжесть (для дисперсии ряби)
   * @param agitation 0..1+ — насколько взволнована вода (растит рябь)
   */
  update(up: [number, number], g: number, time: number, agitation: number) {
    const gl = this.gl;
    // Дисперсия гравитационно-капиллярных волн: σ/ρ воды в единицах колбы ≈ 0.33.
    const tension = 7.2e-5 * Math.pow(10 / 0.6, 3);
    const amp = 0.7 + 2.5 * Math.min(agitation, 2);
    for (let i = 0; i < RIPPLES; i++) {
      const kx = this.waves[4 * i], kz = this.waves[4 * i + 1];
      const k = Math.hypot(kx, kz);
      this.waves[4 * i + 2] = Math.sqrt(Math.max(g, 1) * k + tension * k * k * k);
      this.waves[4 * i + 3] = (this.slopes[i] * amp) / k;
    }
    gl.disable(gl.BLEND);
    this.profile.bind();
    const [cx, cy] = this.solver.cavityHalf;
    this.profileProgram.use({
      ...this.solver.gridUniforms(), uPhi: this.solver.phiRender.texture, uUp: up,
      uReach: Math.hypot(cx, cy), uColumns: CAUSTIC_W,
    });
    drawFullscreen(gl);

    this.target.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const uniforms = {
      uProfile: this.profile.texture, uHalfU: cx, uDepth: this.depth, uMaxD: this.maxDepth,
      uWaves: this.waves, uPhase: this.phases, uTime: time,
      uSide: [up[1], -up[0]], uUpL: up, uCavityHalf: this.solver.cavityHalf, uCavityRadius: this.solver.cavityRadius,
      uGlass: this.glass,
    };
    // Источник света протяжённый (окно, небо ~20°): складываем несколько
    // направлений. Тени получают полутень, а складки света размываются тем
    // сильнее, чем дальше от поверхности, — как в настоящей воде.
    for (const [lx, ly, lz] of LIGHTS) {
      const light = { ...uniforms, uLight: [lx, ly, lz], uLightWeight: 1 / LIGHTS.length };
      this.meshProgram.use(light);
      gl.drawArrays(gl.TRIANGLES, 0, MESH_U * MESH_Z * 6);
      this.wallProgram.use(light);
      gl.drawArrays(gl.TRIANGLES, 0, WALL_U * WALL_D * 2 * 6);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose() {
    this.target.dispose();
    this.profile.dispose();
    this.profileProgram.dispose();
    this.meshProgram.dispose();
    this.wallProgram.dispose();
  }
}
