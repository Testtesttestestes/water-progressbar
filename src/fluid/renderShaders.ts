// Шейдеры отрисовки: стеклянная колба, вода, поверхность, каустики, пузырьки, блики.
//
// Модель стекла: колба — «таблетка» с плоскими передней и задней стенками и
// скруглёнными рёбрами. В середине фон виден почти без искажений, а в полосе
// скругления у контура поверхность стекла наклоняется, и фон сильно преломляется.
// Вода в колбе такого размера почти бесцветна: её выдают преломление, полоса
// поверхности (видна почти с ребра), мениск у стекла, каустики и пузырьки.

export const RENDER_COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uResolution;      // размер холста в пикселях
uniform vec2 uViewCenter;      // центр кадра в мировых координатах
uniform float uViewHeight;     // высота кадра в мировых единицах
uniform vec2 uFlaskPos;        // центр колбы
uniform float uFlaskAngle;     // поворот колбы (против часовой)
uniform vec2 uFlaskHalf;       // полуразмеры по внешнему стеклу
uniform float uFlaskRadius;    // радиус скругления углов
uniform float uGlass;          // толщина стекла
uniform float uBevel;          // ширина полосы скругления рёбер
uniform sampler2D uBg;
uniform vec2 uBgScale;         // «cover»: масштаб UV фона
uniform float uTime;

// Сетка решателя (для выборки level set воды).
uniform ivec2 uN;
uniform float uH;
uniform vec2 uOrigin;
uniform sampler2D uPhi;

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

vec2 worldToLocal(vec2 w) { return rot(-uFlaskAngle) * (w - uFlaskPos); }
vec2 localToWorldDir(vec2 d) { return rot(uFlaskAngle) * d; }

float aspect() { return uResolution.x / uResolution.y; }
vec2 screenToWorld(vec2 uv) { return uViewCenter + (uv - 0.5) * vec2(uViewHeight * aspect(), uViewHeight); }
vec2 worldToScreen(vec2 w) { return (w - uViewCenter) / vec2(uViewHeight * aspect(), uViewHeight) + 0.5; }
vec2 worldOffsetToUV(vec2 d) { return d / vec2(uViewHeight * aspect(), uViewHeight); }
float pixelWorld() { return uViewHeight / uResolution.y; }

vec3 background(vec2 uv) {
    vec2 bgUV = (uv - 0.5) * uBgScale + 0.5;
    return texture(uBg, clamp(bgUV, vec2(0.002), vec2(0.998))).rgb;
}

// Размытый фон (для отражений и матовых участков).
vec3 backgroundBlur(vec2 uv, float radius) {
    vec3 s = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398 + 0.3;
        s += background(uv + vec2(cos(a), sin(a)) * radius);
    }
    return s / 8.0;
}

// Внешний контур колбы в системе колбы.
float flaskSd(vec2 local) { return sdRoundedBox(local, uFlaskHalf, uFlaskRadius); }
vec2 flaskNormal(vec2 local) {
    vec2 e = vec2(0.004, 0.0);
    return normalize(vec2(flaskSd(local + e.xy) - flaskSd(local - e.xy), flaskSd(local + e.yx) - flaskSd(local - e.yx)));
}

// Level set воды (вода < 0) в мировых единицах, по системе колбы.
float waterPhi(vec2 local) {
    vec2 uv = (local - uOrigin) / (vec2(uN) * uH);
    return texture(uPhi, uv).x;
}
vec2 waterNormal(vec2 local) {
    float e = 1.2 * uH;
    vec2 g = vec2(waterPhi(local + vec2(e, 0.0)) - waterPhi(local - vec2(e, 0.0)),
                  waterPhi(local + vec2(0.0, e)) - waterPhi(local - vec2(0.0, e)));
    float l = length(g);
    return l > 1e-6 ? g / l : vec2(0.0, 1.0);
}

// Гладкий шум для каустик.
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

