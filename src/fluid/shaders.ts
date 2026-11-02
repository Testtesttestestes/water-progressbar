// Шейдеры расчёта несжимаемой двухфазной жидкости (вода + воздух) на сетке MAC.
//
// Всё считается в системе координат колбы: x — вдоль колбы, y — поперёк, начало
// в её центре. В этой системе стенки неподвижны, а движение колбы входит в
// уравнения силами инерции (переносной, Эйлера, центробежной и Кориолиса).
//
// Потенциальные силы (тяжесть, переносное ускорение, центробежная) не прикладываются
// к скорости: внутри каждой фазы их целиком уравновешивает давление, а на границе
// вода/воздух они дают скачок давления [p] = (ρв − ρвозд)·Φ(x), Φ = −g'·x − ½ω²|x|²
// (метод «призрачной жидкости»). Так дискретное равновесие точное: ровная
// поверхность в покое не порождает паразитных течений, сколько бы ни была наклонена
// колба и как бы ни отличались плотности.
//
// Раскладка величин:
//   скорость  VEL (Nx+1)×(Ny+1), RG32F: .x = u на вертикальной грани (i, j+½),
//                                       .y = v на горизонтальной грани (i+½, j);
//   давление, level set φ (вода — φ < 0), правая часть: Nx×Ny, в центрах ячеек;
//   геометрия GEO (Nx+1)×(Ny+1): .x/.y — открытая доля u/v-грани (cut-cell стенки),
//                                .z — доля площади ячейки внутри колбы.

export const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform ivec2 uN;       // число ячеек (Nx, Ny)
uniform float uH;       // размер ячейки
uniform vec2 uOrigin;   // нижний левый угол сетки в координатах колбы
uniform vec2 uCavityHalf;
uniform float uCavityRadius;

vec2 cellCenter(ivec2 c) { return uOrigin + (vec2(c) + 0.5) * uH; }
vec2 uFacePos(ivec2 f)   { return uOrigin + vec2(float(f.x), float(f.y) + 0.5) * uH; }
vec2 vFacePos(ivec2 f)   { return uOrigin + vec2(float(f.x) + 0.5, float(f.y)) * uH; }

float cellAt(sampler2D t, ivec2 c) { return texelFetch(t, clamp(c, ivec2(0), uN - 1), 0).x; }

