#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform sampler2D distanceFieldTex;
uniform float u_time;
uniform vec2 u_container_pos;
uniform float u_container_angle;
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
    return len > 0.0001 ? n / len : vec2(0.0, 1.0);
}

vec3 getReflection(vec2 n) {
    float skyLight = smoothstep(0.0, 1.0, n.y);
    return mix(vec3(0.4, 0.55, 0.7), vec3(1.0), skyLight);
}

void main() {
    vec2 screenUV = gl_FragCoord.xy / u_resolution.xy;

    float viewHeight = 12.0;
    vec2 simPos = vec2(
        (screenUV.x - 0.5) * viewHeight * (u_resolution.x / u_resolution.y),
        (screenUV.y - 0.5) * viewHeight
    );

    vec2 waterUV = (simPos - u_sim_min) / u_sim_size;
    float dWater = 1000.0;
    if (waterUV.x >= 0.0 && waterUV.x <= 1.0 && waterUV.y >= 0.0 && waterUV.y <= 1.0) {
        dWater = texture(distanceFieldTex, waterUV).r;
    }

    vec2 boxSize = vec2(5.0, 1.5);
    float boxRadius = 0.8;

    float angle = u_container_angle;
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    mat2 invRot = transpose(rot);
    vec2 p = invRot * (simPos - u_container_pos);

    float dGlass = sdRoundedBox(p, boxSize, boxRadius);
    float edgeAA = max(fwidth(dGlass), 0.001);

    // render only flask object, outside should be transparent
    if (dGlass > edgeAA) {
        outColor = vec4(0.0);
        return;
    }

    vec3 glassColor = vec3(0.82, 0.9, 1.0);
    float glassAlpha = 0.24;

    float edgeGlow = 1.0 - smoothstep(-0.5, 0.0, dGlass);
    vec3 col = glassColor * 0.2 + vec3(1.0) * edgeGlow * 0.35;

    bool isWater = dWater < 0.0 && dGlass < -0.05;
    if (isWater) {
        vec2 waterNormal = getWaterNormal(waterUV);
        float opticalDepth = abs(dWater);
        vec3 extinction = exp(-opticalDepth * vec3(0.2, 0.1, 0.02));
        vec3 waterTint = vec3(0.4, 0.72, 0.95);

        col = waterTint * (1.0 - extinction) * 0.9 + vec3(0.08, 0.12, 0.2);

        float surfaceMask = smoothstep(0.3, 0.0, abs(dWater));
        float fresnel = pow(1.0 - max(dot(waterNormal, vec2(0.0, 1.0)), 0.0), 4.0);
        col = mix(col, getReflection(waterNormal), fresnel * 0.4 * surfaceMask);

        float specA = pow(max(dot(waterNormal, normalize(vec2(0.5, 1.0))), 0.0), 64.0);
        col += vec3(1.0, 1.0, 0.95) * specA * 0.7 * surfaceMask;

        float w = max(fwidth(dWater), 0.001);
        float surfaceLine = 1.0 - smoothstep(0.0, w * 2.0, abs(dWater));
        col += vec3(1.0) * surfaceLine * 0.6;

        glassAlpha = 0.95;
    }

    float rim = smoothstep(0.0, -0.18, dGlass);
    col += rim * vec3(0.12, 0.15, 0.2);

    float alpha = 1.0 - smoothstep(0.0, edgeAA, dGlass);
    alpha = max(alpha * glassAlpha, alpha * 0.2 + (isWater ? 0.0 : 0.0));

    outColor = vec4(col, alpha);
}
