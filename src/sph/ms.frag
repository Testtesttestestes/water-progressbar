#version 300 es
precision highp float;

uniform sampler2D u_bg_tex;
uniform vec2 u_resolution;
uniform sampler2D distanceFieldTex; // Текстура с физикой воды от SPH
uniform float u_time;
uniform float u_wave_amplitude;
uniform vec2 u_sim_min;
uniform vec2 u_sim_size;

out vec4 outColor;

// Генератор фона (используем текстуру из вёрстки)
vec3 getBackground(vec2 uv) {
    return texture(u_bg_tex, uv).rgb;
}

// SDF скругленного прямоугольника (как в вёрстке)
float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// Вычисление нормали воды на основе SDF текстуры
vec2 getWaterNormal(vec2 uv) {
    vec2 e = vec2(12.0 / 256.0, 0.0); // Сильное сглаживание нормалей
    float dx = texture(distanceFieldTex, uv + e.xy).r - texture(distanceFieldTex, uv - e.xy).r;
    float dy = texture(distanceFieldTex, uv + e.yx).r - texture(distanceFieldTex, uv - e.yx).r;
    vec2 n = vec2(dx, dy);
    float len = length(n);
    return len > 0.0001 ? n / len : vec2(0.0, 0.0);
}

// Динамические отражения (Fake Environment Map)
vec3 getReflection(vec2 n) {
    float skyLight = smoothstep(0.0, 1.0, n.y);
    return mix(vec3(0.1, 0.15, 0.2), vec3(1.0, 1.0, 1.2), skyLight);
}