// Билинейная выборка величины из центров ячеек.
float sampleCell(sampler2D t, vec2 p) {
    vec2 g = (p - uOrigin) / uH - 0.5;
    vec2 g0 = floor(g);
    vec2 f = g - g0;
    ivec2 i0 = ivec2(g0);
    float a = cellAt(t, i0);
    float b = cellAt(t, i0 + ivec2(1, 0));
    float c = cellAt(t, i0 + ivec2(0, 1));
    float d = cellAt(t, i0 + ivec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float uAt(sampler2D vel, ivec2 f) { return texelFetch(vel, clamp(f, ivec2(0), ivec2(uN.x, uN.y - 1)), 0).x; }
float vAt(sampler2D vel, ivec2 f) { return texelFetch(vel, clamp(f, ivec2(0), ivec2(uN.x - 1, uN.y)), 0).y; }

// Билинейная выборка компоненты скорости; .x — значение, .y/.z — минимум/максимум
// по четырём узлам (нужны для ограничителя MacCormack).
vec3 sampleUStencil(sampler2D vel, vec2 p) {
    vec2 g = (p - uOrigin) / uH - vec2(0.0, 0.5);
    vec2 g0 = floor(g);
    vec2 f = g - g0;
    ivec2 i0 = ivec2(g0);
    float a = uAt(vel, i0), b = uAt(vel, i0 + ivec2(1, 0)), c = uAt(vel, i0 + ivec2(0, 1)), d = uAt(vel, i0 + ivec2(1, 1));
    return vec3(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
}

vec3 sampleVStencil(sampler2D vel, vec2 p) {
    vec2 g = (p - uOrigin) / uH - vec2(0.5, 0.0);
    vec2 g0 = floor(g);
    vec2 f = g - g0;
    ivec2 i0 = ivec2(g0);
    float a = vAt(vel, i0), b = vAt(vel, i0 + ivec2(1, 0)), c = vAt(vel, i0 + ivec2(0, 1)), d = vAt(vel, i0 + ivec2(1, 1));
    return vec3(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
}

float sampleU(sampler2D vel, vec2 p) { return sampleUStencil(vel, p).x; }
float sampleV(sampler2D vel, vec2 p) { return sampleVStencil(vel, p).x; }
vec2 sampleVel(sampler2D vel, vec2 p) { return vec2(sampleU(vel, p), sampleV(vel, p)); }

// Обратная трассировка по полю скорости (RK2, средняя точка).
vec2 backtrace(sampler2D vel, vec2 p, float dt) {
    vec2 v1 = sampleVel(vel, p);
    vec2 v2 = sampleVel(vel, p - 0.5 * dt * v1);
    return p - dt * v2;
}

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// Расстояние до стенки полости (отрицательно внутри).
float cavitySd(vec2 p) { return sdRoundedBox(p, uCavityHalf, uCavityRadius); }

layout(location = 0) out vec4 o;
`;

// Геометрия: открытые доли граней и доля площади ячейки внутри полости.
export const FS_GEOMETRY = `${COMMON}
float insideFraction(vec2 a, vec2 b) {
    float s = 0.0;
    for (int k = 0; k < 16; k++)
        s += step(cavitySd(mix(a, b, (float(k) + 0.5) / 16.0)), 0.0);
    return s / 16.0;
}

void main() {
    ivec2 f = ivec2(gl_FragCoord.xy);
    float wu = 0.0, wv = 0.0, area = 0.0;
    if (f.y < uN.y && f.x > 0 && f.x < uN.x) {
        vec2 p = uFacePos(f);
        wu = insideFraction(p - vec2(0.0, 0.5 * uH), p + vec2(0.0, 0.5 * uH));
    }
    if (f.x < uN.x && f.y > 0 && f.y < uN.y) {
        vec2 p = vFacePos(f);
        wv = insideFraction(p - vec2(0.5 * uH, 0.0), p + vec2(0.5 * uH, 0.0));
    }
    if (f.x < uN.x && f.y < uN.y) {
        vec2 c = cellCenter(f);
        float s = 0.0;
        for (int a = 0; a < 4; a++)
            for (int b = 0; b < 4; b++)
                s += step(cavitySd(c + (vec2(a, b) - 1.5) * 0.25 * uH), 0.0);
        area = s / 16.0;
    }
    o = vec4(wu, wv, area, 0.0);
}`;

// Для ячеек целиком в стекле — ближайшая целая ячейка полости: оттуда level set
// продолжается в стекло линейно, по своему градиенту.
export const FS_EXTENSION_MAP = `${COMMON}
uniform sampler2D uGeo;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    if (texelFetch(uGeo, c, 0).z > 0.0) {
        o = vec4(vec2(c), 0.0, 0.0);
        return;
    }
    float best = 1e9;
    vec2 bestCell = vec2(-1.0);
    for (int dy = -6; dy <= 6; dy++)
        for (int dx = -6; dx <= 6; dx++) {
            ivec2 q = c + ivec2(dx, dy);
            if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, uN))) continue;
            // Источник — только целая ячейка полости. Срезанные стенкой ячейки
            // тоньше шага сетки: если продолжать φ из них, плёнка «воды» вдоль
            // стенки сама себя подпитывала бы из стекла и бесконечно стекала.
            if (texelFetch(uGeo, q, 0).z < 0.99) continue;
            float d = float(dx * dx + dy * dy);
            if (d < best) { best = d; bestCell = vec2(q); }
        }
    o = vec4(bestCell, 0.0, 0.0);
}`;

// Значение соседа для разностных схем: у стекла и края сетки — линейная
// экстраполяция изнутри. Постоянное продолжение задавало бы краевой угол 90°:
// без поверхностного натяжения такое условие искривляет ровную поверхность у
// стенки, и вода начинает качаться сама по себе.
const NEIGHBOR = `
bool isFluid(sampler2D geo, ivec2 c) {
    return all(greaterThanEqual(c, ivec2(0))) && all(lessThan(c, uN)) && texelFetch(geo, c, 0).z > 0.0;
}
float neighbor(sampler2D phi, sampler2D geo, ivec2 c, ivec2 d, float center) {
    if (isFluid(geo, c + d)) return texelFetch(phi, c + d, 0).x;
    if (isFluid(geo, c - d)) return 2.0 * center - texelFetch(phi, c - d, 0).x;
    return center;
}
`;

export const FS_EXTEND_PHI = `${COMMON}
${NEIGHBOR}
uniform sampler2D uPhi;
uniform sampler2D uGeo;
uniform sampler2D uExt;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float phi = texelFetch(uPhi, c, 0).x;
    if (texelFetch(uGeo, c, 0).z <= 0.0) {
        vec2 src = texelFetch(uExt, c, 0).xy;
        if (src.x >= 0.0) {
            ivec2 q = ivec2(src);
            float pq = texelFetch(uPhi, q, 0).x;
            vec2 grad = vec2(neighbor(uPhi, uGeo, q, ivec2(1, 0), pq) - neighbor(uPhi, uGeo, q, ivec2(-1, 0), pq),
                             neighbor(uPhi, uGeo, q, ivec2(0, 1), pq) - neighbor(uPhi, uGeo, q, ivec2(0, -1), pq)) / (2.0 * uH);
            phi = pq + dot(grad, cellCenter(c) - cellCenter(q));
            // Знак может смениться только там, где граница воды и правда уходит в
            // стекло (контактная линия рядом с q). Вдали от неё градиент у
            // скруглённого угла смотрит в угол, и линейное продолжение рисовало
            // в стекле «воду», которая затягивала соседние ячейки — вода ползла
            // вверх по углу и раскачивалась.
            if (phi * pq < 0.0 && abs(pq) > 2.0 * uH) phi = pq;
        }
    }
    o = vec4(phi);
}`;

// Полулагранжев перенос скорости (прямой шаг MacCormack).
export const FS_ADVECT_VEL = `${COMMON}
uniform sampler2D uVel;
uniform float uDt;
void main() {
    ivec2 f = ivec2(gl_FragCoord.xy);
    float u = 0.0, v = 0.0;
    if (f.y < uN.y) u = sampleU(uVel, backtrace(uVel, uFacePos(f), uDt));
    if (f.x < uN.x) v = sampleV(uVel, backtrace(uVel, vFacePos(f), uDt));
    o = vec4(u, v, 0.0, 1.0);
}`;

// Поправка MacCormack с ограничителем: второй порядок без новых экстремумов.
// У стенок — обычный полулагранжев перенос (Selle et al. 2008): шаблон поправки
// там захватывает закрытые грани с нулевой скоростью, и «исправление ошибки»
// раскачивало пристенный слой — на мелкой сетке это росло экспоненциально.
export const FS_MACCORMACK_VEL = `${COMMON}
uniform sampler2D uVel;  // поле на шаге n
uniform sampler2D uHat;  // результат прямого переноса
uniform float uDt;
bool nearWall(vec2 p, vec2 back) { return max(cavitySd(p), cavitySd(back)) > -2.0 * uH; }
void main() {
    ivec2 f = ivec2(gl_FragCoord.xy);
    float u = 0.0, v = 0.0;
    if (f.y < uN.y) {
        vec2 p = uFacePos(f);
        vec2 back = backtrace(uVel, p, uDt);
        vec3 s = sampleUStencil(uVel, back);
        float tilde = sampleU(uHat, backtrace(uVel, p, -uDt));
        float value = texelFetch(uHat, f, 0).x + 0.5 * (texelFetch(uVel, f, 0).x - tilde);
        u = nearWall(p, back) ? texelFetch(uHat, f, 0).x : clamp(value, s.y, s.z);
    }
    if (f.x < uN.x) {
        vec2 p = vFacePos(f);
        vec2 back = backtrace(uVel, p, uDt);
        vec3 s = sampleVStencil(uVel, back);
        float tilde = sampleV(uHat, backtrace(uVel, p, -uDt));
        float value = texelFetch(uHat, f, 0).y + 0.5 * (texelFetch(uVel, f, 0).y - tilde);
        v = nearWall(p, back) ? texelFetch(uHat, f, 0).y : clamp(value, s.y, s.z);
    }
    o = vec4(u, v, 0.0, 1.0);
}`;

// Непотенциальные силы инерции и непротекание на закрытых гранях:
//   a = ω̇·(y, −x) + 2ω·(v, −u)   (Эйлера и Кориолиса).
// Тяжесть, переносное ускорение и центробежная сила входят через скачок давления.
// uDamping — затухание движения относительно колбы (трение о стенки и вязкость):
// в настоящей колбе такого размера плеск и вихри гаснут за несколько секунд.
export const FS_FORCES = `${COMMON}
uniform sampler2D uVel;
uniform sampler2D uGeo;
uniform float uOmega;
uniform float uOmegaDot;
uniform float uDamping;
uniform float uDt;
void main() {
    ivec2 f = ivec2(gl_FragCoord.xy);
    vec4 geo = texelFetch(uGeo, f, 0);
    vec2 vel = texelFetch(uVel, f, 0).xy;
    float u = 0.0, v = 0.0;
    if (geo.x > 0.0) {
        vec2 p = uFacePos(f);
        float vHere = sampleV(uVel, p);
        float ax = uOmegaDot * p.y + 2.0 * uOmega * vHere;
        u = vel.x * uDamping + uDt * ax;
    }
    if (geo.y > 0.0) {
        vec2 p = vFacePos(f);
        float uHere = sampleU(uVel, p);
        float ay = -uOmegaDot * p.x - 2.0 * uOmega * uHere;
        v = vel.y * uDamping + uDt * ay;
    }
    o = vec4(u, v, 0.0, 1.0);
}`;

export const FS_ADVECT_PHI = `${COMMON}
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform float uDt;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    o = vec4(sampleCell(uPhi, backtrace(uVel, cellCenter(c), uDt)));
}`;

export const FS_MACCORMACK_PHI = `${COMMON}
uniform sampler2D uVel;
uniform sampler2D uPhi;
uniform sampler2D uHat;
uniform float uDt;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    vec2 p = cellCenter(c);
    vec2 back = backtrace(uVel, p, uDt);
    vec2 g = (back - uOrigin) / uH - 0.5;
    ivec2 i0 = ivec2(floor(g));
    float a = cellAt(uPhi, i0), b = cellAt(uPhi, i0 + ivec2(1, 0));
    float cc = cellAt(uPhi, i0 + ivec2(0, 1)), d = cellAt(uPhi, i0 + ivec2(1, 1));
    float lo = min(min(a, b), min(cc, d)), hi = max(max(a, b), max(cc, d));
    float tilde = sampleCell(uHat, backtrace(uVel, p, -uDt));
    float value = texelFetch(uHat, c, 0).x + 0.5 * (texelFetch(uPhi, c, 0).x - tilde);
    o = vec4(clamp(value, lo, hi));
}`;

// Реинициализация φ к функции расстояния (Sussman, схема Годунова). Ячейки, через
// которые проходит граница воды, не трогаем: их значения задаёт только перенос.
// Так реинициализация не сдвигает границу — иначе (поправка Russo–Smereka и др.)
// мельчайший зигзаг поверхности через скачок давления превращался в течение и
// раскачивал воду сам собой.
export const FS_REINIT = `${COMMON}
${NEIGHBOR}
uniform sampler2D uPhi;
uniform sampler2D uPhi0;
uniform sampler2D uGeo;
uniform float uDtau;
float sq(float x) { return x * x; }
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float phi = cellAt(uPhi, c);
    if (texelFetch(uGeo, c, 0).z <= 0.0) { o = vec4(phi); return; }

    float p0 = cellAt(uPhi0, c);
    float p0L = neighbor(uPhi0, uGeo, c, ivec2(-1, 0), p0), p0R = neighbor(uPhi0, uGeo, c, ivec2(1, 0), p0);
    float p0B = neighbor(uPhi0, uGeo, c, ivec2(0, -1), p0), p0T = neighbor(uPhi0, uGeo, c, ivec2(0, 1), p0);
    float s = p0 > 0.0 ? 1.0 : (p0 < 0.0 ? -1.0 : 0.0);

    if (p0 * p0L <= 0.0 || p0 * p0R <= 0.0 || p0 * p0B <= 0.0 || p0 * p0T <= 0.0) {
        o = vec4(p0);
        return;
    }

    float pL = neighbor(uPhi, uGeo, c, ivec2(-1, 0), phi), pR = neighbor(uPhi, uGeo, c, ivec2(1, 0), phi);
    float pB = neighbor(uPhi, uGeo, c, ivec2(0, -1), phi), pT = neighbor(uPhi, uGeo, c, ivec2(0, 1), phi);
    float a = (phi - pL) / uH, b = (pR - phi) / uH, cc = (phi - pB) / uH, d = (pT - phi) / uH;
    float G;
    if (p0 > 0.0)
        G = sqrt(max(sq(max(a, 0.0)), sq(min(b, 0.0))) + max(sq(max(cc, 0.0)), sq(min(d, 0.0))));
    else
        G = sqrt(max(sq(min(a, 0.0)), sq(max(b, 0.0))) + max(sq(min(cc, 0.0)), sq(max(d, 0.0))));
    o = vec4(phi - uDtau * s * (G - 1.0));
}`;

// Объём воды по столбцам: .x — объём (в площадях ячеек), .y — dV/dδ при сдвиге φ на −δ.
export const FS_VOLUME_COLUMNS = `${COMMON}
uniform sampler2D uPhi;
uniform sampler2D uGeo;
void main() {
    int i = int(gl_FragCoord.x);
    float volume = 0.0, band = 0.0;
    for (int j = 0; j < 4096; j++) {
        if (j >= uN.y) break;
        ivec2 c = ivec2(i, j);
        float area = texelFetch(uGeo, c, 0).z;
        float phi = texelFetch(uPhi, c, 0).x;
        volume += area * clamp(0.5 - phi / uH, 0.0, 1.0);
        band += area * step(abs(phi), 0.5 * uH);
    }
    o = vec4(volume, band / uH, 0.0, 0.0);
}`;

export const FS_VOLUME_TOTAL = `${COMMON}
uniform sampler2D uColumns;
void main() {
    vec2 s = vec2(0.0);
    for (int i = 0; i < 8192; i++) {
        if (i >= uN.x) break;
        s += texelFetch(uColumns, ivec2(i, 0), 0).xy;
    }
    o = vec4(s, 0.0, 0.0);
}`;

// Точное соблюдение объёма воды: сдвигаем φ так, чтобы объём совпал с целевым.
// В крайних случаях (колба полная/пустая) φ становится плоской «виртуальной»
// поверхностью над потолком/под дном — тогда слив начнётся сверху, а налив снизу.
export const FS_VOLUME_CORRECT = `${COMMON}
uniform sampler2D uPhi;
uniform sampler2D uSum;
uniform float uTargetVolume;
uniform float uTotalVolume;
uniform vec2 uUp;
uniform vec2 uLevels;   // (низ, верх) полости вдоль uUp
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float phi = texelFetch(uPhi, c, 0).x;
    float height = dot(cellCenter(c), uUp);
    float fill = uTargetVolume / uTotalVolume;
    // Ровно плоскость, а не min/max с прежним полем: в полной (пустой) колбе
    // границы нет, и реинициализация ничем не держит φ — у скруглённых углов оно
    // уходило в глубокий минус. Потом при сливе там оставалась «вода», прилипшая
    // к потолку, и сама себя поддерживала через продолжение φ в стекло.
    if (fill >= 0.9995) { o = vec4(height - (uLevels.y + uH)); return; }
    if (fill <= 0.0005) { o = vec4(height - (uLevels.x - uH)); return; }
    vec2 s = texelFetch(uSum, ivec2(0), 0).xy;
    float delta = clamp((uTargetVolume - s.x) / max(s.y, 1e-4), -0.5 * uH, 0.5 * uH);
    o = vec4(phi - delta);
}`;

// Коэффициенты уравнения давления на гранях по методу «призрачной жидкости»:
//   o  = (w·β_x, w·β_y, β_x, β_y),  β = 1/(θρв + (1−θ)ρвозд), θ — доля воды на
//        отрезке между центрами ячеек, w — открытая доля грани;
//   o1 = (J_x, J_y) — скачок давления на грани: J = (ρв − ρвозд)·Φ(xΓ)·(вода₊ − вода₋),
//        где xΓ — точка пересечения границы с этим отрезком.
export const FS_BETA = `${COMMON}
uniform sampler2D uPhi;
uniform sampler2D uGeo;
uniform float uRhoAir;
uniform vec2 uAccel;    // g' − A' в системе колбы
uniform float uOmega;
layout(location = 1) out vec4 o1;