// Тонкая линия на уровне d = center (мировые единицы), ширина width, сглаживание по пикселю.
float line(float d, float center, float width) {
    float pw = pixelWorld();
    float w = max(width, 0.8 * pw);
    return 1.0 - smoothstep(0.5 * w, 0.5 * w + pw, abs(d - center));
}
`;

export const VS_FULLSCREEN_RENDER = `#version 300 es
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Основной проход: фон, стекло, вода, поверхность, каустики.
export const FS_SCENE = `${RENDER_COMMON}
uniform vec2 uUp;          // «вверх» в системе колбы (против эффективной тяжести)
out vec4 outColor;

void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 world = screenToWorld(uv);
    vec2 local = worldToLocal(world);
    float pw = pixelWorld();

    float sdO = flaskSd(local);            // внешнее стекло
    float sdI = sdO + uGlass;              // полость
    vec3 outside = background(uv);
    if (sdO > 2.0 * pw) { outColor = vec4(outside, 1.0); return; }

    vec2 nL = flaskNormal(local);          // внешняя нормаль контура (система колбы)
    vec2 nW = localToWorldDir(nL);         // она же в мире
    float depthIn = max(-sdO, 0.0);        // расстояние внутрь от контура
    // Наклон поверхности стекла в полосе скругления рёбер: 1 у контура, 0 в глубине.
    float slope = clamp(1.0 - depthIn / uBevel, 0.0, 1.0);
    float slope2 = slope * slope;
    float bottomness = smoothstep(0.2, -0.8, nL.y);
    float endness = smoothstep(0.55, 0.95, abs(nL.x));

    // ---------- вода ----------
    float phi = waterPhi(local);
    // Мениск: у торцов вода чуть приподнимается вдоль стекла (смачивание).
    float wallDist = max(-sdI, 0.0);
    float acrossUp = abs(nL.x * uUp.y - nL.y * uUp.x);
    phi -= 0.08 * exp(-wallDist / 0.07) * acrossUp;
    float aa = max(fwidth(phi), pw);
    float water = (1.0 - smoothstep(-aa, aa, phi)) * step(sdI, 0.0);
    vec2 nWater = waterNormal(local);
    float facing = dot(nWater, uUp);
    float upward = smoothstep(0.15, 0.7, facing);

    // ---------- преломление ----------
    // Полоса скругления сдвигает фон вдоль нормали; с водой внутри линза сильнее.
    float lens = 0.16 * slope2 * (1.0 + 0.9 * water);
    vec2 refr = nW * lens;
    // У поверхности воды фон изгибается по её нормали (вода — тонкая линза).
    float nearSurface = 1.0 - smoothstep(0.0, 0.25, abs(phi));
    refr += localToWorldDir(nWater) * 0.05 * nearSurface * water;
    vec2 ruv = uv + worldOffsetToUV(refr);
    vec2 disp = worldOffsetToUV(nW) * 0.014 * slope2;
    vec3 seen = vec3(background(ruv - disp).r, background(ruv).g, background(ruv + disp).b);
    // Сквозь толстое стекло на скосе фон чуть размыт.
    seen = mix(seen, backgroundBlur(ruv, 0.004), 0.55 * slope2);

    vec3 col = seen;
    // Внутренние отражения стекла слегка высветляют всё, что видно сквозь колбу.
    col = mix(col, vec3(1.0), 0.06);
    // Воздух чуть «дымнее», вода — чище и холоднее.
    col = mix(col, vec3(1.0), 0.03 * (1.0 - water));
    col = mix(col, col * vec3(0.96, 1.0, 1.03) + vec3(0.012, 0.02, 0.026), water);
    float deep = 1.0 - exp(-max(-phi, 0.0) * 0.45);
    col = mix(col, vec3(0.84, 0.94, 0.95), 0.15 * deep * water);

    // ---------- каустики ----------
    // Свет, преломлённый волнистой поверхностью, ложится на заднюю стенку длинными
    // плавными нитями — от поверхности вниз, с разрывами.
    if (water > 0.0) {
        float t = uTime * 0.22;
        // Нити идут наискосок (сверху справа вниз налево) и слегка вьются.
        vec2 q = vec2(0.87 * local.x - 0.5 * local.y, 0.5 * local.x + 0.87 * local.y);
        // Шаг между нитями «плавает» (крупный шум), поэтому они не выглядят полосками.
        float f = q.x * 1.1 + 0.45 * sin(0.8 * q.y + 0.5 * q.x + t)
                + 0.18 * sin(1.9 * q.y - 0.8 * q.x - 0.7 * t)
                + 0.9 * (noise(q * vec2(0.3, 0.45) + vec2(0.25 * t, -0.2 * t)) - 0.5);
        float g = abs(fract(f) - 0.5);
        float w = fwidth(f);
        float filament = 1.0 - smoothstep(0.55 * w, 1.6 * w, 0.5 - g);
        float depth = max(-phi, 0.0);
        float along = 0.35 + 0.65 * smoothstep(0.2, 0.6, noise(q * vec2(0.35, 0.9) + vec2(t * 0.3, 3.0)));
        float fade = mix(0.3, 1.0, exp(-depth * 0.7)) * along;
        col += vec3(0.82, 0.93, 1.0) * filament * fade * 0.24 * water;
    }

    // ---------- полоса поверхности ----------
    // Поверхность видна почти с ребра: задний и передний мениски, полное внутреннее
    // отражение и тёмная кромка дают несколько параллельных линий. На склонах
    // волн полоса шире (поверхность повёрнута к нам сильнее).
    float band = upward * step(sdI, 0.0);
    float spread = 1.0 + 1.8 * (1.0 - clamp(facing, 0.0, 1.0));
    col = mix(col, vec3(1.0), 0.07 * band * (1.0 - smoothstep(-0.1 * spread, -0.02, phi)) * step(phi, 0.0));
    col = mix(col, vec3(1.0), 0.8 * band * line(phi, 0.010 * spread, 0.012));
    col = mix(col, vec3(0.93, 0.98, 1.0), 0.62 * band * line(phi, -0.012 * spread, 0.016));
    col = mix(col, vec3(0.7, 0.88, 0.97), 0.38 * band * line(phi, -0.033 * spread, 0.009));
    float darkGaps = smoothstep(0.35, 0.65, noise(vec2(local.x * 1.3 + uTime * 0.05, 7.0)));
    col *= 1.0 - (0.15 + 0.45 * darkGaps) * band * line(phi, -0.056 * spread, 0.016);
    col = mix(col, vec3(1.0), 0.28 * band * line(phi, -0.085 * spread, 0.012));
    // Нижние стороны (капли, пузыри, перехлёст волны) — одна светлая кромка.
    float under = (1.0 - upward) * step(sdI, 0.0);
    col = mix(col, vec3(0.95, 0.98, 1.0), 0.5 * under * line(phi, -0.008, 0.012));

    // ---------- стекло ----------
    // Стенка между внешним и внутренним контуром: светлая полупрозрачная кайма.
    if (sdI > 0.0) {
        float across = clamp(sdI / uGlass, 0.0, 1.0);
        vec3 wall = backgroundBlur(uv + worldOffsetToUV(nW * 0.08), 0.003);
        col = mix(wall, vec3(0.95, 0.97, 0.97), 0.12 + 0.12 * across);
    }
    // Мягкое светлое свечение вдоль внешнего контура (толща стекла под углом).
    col = mix(col, vec3(0.98), 0.22 * exp(-depthIn / 0.035));
    // Скос рёбер: светлая полоса (снизу и у торцов шире) и лёгкое отражение комнаты.
    float rim = slope2 * (0.35 + 0.65 * max(bottomness, endness));
    col = mix(col, vec3(0.97, 0.98, 0.98), 0.2 * rim);
    vec3 env = backgroundBlur(vec2(uv.x, 1.0 - uv.y) + worldOffsetToUV(nW * 0.3), 0.02);
    col = mix(col, env * 1.1 + 0.05, (0.03 + 0.25 * pow(slope, 3.0)) * 0.5);
    // Бирюзовый оттенок толстого стекла на скосе (особенно снизу).
    col *= mix(vec3(1.0), vec3(0.9, 1.0, 0.98), slope2 * (0.3 + 0.7 * bottomness));

    // Сглаживание внешнего края.
    float edge = smoothstep(-pw, pw, sdO);
    outColor = vec4(mix(col, outside, edge), 1.0);
}`;

