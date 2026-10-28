#version 300 es
precision highp float;

uniform sampler2D u_bg_tex;
uniform vec2 u_resolution;
uniform sampler2D distanceFieldTex; // Поле расстояний до поверхности воды (из SPH), [-1, 1]
uniform float u_time;
uniform float u_wave_amplitude;
uniform vec2 u_container_pos;
uniform float u_container_angle;
uniform vec2 u_sim_min;
uniform vec2 u_sim_size;
uniform vec2 u_flask_half_size;
uniform float u_flask_radius;

out vec4 outColor;

// Высота кадра в единицах симуляции.
const float VIEW_HEIGHT = 12.0;
// Толщина стенки колбы.
const float GLASS_THICKNESS = 0.07;
// На сколько вода «дотягивается» до стекла: частицы держатся чуть в стороне от
// стенки, а настоящая вода смачивает стекло без зазора.
const float WALL_WETTING = 0.2;
// Поглощение воды на единицу пути. Вода в колбе такого размера почти бесцветна:
// заметный голубой оттенок появляется только на толще в метры. Поэтому
// поглощение крошечное, а воду выдаёт оптика — преломление, поверхность, мениск.
const vec3 WATER_ABSORPTION = vec3(0.045, 0.014, 0.008);
const vec3 SKY = vec3(0.92, 0.97, 1.0);

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

mat2 flaskRotation() {
    float a = u_container_angle;
    return mat2(cos(a), -sin(a), sin(a), cos(a));
}

vec2 toFlaskLocal(vec2 world) {
    return transpose(flaskRotation()) * (world - u_container_pos);
}

// Расстояние до внешней поверхности стекла (отрицательно внутри колбы).
float flaskSd(vec2 world) {
    return sdRoundedBox(toFlaskLocal(world), u_flask_half_size, u_flask_radius);
}

vec2 flaskNormal(vec2 world) {
    vec2 e = vec2(0.01, 0.0);
    return normalize(vec2(flaskSd(world + e.xy) - flaskSd(world - e.xy),
                          flaskSd(world + e.yx) - flaskSd(world - e.yx)));
}

float aspect() {
    return u_resolution.x / u_resolution.y;
}

vec2 screenToSim(vec2 uv) {
    return vec2((uv.x - 0.5) * VIEW_HEIGHT * aspect(), (uv.y - 0.5) * VIEW_HEIGHT);
}

// Смещение в единицах симуляции → смещение в UV экрана.
vec2 simOffsetToUV(vec2 d) {
    return d / vec2(VIEW_HEIGHT * aspect(), VIEW_HEIGHT);
}

vec3 background(vec2 uv) {
    return texture(u_bg_tex, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
}

float rawWaterField(vec2 world) {
    vec2 uv = (world - u_sim_min) / u_sim_size;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))))
        return 1.0;
    return texture(distanceFieldTex, uv).r;
}

// Поле воды, «смачивающей» стекло: у самой стенки берём значение чуть глубже внутри.
float waterField(vec2 world) {
    float sdInner = flaskSd(world) + GLASS_THICKNESS;
    if (sdInner > -WALL_WETTING) {
        world -= flaskNormal(world) * (sdInner + WALL_WETTING);
    }
    return rawWaterField(world);
}

vec2 waterNormal(vec2 world) {
    vec2 texel = u_sim_size / vec2(textureSize(distanceFieldTex, 0));
    vec2 e = vec2(1.5 * max(texel.x, texel.y), 0.0);
    vec2 g = vec2(waterField(world + e.xy) - waterField(world - e.xy),
                  waterField(world + e.yx) - waterField(world - e.yx));
    float len = length(g);
    return len > 1e-5 ? g / len : vec2(0.0, 1.0);
}

// Сколько воды над точкой (вверх, против гравитации, до потолка колбы).
// Свет сверху ослабляет вся вода над точкой, а не только слой до первого пузыря:
// так пузыри и брызги не дают вертикальных «колонн» в толще.
float waterAbove(vec2 world) {
    const float STEP = 0.09;
    float sum = 0.0;
    for (int i = 1; i <= 40; i++) {
        vec2 q = world + vec2(0.0, STEP * float(i));
        if (flaskSd(q) + GLASS_THICKNESS > 0.0)
            break;
        sum += STEP * (1.0 - smoothstep(-0.3, 0.3, waterField(q)));
    }
    return sum;
}

// Подвижная сетка каустик: мягкие светлые гребни.
float caustics(vec2 p, float t) {
    vec2 q = p * 1.6;
    q += 0.5 * vec2(sin(q.y * 1.3 + t * 0.7), sin(q.x * 1.1 - t * 0.6));
    float v = sin(q.x * 1.9 + t * 0.8) * sin(q.y * 2.3 - t * 0.6) + 0.5 * sin((q.x - q.y) * 2.1 + t);
    return pow(clamp(1.0 - abs(v), 0.0, 1.0), 4.0);
}

