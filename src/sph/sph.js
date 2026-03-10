import { Vec2 } from './mathtype.js';
import * as GLU from './glutils.js';
import { uniformBlockBindingTable } from './uniformblock.js';
import { ShaderProgram } from './shaderprogram.js';
import { FramebufferObject } from './framebufferobject.js';

import initparticlesVert from './initparticles.vert?raw';
import initwallkernelVert from './initwallkernel.vert?raw';
import sphVert from './sph.vert?raw';
import writeindexVert from './writeindex.vert?raw';
import aggregatesubcellVert from './aggregatesubcell.vert?raw';
import xwidthscanVert from './xwidthscan.vert?raw';
import cellbeginendVert from './cellbeginend.vert?raw';
import sortparticlesVert from './sortparticles.vert?raw';

import initparticlesFrag from './initparticles.frag?raw';
import initwallkernelFrag from './initwallkernel.frag?raw';
import pressureFrag from './pressure.frag?raw';
import updateFrag from './update.frag?raw';
import writeindexFrag from './writeindex.frag?raw';
import aggregatesubcellFrag from './aggregatesubcell.frag?raw';
import xwidthscanFrag from './xwidthscan.frag?raw';
import cellbeginendFrag from './cellbeginend.frag?raw';
import sortparticlesFrag from './sortparticles.frag?raw';

let _gl;

const _gravity       = new Vec2(0, -10);
let _gravityScale    = 2.0;
const _gravityScaleNormalization = 2.0;
const _rho0          = 1; //1000だと圧力が半精度では表現できなくなるので適当な値にする
const _viscosity     = 0.18 * _rho0;
const _surfTension   = 2;

const _vertSources = [
    initparticlesVert,
    initwallkernelVert,
    sphVert,
    writeindexVert,
    aggregatesubcellVert,
    xwidthscanVert,
    cellbeginendVert,
    sortparticlesVert
];
const _fragSources = [
    initparticlesFrag,
    initwallkernelFrag,
    pressureFrag,
    updateFrag,
    writeindexFrag,
    aggregatesubcellFrag,
    xwidthscanFrag,
    cellbeginendFrag,
    sortparticlesFrag
];

let _calcPressureProgram;
let _updateParticlesProgram;
let _writeIndexProgram;
let _aggregateSubcellProgram;
let _xWidthScanProgram;
let _cellBeginEndProgram;
let _sortParticlesProgram;

let _posVelReadFBO;
let _posVelWriteFBO;
let _calcPressureFBO;
let _writeIndexFBO;
let _aggregateSubcellFBO;
let _xWidthScanFBO;
let _cellBeginEndFBO;

let _wallKernelTex;

let _fluidDomainRadius;
let _kernelRadius;
let _dp;
let _dt;
let _updateStaticParams;

let _particleCount;

let _cellResolution;
let _subcellResolution;

let _particleTextureResolution;
let _cellTextureResolution;
let _subcellTextureResolution;

let _is1stStep = true;

let _pointerPos = Vec2.zero();
let _pointerVel = Vec2.zero();

let _progress = 1.0;
let _flaskShape = {
    boxHalfSize: new Vec2(5.0, 1.5),
    radius: 0.8,
};
let _time = 0.0;
let _waveAmplitude = 0.0;
let _containerKinematics = {
    position: Vec2.zero(),
    velocity: Vec2.zero(),
    acceleration: Vec2.zero(),
    angle: 0.0,
    angularVelocity: 0.0,
    angularAcceleration: 0.0,
    reverseImpulseStrength: 0.0,
    reverseImpulseAge: 1e6,
    reverseDeltaV: Vec2.zero(),
    wallRepulsionScale: 4.0,
    wallNormalViscScale: 0.12,
    wallTangentialViscScale: 0.45,
    wallTangentialFriction: 11.0,
    wallNormalRestitution: 0.02,
    wallMaxNormalEnergy: 5.0,
};

const _helper = {
    sampleParticles5x5: (dp) => {
        let p = [];
        for (let yi = -2; yi < 3; yi++)
            for (let xi = -2; xi < 3; xi++)
                p.push(new Vec2(xi * dp, yi * dp));
        return p;
    },

    poly6Kernel:       (r, R) => (r > R) ? 0 : (R*R - r*r)**3,
    ddrWendlandKernel: (r, R) => (r > R) ? 0 : (1 - r/R)**3
};