// Блики стекла поверх всего (аддитивно).
export const FS_HIGHLIGHTS = `${RENDER_COMMON}
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 local = worldToLocal(screenToWorld(uv));
    float pw = pixelWorld();
    float sdO = flaskSd(local);
    if (sdO > 2.0 * pw) { outColor = vec4(0.0); return; }
    float sdI = sdO + uGlass;
    vec2 nL = flaskNormal(local);
    vec2 hb = uFlaskHalf;
    float straight = 1.0 - smoothstep(hb.x - uFlaskRadius * 1.1, hb.x - uFlaskRadius * 0.15, abs(local.x));
    float topSide = smoothstep(0.3, 0.9, nL.y);
    float bottomSide = smoothstep(0.3, 0.9, -nL.y);

    float light = 0.0;
    // Контуры: внешний ярче сверху, внутренний тоньше.
    light += line(sdO, -0.6 * pw, 0.7 * pw) * (0.25 + 0.3 * topSide + 0.12 * bottomSide);
    light += line(sdI, 0.0, 0.7 * pw) * (0.1 + 0.15 * topSide);
    // Длинный блик под верхним краем (отражение светильника) и его ореол.
    float yTop = hb.y - uGlass - uBevel * 0.42;
    light += line(local.y, yTop, 0.03) * straight * 1.0;
    light += exp(-pow((local.y - yTop) / 0.06, 2.0)) * straight * 0.2;
    // Светлые линии у дна.
    light += line(local.y, -hb.y + uGlass + 0.04, 0.012) * straight * 0.35;
    light += line(local.y, -hb.y + uGlass + 0.11, 0.008) * straight * 0.15;
    // Вертикальные блики в торцах (отражение окна).
    float xEnd = hb.x - uFlaskRadius * 0.55;
    float vertical = smoothstep(-hb.y * 0.6, -hb.y * 0.15, local.y) * (1.0 - smoothstep(hb.y * 0.2, hb.y * 0.6, local.y));
    light += exp(-pow((local.x - xEnd) / 0.07, 2.0)) * vertical * 0.34 * step(sdI, 0.0);
    light += exp(-pow((local.x - xEnd - 0.1) / 0.02, 2.0)) * vertical * 0.2 * step(sdI, 0.0);
    light += exp(-pow((local.x + xEnd) / 0.06, 2.0)) * vertical * 0.24 * step(sdI, 0.0);
    light += exp(-pow((local.x + xEnd + 0.09) / 0.018, 2.0)) * vertical * 0.16 * step(sdI, 0.0);
    // Блик на верхнем левом скруглении.
    vec2 corner = vec2(-hb.x + uFlaskRadius, hb.y - uFlaskRadius);
    vec2 dc = local - corner;
    float ang = atan(dc.y, dc.x);
    float arc = smoothstep(1.75, 2.1, ang) * (1.0 - smoothstep(2.6, 2.9, ang)) * step(local.x, corner.x) * step(corner.y, local.y);
    light += line(sdO, -0.035, 0.016) * arc * 0.6;

    light *= 1.0 - smoothstep(-pw, pw, sdO);
    outColor = vec4(vec3(1.0, 0.99, 0.96) * light, 0.0);
}`;

