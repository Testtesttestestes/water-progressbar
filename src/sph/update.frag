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
    float wallRepulsionScale;
    float wallNormalViscScale;
    float wallTangentialViscScale;
    float wallTangentialFriction;
    float wallNormalRestitution;
    float wallMaxNormalEnergy;
};

uniform vec2  g;
uniform vec4  pointerPosVel;
uniform float pointerRadius;
uniform float u_progress;
uniform float particleCount;
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

float wallContactThickness() {
    return max(dp * 0.7, 0.05);
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
    
    float angle = u_container_angle;

    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    mat2 invRot = transpose(rot);
    vec2 p = invRot * (pos_i - u_container_pos);

    float contactThickness = wallContactThickness();
    float dist_iw = -sdRoundedBox(p, boxSize, boxRadius) + 0.5 * contactThickness;
    vec2 normalLocal = calcRoundedBoxNormal(p, boxSize, boxRadius);
    vec2 posDir = rot * normalLocal;
    if (dist_iw < kernelRadius) {
        vec2  accWKer = texture(accWallKerTex, vec2(dist_iw * rcplKernelRadius, 0.5)).xy;
        float sideWallFactor = smoothstep(0.6, 0.95, abs(normalLocal.x));
        
        float pres  = max((pr_i.x + rho0 * dot(g, dist_iw * posDir)) * pr_i.y * rcplRho0, 0.0);
        float repul = wallRepulsionScale * coefRepul * clamp(contactThickness - dist_iw, 0.0, 0.5 * contactThickness);

        vec2 r_local = pos_i - u_container_pos;
        vec2 wallVel = u_container_vel + vec2(-r_local.y, r_local.x) * u_container_ang_vel;
        vec2 relVel  = vel_i - wallVel;
        float relN   = dot(relVel, posDir);
        vec2 relT    = relVel - relN * posDir;

        float sideTangentialScale = mix(1.0, 0.15, sideWallFactor);
        float sidePressureScale = mix(1.0, 0.65, sideWallFactor);

        vec2 viscWall = (-wallNormalViscScale * relN * posDir - wallTangentialViscScale * sideTangentialScale * relT)
                      * coefViscosity * pr_i.y * rcplRho0 * accWKer.y;
        acc_i += (sidePressureScale * pres * accWKer.x - repul) * posDir + viscWall;
    }

    vec2 r_world = pos_i - u_container_pos;
    vec2 tangential = vec2(-r_world.y, r_world.x) * u_container_ang_acc;
    vec2 centripetal = -u_container_ang_vel * u_container_ang_vel * r_world;
    vec2 a_container = u_container_acc + tangential + centripetal;

    acc_i *= coefAcceleration;
    acc_i += g - a_container;

    float impulseDecay = exp(-u_reverse_impulse_age * 30.0);
    vec2 deltaDir = normalize(u_reverse_delta_v + vec2(1e-5, 0.0));
    float endBlend = smoothstep(3.0, 5.0, abs(p.x));
    float edgeWeight = endBlend * exp(-abs(dist_iw) * 6.0);
    float normalAlign = max(dot(posDir, -deltaDir), 0.0);
    float impulse = u_reverse_impulse_strength * impulseDecay * edgeWeight * normalAlign;
    if (u_reverse_impulse_strength > 0.0 && dist_iw < kernelRadius) {
        acc_i += posDir * impulse;
    }

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

    vec2 boxSize = vec2(5.0, 1.5);
    float boxRadius = 0.8;
    float angle = u_container_angle;
    mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
    mat2 invRot = transpose(rot);
    vec2 pLocal = invRot * (pos - u_container_pos);
    float contactThickness = wallContactThickness();
    float dist_iw = -sdRoundedBox(pLocal, boxSize, boxRadius) + 0.5 * contactThickness;
    vec2 normalLocal = calcRoundedBoxNormal(pLocal, boxSize, boxRadius);
    vec2 wallNormal = rot * normalLocal;

    if (dist_iw < contactThickness) {
        vec2 r_world = pos - u_container_pos;
        vec2 wallVel = u_container_vel + vec2(-r_world.y, r_world.x) * u_container_ang_vel;
        vec2 relVel = velh - wallVel;
        float relVN = dot(relVel, wallNormal);
        vec2 relVT = relVel - relVN * wallNormal;

        if (relVN > 0.0) {
            // Suppress per-particle ballistic bounces so the splash stays coherent.
            relVN = -wallNormalRestitution * relVN;
            float normalEnergy = 0.5 * relVN * relVN;
            float softClamp = sqrt(wallMaxNormalEnergy / (wallMaxNormalEnergy + normalEnergy + 1e-6));
            relVN *= softClamp;
        }

        float nearWallBlend = 1.0 - clamp(dist_iw / contactThickness, 0.0, 1.0);
        float sideWallFactor = smoothstep(0.55, 0.9, abs(normalLocal.x));
        float tangentialDamping = clamp(1.0 - wallTangentialFriction * dt * (0.7 + 0.3 * nearWallBlend), 0.0, 1.0);
        relVT *= tangentialDamping;

        // Shared tangential drift from flask motion makes the whole contact layer move together.
        vec2 wallTangent = vec2(-wallNormal.y, wallNormal.x);
        float wallSlip = dot(wallVel, wallTangent);
        float sideWallSlipCoupling = mix(1.0, 0.2, sideWallFactor);
        wallVel -= (1.0 - sideWallSlipCoupling) * wallSlip * wallTangent;
        wallSlip *= sideWallSlipCoupling;
        float cohesiveSlip = wallSlip * nearWallBlend * u_wave_amplitude * 0.35 * (1.0 - sideWallFactor);

        velh = wallVel + relVN * wallNormal + relVT + cohesiveSlip * wallTangent;
    }

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