float potential(vec2 x) { return -dot(uAccel, x) - 0.5 * uOmega * uOmega * dot(x, x); }

// .x — β, .y — скачок J для грани между ячейками a (минус) и b (плюс).
vec2 face(ivec2 a, ivec2 b) {
    float pa = texelFetch(uPhi, a, 0).x, pb = texelFetch(uPhi, b, 0).x;
    float water = (max(-pa, 0.0) + max(-pb, 0.0)) / (abs(pa) + abs(pb) + 1e-12);
    float jump = 0.0;
    if ((pa < 0.0) != (pb < 0.0)) {
        float t = pa / (pa - pb);
        vec2 xg = mix(cellCenter(a), cellCenter(b), t);
        jump = (1.0 - uRhoAir) * potential(xg) * ((pb < 0.0 ? 1.0 : 0.0) - (pa < 0.0 ? 1.0 : 0.0));
    }
    return vec2(1.0 / mix(uRhoAir, 1.0, water), jump);
}

void main() {
    ivec2 f = ivec2(gl_FragCoord.xy);
    vec4 geo = texelFetch(uGeo, f, 0);
    vec2 fu = vec2(0.0), fv = vec2(0.0);
    if (geo.x > 0.0) fu = face(f - ivec2(1, 0), f);
    if (geo.y > 0.0) fv = face(f - ivec2(0, 1), f);
    o = vec4(geo.x * fu.x, geo.y * fv.x, fu.x, fv.x);
    o1 = vec4(fu.y, fv.y, 0.0, 0.0);
}`;

// Правая часть: (h/dt)·Σ w·u·n по граням ячейки плюс вклад скачков давления
//   c_R·J_R − c_L·J_L + c_T·J_T − c_B·J_B.
export const FS_DIVERGENCE = `${COMMON}
uniform sampler2D uVel;
uniform sampler2D uGeo;
uniform sampler2D uBeta;
uniform sampler2D uJump;
uniform float uDt;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    ivec2 r = c + ivec2(1, 0), t = c + ivec2(0, 1);
    float flux = texelFetch(uGeo, r, 0).x * texelFetch(uVel, r, 0).x
               - texelFetch(uGeo, c, 0).x * texelFetch(uVel, c, 0).x
               + texelFetch(uGeo, t, 0).y * texelFetch(uVel, t, 0).y
               - texelFetch(uGeo, c, 0).y * texelFetch(uVel, c, 0).y;
    float jumps = texelFetch(uBeta, r, 0).x * texelFetch(uJump, r, 0).x
                - texelFetch(uBeta, c, 0).x * texelFetch(uJump, c, 0).x
                + texelFetch(uBeta, t, 0).y * texelFetch(uJump, t, 0).y
                - texelFetch(uBeta, c, 0).y * texelFetch(uJump, c, 0).y;
    o = vec4(flux * uH / uDt + jumps);
}`;

// Красно-чёрный Гаусс–Зейдель с верхней релаксацией для Σ c·(p_nb − p) = rhs.
export const FS_PRESSURE = `${COMMON}
uniform sampler2D uP;
uniform sampler2D uBeta;
uniform sampler2D uRhs;
uniform int uParity;
uniform float uSor;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float p = texelFetch(uP, c, 0).x;
    if (((c.x + c.y) & 1) != uParity) { o = vec4(p); return; }
    float cL = texelFetch(uBeta, c, 0).x;
    float cR = texelFetch(uBeta, c + ivec2(1, 0), 0).x;
    float cB = texelFetch(uBeta, c, 0).y;
    float cT = texelFetch(uBeta, c + ivec2(0, 1), 0).y;
    float diag = cL + cR + cB + cT;
    // Ячейка почти целиком в стекле (обрезок у скруглённой стенки) — считаем твёрдой:
    // деление на крошечную диагональ раскачивало давление до бесконечности.
    if (diag < 1e-3) { o = vec4(0.0); return; }
    float sum = cL * cellAt(uP, c - ivec2(1, 0)) + cR * cellAt(uP, c + ivec2(1, 0))
              + cB * cellAt(uP, c - ivec2(0, 1)) + cT * cellAt(uP, c + ivec2(0, 1));
    // Крошечная добавка к диагонали делает задачу Неймана невырожденной.
    float gs = (sum - texelFetch(uRhs, c, 0).x) / (diag * (1.0 + 1e-6));
    o = vec4(mix(p, gs, uSor));
}`;

export const FS_PROJECT = `${COMMON}
uniform sampler2D uVel;
uniform sampler2D uP;
uniform sampler2D uBeta;
uniform sampler2D uJump;
uniform sampler2D uGeo;
uniform float uDt;
void main() {
    ivec2 f = ivec2(gl_FragCoord.xy);
    vec2 vel = texelFetch(uVel, f, 0).xy;
    vec4 geo = texelFetch(uGeo, f, 0);
    vec4 b = texelFetch(uBeta, f, 0);
    vec2 jump = texelFetch(uJump, f, 0).xy;
    float u = 0.0, v = 0.0;
    if (geo.x > 0.0) u = vel.x - uDt / uH * b.z * (texelFetch(uP, f, 0).x - texelFetch(uP, f - ivec2(1, 0), 0).x - jump.x);
    if (geo.y > 0.0) v = vel.y - uDt / uH * b.w * (texelFetch(uP, f, 0).x - texelFetch(uP, f - ivec2(0, 1), 0).x - jump.y);
    o = vec4(u, v, 0.0, 1.0);
}`;

// Копия φ в R16F с линейной фильтрацией — для отрисовки.
export const FS_COPY_PHI = `${COMMON}
uniform sampler2D uPhi;
void main() {
    o = vec4(texelFetch(uPhi, ivec2(gl_FragCoord.xy), 0).x);
}`;

// Плоская поверхность воды: φ = высота над уровнем вдоль «вверх».
export const FS_PLANAR_PHI = `${COMMON}
uniform vec2 uUp;
uniform float uLevel;
void main() {
    o = vec4(dot(cellCenter(ivec2(gl_FragCoord.xy)), uUp) - uLevel);
}`;

// ---------- Многосеточный решатель давления (V-цикл) ----------
// Уравнение на уровне ℓ: Σ c·(p_nb − p) = rhs, с той же раскладкой коэффициентов,
// что и FS_BETA (.x — грани по x, .y — грани по y). Размер уровня — в uN.

// Коэффициенты грубого уровня: среднее двух мелких граней, составляющих грубую.
// (Гармоническое сложение вдоль нормали пробовали: у скруглённых стенок оно делает
// грубую поправку несогласованной, и V-цикл сходится хуже.)
export const FS_MG_COARSEN = `${COMMON}
uniform sampler2D uFine;
uniform ivec2 uFineN;
float fineX(ivec2 f) { return (f.x <= uFineN.x && f.y < uFineN.y) ? texelFetch(uFine, f, 0).x : 0.0; }
float fineY(ivec2 f) { return (f.x < uFineN.x && f.y <= uFineN.y) ? texelFetch(uFine, f, 0).y : 0.0; }
void main() {
    ivec2 F = ivec2(gl_FragCoord.xy);
    float cx = 0.0, cy = 0.0;
    if (F.y < uN.y && F.x > 0 && F.x < uN.x) cx = 0.5 * (fineX(ivec2(2 * F.x, 2 * F.y)) + fineX(ivec2(2 * F.x, 2 * F.y + 1)));
    if (F.x < uN.x && F.y > 0 && F.y < uN.y) cy = 0.5 * (fineY(ivec2(2 * F.x, 2 * F.y)) + fineY(ivec2(2 * F.x + 1, 2 * F.y)));
    o = vec4(cx, cy, 0.0, 0.0);
}`;

export const FS_MG_RESIDUAL = `${COMMON}
uniform sampler2D uP;
uniform sampler2D uCoef;
uniform sampler2D uRhs;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float p = texelFetch(uP, c, 0).x;
    float cL = texelFetch(uCoef, c, 0).x, cR = texelFetch(uCoef, c + ivec2(1, 0), 0).x;
    float cB = texelFetch(uCoef, c, 0).y, cT = texelFetch(uCoef, c + ivec2(0, 1), 0).y;
    float ap = cL * (cellAt(uP, c - ivec2(1, 0)) - p) + cR * (cellAt(uP, c + ivec2(1, 0)) - p)
             + cB * (cellAt(uP, c - ivec2(0, 1)) - p) + cT * (cellAt(uP, c + ivec2(0, 1)) - p);
    o = vec4(texelFetch(uRhs, c, 0).x - ap);
}`;

// Невязка на грубый уровень: сумма четырёх дочерних ячеек (оператор масштабирован на h²).
export const FS_MG_RESTRICT = `${COMMON}
uniform sampler2D uFineRes;
uniform ivec2 uFineN;
float fine(ivec2 c) { return (c.x < uFineN.x && c.y < uFineN.y) ? texelFetch(uFineRes, c, 0).x : 0.0; }
void main() {
    ivec2 C = ivec2(gl_FragCoord.xy) * 2;
    o = vec4(fine(C) + fine(C + ivec2(1, 0)) + fine(C + ivec2(0, 1)) + fine(C + ivec2(1, 1)));
}`;

// Поправка с грубого уровня: билинейная интерполяция в центры мелких ячеек.
export const FS_MG_PROLONG = `${COMMON}
uniform sampler2D uP;        // мелкий уровень
uniform sampler2D uCoarse;   // поправка на грубом уровне
uniform ivec2 uCoarseN;
uniform sampler2D uCoef;     // коэффициенты мелкого уровня (ячейки без открытых граней не трогаем)
float coarse(ivec2 c) { return texelFetch(uCoarse, clamp(c, ivec2(0), uCoarseN - 1), 0).x; }
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    float p = texelFetch(uP, c, 0).x;
    float diag = texelFetch(uCoef, c, 0).x + texelFetch(uCoef, c + ivec2(1, 0), 0).x
               + texelFetch(uCoef, c, 0).y + texelFetch(uCoef, c + ivec2(0, 1), 0).y;
    if (diag < 1e-3) { o = vec4(0.0); return; }
    vec2 g = (vec2(c) + 0.5) * 0.5 - 0.5;
    vec2 g0 = floor(g);
    vec2 f = g - g0;
    ivec2 i0 = ivec2(g0);
    float e = mix(mix(coarse(i0), coarse(i0 + ivec2(1, 0)), f.x), mix(coarse(i0 + ivec2(0, 1)), coarse(i0 + ivec2(1, 1)), f.x), f.y);
    o = vec4(p + e);
}`;

export const FS_CLEAR = `${COMMON}
void main() { o = vec4(0.0); }`;