// Пузырьки: экземпляры квадратов по текстуре состояния (32 в строке).
export const VS_BUBBLES = `${RENDER_COMMON}
uniform sampler2D uBubbles;
out vec2 vQ;
out float vAlpha;
out float vRadiusPx;
void main() {
    ivec2 id = ivec2(gl_InstanceID % 32, gl_InstanceID / 32);
    vec4 A = texelFetch(uBubbles, id, 0);
    vec2 corner = vec2(gl_VertexID & 1, (gl_VertexID >> 1) & 1) * 2.0 - 1.0;
    float visible = (A.w > 0.5 && A.z > 0.0) ? 1.0 : 0.0;
    // Прилипшие к стеклу видны, только когда их покрывает вода.
    if (A.w > 1.5 && A.w < 2.5) visible *= 1.0 - smoothstep(-2.5 * A.z, -0.5 * A.z, waterPhi(A.xy));
    float radius = max(A.z, 1.1 * pixelWorld());
    vec2 local = A.xy + corner * radius * 1.3;
    vec2 world = uFlaskPos + rot(uFlaskAngle) * local;
    vec2 s = worldToScreen(world);
    gl_Position = visible > 0.001 ? vec4(s * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    vQ = corner * 1.3;
    vAlpha = visible;
    vRadiusPx = radius / pixelWorld();
}`;

export const FS_BUBBLES = `#version 300 es
precision highp float;
in vec2 vQ;
in float vAlpha;
in float vRadiusPx;
out vec4 outColor;
void main() {
    float d = length(vQ);
    float aa = 1.2 / max(vRadiusPx, 1.0);
    float mask = 1.0 - smoothstep(1.0 - aa, 1.0, d);
    if (mask <= 0.0) discard;
    // Край воздушной сферы в воде — полное внутреннее отражение: тёмный ободок.
    float rim = smoothstep(0.45, 0.9, d);
    vec2 hlPos = vQ - vec2(-0.3, 0.34);
    float highlight = exp(-dot(hlPos, hlPos) / 0.06);
    float crescent = smoothstep(0.55, 0.9, d) * smoothstep(0.1, 0.7, dot(vQ / max(d, 1e-4), vec2(0.55, -0.83)));
    vec3 col = mix(vec3(0.88, 0.92, 0.95), vec3(0.16, 0.18, 0.2), rim);
    float a = mask * (0.12 + 0.72 * rim) * vAlpha;
    vec3 light = vec3(1.0) * (0.95 * highlight + 0.3 * crescent) * mask * vAlpha;
    outColor = vec4(col * a + light, a);
}`;

// Сглаживание поля воды перед отрисовкой (разделимый Гаусс по сетке решателя).
// Рябь размером в ячейку физически не держится: поверхностное натяжение гасит
// волны короче пары сантиметров, а ячейка здесь — около 2–3 мм.
export const FS_BLUR_PHI = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform float uSigma;
out vec4 outColor;
void main() {
    ivec2 size = textureSize(uSrc, 0);
    ivec2 c = ivec2(gl_FragCoord.xy);
    float sum = 0.0, wsum = 0.0;
    for (int i = -6; i <= 6; i++) {
        float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
        sum += w * texelFetch(uSrc, clamp(c + uDir * i, ivec2(0), size - 1), 0).x;
        wsum += w;
    }
    outColor = vec4(sum / wsum);
}`;
