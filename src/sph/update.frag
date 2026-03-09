#version 300 es

precision highp float;
precision highp isampler2D;
precision highp usampler2D;

layout(std140) uniform ParticleTexture { vec4  particleTexelSizeOffset; };
layout(std140) uniform CellTexture     { vec4  cellTexelSizeOffset; };
layout(std140) uniform ToFloatPos      { float toFloatPos; };
layout(std140) uniform ToIntPos        { float toIntPos; };
layout(std140) uniform Cell {
    vec2 cellResolution;
    vec2 cellOrigin;
    float rcplCellSize;
};
layout(std140) uniform Update {
    vec2  particleTexMaxUV;
    float dp;
    float rho0;
    float rcplRho0;
    float kernelRadius;
    float kernelRadiusSq;
    float rcplKernelRadius;
    float coefViscosity;
    float coefSurfTension;
    float coefAcceleration;
    float coefRepul;
    float domainRadius;
    float dt;
    float velLimit;
};

uniform vec2  g;
uniform vec4  pointerPosVel;
uniform float pointerRadius;
uniform float u_progress;
uniform float particleCount;
uniform float u_time;
uniform float u_wave_amplitude;
uniform sampler2D  posTex;
uniform isampler2D intPosTex;
uniform sampler2D  velTex;
uniform usampler2D cellBeginEndTex;
uniform sampler2D  accWallKerTex;


layout(location = 0) out vec4 oPos;
layout(location = 1) out vec2 oVel;
layout(location = 2) out ivec2 oIntPos;

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

vec2 calcRoundedBoxNormal(vec2 p, vec2 b, float r) {
    vec2 e = vec2(0.01, 0.0);
    return normalize(vec2(
        sdRoundedBox(p + e.xy, b, r) - sdRoundedBox(p - e.xy, b, r),
        sdRoundedBox(p + e.yx, b, r) - sdRoundedBox(p - e.yx, b, r)
    ));
}

vec2 calcAcceleration() {
    vec2 pos_i;
    vec2 vel_i;
    vec2 pr_i;
    {
        vec2 uv_i  = gl_FragCoord.xy * particleTexelSizeOffset.xy;
        vec4 vpr_i = texture(velTex, uv_i);
        pos_i = vec2(texture(intPosTex, uv_i).xy) * toFloatPos;
        vel_i = vpr_i.xy;
        pr_i  = vpr_i.zw;
        if (uv_i.x > particleTexMaxUV.x && uv_i.y > particleTexMaxUV.y) {
            pos_i = vec2(domainRadius);
            vel_i = vec2(0, 0);
            pr_i  = vec2(0, rcplRho0);
        }
    }
    vec2 cell_i = floor((pos_i - cellOrigin) * rcplCellSize);
    vec2 acc_i  = vec2(0);

    for (float cy = -1.; cy <= 1.; cy++) {
        vec2 uv_c   = cell2uv(vec2(cell_i.x, cell_i.y + cy));
        vec2 begEnd = vec2(texture(cellBeginEndTex, uv_c).xy);

        for (float j = begEnd.x; j < begEnd.y; j++) {
            vec2  uv_j   = idx2uv(j, particleTexelSizeOffset);
            vec2  pos_ij = pos_i - vec2(texture(intPosTex, uv_j).xy) * toFloatPos;
            float r_sq   = dot(pos_ij, pos_ij);
            if (r_sq > kernelRadiusSq) continue;

            vec4 vpr_j = texture(velTex, uv_j);

            float rr  = inversesqrt(r_sq + 1e-8);
            float r   = r_sq * rr;

            // 表面張力
            float st = kernelRadiusSq - r_sq;
            st = st * st * st * coefSurfTension * step(0.9 * dp, r);
            acc_i -= st * pos_ij;

            vec2 vel_ij = vel_i - vpr_j.xy;
            vec2 prr_ij = vec2(pr_i.x + vpr_j.z, pr_i.y * vpr_j.w);

            float ker = 1.0 - r * rcplKernelRadius;
            ker = ker * ker * ker;

            // 粘性項
            acc_i += (coefViscosity * prr_ij.y * ker) * vel_ij;

            // 圧力項と人工斥力
            float pres_ij  = -prr_ij.x * prr_ij.y;
            float repul_ij = coefRepul * rr * max(0.98 * dp - r, 0.0);
            acc_i += (pres_ij * ker + repul_ij) * pos_ij;
        }
    }

    vec2 boxSize = vec2(5.0, 1.5);
    float boxRadius = 0.8;
    
    // Apply animation (must match ms.frag)
    float angle = sin(u_time * 1.2) * 0.15 * u_wave_amplitude;
    float offsetX = sin(u_time * 0.8) * 1.0 * u_wave_amplitude;
    
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    vec2 p = pos_i;
    p.y -= 3.0; // Offset up
    p.x -= offsetX;
    p = rot * p;

    float dist_iw = -sdRoundedBox(p, boxSize, boxRadius) + 0.5 * dp;
    if (dist_iw < kernelRadius) {
        vec2  accWKer = texture(accWallKerTex, vec2(dist_iw * rcplKernelRadius, 0.5)).xy;
        vec2  posDir  = calcRoundedBoxNormal(p, boxSize, boxRadius);
        // Transform normal back to world space
        posDir = vec2(cos(-angle) * posDir.x - sin(-angle) * posDir.y, sin(-angle) * posDir.x + cos(-angle) * posDir.y);
        
        float pres    = max((pr_i.x + rho0 * dot(g, dist_iw * posDir)) * pr_i.y * rcplRho0, 0.0);
        float repul   = 10.0 * coefRepul * clamp(dp - dist_iw, 0.0, 0.5 * dp);
        acc_i += (pres * accWKer.x - repul) * posDir + 0.2 * coefViscosity * vel_i * pr_i.y * rcplRho0 * accWKer.y;
    }

    acc_i *= coefAcceleration;
    acc_i += g;

    return acc_i;
}

