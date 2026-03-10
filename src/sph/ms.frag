#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform sampler2D distanceFieldTex;
uniform float u_time;
uniform float u_wave_amplitude;
uniform vec2 u_container_pos;
uniform float u_container_angle;
uniform vec2 u_container_size;
uniform vec2 u_sim_min;
uniform vec2 u_sim_size;

out vec4 outColor;

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

vec2 getWaterNormal(vec2 uv) {
    vec2 e = vec2(12.0 / 256.0, 0.0);
    float dx = texture(distanceFieldTex, uv + e.xy).r - texture(distanceFieldTex, uv - e.xy).r;
    float dy = texture(distanceFieldTex, uv + e.yx).r - texture(distanceFieldTex, uv - e.yx).r;
    vec2 n = vec2(dx, dy);
    float len = length(n);
    return len > 0.0001 ? n / len : vec2(0.0, 0.0);
}

void main() {
    vec2 screenUV = gl_FragCoord.xy / u_resolution.xy;

    // Восстанавливаем точный масштаб (канвас имеет высоту flaskHeight + 6)
    float viewHeight = u_container_size.y + 6.0;
    
    vec2 simPos = u_container_pos + vec2(
        (screenUV.x - 0.5) * viewHeight * (u_resolution.x / u_resolution.y),
        (screenUV.y - 0.5) * viewHeight
    );

    vec2 waterUV = (simPos - u_sim_min) / u_sim_size;
    float dWater = 1000.0;
    if (waterUV.x >= 0.0 && waterUV.x <= 1.0 && waterUV.y >= 0.0 && waterUV.y <= 1.0) {
        dWater = texture(distanceFieldTex, waterUV).r;
    }

    vec2 boxSize = 0.5 * u_container_size;
    float boxRadius = 0.8;
    
    // Вращаем координаты для проверки границ стекла
    float angle = u_container_angle;
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    mat2 invRot = transpose(rot);
    vec2 p = invRot * (simPos - u_container_pos);

    float dGlass = sdRoundedBox(p, boxSize, boxRadius);

    vec3 col = vec3(0.0);
    float alpha = 0.0;

    // Убираем зазор между краем частиц и стенкой
    dWater -= 0.15; 

    // РИСУЕМ ВОДУ ТОЛЬКО СТРОГО ВНУТРИ КОЛБЫ (dGlass < 0.0)
    if (dWater < 0.0 && dGlass < 0.0) {
        vec2 waterNormal = getWaterNormal(waterUV);
        
        // Мениск у краев колбы
        float edgeDist = abs(dGlass);
        if (edgeDist < 0.1) {
            waterNormal.y += smoothstep(0.1, 0.0, edgeDist) * 0.8;
            waterNormal = normalize(waterNormal);
        }

        vec3 waterTint = vec3(0.2, 0.5, 0.9);
        float fresnel = pow(1.0 - max(dot(waterNormal, vec2(0.0, 1.0)), 0.0), 3.0);
        
        float light = dot(waterNormal, normalize(vec2(0.5, 1.0)));
        vec3 reflection = mix(vec3(0.05, 0.1, 0.2), vec3(1.0, 1.0, 1.2), smoothstep(-0.5, 1.0, light));
        
        col = waterTint * 0.4 + reflection * fresnel * 0.8;
        alpha = mix(0.4, 0.9, fresnel);

        float spec = pow(max(dot(waterNormal, normalize(vec2(0.3, 0.8))), 0.0), 64.0);
        col += vec3(1.0) * spec * 1.5;
        alpha += spec;

        float w = max(fwidth(dWater), 0.001);
        float surfaceLine = 1.0 - smoothstep(0.0, w * 2.0, abs(dWater));
        col += vec3(1.0) * surfaceLine;
        alpha += surfaceLine;
    }

    // Абсолютная прозрачность вне воды
    alpha = clamp(alpha, 0.0, 1.0);
    col *= alpha; // Важно для правильного смешивания с прозрачным фоном в WebGL

    outColor = vec4(col, alpha);
}