export const loadShaderFilesAsync = async () => {
    // Shaders are imported synchronously via Vite ?raw
};

export const init = (gl, particleSpacing, fluidDomainRadius, posArray) => {
    _gl = gl;
    _dp = particleSpacing;
    _fluidDomainRadius = fluidDomainRadius;

    _particleCount = posArray.length / 2;
    console.log(`${_particleCount} particles`);

    _initParams();
    _createMainPrograms();
    _createMainFBOs();

    _initWallKernelTex();

    let vel  = new Array(posArray.length).fill(0);
    let g = _scaledGravity();
    let velh = vel.map((v, i) => v-_dt/2*(i%2===0?g.x:g.y));
    let particleVBOs = [posArray, vel, velh].map(a => GLU.createVBO(_gl, a));
    _initPosVelTex(particleVBOs);
};

export const step = () => {
    if (_is1stStep)
        _is1stStep = false;
    else
        _updateParticles();

    _sortParticles();

    _calcPressure();
};

export const setPointerPos = (pos) => {
    _pointerPos = pos;
};

export const setPointerVel = (vel) => {
    _pointerVel = vel;
};

export const visualize = (callback) => {
    callback(_particleCount, 
            _dp, 
            _particleTextureResolution, 
            _posVelReadFBO.texture('intPos'), 
            _posVelReadFBO.texture('vel'), 
            _cellBeginEndFBO.texture('cellBeginEnd')
    );
};

export const injectWater = (volumeRatio) => {
    _progress = volumeRatio;
};

export const setAnimationParams = (time, waveAmplitude) => {
    _time = time;
    _waveAmplitude = waveAmplitude;
};

export const setGravityScale = (scale) => {
    _gravityScale = Math.max(0, scale) * _gravityScaleNormalization;
};

export const setContainerKinematics = (kinematics) => {
    _containerKinematics = {
        ..._containerKinematics,
        ...kinematics,
    };
};

const _scaledGravity = () => Vec2.mul(_gravityScale, _gravity);

//-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const _bindUpdateUBO = () => {
    GLU.bindUBO(_gl, uniformBlockBindingTable.Update, [
        _updateStaticParams.effectiveParticleMaxUV.x, _updateStaticParams.effectiveParticleMaxUV.y,
        _dp,
        _rho0, 1 / _rho0,
        _kernelRadius, _kernelRadius**2, 1 / _kernelRadius,
        _viscosity,
        _updateStaticParams.surfaceTensionCoef,
        _updateStaticParams.accelerationCoef,
        _updateStaticParams.repulsionCoef,
        _fluidDomainRadius,
        _dt,
        _updateStaticParams.velLimit,
        _containerKinematics.wallRepulsionScale,
        _containerKinematics.wallNormalViscScale,
        _containerKinematics.wallTangentialViscScale,
        _containerKinematics.wallTangentialFriction,
        _containerKinematics.wallNormalRestitution,
        _containerKinematics.wallMaxNormalEnergy
    ]);
};