void main() {
    vec2 screenUV = gl_FragCoord.xy / u_resolution.xy;
    
    // Map screen to Simulation Space
    float viewHeight = 12.0;
    vec2 simPos = vec2(
        (screenUV.x - 0.5) * viewHeight * (u_resolution.x / u_resolution.y),
        (screenUV.y - 0.5) * viewHeight
    );

    // Map SimSpace to distanceFieldTex UV
    vec2 waterUV = (simPos - u_sim_min) / u_sim_size;
    float dWater = 1000.0;
    if (waterUV.x >= 0.0 && waterUV.x <= 1.0 && waterUV.y >= 0.0 && waterUV.y <= 1.0) {
        dWater = texture(distanceFieldTex, waterUV).r;
    }

    // Параметры формы (делаем чуть шире и "коробочнее" как в вёрстке)
    vec2 boxSize = vec2(5.0, 1.5);
    float boxRadius = 0.8;
    
    // Анимация (вращение и покачивание)
    float angle = sin(u_time * 1.2) * 0.15 * u_wave_amplitude;
    float offsetX = sin(u_time * 0.8) * 1.0 * u_wave_amplitude;
    
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    vec2 p = simPos;
    p.y -= 3.0; // Offset up
    p.x -= offsetX;
    p = rot * p;

    float dGlass = sdRoundedBox(p, boxSize, boxRadius);

    // --- ОПТИКА И РЕФРАКЦИЯ ---
    vec2 distortedUV = screenUV;
    vec2 waterNormal = vec2(0.0);
    bool isWater = false;
    float glassThickness = 0.0;
    vec2 glassNormal = vec2(0.0);
    
    if (dGlass < 0.0) {
        glassThickness = 1.0 - pow(abs(dGlass) / boxRadius, 0.5);
        
        // Вычисление нормали для скругленного бокса
        vec2 e = vec2(0.01, 0.0);
        glassNormal = normalize(vec2(
            sdRoundedBox(p + e.xy, boxSize, boxRadius) - sdRoundedBox(p - e.xy, boxSize, boxRadius),
            sdRoundedBox(p + e.yx, boxSize, boxRadius) - sdRoundedBox(p - e.yx, boxSize, boxRadius)
        ));
        // Возвращаем нормаль в мировое пространство (обратное вращение)
        glassNormal = vec2(cos(-angle) * glassNormal.x - sin(-angle) * glassNormal.y, sin(-angle) * glassNormal.x + cos(-angle) * glassNormal.y);
        
        // Маска воды
        if (dWater < 0.0 && dGlass < -0.05) {
            isWater = true;
            waterNormal = getWaterNormal(waterUV);
            
            // Мениск: натяжение у стенок колбы
            float edgeDist = abs(dGlass + 0.05);
            if (edgeDist < 0.1) {
                waterNormal.y += smoothstep(0.1, 0.0, edgeDist) * 0.8;
                waterNormal = normalize(waterNormal);
            }

            // Затухание рефракции на глубине
            // Чем глубже, тем меньше шумные нормали SPH искажают фон
            float depthDamping = smoothstep(0.5, 0.0, abs(dWater)); 

            // Физически корректная рефракция, которая успокаивается на глубине
            vec2 refractionOffset = waterNormal * 0.08 * glassThickness * depthDamping;
            distortedUV += refractionOffset;
        } else {
            distortedUV += glassNormal * 0.02; // Пустая колба
        }
    }

    // Хроматическая аберрация (RGB сдвиг)
    float caStrength = isWater ? 0.006 : 0.002;
    float r = getBackground(distortedUV - vec2(caStrength, 0.0)).r;
    float g = getBackground(distortedUV).g;
    float b = getBackground(distortedUV + vec2(caStrength, 0.0)).b;
    vec3 col = vec3(r, g, b);

    // --- МАТЕРИАЛЫ И БЛИКИ (Стиль из вёрстки) ---
    if (dGlass < 0.0) {
        // 1. Тинт стекла (белый полупрозрачный из вёрстки: tint-opacity 0.06)
        col = mix(col, vec3(1.0), 0.06);

        // 2. Внутренняя тень/свечение (из вёрстки: shadow-color rgba(255,255,255,0.45), blur 20px)
        // Имитируем inset shadow через расстояние до края
        float innerGlow = smoothstep(-0.8, 0.0, dGlass);
        col += vec3(1.0) * innerGlow * 0.35;

        if (isWater) {
            // 2. Глубина и поглощение (Кристально чистая вода)
            float opticalDepth = abs(dWater);
            vec3 extinction = exp(-opticalDepth * vec3(0.2, 0.1, 0.02));
            vec3 waterTint = vec3(0.4, 0.7, 0.9);
            col = col * extinction + waterTint * (1.0 - extinction) * 0.3;

            // 3. Отражения и Френель (только на поверхности)
            float surfaceMask = smoothstep(0.3, 0.0, abs(dWater));
            vec3 reflection = getReflection(waterNormal);
            float fresnel = pow(1.0 - max(dot(waterNormal, vec2(0.0, 1.0)), 0.0), 4.0);
            col = mix(col, reflection, fresnel * 0.5 * surfaceMask);
            
            // 4. Двойной Спекуляр (Блик)
            float specA = pow(max(dot(waterNormal, normalize(vec2(0.5, 1.0))), 0.0), 64.0);
            float specB = pow(max(dot(waterNormal, normalize(vec2(-0.4, 0.8))), 0.0), 128.0);
            col += (vec3(1.0, 1.0, 0.9) * specA + vec3(0.8, 0.9, 1.0) * specB) * 0.8 * surfaceMask;

            // 5. Каустика (опционально)
            float caustic = 0.05 * sin(waterUV.x * 40.0 + u_time * 2.0) * sin(waterUV.y * 40.0 - u_time * 2.0);
            col += max(caustic, 0.0) * extinction.g;

            // --- ГЛАВНЫЙ ШТРИХ: Линия поверхности ---
            // Рисуем яркую кромку там, где dWater близко к 0
            float surfaceThickness = 0.02;
            float surfaceLine = smoothstep(surfaceThickness, 0.0, abs(dWater));

            // Делаем блик ярче у краев стекла (мениск)
            float meniscus = smoothstep(0.1, 0.0, abs(dGlass + 0.05));
            float highlightIntensity = 0.5 + meniscus * 0.5;

            // Добавляем поверхностный блик к цвету
            col += vec3(1.0, 1.0, 1.0) * surfaceLine * highlightIntensity;
        } else {
            // Легкая синева стекла
            col = mix(col, vec3(0.9, 0.95, 1.0), 0.1);
        }

        // Блик стекла (более мягкий и широкий)
        float highlightTop = smoothstep(0.15, 0.0, abs(p.y - (boxSize.y - 0.3)));
        col += highlightTop * 0.5;

        // Френель (тень по контуру стекла)
        float edgeShadow = smoothstep(0.0, -0.15, dGlass);
        col *= mix(0.85, 1.0, edgeShadow);
    }

    // Сглаживание краев колбы (AA)
    float aa = smoothstep(0.0, 0.03, dGlass);
    vec3 finalBg = getBackground(screenUV);
    
    // Внешняя тень (из вёрстки: outer-shadow-blur 24px)
    float outerShadow = smoothstep(0.0, 0.6, dGlass);
    finalBg *= mix(0.85, 1.0, outerShadow);

    outColor = vec4(mix(col, finalBg, aa), 1.0);
}
