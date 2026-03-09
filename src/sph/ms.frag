#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform sampler2D distanceFieldTex; // Текстура с физикой воды от SPH
uniform float u_time;
uniform float u_wave_amplitude;

out vec4 outColor;

// Генератор фона (можно заменить на реальную картинку/скриншот)
vec3 getBackground(vec2 uv) {
    vec2 grid = fract(uv * 20.0);
    float line = smoothstep(0.9, 1.0, grid.x) + smoothstep(0.9, 1.0, grid.y);
    vec3 bgColor = mix(vec3(0.95, 0.95, 0.97), vec3(0.8, 0.82, 0.85), length(uv - 0.5));
    return mix(bgColor, vec3(0.6, 0.65, 0.7), clamp(line, 0.0, 1.0));
}

// SDF стеклянной колбы
float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
}

// Вычисление нормали воды на основе SDF текстуры
vec2 getWaterNormal(vec2 uv) {
    vec2 e = vec2(3.0 / 256.0, 0.0); // Увеличиваем шаг для сглаживания
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
    float viewHeight = 4.0;
    vec2 simPos = vec2(
        (screenUV.x - 0.5) * viewHeight * (u_resolution.x / u_resolution.y),
        (screenUV.y - 0.5) * viewHeight
    );

    // Map SimSpace to distanceFieldTex UV
    // distanceFieldTex covers [-8, 8] x [-8, 8]
    vec2 waterUV = (simPos + 8.0) / 16.0;
    float dWater = texture(distanceFieldTex, waterUV).r;

    vec2 pA = vec2(-6.0, 0.0);
    vec2 pB = vec2(6.0, 0.0);
    
    // Apply animation
    float angle = sin(u_time * 2.0) * 0.261799 * u_wave_amplitude; // 15 degrees in radians
    float offsetX = sin(u_time * 1.5) * 1.5 * u_wave_amplitude;
    
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    pA = rot * pA;
    pB = rot * pB;
    pA.x += offsetX;
    pB.x += offsetX;

    float radius = 1.5;
    float dGlass = sdCapsule(simPos, pA, pB, radius);

    // --- ОПТИКА И РЕФРАКЦИЯ ---
    vec2 distortedUV = screenUV;
    vec2 waterNormal = vec2(0.0);
    bool isWater = false;
    float glassThickness = 0.0;
    vec2 glassNormal = vec2(0.0);
    
    if (dGlass < 0.0) {
        glassThickness = 1.0 - pow(abs(dGlass) / radius, 0.5);
        // Нормаль стекла с учетом вращения
        glassNormal = normalize(simPos - (pA + (pB - pA) * clamp(dot(simPos - pA, pB - pA) / dot(pB - pA, pB - pA), 0.0, 1.0)));
        
        // Маска воды: обрезаем воду по краям колбы, чтобы она не выливалась за пределы стекла
        if (dWater < 0.0 && dGlass < -0.05) {
            isWater = true;
            waterNormal = getWaterNormal(waterUV);
            
            // Мениск: натяжение у стенок колбы
            float edgeDist = abs(dGlass + 0.05);
            if (edgeDist < 0.1) {
                waterNormal.y += smoothstep(0.1, 0.0, edgeDist) * 0.5;
                waterNormal = normalize(waterNormal);
            }

            // 1. Физически корректная рефракция (IOR воды ~1.33)
            vec2 refractionOffset = waterNormal * (1.0 - 1.0/1.33) * glassThickness * 0.8;
            distortedUV += refractionOffset;
        } else {
            distortedUV += glassNormal * 0.03; // Пустая колба
        }
    }

    // Хроматическая аберрация (RGB сдвиг)
    // Усиливаем аберрацию только для воды
    float caStrength = isWater ? 0.005 : 0.001;
    float r = getBackground(distortedUV - vec2(caStrength, 0.0)).r;
    float g = getBackground(distortedUV).g;
    float b = getBackground(distortedUV + vec2(caStrength, 0.0)).b;
    vec3 col = vec3(r, g, b);

    // --- МАТЕРИАЛЫ И БЛИКИ ---
    if (dGlass < 0.0) {
        if (isWater) {
            // 2. Глубина и поглощение (Beer-Lambert Law)
            float opticalDepth = abs(dWater) * 1.5;
            vec3 extinction = exp(-opticalDepth * vec3(0.8, 0.4, 0.1));
            vec3 waterTint = vec3(0.1, 0.5, 0.8);
            col = col * extinction + waterTint * (1.0 - extinction) * 0.5;

            // 3. Отражения и Френель
            vec3 reflection = getReflection(waterNormal);
            float fresnel = pow(1.0 - max(dot(waterNormal, vec2(0.0, 1.0)), 0.0), 4.0);
            col = mix(col, reflection, fresnel * 0.5);
            
            // 4. Двойной Спекуляр (Блик)
            float specA = pow(max(dot(waterNormal, normalize(vec2(0.5, 1.0))), 0.0), 64.0);
            float specB = pow(max(dot(waterNormal, normalize(vec2(-0.4, 0.8))), 0.0), 128.0);
            col += (vec3(1.0, 1.0, 0.9) * specA + vec3(0.8, 0.9, 1.0) * specB) * 0.6;

            // 5. Каустика (опционально)
            float caustic = 0.05 * sin(waterUV.x * 40.0 + u_time * 2.0) * sin(waterUV.y * 40.0 - u_time * 2.0);
            col += max(caustic, 0.0) * extinction.g;
        } else {
            // Легкая синева стекла
            col = mix(col, vec3(0.9, 0.95, 1.0), 0.1);
        }

        // Блик стекла
        // Вычисляем локальную Y-координату относительно капсулы для блика
        vec2 pa = simPos - pA, ba = pB - pA;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        vec2 closestPoint = pA + ba * h;
        vec2 localDir = simPos - closestPoint;
        float localY = dot(localDir, vec2(-ba.y, ba.x) / length(ba));
        
        float highlightTop = smoothstep(0.1, 0.0, abs(localY - (radius - 0.2)));
        col += highlightTop * 0.8;

        // Френель (тень по контуру стекла)
        float edgeShadow = smoothstep(0.0, -0.2, dGlass);
        col *= mix(0.6, 1.0, edgeShadow);
    }

    // Сглаживание краев колбы
    float aa = smoothstep(0.0, 0.05, dGlass);
    vec3 finalBg = getBackground(screenUV);
    outColor = vec4(mix(col, finalBg, aa), 1.0);
}