const _initParams = () => {
    let toIntPos   = (2**15 - 1) / Math.ceil(_fluidDomainRadius);
    let toFloatPos = 1 / toIntPos;
    let volume0    = _dp**2;
    let mass       = _rho0 * volume0;
    let h          = 1.02 * _dp;
    _kernelRadius  = 2*h;
    let gravityLength = Math.max(Vec2.length(_scaledGravity()), 1e-4);
    let velLimit   = Math.sqrt(2 * gravityLength * _fluidDomainRadius);
    let speedSound = 3 * velLimit;
    _dt            = 0.45 * h / velLimit;
    let pressB     = _rho0 * speedSound * speedSound / 2;
    let poly6KernelAlpha = (() => {
        let sum = 0;
        for (let r of _helper.sampleParticles5x5(_dp))
            sum += _helper.poly6Kernel(Vec2.length(r), _kernelRadius);
        return 1 / (volume0 * sum);
    })();
    let gradWendlandKernelAlpha = -7 / (4 * Math.PI * h**4) * 5;

    _particleTextureResolution = new Vec2(2**Math.ceil(Math.log2(_particleCount) / 2));
    let particleTexelSize      = Vec2.reciprocal(_particleTextureResolution);
    let effectiveParticleMaxUV = new Vec2(
        (_particleCount % _particleTextureResolution.x + 1) * particleTexelSize.x, 
        Math.floor(_particleCount / _particleTextureResolution.x) * particleTexelSize.y
    );

    let cellSize              = _kernelRadius;
    _cellResolution           = new Vec2(2**(Math.ceil(Math.log2(_fluidDomainRadius / cellSize)) + 1)); // 2^nにして単純化
    _cellTextureResolution    = new Vec2(_cellResolution);
    let cellOrigin            = Vec2.mul(new Vec2(-cellSize), Vec2.div(_cellResolution, 2));
    let cellTexelSize         = Vec2.reciprocal(_cellTextureResolution);
    let subcellSize           = new Vec2(cellSize/4, cellSize/2);
    _subcellResolution        = new Vec2(4*_cellResolution.x, 2*_cellResolution.y);
    _subcellTextureResolution = new Vec2(_subcellResolution.x, 2*_subcellResolution.y);
    let subcellTexelSize      = Vec2.reciprocal(_subcellTextureResolution);
    let subcellOrigin         = cellOrigin;

    GLU.bindUBO(_gl, uniformBlockBindingTable.ParticleTexture, [particleTexelSize.x, particleTexelSize.y, 0.5 * particleTexelSize.x, 0.5 * particleTexelSize.y]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.CellTexture,     [cellTexelSize.x,     cellTexelSize.y,     0.5 * cellTexelSize.x,     0.5 * cellTexelSize.y]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.SubcellTexture,  [subcellTexelSize.x,  subcellTexelSize.y,  0.5 * subcellTexelSize.x,  0.5 * subcellTexelSize.y]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.ToIntPos,        [toIntPos]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.ToFloatPos,      [toFloatPos]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.Cell,            [_cellResolution.x, _cellResolution.y, cellOrigin.x, cellOrigin.y, 1/cellSize]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.Subcell,         [_subcellResolution.x, _subcellResolution.y, subcellOrigin.x, subcellOrigin.y, 1/subcellSize.x, 1/subcellSize.y]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.SPHVertexShader, [0.5 * particleTexelSize.x, 0.5 * particleTexelSize.y, 1, effectiveParticleMaxUV.y + particleTexelSize.y]);
    GLU.bindUBO(_gl, uniformBlockBindingTable.Density, [
        effectiveParticleMaxUV.x, effectiveParticleMaxUV.y, 
        _dp, 
        1/_rho0, 
        _kernelRadius, _kernelRadius**2, 1/_kernelRadius, 
        mass * poly6KernelAlpha, 
        pressB, 
        _fluidDomainRadius]);
    _updateStaticParams = {
        effectiveParticleMaxUV,
        surfaceTensionCoef: _surfTension * poly6KernelAlpha / (mass * gradWendlandKernelAlpha),
        accelerationCoef: mass * gradWendlandKernelAlpha,
        repulsionCoef: 0.01 / (mass * gradWendlandKernelAlpha * _dt**2),
        velLimit
    };
    _bindUpdateUBO();
};

const _createProgram = (vsIdx, fsIdx, location = null, stride = null, uniformBlockNames = []) => {
    let invalid = uniformBlockNames.filter(n => !(n in uniformBlockBindingTable));
    if (invalid.length > 0)
        throw new Error(`Invalid uniform block '${invalid}'`);
    
    return new ShaderProgram(_gl, _vertSources[vsIdx], _fragSources[fsIdx], location, stride, uniformBlockNames.map(n => [n, uniformBlockBindingTable[n]]));
};

const _createMainPrograms = () => {
    _calcPressureProgram     = _createProgram(2, 2, null, null, ['SPHVertexShader', 'ParticleTexture', 'CellTexture', 'Cell', 'ToFloatPos', 'Density']);
    _updateParticlesProgram  = _createProgram(2, 3, null, null, ['SPHVertexShader', 'ParticleTexture', 'CellTexture', 'Cell', 'ToFloatPos', 'ToIntPos', 'Update']);
    _writeIndexProgram       = _createProgram(3, 4, null, null, ['ParticleTexture', 'SubcellTexture', 'Subcell', 'ToFloatPos']);
    _aggregateSubcellProgram = _createProgram(4, 5, null, null, ['CellTexture', 'SubcellTexture']);
    _xWidthScanProgram       = _createProgram(5, 6, null, null, ['CellTexture']);
    _cellBeginEndProgram     = _createProgram(6, 7, null, null, ['CellTexture_', 'CellTexture', 'Cell']);
    _sortParticlesProgram    = _createProgram(7, 8, null, null, ['ParticleTexture', 'Cell', 'Subcell', 'ToFloatPos', 'ToIntPos']);
};

