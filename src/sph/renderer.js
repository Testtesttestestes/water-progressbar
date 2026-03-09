import { Vec2 } from './mathtype.js';
import * as GLU from './glutils.js';
import { uniformBlockBindingTable } from './uniformblock.js';
import { ShaderProgram } from './shaderprogram.js';
import { FramebufferObject } from './framebufferobject.js';

import fullscreenVert from './fullscreen.vert?raw';
import pointspriteVert from './pointsprite.vert?raw';
import smoothposVert from './smoothpos.vert?raw';
import msVert from './ms.vert?raw';
import inittableVert from './inittable.vert?raw';

import backgroundFrag from './background.frag?raw';
import pointspriteFrag from './pointsprite.frag?raw';
import smoothposFrag from './smoothpos.frag?raw';
import weightedcenterFrag from './weightedcenter.frag?raw';
import distancefieldFrag from './distancefield.frag?raw';
import msFrag from './ms.frag?raw';
import inittableFrag from './inittable.frag?raw';

let _gl;
let _canvas;

const _vertSources = [
    fullscreenVert,
    pointspriteVert,
    smoothposVert,
    msVert,
    inittableVert
];
const _fragSources = [
    backgroundFrag,
    pointspriteFrag,
    smoothposFrag,
    weightedcenterFrag,
    distancefieldFrag,
    msFrag,
    inittableFrag
];

let _backgroundProgram;
let _pointSpriteProgram;
let _smoothPosProgram;
let _weightedCenterProgram;
let _distanceFieldProgram;
let _marchingSquaresProgram;
let _initTableProgram;

let _smoothPosFBO;
let _weightedCenterFBO;
let _distanceFieldFBO;

let _tabelTex;

let _resolution;
let _cellSize;
let _cellOrigin; 
let _meshSizeQualityFactor = 5.0;

let _renderingArea = { min: Vec2.zero(), max: new Vec2(1) };

let _simToClip = { scale: new Vec2(1), move: Vec2.zero() };

let _time = 0.0;
let _waveAmplitude = 0.0;
let _containerPos = new Vec2(0.0, 3.0);
let _containerAngle = 0.0;
let _containerSize = new Vec2(10.0, 3.0);

export const loadShaderFilesAsync = async () => {
    // Shaders are imported synchronously via Vite ?raw
};

export const init = (gl, canvas, meshSize, meshingAreaMin, meshingAreaMax, { meshSizeQualityFactor = 1.0 } = {}) => {
    _gl         = gl;
    _canvas     = canvas;
    _meshSizeQualityFactor = Math.max(meshSizeQualityFactor, 1.0);
    _cellSize   = meshSize / _meshSizeQualityFactor;
    _cellOrigin = meshingAreaMin;
    _resolution = (() => {
        let n = Vec2.div(Vec2.sub(meshingAreaMax, meshingAreaMin), _cellSize);
        let rx = 2**Math.ceil(Math.log2(n.x));
        let ry = 2**Math.ceil(Math.log2(n.y));
        return new Vec2(rx, ry);
    })();

    addEventListener('resize', _calcSimToClip);

    _createPrograms();
    _createFBOs();

    _initTableTex();

    GLU.bindUBO(_gl, uniformBlockBindingTable.MarchingSquares, [
        _resolution.x,   _resolution.y,
        1/_resolution.y, 1/_resolution.y,
        _cellOrigin.x,   _cellOrigin.y,
        _cellSize
    ]);
};

export const setAnimationParams = (time, waveAmplitude, containerPos = null, containerAngle = null) => {
    _time = time;
    _waveAmplitude = waveAmplitude;
    if (containerPos) _containerPos = containerPos;
    if (containerAngle !== null) _containerAngle = containerAngle;
};

export const setContainerSize = (size) => {
    _containerSize = size;
};

export const setRenderingSimulationArea = (min, max) => {
    _renderingArea = { min, max };
    _calcSimToClip();
};

export const clipPosToSimPos = (clipPos) => {
    return Vec2.div(Vec2.sub(clipPos, _simToClip.move), _simToClip.scale);
};


