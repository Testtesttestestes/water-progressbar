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

// Фон: 0 — текстура; 1 — ровный цвет uBgColor (прозрачный режим: сцену рисуем
// дважды, на чёрном и на белом, и восстанавливаем цвет и непрозрачность).
uniform int uBgMode;
uniform vec3 uBgColor;
vec3 background(vec2 uv) {
    if (uBgMode == 1) return uBgColor;
    vec2 bgUV = (uv - 0.5) * uBgScale + 0.5;
    return texture(uBg, clamp(bgUV, vec2(0.002), vec2(0.998))).rgb;
}
// Окружение для отражений. Без фона — мягкая «студия»: светлый верх, тёплый
// тёмный низ. Отражение не должно зависеть от uBgColor, иначе оно стало бы прозрачностью.
vec3 environment(vec2 uv) {
    if (uBgMode == 0) return background(uv);
    float t = clamp(uv.y, 0.0, 1.0);
    return mix(vec3(0.34, 0.32, 0.30), vec3(0.92, 0.93, 0.94), smoothstep(0.15, 0.85, t));
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


// Каустики (caustics.ts): яркость света на задней стенке в координатах
// (u — вдоль поверхности, d — глубина под ней); 1 — ровный свет.
uniform sampler2D uCaustics;
uniform vec2 uCausticSize;   // (полудлина по u, глубина приёмника)
uniform sampler2D uSurfaceProfile;   // RGBA32F, CAUSTIC_W×1: высота поверхности вдоль u, граница?, столбец в воде?
// Глубина под поверхностью по профилю: φ — точное расстояние лишь у границы,
// глубже оно ступенчатое, и каустики по нему шли бы полосами.
float depthBelowSurface(vec2 local, vec2 side, float phi) {
    int w = textureSize(uSurfaceProfile, 0).x;
    float t = clamp(dot(local, side) / uCausticSize.x * 0.5 + 0.5, 0.0, 1.0) * float(w - 1);
    int i = int(floor(t));
    vec3 a = texelFetch(uSurfaceProfile, ivec2(i, 0), 0).xyz;
    vec3 b = texelFetch(uSurfaceProfile, ivec2(min(i + 1, w - 1), 0), 0).xyz;
    vec3 s = mix(a, b, t - float(i));
    float fromProfile = s.x - dot(local, vec2(-side.y, side.x));
    // У самой поверхности (волны, брызги) — φ, глубже — профиль.
    float k = clamp(s.y + s.z, 0.0, 1.0) * smoothstep(0.05, 0.3, -phi);
    return max(mix(-phi, fromProfile, k), 0.0);
}
float causticAt(vec2 ud) {
    // Строка 0 текстуры — самая глубокая (сетка каустик пишет глубину 0 в верх кадра).
    vec2 t = vec2(ud.x / uCausticSize.x * 0.5 + 0.5, 1.0 - ud.y / uCausticSize.y);
    if (t.y < 0.0) return 1.0;
    // Источник света не точка (окно, небо): яркие фокусы мягко насыщаются,
    // а тени не бывают совсем чёрными — их подсвечивает рассеянный свет комнаты.
    float c = texture(uCaustics, t).x;
    return 1.0 + (c >= 1.0 ? 2.0 * tanh((c - 1.0) / 2.0) : 0.6 * (c - 1.0));
}

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
    // У самого стекла нормаль воды считалась бы по ячейкам внутри стекла (там φ лишь
    // продолжено и может скачком меняться) — плавно переходим к «вверх».
    float awayFromWall = smoothstep(0.02, 0.14, wallDist);
    nWater = normalize(mix(uUp, nWater, awayFromWall));
    // Сколько воды за стеклом: тонкая плёнка (волна на мгновение взбежала по стенке)
    // почти не меняет преломление скоса — иначе оно резко удваивалось на пару кадров,
    // и у стенки появлялся вытянутый сдвинутый кусок фона.
    float waterDepth = smoothstep(0.0, 0.15, -phi) * step(sdI, 0.0);
    float facing = dot(nWater, uUp);
    float upward = smoothstep(0.15, 0.7, facing);

    // ---------- нити-складки в воде ----------
    // Тонкие складки (отражение ряби поверхности в толще) — это линзы: фон сквозь
    // них сдвигается по градиенту профиля (рама окна за нитью изгибается), а свет
    // фокусируется — светлая середина и тёмная кайма (знак кривизны профиля).
    vec2 ridgeGrad = vec2(0.0);
    float ridgeFocus = 0.0;
    if (water > 0.0) {
        vec2 side = vec2(uUp.y, -uUp.x);
        vec2 ud = vec2(dot(local, side), depthBelowSurface(local, side, phi));
        float e = 1.5 * pw;
        float c0 = causticAt(ud);
        vec2 g = vec2(causticAt(ud + vec2(e, 0.0)) - causticAt(ud - vec2(e, 0.0)),
                      causticAt(ud + vec2(0.0, e)) - causticAt(ud - vec2(0.0, e))) / (2.0 * e);
        ridgeFocus = c0 - 1.0;
        // Складка — пологая линза: резкий край тени не должен рвать фон.
        g /= max(1.0, length(g) / 25.0);
        // Градиент из (u, d) в систему колбы: d растёт вниз, против «вверх».
        ridgeGrad = g.x * side - g.y * uUp;
    }

    // ---------- преломление ----------
    // Полоса скругления сдвигает фон вдоль нормали; с водой внутри линза сильнее.
    float lens = 0.16 * slope2 * (1.0 + 0.9 * waterDepth);
    vec2 refr = nW * lens;
    // У поверхности воды фон изгибается по её нормали (вода — тонкая линза).
    float nearSurface = 1.0 - smoothstep(0.0, 0.25, abs(phi));
    refr += localToWorldDir(nWater) * 0.05 * nearSurface * water * awayFromWall;
    refr -= localToWorldDir(ridgeGrad) * 0.0008 * water;
    vec2 ruv = uv + worldOffsetToUV(refr);
    vec2 disp = worldOffsetToUV(nW) * 0.014 * slope2 + worldOffsetToUV(localToWorldDir(ridgeGrad)) * 0.00015 * water;
    vec3 seen = vec3(background(ruv - disp).r, background(ruv).g, background(ruv + disp).b);
    // Сквозь толстое стекло на скосе фон чуть размыт.
    seen = mix(seen, backgroundBlur(ruv, 0.004), 0.55 * slope2);

    vec3 col = seen;
    // Цвет: никакого подмешивания серого — оно и давало «мутность». Воздух в колбе
    // лишь чуть светлее от отражений стекла; вода — чистый светофильтр: холодное
    // пропускание, чуть больше насыщенности и контраста (вода собирает свет как линза).
    col = mix(col, vec3(1.0), 0.015 * (1.0 - water));
    vec3 graded = col * vec3(0.965, 1.0, 1.025);
    float lum = dot(graded, vec3(0.2126, 0.7152, 0.0722));
    graded = mix(vec3(lum), graded, 1.12);
    graded = (graded - 0.5) * 1.07 + 0.5 + vec3(0.004, 0.012, 0.02);
    float deep = 1.0 - exp(-max(-phi, 0.0) * 0.45);
    graded *= mix(vec3(1.0), vec3(0.93, 1.0, 1.0), deep);
    col = mix(col, clamp(graded, 0.0, 1.0), water);

    // Каустики: свет, собранный рябью, ярче; разошедшийся — чуть темнее.
    float gain = clamp(ridgeFocus, -0.6, 4.0);
    col *= 1.0 + 0.12 * min(gain, 0.0) * water;
    col += vec3(0.86, 0.95, 1.0) * 0.07 * max(gain, 0.0) * water;

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
    col = mix(col, vec3(0.98), 0.15 * exp(-depthIn / 0.035));
    // Скос рёбер: светлая полоса (снизу и у торцов шире) и лёгкое отражение комнаты.
    float rim = slope2 * (0.35 + 0.65 * max(bottomness, endness));
    col = mix(col, vec3(0.97, 0.98, 0.98), 0.1 * rim);
    vec2 envUV = vec2(uv.x, 1.0 - uv.y) + worldOffsetToUV(nW * 0.3);
    vec3 env = uBgMode == 0 ? backgroundBlur(envUV, 0.02) : environment(envUV);
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
    // Альфа — чтобы на прозрачном холсте блик оставался светом, а не «пустотой».
    outColor = vec4(vec3(1.0, 0.99, 0.96) * light, clamp(light, 0.0, 1.0));
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

// Брызги и капли (spray.ts): экземпляры квадратов, 32 в строке текстуры состояния.
// Квадрат ориентирован в мире (свет и вид — мировые), летящая капля вытянута
// по скорости: за выдержку кадра она проходит больше своего размера.
export const VS_DROPS = `${RENDER_COMMON}
uniform sampler2D uSprayA;
uniform sampler2D uSprayB;
uniform float uShutter;        // выдержка, с
out vec2 vQ;                   // координаты в капле: |q| = 1 — край
out float vKind;
out float vAlpha;
out float vRadiusPx;
out float vStretch;
out vec2 vAxis;                // направление вытяжки (мир)
out vec2 vCenterUV;
out vec2 vRadiusUV;
void main() {
    ivec2 id = ivec2(gl_InstanceID % 32, gl_InstanceID / 32);
    vec4 A = texelFetch(uSprayA, id, 0);
    vec4 B = texelFetch(uSprayB, id, 0);
    vec2 corner = vec2(gl_VertexID & 1, (gl_VertexID >> 1) & 1) * 2.0 - 1.0;
    float kind = B.y;
    float visible = kind > 0.5 ? 1.0 : 0.0;
    // Капля на стекле тает к концу срока; брызга появляется не мгновенно.
    if (kind > 1.5) visible *= 1.0 - smoothstep(0.75, 1.0, B.z / max(B.w, 1e-3));
    float radius = max(B.x, 0.9 * pixelWorld());
    vec2 vWorld = localToWorldDir(A.zw);
    float speed = length(vWorld);
    vec2 axis = speed > 1e-4 ? vWorld / speed : vec2(1.0, 0.0);
    float streak = kind < 1.5 ? speed * uShutter * 0.5 : 0.0;
    float stretch = 1.0 + streak / radius;
    // Капля на стекле под тяжестью чуть оседает: вытянута вниз (или вдоль сползания).
    if (kind > 1.5) {
        axis = speed > 1e-3 ? axis : vec2(0.0, -1.0);
        stretch = 1.0 + 0.14 * clamp(radius / 0.06, 0.0, 1.0);
    }
    vec2 center = uFlaskPos + rot(uFlaskAngle) * A.xy;
    vec2 perp = vec2(-axis.y, axis.x);
    vec2 world = center + (axis * corner.x * stretch + perp * corner.y) * radius * 1.15;
    vec2 s = worldToScreen(world);
    gl_Position = visible > 0.001 ? vec4(s * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
    // В фрагментном шейдере форма — круг в «несжатых» координатах.
    vQ = corner * 1.15 * vec2(stretch, 1.0);
    vKind = kind;
    vAlpha = visible;
    vRadiusPx = radius / pixelWorld();
    vStretch = stretch;
    vAxis = axis;
    vCenterUV = worldToScreen(center);
    vRadiusUV = worldOffsetToUV(vec2(radius));
}`;

// Капля — линза. Сквозь неё виден перевёрнутый уменьшенный вид сцены позади
// (короткофокусная линза), у края — тёмная кайма (лучи у края уходят под
// большими углами и видят тёмное окружение, плюс френелевское отражение),
// сверху-слева — зеркальный блик источника, а напротив, внутри капли — светлое
// пятно: капля фокусирует свет на стекло за собой. Капля на стекле — плоская
// шапочка (краевой угол воды на стекле ~40–60°), брызга в воздухе — шар.
export const FS_DROPS = `${RENDER_COMMON}
uniform sampler2D uSceneTex;
in vec2 vQ;
in float vKind;
in float vAlpha;
in float vRadiusPx;
in float vStretch;
in vec2 vAxis;
in vec2 vCenterUV;
in vec2 vRadiusUV;
out vec4 outColor;
void main() {
    // Вытянутая брызга: капсула вдоль оси; в её середине — сфера.
    vec2 q = vQ;
    float ext = vStretch - 1.0;
    q.x = sign(q.x) * max(abs(q.x) - ext, 0.0);
    float d = length(q);
    float aa = 1.5 / max(vRadiusPx, 1.0);
    float mask = 1.0 - smoothstep(1.0 - aa, 1.0, d);
    if (mask <= 0.0) discard;
    // В мировые оси: q.x — вдоль оси вытяжки.
    vec2 qw = vAxis * q.x + vec2(-vAxis.y, vAxis.x) * q.y;
    bool onGlass = vKind > 1.5;

    float h = sqrt(max(1.0 - d * d, 0.0));
    // Шапочка на стекле плоская: наклон поверхности у края ~ краевому углу.
    vec3 n = onGlass ? normalize(vec3(qw * 0.75, h + 0.55)) : normalize(vec3(qw, h));
    // Перевёрнутое изображение: точка сцены с противоположной стороны, шире капли.
    float invert = onGlass ? 2.2 : 3.0;
    vec2 off = -qw * vRadiusUV * invert;
    vec4 seen4 = texture(uSceneTex, vCenterUV + off) * 0.5
               + texture(uSceneTex, vCenterUV + off * 1.15) * 0.25
               + texture(uSceneTex, vCenterUV + off * 0.85) * 0.25;
    // Сцена — с предумноженной альфой. В прозрачном режиме за каплей может быть
    // «ничего» (страница под холстом): там капля пропускает страницу как есть.
    float seenA = max(seen4.a, 1e-3);
    vec3 seen = seen4.rgb / seenA;
    // Вода в капле чуть поднимает контраст изображения (собирающая линза).
    seen = (seen - 0.5) * 1.08 + 0.52;
    // Френель (n = 1.333): к краю растёт отражение окружения.
    float cosV = clamp(n.z, 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
    vec3 env = environment(vec2(vCenterUV.x, 1.0 - vCenterUV.y) + qw * 0.03) * 0.9 + 0.06;
    vec3 col = mix(seen, env, F * (onGlass ? 0.6 : 1.0));
    // Тёмная кайма: у брызги шире (шар), у капли на стекле — тонкая линия по
    // контуру, где шапочка круче всего.
    float rim = onGlass ? smoothstep(0.8, 0.99, d) : smoothstep(0.45, 0.95, d);
    float rimDark = mix(1.0, onGlass ? 0.5 : 0.3, rim);
    col *= rimDark;
    // Блик: отражение источника (свет приходит сверху-слева-спереди).
    vec3 L = normalize(vec3(-0.3, 1.0, 0.85));
    vec3 Hv = normalize(L + vec3(0.0, 0.0, 1.0));
    float nh = max(dot(n, Hv), 0.0);
    float spec = pow(nh, onGlass ? 160.0 : 220.0) * 1.6 + pow(nh, 18.0) * 0.08;
    // Свет, сфокусированный каплей, — светлый серп с противоположной стороны.
    vec2 g = qw + L.xy * 0.42;
    float focus = exp(-dot(g, g) / (onGlass ? 0.09 : 0.05)) * (onGlass ? 0.32 : 0.22);
    vec3 light = vec3(1.0, 0.99, 0.95) * (spec + focus);
    // Брызга размазана выдержкой: энергия на большей площади.
    float a = mask * vAlpha * (onGlass ? 1.0 : 1.0 / sqrt(vStretch));
    // Непрозрачность капли: изображение сцены за ней (seenA), кайма и отражение
    // видны и над пустотой. Без фона кайма — лёгкое затемнение страницы.
    float own = max(seen4.a, max(1.0 - rimDark, F * 0.6));
    float A = a * own;
    vec3 body = col * seen4.a + env * F * 0.6 * (1.0 - seen4.a) * (onGlass ? 0.6 : 1.0);
    outColor = vec4(body * a + light * a, A);
}`;

// Копия текстуры сцены на экран.
export const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

// Белая вода (whitewater.ts): частицы рисуются пятнами в карту плотности
// (R — пена, G — брызги, B — пузыри), потом карта накладывается одним проходом:
// пена из отдельных пузырьков сливается в сплошные белые пятна и полосы.
export const VS_WHITEWATER = `${RENDER_COMMON}
uniform sampler2D uWA;
uniform sampler2D uWB;
uniform int uRow;
out vec3 vKind;
out float vWeight;
out float vSeed;
void main() {
    ivec2 id = ivec2(gl_VertexID % uRow, gl_VertexID / uRow);
    vec4 A = texelFetch(uWA, id, 0);
    vec4 B = texelFetch(uWB, id, 0);
    float kind = B.x;
    if (kind < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; return; }
    vec2 world = uFlaskPos + rot(uFlaskAngle) * A.xy;
    gl_Position = vec4(worldToScreen(world) * 2.0 - 1.0, 0.0, 1.0);
    // Пятно пены шире самого пузырька: так соседние сливаются в слой.
    float r = kind > 1.5 && kind < 2.5 ? 3.2 * B.w : (kind < 1.5 ? 1.6 * B.w : 1.4 * B.w);
    gl_PointSize = clamp(2.0 * r / pixelWorld(), 2.0, 64.0);
    vKind = vec3(kind > 1.5 && kind < 2.5 ? 1.0 : 0.0, kind < 1.5 ? 1.0 : 0.0, kind > 2.5 ? 1.0 : 0.0);
    // Тающая пена бледнеет.
    vWeight = kind > 1.5 && kind < 2.5 ? smoothstep(0.0, 1.0, B.y) : 1.0;
    vSeed = B.z;
}`;

export const FS_WHITEWATER_SPLAT = `#version 300 es
precision highp float;
in vec3 vKind;
in float vWeight;
in float vSeed;
out vec4 outColor;
float h1(float x) { return fract(sin(x * 91.345 + vSeed * 417.13) * 43758.5453); }
void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float d2 = dot(q, q);
    if (d2 > 1.0) discard;
    float w = exp(-3.0 * d2) * vWeight;
    // Пена — не однородная белизна, а гроздь пузырьков: светлые плёнки-ободки и
    // тёмные просветы между ними. Рисуем несколько пузырьков внутри пятна —
    // узор едет вместе с пеной, а не «приклеен» к экрану.
    float cluster = 0.0;
    for (int k = 0; k < 4; k++) {
        float fk = float(k);
        vec2 c = vec2(h1(fk), h1(fk + 7.1)) * 1.1 - 0.55;
        float r = 0.18 + 0.22 * h1(fk + 3.3);
        float d = length(q - c);
        cluster = max(cluster, smoothstep(r, r * 0.72, d) * (0.55 + 0.45 * smoothstep(r * 0.45, r * 0.95, d)));
    }
    float foam = vKind.x * w * (0.35 + 0.9 * cluster);
    outColor = vec4(foam, vKind.yz * w, 0.0);
}`;

export const FS_WHITEWATER_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uDensity;
uniform vec2 uResolution;
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec3 d = texture(uDensity, uv).rgb;
    if (d.r + d.g + d.b < 1e-3) discard;
    // Пена: плотная — почти белая и непрозрачная, редкая — серо-голубоватая дымка;
    // снизу слоя (меньше света) чуть темнее — берём по градиенту плотности.
    float foamA = 1.0 - exp(-0.9 * d.r);
    float below = texture(uDensity, uv + vec2(0.0, 2.0 / uResolution.y)).r - d.r;
    vec3 foamCol = mix(vec3(0.80, 0.86, 0.88), vec3(0.97, 0.98, 0.98), smoothstep(0.2, 2.0, d.r));
    foamCol *= 1.0 - 0.08 * clamp(below, 0.0, 1.0);
    // Брызги — мелкие светлые капли, пузыри в толще — светлая муть.
    float sprayA = 1.0 - exp(-0.7 * d.g);
    float bubbleA = 0.55 * (1.0 - exp(-0.5 * d.b));
    vec3 col = foamCol * foamA;
    float a = foamA;
    col += vec3(0.95, 0.97, 1.0) * sprayA * (1.0 - a); a += sprayA * (1.0 - a);
    col += vec3(0.86, 0.93, 0.96) * bubbleA * (1.0 - a); a += bubbleA * (1.0 - a);
    outColor = vec4(col, a);
}`;

// Восстановление цвета и непрозрачности по двум кадрам: на чёрном (K) и на белом (W).
// Кадр на фоне b: C = c + (1 − a)·b ⇒ c = K, a = 1 − (W − K). Результат —
// с предумноженной альфой, как и всё, что рисуется поверх.
export const FS_MATTE = `#version 300 es
precision highp float;
uniform sampler2D uBlack;
uniform sampler2D uWhite;
out vec4 outColor;
void main() {
    ivec2 c = ivec2(gl_FragCoord.xy);
    vec3 k = texelFetch(uBlack, c, 0).rgb;
    vec3 w = texelFetch(uWhite, c, 0).rgb;
    float a = clamp(1.0 - dot(w - k, vec3(1.0 / 3.0)), 0.0, 1.0);
    outColor = vec4(min(k, vec3(a)), a);
}`;