void main() {
    vec2 screenUV = gl_FragCoord.xy / u_resolution.xy;
    vec2 world = screenToSim(screenUV);
    vec2 local = toFlaskLocal(world);
    float sdOuter = flaskSd(world);
    float sdInner = sdOuter + GLASS_THICKNESS;
    vec2 nGlass = flaskNormal(world);
    float pxWorld = VIEW_HEIGHT / u_resolution.y;

    // ---------- Фон снаружи: мягкая тень от колбы ----------
    vec3 outside = background(screenUV);
    float shadow = 1.0 - 0.28 * exp(-max(flaskSd(world + vec2(0.0, 0.25)), 0.0) * 3.0);
    outside *= shadow;

    if (sdOuter > 2.0 * pxWorld) {
        outColor = vec4(outside, 1.0);
        return;
    }

    // Линза стекла: у краёв колбы фон смещается сильнее (цилиндрическая стенка).
    float edgeCloseness = exp(min(sdOuter, 0.0) * 6.0);
    vec2 glassLens = -nGlass * 0.06 * edgeCloseness;

    // ---------- Полость колбы: воздух ----------
    vec3 air = background(screenUV + simOffsetToUV(glassLens));
    air = mix(air, vec3(1.0), 0.05);

    // ---------- Вода ----------
    float field = waterField(world);
    float aa = max(fwidth(field), 1e-3);
    float waterCoverage = (1.0 - smoothstep(-aa, aa, field)) * step(sdInner, 0.0);

    vec3 col = air;
    if (waterCoverage > 0.0) {
        vec2 n = waterNormal(world);
        float upward = smoothstep(0.15, 0.75, n.y);
        float depth = waterAbove(world);
        // Расстояние до ближайшей поверхности (поле нормировано на 1.5·dp ≈ 0.19).
        float surfDist = max(-field, 0.0) * 0.19;
        float nearSurface = 1.0 - smoothstep(0.0, 0.18, surfDist);

        // Преломление: у поверхности — по её нормали, в толще — только линза стекла.
        vec2 refr = glassLens * 1.6 + n * 0.09 * nearSurface;
        vec2 uvW = screenUV + simOffsetToUV(refr);
        // Небольшая дисперсия: красный и синий преломляются по-разному.
        vec2 ca = simOffsetToUV(refr) * 0.12;
        vec3 seen = vec3(background(uvW - ca).r, background(uvW).g, background(uvW + ca).b);

        // Бугер–Ламберт: путь луча через толщу трубки + глубина под поверхностью.
        float path = 0.9 + 1.1 * depth;
        vec3 transmittance = exp(-WATER_ABSORPTION * path);
        vec3 water = seen * transmittance;
        // Вода собирает свет как линза: толща чуть светлее воздуха над ней.
        water *= 1.04;

        // Каустики на задней стенке: ярче у поверхности, гаснут с глубиной.
        float c = caustics(local, u_time) * exp(-depth * 1.1);
        water += vec3(0.9, 0.97, 1.0) * c * 0.025;

        // Поверхность сбоку: серебристая полоса полного внутреннего отражения
        // прямо под водой и тонкая тень мениска чуть ниже. Только у верхней поверхности.
        float tir = exp(-pow(surfDist / 0.035, 2.0));
        float meniscusShadow = exp(-pow((surfDist - 0.09) / 0.04, 2.0));
        water = mix(water, SKY, tir * 0.62 * upward);
        water *= 1.0 - 0.18 * meniscusShadow * upward;

        // Френелевское отражение неба на наклонных участках поверхности (волны, капли).
        float fresnel = pow(1.0 - clamp(abs(n.y), 0.0, 1.0), 3.0) * nearSurface;
        water = mix(water, SKY, fresnel * 0.3);
        // Тонкая тёмная кромка там, где поверхность видна под углом: так глаз
        // отличает прозрачную воду от воздуха (как контур капли на стекле).
        water *= 1.0 - 0.22 * fresnel * (1.0 - upward);
        // Блик солнца на гребнях.
        float spec = pow(max(dot(n, normalize(vec2(0.35, 1.0))), 0.0), 90.0) * nearSurface;
        water += vec3(1.0, 0.98, 0.92) * spec * 0.5;

        // Мениск: вода чуть приподнимается и светлеет у стекла.
        float atWall = exp(sdInner * 30.0);
        water = mix(water, SKY, atWall * tir * 0.4);

        col = mix(air, water, waterCoverage);
    }

    // ---------- Стекло ----------
    // Внутренняя тень у стенок: объём трубки.
    col *= mix(0.86, 1.0, smoothstep(0.0, 0.35, -sdInner));

    // Стенка: преломляет фон сильнее и слегка светится по Френелю.
    if (sdInner > 0.0) {
        vec3 wall = background(screenUV + simOffsetToUV(-nGlass * 0.12));
        float rim = smoothstep(0.0, GLASS_THICKNESS, sdInner);
        col = mix(wall, vec3(1.0), 0.18 + 0.25 * rim);
    }

    // Блики цилиндра: длинный узкий сверху, мягкий широкий под ним и слабый у дна.
    float hy = u_flask_half_size.y;
    float alongLength = 1.0 - smoothstep(u_flask_half_size.x - u_flask_radius * 1.2, u_flask_half_size.x, abs(local.x));
    float topStreak = exp(-pow((local.y - (hy - 0.2 * min(hy, 1.0))) / 0.035, 2.0));
    float topSoft = exp(-pow((local.y - (hy - 0.42 * min(hy, 1.0))) / 0.16, 2.0));
    float bottomStreak = exp(-pow((local.y + (hy - 0.16 * min(hy, 1.0))) / 0.05, 2.0));
    col += vec3(1.0) * (0.75 * topStreak + 0.12 * topSoft + 0.18 * bottomStreak) * alongLength;

    // Тонкие светлые кромки по внешнему и внутреннему краю стекла.
    float outerRim = exp(-pow(sdOuter / (1.5 * pxWorld), 2.0));
    float innerRim = exp(-pow(sdInner / (1.5 * pxWorld), 2.0));
    col = mix(col, vec3(1.0), 0.35 * outerRim + 0.2 * innerRim);

    // Сглаживание внешнего края колбы.
    float edgeAA = smoothstep(-pxWorld, pxWorld, sdOuter);
    outColor = vec4(mix(col, outside, edgeAA), 1.0);
}