const _createFBO = (reso, namesFormats, depth = false) => {
    return new FramebufferObject(_gl, reso.x, reso.y, namesFormats, depth);
};

const _createMainFBOs = () => {
    _posVelReadFBO       = _createFBO(_particleTextureResolution, [['posVelh', 'RGBA32F'], ['vel', 'RG16F'], ['intPos', 'RG16I']]);
    _posVelWriteFBO      = _createFBO(_particleTextureResolution, [['posVelh', 'RGBA32F'], ['vel', 'RG16F'], ['intPos', 'RG16I']]);
    _calcPressureFBO     = _createFBO(_particleTextureResolution, [['tex', 'RGBA16F']]);
    _writeIndexFBO       = _createFBO(_subcellTextureResolution,  [['tex',  'R32F']], true);
    _aggregateSubcellFBO = _createFBO(_cellTextureResolution,     [['cell', 'R8'  ], ['subcell', 'R32I']]);
    _xWidthScanFBO       = _createFBO(_cellTextureResolution,     [['tex',  'R16F']]);
    _cellBeginEndFBO     = _createFBO(_cellTextureResolution,     [['scan', 'R32F'], ['cellBeginEnd', 'RG16UI', , _gl.CLAMP_TO_EDGE]]);
};

const _initPosVelTex = (particleVBOs) => {
    let prg = _createProgram(0, 0, [0, 1, 2], [2, 2, 2], ['ParticleTexture', 'ToIntPos']);
    prg.use();
    GLU.setAttributes(_gl, particleVBOs, prg.location, prg.stride);

    _posVelReadFBO.bind();
    _gl.drawArrays(_gl.POINTS, 0, _particleCount);

    _posVelWriteFBO.bind();
    _gl.drawArrays(_gl.POINTS, 0, _particleCount);

    _gl.disableVertexAttribArray(1);
    _gl.disableVertexAttribArray(2);
};

const _initWallKernelTex = () => {
    const wallKernelResolution = 128;
    const createWallKernelVBO = () => {
        let wallKernel = [];
        let samplep = _helper.sampleParticles5x5(_dp);
        for (let yi = 0; yi < wallKernelResolution; yi++) {
            let p_i = new Vec2(0, yi * _kernelRadius / wallKernelResolution + 2 * _dp);
            let [wkDens, wkPres, wkVisc] = [0, 0, 0];
            for (let p_j of samplep) {
                let p_ij = Vec2.sub(p_i, p_j);
                let r = Vec2.length(p_ij);
                wkDens += _helper.poly6Kernel(r, _kernelRadius);
                wkPres += _helper.ddrWendlandKernel(r, _kernelRadius) * p_ij.y;
                wkVisc += _helper.ddrWendlandKernel(r, _kernelRadius);
            }
            wallKernel.push(wkDens, wkPres, wkVisc);
        }
        return GLU.createVBO(_gl, wallKernel);
    };

    let prg = _createProgram(1, 1);
    prg.use();
    let fbo = _createFBO(new Vec2(wallKernelResolution, 1), [['dens', 'R32F'], ['acc', 'RG32F']]);
    fbo.bind();

    _gl.uniform1f(prg.uniform('texelSize'), 1/wallKernelResolution);
    GLU.setAttributes(_gl, [createWallKernelVBO()], [0], [3]);
    _gl.drawArrays(_gl.POINTS, 0, wallKernelResolution);

    _wallKernelTex = { density: fbo.texture('dens'), acceleration: fbo.texture('acc') };
    fbo.detache('dens');
    fbo.detache('acc');
};

