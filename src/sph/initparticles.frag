#version 300 es

precision highp float;

layout(std140) uniform ToIntPos { float toIntPos; };

// Маркер неактивной частицы в intPos. Представим в RG16I (в отличие от прежнего
// round(1000 * toIntPos), который переполнялся и «телепортировал» частицы в (-8, -8)).
const int INACTIVE = -32768;

uniform float activeCount;

in vec2 vPos;
in vec2 vVel;
in vec2 vVelh;
flat in float vSlot;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec2 oVel;
layout(location = 2) out ivec2 oIntPos;

void main(void){
    if (vSlot >= activeCount) {
        oPos = vec4(vPos, 0.0, 0.0);
        oVel = vec2(0.0);
        oIntPos = ivec2(INACTIVE);
        return;
    }
    oPos = vec4(vPos, vVelh);
    oVel = vVel;
    oIntPos = ivec2(round(vPos * toIntPos));
}
