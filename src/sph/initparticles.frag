#version 300 es

precision highp float;

layout(std140) uniform ToIntPos { float toIntPos; };

uniform float u_progress;
uniform float particleCount;

in vec2 vPos;
in vec2 vVel;
in vec2 vVelh;
flat in int vVertexID;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec2 oVel;
layout(location = 2) out ivec2 oIntPos;
layout(location = 3) out vec2 oState;

void main(void){
    oPos = vec4(vPos, vVelh);
    oVel = vVel;
    oIntPos = ivec2(round(vPos * toIntPos));
    float particleIndex = float(vVertexID);
    float activeCount = u_progress * particleCount;
    float isActive = step(particleIndex, activeCount - 1.0);
    oState = vec2(isActive, isActive);
}