export const renderWater = (particleCount, dp, particleTexReso, intPosTex, _, cellBeginEndTex) => {
    if (_smoothPosFBO.width() !== particleTexReso.x || _smoothPosFBO.height() !== particleTexReso.y) {
        _smoothPosFBO.resize(particleTexReso.x, particleTexReso.y);
    }

    let smoothRadius = 3.0 * dp;

    _smoothPosProgram.use();
    _smoothPosFBO.bind();
    _gl.uniform1f(_smoothPosProgram.uniform('smoothRadius'), smoothRadius);
    GLU.bindTextureUniform(_gl, 0, _smoothPosProgram.uniform('intPosTex'), intPosTex);
    GLU.bindTextureUniform(_gl, 1, _smoothPosProgram.uniform('cellBeginEndTex'), cellBeginEndTex);
    _gl.drawArrays(_gl.POINTS, 0, particleCount);

    _weightedCenterProgram.use();
    _weightedCenterFBO.bind();
    _gl.uniform1f(_weightedCenterProgram.uniform('smoothRadius'), smoothRadius);
    GLU.bindTextureUniform(_gl, 0, _weightedCenterProgram.uniform('intPosTex'), _smoothPosFBO.texture('tex'));
    GLU.bindTextureUniform(_gl, 1, _weightedCenterProgram.uniform('cellBeginEndTex'), cellBeginEndTex);
    _gl.drawArrays(_gl.TRIANGLES, 0, 3);

    _distanceFieldProgram.use();
    _distanceFieldFBO.bind();
    _gl.uniform1f(_distanceFieldProgram.uniform('particleRadius'), dp * 8.5);
    GLU.bindTextureUniform(_gl, 0, _distanceFieldProgram.uniform('weightedCenterTex'), _weightedCenterFBO.texture('tex'));
    _gl.drawArrays(_gl.TRIANGLES, 0, 3);

    _gl.bindFramebuffer(_gl.DRAW_FRAMEBUFFER, null);
    _gl.viewport(0, 0, _canvas.width, _canvas.height);

    _marchingSquaresProgram.use();
    _gl.uniform2f(_marchingSquaresProgram.uniform('u_resolution'), _canvas.width, _canvas.height);
    _gl.uniform1f(_marchingSquaresProgram.uniform('u_time'), _time);
    _gl.uniform1f(_marchingSquaresProgram.uniform('u_wave_amplitude'), _waveAmplitude);
    _gl.uniform2f(_marchingSquaresProgram.uniform('u_container_pos'), _containerPos.x, _containerPos.y);
    _gl.uniform1f(_marchingSquaresProgram.uniform('u_container_angle'), _containerAngle);
    _gl.uniform2f(_marchingSquaresProgram.uniform('u_container_size'), _containerSize.x, _containerSize.y);
    _gl.uniform2f(_marchingSquaresProgram.uniform('u_sim_min'), _cellOrigin.x, _cellOrigin.y);
    _gl.uniform2f(_marchingSquaresProgram.uniform('u_sim_size'), _resolution.x * _cellSize, _resolution.y * _cellSize);
    GLU.bindTextureUniform(_gl, 0, _marchingSquaresProgram.uniform('distanceFieldTex'), _distanceFieldFBO.texture('tex'));
    _gl.drawArrays(_gl.TRIANGLES, 0, 3);
};

export const renderParticles = (particleCount, dp, _1, intPosTex, velTex, _2) => {
    _gl.bindFramebuffer(_gl.FRAMEBUFFER, null);
    _gl.viewport(0, 0, _canvas.width, _canvas.height);
    _gl.clearColor(0.2, 0.2, 0.2, 1);
    _gl.clear(_gl.COLOR_BUFFER_BIT);

    _pointSpriteProgram.use();
    _gl.uniform4f(_pointSpriteProgram.uniform('moveScale'), _simToClip.move.x, _simToClip.move.y, _simToClip.scale.x, _simToClip.scale.y);
    _gl.uniform1f(_pointSpriteProgram.uniform('particleRadius'), dp/2);
    GLU.bindTextureUniform(_gl, 0, _pointSpriteProgram.uniform('intPosTex'), intPosTex);
    GLU.bindTextureUniform(_gl, 1, _pointSpriteProgram.uniform('velTex'), velTex);
    _gl.drawArraysInstanced(_gl.TRIANGLE_STRIP, 0, 4, particleCount);
};