const _calcPressure = () => {
    _calcPressureProgram.use();
    _calcPressureFBO.bind();
    _gl.uniform1f(_calcPressureProgram.uniform('u_time'), _time);
    _gl.uniform1f(_calcPressureProgram.uniform('u_wave_amplitude'), _waveAmplitude);
    _gl.uniform2f(_calcPressureProgram.uniform('u_container_pos'), _containerKinematics.position.x, _containerKinematics.position.y);
    _gl.uniform2f(_calcPressureProgram.uniform('u_container_vel'), _containerKinematics.velocity.x, _containerKinematics.velocity.y);
    _gl.uniform2f(_calcPressureProgram.uniform('u_container_acc'), _containerKinematics.acceleration.x, _containerKinematics.acceleration.y);
    _gl.uniform1f(_calcPressureProgram.uniform('u_container_angle'), _containerKinematics.angle);
    _gl.uniform1f(_calcPressureProgram.uniform('u_container_ang_vel'), _containerKinematics.angularVelocity);
    _gl.uniform1f(_calcPressureProgram.uniform('u_container_ang_acc'), _containerKinematics.angularAcceleration);
    _gl.uniform1f(_calcPressureProgram.uniform('u_reverse_impulse_strength'), _containerKinematics.reverseImpulseStrength);
    _gl.uniform1f(_calcPressureProgram.uniform('u_reverse_impulse_age'), _containerKinematics.reverseImpulseAge);
    _gl.uniform2f(_calcPressureProgram.uniform('u_reverse_delta_v'), _containerKinematics.reverseDeltaV.x, _containerKinematics.reverseDeltaV.y);
    _gl.uniform2f(_calcPressureProgram.uniform('u_flask_half_size'), _flaskShape.boxHalfSize.x, _flaskShape.boxHalfSize.y);
    _gl.uniform1f(_calcPressureProgram.uniform('u_flask_radius'), _flaskShape.radius);
    GLU.bindTextureUniform(_gl, 0, _calcPressureProgram.uniform('intPosTex'),       _posVelReadFBO.texture('intPos'));
    GLU.bindTextureUniform(_gl, 1, _calcPressureProgram.uniform('velTex'),          _posVelReadFBO.texture('vel'));
    GLU.bindTextureUniform(_gl, 2, _calcPressureProgram.uniform('cellBeginEndTex'), _cellBeginEndFBO.texture('cellBeginEnd'));
    GLU.bindTextureUniform(_gl, 3, _calcPressureProgram.uniform('densWallKerTex'),  _wallKernelTex.density);
    _gl.drawArrays(_gl.TRIANGLE_STRIP, 0, 4);
};

const _updateParticles = () => {
    _bindUpdateUBO();

    _updateParticlesProgram.use();
    _posVelWriteFBO.bind();
    const g = _scaledGravity();
    _gl.uniform2f(_updateParticlesProgram.uniform('g'), g.x, g.y);
    _gl.uniform4f(_updateParticlesProgram.uniform('pointerPosVel'), _pointerPos.x, _pointerPos.y, _pointerVel.x, _pointerVel.y);
    _gl.uniform1f(_updateParticlesProgram.uniform('pointerRadius'), 3);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_progress'), _progress);
    _gl.uniform1f(_updateParticlesProgram.uniform('particleCount'), _particleCount);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_time'), _time);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_wave_amplitude'), _waveAmplitude);
    _gl.uniform2f(_updateParticlesProgram.uniform('u_container_pos'), _containerKinematics.position.x, _containerKinematics.position.y);
    _gl.uniform2f(_updateParticlesProgram.uniform('u_container_vel'), _containerKinematics.velocity.x, _containerKinematics.velocity.y);
    _gl.uniform2f(_updateParticlesProgram.uniform('u_container_acc'), _containerKinematics.acceleration.x, _containerKinematics.acceleration.y);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_container_angle'), _containerKinematics.angle);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_container_ang_vel'), _containerKinematics.angularVelocity);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_container_ang_acc'), _containerKinematics.angularAcceleration);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_reverse_impulse_strength'), _containerKinematics.reverseImpulseStrength);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_reverse_impulse_age'), _containerKinematics.reverseImpulseAge);
    _gl.uniform2f(_updateParticlesProgram.uniform('u_reverse_delta_v'), _containerKinematics.reverseDeltaV.x, _containerKinematics.reverseDeltaV.y);
    _gl.uniform2f(_updateParticlesProgram.uniform('u_flask_half_size'), _flaskShape.boxHalfSize.x, _flaskShape.boxHalfSize.y);
    _gl.uniform1f(_updateParticlesProgram.uniform('u_flask_radius'), _flaskShape.radius);
    GLU.bindTextureUniform(_gl, 0, _updateParticlesProgram.uniform('posTex'),          _posVelReadFBO.texture('posVelh'));
    GLU.bindTextureUniform(_gl, 1, _updateParticlesProgram.uniform('intPosTex'),       _posVelReadFBO.texture('intPos'));
    GLU.bindTextureUniform(_gl, 2, _updateParticlesProgram.uniform('velTex'),          _calcPressureFBO.texture('tex'));
    GLU.bindTextureUniform(_gl, 3, _updateParticlesProgram.uniform('cellBeginEndTex'), _cellBeginEndFBO.texture('cellBeginEnd'));
    GLU.bindTextureUniform(_gl, 4, _updateParticlesProgram.uniform('accWallKerTex'),   _wallKernelTex.acceleration);
    _gl.drawArrays(_gl.TRIANGLE_STRIP, 0, 4);

    [_posVelReadFBO, _posVelWriteFBO] = [_posVelWriteFBO, _posVelReadFBO];
};

