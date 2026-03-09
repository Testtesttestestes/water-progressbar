#version 300 es

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

uniform float smoothRadius;
uniform isampler2D intPosTex;
uniform usampler2D cellBeginEndTex;
uniform sampler2D stateTex;

out vec2 vPos;

vec2 idx2uv(in float idx, in vec4 tsizeOfs) {
    float y;
    float x = modf(idx * tsizeOfs.x + tsizeOfs.z, y);
    return vec2(x, y * tsizeOfs.y + tsizeOfs.w);
}

vec2 cell2uv(in vec2 cell) {
    return idx2uv(cell.y * cellResolution.x + cell.x, cellTexelSizeOffset);
}

void main(void) {
    float idx = float(gl_VertexID);
    vec2  uv  = idx2uv(idx, particleTexelSizeOffset);
    gl_Position  = vec4(uv * 2.0 - 1.0, 0, 1);
    gl_PointSize = 1.0;

    vec2 state_i = texture(stateTex, uv).xy;
    if (state_i.x < 0.5) {
        vPos = vec2(1000.0); // Move inactive particles far away
        return;
    }

    vec2  pos_i  = vec2(texture(intPosTex, uv).xy) * toFloatPos;
    vec2  cell_i = floor((pos_i - cellOrigin) * rcplCellSize);
    vec3  wx_i   = vec3(0);
    float smoothRadiusSq = smoothRadius * smoothRadius;
    float smoothRadiusCb = smoothRadiusSq * smoothRadius;

    for (float cy = -3.; cy <= 3.; cy++) {
        float y = cell_i.y + cy;
        if (y < 0.0 || y >= cellResolution.y) continue;
        
        float cx_min = max(cell_i.x - 3.0, 0.0);
        float cx_max = min(cell_i.x + 3.0, cellResolution.x - 1.0);
        
        vec2 uv_cb = cell2uv(vec2(cx_min, y));
        vec2 uv_ce = cell2uv(vec2(cx_max, y));
        float begin = vec2(texture(cellBeginEndTex, uv_cb).xy).x;
        float end   = vec2(texture(cellBeginEndTex, uv_ce).xy).y;

        for (float j = begin; j < end; j++) {
            vec2 uv_j = idx2uv(j, particleTexelSizeOffset);
            
            vec2 state_j = texture(stateTex, uv_j).xy;
            if (state_j.x < 0.5) continue;

            vec2  pos_j  = vec2(texture(intPosTex, uv_j).xy) * toFloatPos;
            vec2  pos_ij = pos_i - pos_j;
            float r_sq = dot(pos_ij, pos_ij);
            if (r_sq > smoothRadiusSq) continue;

            float w = smoothRadiusCb - r_sq * sqrt(r_sq);
            wx_i += w * vec3(pos_j, 1);
        }
    }

    const float lambda = 0.9;
    vPos = (1.0 - lambda) * pos_i + lambda * wx_i.xy / wx_i.z;
}
