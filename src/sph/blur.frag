#version 300 es

precision highp float;

// Разделимое размытие поля поверхности по Гауссу (один проход — одна ось).
// Убирает бугорки размером с частицу: настоящая вода в таком масштабе их не держит
// (поверхностное натяжение сглаживает всё мельче пары миллиметров), а волны
// крупнее частицы остаются.
uniform sampler2D srcTex;
uniform vec2 direction;   // (1, 0) или (0, 1)
uniform float sigma;      // в текселях

out mediump float oDistance;

void main(void) {
    ivec2 size = textureSize(srcTex, 0);
    ivec2 node = ivec2(floor(gl_FragCoord.xy));
    ivec2 dir = ivec2(direction);
    int radius = int(ceil(2.5 * sigma));
    float sum = 0.0;
    float wsum = 0.0;
    for (int i = -8; i <= 8; i++) {
        if (abs(i) > radius) continue;
        ivec2 q = clamp(node + dir * i, ivec2(0), size - 1);
        float w = exp(-0.5 * float(i * i) / (sigma * sigma));
        sum += w * texelFetch(srcTex, q, 0).x;
        wsum += w;
    }
    oDistance = sum / wsum;
}
