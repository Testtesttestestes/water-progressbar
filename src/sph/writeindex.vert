#version 300 es

precision highp isampler2D;

layout(std140) uniform ParticleTexture { vec4  particleTexelSizeOffset; };
layout(std140) uniform SubcellTexture  { vec4  subcellTexelSizeOffset; };
layout(std140) uniform ToFloatPos      { float toFloatPos; };
layout(std140) uniform Subcell {
    vec2 subcellResolution;
    vec2 subcellOrigin;
    vec2 rcplSubcellSize;
};

// Маркер неактивной частицы (см. initparticles.frag).
const int INACTIVE = -32768;

uniform float particleCount;
uniform isampler2D intPosTex;

out float vIndex;

vec2 idx2uv(in float idx, in vec4 texelSizeOffset) {
    float y;
    float x = modf(idx * texelSizeOffset.x + texelSizeOffset.z, y);
    return vec2(x, y * texelSizeOffset.y + texelSizeOffset.w);
}

void main(void) {
    float vid = float(gl_VertexID);
    float idx = vid - particleCount * step(particleCount, vid);
    vIndex = idx + 1.0;

    ivec2 ipos    = texture(intPosTex, idx2uv(idx, particleTexelSizeOffset)).xy;
    if (ipos.x == INACTIVE) {
        // Вне клипа: частица не попадает в подъячейки и не считается соседом.
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 1.0;
        return;
    }
    vec2  pos     = vec2(ipos) * toFloatPos;
    vec2  subcell = floor((pos - subcellOrigin) * rcplSubcellSize);
    vec2  uv      = idx2uv(subcell.y * subcellResolution.x + subcell.x, subcellTexelSizeOffset);
    float depth   = (idx + 1.0) / (particleCount + 2.0);
    if (vid >= particleCount) {
        uv.y += 0.5;
        depth = 1.0 - depth;
    }

    gl_Position = vec4(uv * 2.0 - 1.0, depth, 1);
    gl_PointSize = 1.0;
}
