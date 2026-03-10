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

vec3 getReflection(vec2 n) {
    float skyLight = smoothstep(0.0, 1.0, n.y);
    return mix(vec3(0.05, 0.1, 0.15), vec3(0.8, 0.9, 1.0), skyLight);
}

void main() {
    vec2 screenUV = gl_FragCoord.xy / u_resolution.xy;

    vec2 simPos = u_container_pos + (screenUV - 0.5) * u_container_size;

    vec2 waterUV = (simPos - u_sim_min) / u_sim_size;
    float dWater = 1000.0;
    if (waterUV.x >= 0.0 && waterUV.x <= 1.0 && waterUV.y >= 0.0 && waterUV.y <= 1.0) {
        dWater = texture(distanceFieldTex, waterUV).r;
    }

    vec2 boxSize = 0.5 * u_container_size;
    float boxRadius = 0.8;
    float angle = u_container_angle;
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    mat2 invRot = transpose(rot);
    vec2 p = invRot * (simPos - u_container_pos);

    float dGlass = sdRoundedBox(p, boxSize, boxRadius);

    vec3 col = vec3(0.0);
    float alpha = 0.0;

    if (dGlass < 0.05) {
        bool isWater = (dWater < 0.0 && dGlass < -0.05);

        if (isWater) {
            vec2 waterNormal = getWaterNormal(waterUV);
            float edgeDist = abs(dGlass + 0.05);
            if (edgeDist < 0.1) {
                waterNormal.y += smoothstep(0.1, 0.0, edgeDist) * 0.8;
                waterNormal = normalize(waterNormal);
            }

            float opticalDepth = abs(dWater);
            vec3 extinction = exp(-opticalDepth * vec3(0.3, 0.15, 0.05));
            vec3 waterTint = vec3(0.1, 0.5, 0.8);

            col = waterTint * (1.0 - extinction) * 0.8;
            alpha = mix(0.75, 0.35, (extinction.r + extinction.g + extinction.b) / 3.0);

            float surfaceMask = smoothstep(0.3, 0.0, abs(dWater));
            vec3 reflection = getReflection(waterNormal);
            float fresnel = pow(1.0 - max(dot(waterNormal, vec2(0.0, 1.0)), 0.0), 4.0);
            col += reflection * fresnel * 0.6 * surfaceMask;
            alpha += fresnel * 0.5 * surfaceMask;

            float specA = pow(max(dot(waterNormal, normalize(vec2(0.5, 1.0))), 0.0), 64.0);
            float specB = pow(max(dot(waterNormal, normalize(vec2(-0.4, 0.8))), 0.0), 128.0);
            float spec = (specA + specB) * 0.8 * surfaceMask;
            col += vec3(1.0) * spec;
            alpha += spec;

            float w = max(fwidth(dWater), 0.001);
            float surfaceLine = 1.0 - smoothstep(0.0, w * 2.0, abs(dWater));
            float meniscus = smoothstep(0.1, 0.0, abs(dGlass + 0.05));
            float highlightIntensity = 0.5 + meniscus * 0.5;
            col += vec3(1.0) * surfaceLine * highlightIntensity;
            alpha += surfaceLine * highlightIntensity;

        } else if (dGlass < 0.0) {
            col = vec3(0.9, 0.95, 1.0);
            alpha = 0.08;
        }

        if (dGlass < 0.0) {
            float innerGlow = smoothstep(-0.8, 0.0, dGlass);
            col += vec3(1.0) * innerGlow * 0.15;
            alpha += innerGlow * 0.15;

            float highlightTop = smoothstep(0.15, 0.0, abs(p.y - (boxSize.y - 0.3)));
            col += vec3(1.0) * highlightTop * 0.3;
            alpha += highlightTop * 0.3;

            float edgeShadow = smoothstep(0.0, -0.15, dGlass);
            col *= mix(0.7, 1.0, edgeShadow);
        }
    }

    float shadowAlpha = 0.0;
    if (dGlass > 0.0) {
        shadowAlpha = (1.0 - smoothstep(0.0, 0.8, dGlass)) * 0.3;
    }

    float aa = smoothstep(0.0, max(fwidth(dGlass), 0.001), dGlass);

    vec4 insideColor = vec4(col, clamp(alpha, 0.0, 1.0));
    vec4 outsideColor = vec4(0.0, 0.0, 0.0, shadowAlpha);

    vec4 finalColor = mix(insideColor, outsideColor, aa);

    finalColor.rgb *= finalColor.a;

    outColor = finalColor;
}