const _sortParticles = () => {
    _writeIndexProgram.use();
    _writeIndexFBO.bind();
    _gl.enable(_gl.DEPTH_TEST);
    _gl.depthFunc(_gl.LESS);
    _gl.clearColor(0.0, 0.0, 0.0, 0.0);
    _gl.clearDepth(1.0);
    _gl.clear(_gl.COLOR_BUFFER_BIT | _gl.DEPTH_BUFFER_BIT);
    _gl.uniform1f(_writeIndexProgram.uniform('particleCount'), _particleCount);
    GLU.bindTextureUniform(_gl, 0, _writeIndexProgram.uniform('intPosTex'), _posVelReadFBO.texture('intPos'));
    _gl.drawArrays(_gl.POINTS, 0, 2 * _particleCount);
    _gl.invalidateFramebuffer(_gl.FRAMEBUFFER, [_gl.DEPTH_ATTACHMENT]);
    _gl.disable(_gl.DEPTH_TEST);

    _aggregateSubcellProgram.use();
    _aggregateSubcellFBO.bind();
    GLU.bindTextureUniform(_gl, 0, _aggregateSubcellProgram.uniform('indexTex'), _writeIndexFBO.texture('tex'));
    _gl.drawArrays(_gl.POINTS, 0, _cellResolution.x * _cellResolution.y);

    _xWidthScanProgram.use();
    _xWidthScanFBO.bind();
    GLU.bindTextureUniform(_gl, 0, _xWidthScanProgram.uniform('cellTex'), _aggregateSubcellFBO.texture('cell'));
    _gl.drawArrays(_gl.POINTS, 0, _cellResolution.x * _cellResolution.y);

    _cellBeginEndProgram.use();
    _cellBeginEndFBO.bind();
    GLU.bindTextureUniform(_gl, 0, _cellBeginEndProgram.uniform('xscanTex_'), _xWidthScanFBO.texture('tex'));
    GLU.bindTextureUniform(_gl, 1, _cellBeginEndProgram.uniform('xscanTex'),  _xWidthScanFBO.texture('tex'));
    GLU.bindTextureUniform(_gl, 2, _cellBeginEndProgram.uniform('cellTex'),   _aggregateSubcellFBO.texture('cell'));
    _gl.drawArraysInstanced(_gl.LINES, 0, 2, _cellResolution.y);

    _sortParticlesProgram.use();
    _posVelWriteFBO.bind();
    _gl.uniform1f(_sortParticlesProgram.uniform('particleCount'), _particleCount);
    GLU.bindTextureUniform(_gl, 0, _sortParticlesProgram.uniform('scanTex'),    _cellBeginEndFBO.texture('scan'));
    GLU.bindTextureUniform(_gl, 1, _sortParticlesProgram.uniform('subcellTex'), _aggregateSubcellFBO.texture('subcell'));
    GLU.bindTextureUniform(_gl, 2, _sortParticlesProgram.uniform('indexTex'),   _writeIndexFBO.texture('tex'));
    GLU.bindTextureUniform(_gl, 3, _sortParticlesProgram.uniform('intPosTex'),  _posVelReadFBO.texture('intPos'));
    GLU.bindTextureUniform(_gl, 4, _sortParticlesProgram.uniform('posTex'),     _posVelReadFBO.texture('posVelh'));
    GLU.bindTextureUniform(_gl, 5, _sortParticlesProgram.uniform('velTex'),     _posVelReadFBO.texture('vel'));
    _gl.drawArrays(_gl.POINTS, 0, _particleCount);

    [_posVelReadFBO, _posVelWriteFBO] = [_posVelWriteFBO, _posVelReadFBO];
};

export const setFlaskShape = ({ boxHalfSize, radius }) => {
    _flaskShape = {
        boxHalfSize: boxHalfSize ? new Vec2(boxHalfSize.x, boxHalfSize.y) : _flaskShape.boxHalfSize,
        radius: radius ?? _flaskShape.radius,
    };
};
