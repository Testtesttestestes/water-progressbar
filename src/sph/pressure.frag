#version 300 es

precision highp float;
precision highp isampler2D;
precision highp usampler2D;

layout(std140) uniform ParticleTexture { vec4  particleTexelSizeOffset; };
layout(std140) uniform CellTexture     { vec4  cellTexelSizeOffset; };
layout(std140) uniform ToFloatPos      { float toFloatPos; };
layout(std140) uniform Cell {
    vec2 cellResolution;
    vec2 cellOrigin;
    float rcplCellSize;
};
layout(std140) uniform Density {
    vec2  particleTexMaxUV;
    float dp;
    float rcplRho0;
    float kernelRadius;
    float kernelRadiusSq;
    float rcplKernelRadius;
    float coefDensity;
    float pressB;
    float domainRadius;
};

uniform isampler2D intPosTex;
uniform sampler2D  velTex;
uniform usampler2D cellBeginEndTex;
uniform sampler2D  densWallKerTex;
uniform sampler2D  stateTex;
uniform float u_time;
uniform float u_wave_amplitude;
uniform vec2 u_container_pos;
uniform vec2 u_container_vel;
uniform vec2 u_container_acc;
uniform float u_container_angle;
uniform float u_container_ang_vel;
uniform float u_container_ang_acc;
uniform float u_reverse_impulse_strength;
uniform float u_reverse_impulse_age;
uniform vec2 u_reverse_delta_v;

out vec4 o;

vec2 idx2uv(in float idx, in vec4 texelSizeOffset) {
    float y;
    float x = modf(idx * texelSizeOffset.x + texelSizeOffset.z, y);
    return vec2(x, y * texelSizeOffset.y + texelSizeOffset.w);
}

vec2 cell2uv(in vec2 cell) {
    return idx2uv(cell.y * cellResolution.x + cell.x, cellTexelSizeOffset);
}

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main(void) {
    vec2 uv_i  = gl_FragCoord.xy * particleTexelSizeOffset.xy;
    vec2 pos_i = vec2(texture(intPosTex, uv_i).xy) * toFloatPos;
    if (uv_i.x > particleTexMaxUV.x && uv_i.y > particleTexMaxUV.y)
        pos_i = vec2(domainRadius);
    vec2 cell_i = floor((pos_i - cellOrigin) * rcplCellSize);
    float rho_i = 0.0;

    for (float cy = -1.; cy <= 1.; cy++) {
        vec2 uv_c   = cell2uv(vec2(cell_i.x, cell_i.y + cy));
        vec2 begEnd = vec2(texture(cellBeginEndTex, uv_c).xy);

        for (float j = begEnd.x; j < begEnd.y; j++) {
            vec2  uv_j   = idx2uv(j, particleTexelSizeOffset);
            vec2 state_j = texture(stateTex, uv_j).xy;
            vec2  pos_ij = pos_i - vec2(texture(intPosTex, uv_j).xy) * toFloatPos;
            float poly6  = kernelRadiusSq - dot(pos_ij, pos_ij);
            float neighMass = state_j.x * state_j.y;
            rho_i += neighMass * poly6 * poly6 * poly6 * step(0.0, poly6);
        }
    }

    vec2 boxSize = vec2(5.0, 1.5);
    float boxRadius = 0.8;
    
    // Apply container pose from CPU kinematics
    float angle = u_container_angle;

    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    vec2 p = pos_i - u_container_pos;
    p = rot * p;

    vec2 state_i = texture(stateTex, uv_i).xy;
    float selfMass = state_i.x * state_i.y;

    float dist_iw = -sdRoundedBox(p, boxSize, boxRadius) + 0.5 * dp;
    float u_w = dist_iw * rcplKernelRadius;
    if (u_w < 1.0)
        rho_i += texture(densWallKerTex, vec2(u_w, 0.5)).x;

    rho_i *= coefDensity;
    rho_i = max(rho_i, 1e-5);
    float relrho_i = rho_i * rcplRho0;
    float eosTerm = relrho_i * relrho_i - 1.0;
    float negBand = 0.05;
    float softBand = smoothstep(-negBand, 0.0, eosTerm);
    float negClamp = clamp(eosTerm, -negBand, 0.0);
    float blendedEos = mix(0.35 * negClamp, eosTerm, softBand);
    float pres_i = pressB * blendedEos;

    o = vec4(texture(velTex, uv_i).xy, pres_i * selfMass, selfMass / rho_i);
}