void main(void) {
    float particleIndex = floor(gl_FragCoord.y) * round(1.0 / particleTexelSizeOffset.x) + floor(gl_FragCoord.x);
    float activeCount = u_progress * particleCount;
    
    if (particleIndex >= activeCount) {
        // Hide particle
        oPos = vec4(1000.0, 1000.0, 0.0, 0.0);
        oVel = vec2(0.0);
        oIntPos = ivec2(round(vec2(1000.0, 1000.0) * toIntPos));
        return;
    }

    vec2 acc  = calcAcceleration();
    vec4 pvh  = texture(posTex, gl_FragCoord.xy * particleTexelSizeOffset.xy);
    vec2 pos  = pvh.xy;
    vec2 velh = pvh.zw;

    if (pos.x > 500.0) {
        // Just became active! Teleport to top of capsule
        float randX = fract(sin(particleIndex * 12.9898) * 43758.5453) * 10.0 - 5.0;
        pos = vec2(randX, 3.0);
        velh = vec2(0.0, -2.0);
    }

    float dist_im_sq = dot(pos - pointerPosVel.xy, pos - pointerPosVel.xy);
    if (dist_im_sq < pointerRadius * pointerRadius) {
        float scale = 1.0 - dist_im_sq / (pointerRadius * pointerRadius);
        vec2 temp = velh + pointerPosVel.zw * scale * scale * scale;
        if (dot(temp, temp) < 0.25 * velLimit * velLimit)
            velh = temp;
    }

    // leap-frog
    vec2 vel;
    velh += dt * acc;
    vel   = velh + 0.5 * dt * acc;
    if (dot(velh, velh) > velLimit * velLimit)
        velh = velLimit * normalize(velh);
    if (dot(vel, vel) > velLimit * velLimit)
        vel  = velLimit * normalize(vel);
    pos += dt * velh;

    oPos    = vec4(pos, velh);
    oVel    = vel;
    oIntPos = ivec2(round(pos * toIntPos));
}