const _createPrograms = () => {
    const create = (vs, fs, location = null, stride = null, uniformBlockNames = []) => {
        let invalid = uniformBlockNames.filter(n => !(n in uniformBlockBindingTable));
        if (invalid.length > 0)
            throw new Error(`Invalid uniform block '${invalid}'`);
        
        return new ShaderProgram(_gl, vs, fs, location, stride, uniformBlockNames.map(n => [n, uniformBlockBindingTable[n]]));
    };
    _backgroundProgram      = create(_vertSources[0], _fragSources[0]);
    _pointSpriteProgram     = create(_vertSources[1], _fragSources[1], null, null, ['ParticleTexture', 'ToFloatPos']);
    _smoothPosProgram       = create(_vertSources[2], _fragSources[2], null, null, ['ParticleTexture', 'CellTexture', 'ToIntPos', 'ToFloatPos', 'Cell']);
    _weightedCenterProgram  = create(_vertSources[0], _fragSources[3], null, null, ['ParticleTexture', 'CellTexture', 'ToFloatPos', 'Cell', 'MarchingSquares']);
    _distanceFieldProgram   = create(_vertSources[0], _fragSources[4], null, null, ['MarchingSquares']);
    _marchingSquaresProgram = create(_vertSources[0], _fragSources[5], null, null, []);
    _initTableProgram       = create(_vertSources[4], _fragSources[6], [0], [1]);
};

const _createFBOs = () => {
    const create = (reso, namesFormats) => new FramebufferObject(_gl, reso.x, reso.y, namesFormats);
    _smoothPosFBO      = create(new Vec2(1), [['tex', 'RG16I'  ]]);
    _weightedCenterFBO = create(_resolution, [['tex', 'RGBA16F']]);
    _distanceFieldFBO  = create(_resolution, [['tex', 'R16F']]);
};

const _initTableTex = () => {
    const table = [
        //  いる頂点       いらない頂点
        0, 0, 0, 0, 0, 0,
        0, 4, 5,          5, 5, 5,
        1, 4, 6,          6, 6, 6,
        0, 1, 5, 6,       6, 6,
        2, 5, 7,          7, 7, 7,
        0, 4, 2,          7, 7, 7,
        5, 4, 2, 1, 7, 6,
        0, 2, 7, 0, 6, 1,
        3, 7, 6,          6, 6, 6,
        4, 6, 0, 3, 5, 7,
        4, 1, 7, 3,       3, 3,
        0, 1, 5, 7, 1, 3,   
        5, 6, 2, 3,       3, 3,
        0, 4, 2, 6, 2, 3,
        1, 4, 3, 5, 3, 2,
        0, 1, 2, 3,       3, 3];
    
    let vbo = GLU.createVBO(_gl, table);
    let fbo = new FramebufferObject(_gl, table.length, 1, [['tex', 'R16I']]);
    fbo.bind();
    _initTableProgram.use();
    _gl.uniform1f(_initTableProgram.uniform('texelSize'), 1/table.length);
    GLU.setAttributes(_gl, [vbo], _initTableProgram.location, _initTableProgram.stride);
    _gl.drawArrays(_gl.POINTS, 0, table.length);

    _tabelTex = fbo.texture('tex');
    fbo.detache('tex');
}

const _calcSimToClip = () => {
    let aspect = _canvas.width / _canvas.height;
    let tmp = aspect >= 1 ? new Vec2(1/aspect, 1) : new Vec2(1, aspect);
    _simToClip.scale = Vec2.mul(Vec2.div(tmp, Vec2.sub(_renderingArea.max, _renderingArea.min)), 2);
    _simToClip.move  = Vec2.minus(Vec2.add(Vec2.mul(_simToClip.scale, _renderingArea.min), tmp));
;}
