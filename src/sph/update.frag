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
uniform float particleCount;
// Активны частицы в слотах [0, u_active_count) (см. sortparticles.vert).
uniform float u_active_count;
// Отрезок по x, на котором рождаются новые частицы (внутри колбы на высоте
// расчётного уровня воды): xy — концы отрезка, z — его высота y.
uniform vec3 u_spawn_line;
uniform float u_time;
uniform float u_wave_amplitude;
uniform vec2 u_container_pos;
uniform vec2 u_container_vel;
uniform float u_container_angle;
uniform float u_container_ang_vel;
uniform vec2 u_flask_half_size;
uniform float u_flask_radius;
uniform sampler2D  posTex;
uniform isampler2D intPosTex;
uniform sampler2D  velTex;
uniform usampler2D cellBeginEndTex;
uniform sampler2D  accWallKerTex;


layout(location = 0) out vec4 oPos;
layout(location = 1) out vec2 oVel;
layout(location = 2) out ivec2 oIntPos;

// Маркер неактивной частицы (см. initparticles.frag).
const int INACTIVE = -32768;

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

    vec2 boxSize = u_flask_half_size;
    float boxRadius = u_flask_radius;
    
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

    // Симуляция идёт в мировой системе координат: колба двигается, и стенки сами
    // передают воде импульс через граничные силы выше. Добавлять ещё и силу инерции
    // (-a_container) значило бы учесть движение колбы дважды.
    acc_i *= coefAcceleration;
    acc_i += g;

    return acc_i;
}

vec2 wallVelocityAt(vec2 p) {
    vec2 r = p - u_container_pos;
    return u_container_vel + vec2(-r.y, r.x) * u_container_ang_vel;
}

// Сколько соседей у частицы в радиусе ядра (с ней самой).
float neighborCount(vec2 p) {
    vec2 c = floor((p - cellOrigin) * rcplCellSize);
    float count = 0.0;
    for (float cy = -1.; cy <= 1.; cy++) {
        vec2 begEnd = vec2(texture(cellBeginEndTex, cell2uv(vec2(c.x, c.y + cy))).xy);
        for (float j = begEnd.x; j < begEnd.y; j++) {
            vec2 d = p - vec2(texture(intPosTex, idx2uv(j, particleTexelSizeOffset)).xy) * toFloatPos;
            count += step(dot(d, d), kernelRadiusSq);
        }
    }
    return count;
}

// Высота поверхности воды в колонке x: идём по ячейкам сверху вниз и берём самую
// верхнюю частицу рядом с x, у которой есть опора (достаточно соседей).
// Падающие одиночные частицы не считаются: иначе следующая частица рождалась бы
// над ещё летящей, и над водой нарастала бы «морось». Без воды в колонке — -1e9.
float waterSurfaceAt(float x, float yFrom, float yTo) {
    const float MIN_SUPPORT = 5.0;
    float cx    = floor((x - cellOrigin.x) * rcplCellSize);
    float cyTop = floor((yFrom - cellOrigin.y) * rcplCellSize);
    float cyBot = max(floor((yTo - cellOrigin.y) * rcplCellSize), 0.0);
    cyTop = min(cyTop, cellResolution.y - 1.0);
    for (int k = 0; k < 96; k++) {
        float cy = cyTop - float(k);
        if (cy < cyBot) break;
        // cellBeginEnd хранит диапазон сразу трёх ячеек по x: [cx-1, cx+1].
        vec2 begEnd = vec2(texture(cellBeginEndTex, cell2uv(vec2(cx, cy))).xy);
        float best = -1e9;
        for (float j = begEnd.x; j < begEnd.y; j++) {
            vec2 pj = vec2(texture(intPosTex, idx2uv(j, particleTexelSizeOffset)).xy) * toFloatPos;
            if (abs(pj.x - x) < 1.5 * dp && pj.y > best && neighborCount(pj) >= MIN_SUPPORT)
                best = pj.y;
        }
        if (best > -1e8) return best;
    }
    return -1e9;
}

// Дно колбы в колонке x (с отступом от стенки), если воды в колонке ещё нет.
float flaskFloorAt(float x, mat2 invRot, float inset) {
    float y = u_container_pos.y;
    for (int k = 0; k < 160; k++) {
        vec2 pl = invRot * (vec2(x, y - 0.5 * dp) - u_container_pos);
        if (sdRoundedBox(pl, u_flask_half_size, u_flask_radius) > -inset) break;
        y -= 0.5 * dp;
    }
    return y;
}

void writeInactive() {
    oPos = vec4(0.0);
    oVel = vec2(0.0);
    oIntPos = ivec2(INACTIVE);
}

void main(void) {
    vec2  uv_i = gl_FragCoord.xy * particleTexelSizeOffset.xy;
    float slot = floor(gl_FragCoord.y) * round(1.0 / particleTexelSizeOffset.x) + floor(gl_FragCoord.x);
    if (slot >= u_active_count) {
        // Неактивна (или хвост текстуры за последней частицей). При сливе сюда
        // попадают верхние частицы: после сортировки последние слоты — самые верхние.
        writeInactive();
        return;
    }

    if (texture(intPosTex, uv_i).x == INACTIVE) {
        // Частица только что стала активной: рождается прямо над реальной поверхностью
        // воды в своей колонке и мягко ложится на неё — без падения струёй.
        // Золотое сечение раскладывает последовательные слоты по ширине равномерно,
        // поэтому рождённые подряд частицы не налезают друг на друга.
        float t = fract(slot * 0.6180339887 + 0.5);
        float x = mix(u_spawn_line.x, u_spawn_line.y, t);
        float reach = length(u_flask_half_size) + kernelRadius;
        float surface = waterSurfaceAt(x, u_container_pos.y + reach, u_container_pos.y - reach);
        float angle = u_container_angle;
        mat2 invRot = transpose(mat2(cos(angle), -sin(angle), sin(angle), cos(angle)));
        float y = surface > -1e8 ? surface + 0.9 * dp : flaskFloorAt(x, invRot, 1.0 * dp);
        y += 0.15 * dp * fract(slot * 0.7548776662);
        vec2 spawnPos = vec2(x, y);
        vec2 spawnVel = wallVelocityAt(spawnPos);
        oPos    = vec4(spawnPos, spawnVel);
        oVel    = spawnVel;
        oIntPos = ivec2(round(spawnPos * toIntPos));
        return;
    }

    vec2 acc  = calcAcceleration();
    vec4 pvh  = texture(posTex, uv_i);
    vec2 pos  = pvh.xy;
    vec2 velh = pvh.zw;

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

    vec2 boxSize = u_flask_half_size;
    float boxRadius = u_flask_radius;
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
