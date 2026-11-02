import { Program, Target, drawFullscreen, UniformValue } from './gl';
import { FS_BLUR_PHI, FS_HIGHLIGHTS, FS_SCENE, FS_BUBBLES, VS_BUBBLES, VS_FULLSCREEN_RENDER, VS_DROPS, FS_DROPS, FS_COPY, VS_WHITEWATER, FS_WHITEWATER_SPLAT, FS_WHITEWATER_COMPOSITE } from './renderShaders';
import { BUBBLE_COUNT, Bubbles } from './bubbles';
import { Caustics } from './caustics';
import { SPRAY_COUNT, Spray } from './spray';
import type { Whitewater } from './whitewater';
import { PARTICLE_ROW } from './particles';
import type { FluidSolver } from './solver';

export interface FlaskView {
  /** Центр и поворот колбы в мире (поворот против часовой, радианы). */
  position: [number, number];
  angle: number;
  /** Полуразмеры и радиус скругления по внешнему стеклу. */
  halfSize: [number, number];
  radius: number;
  glass: number;
  /** «Вверх» в системе колбы — для полосы поверхности и мениска. */
  up: [number, number];
}

export interface Camera {
  center: [number, number];
  height: number;
}

/** Отрисовка колбы с водой: сцена → пузырьки → брызги и капли → блики стекла. */
export class FluidRenderer {
  private scene: Program;
  private highlights: Program;
  private bubbles: Program;
  private blur: Program;
  private drops: Program;
  private copy: Program;
  private whiteSplat: Program;
  private whiteComposite: Program;
  private whiteDensity: Target | null = null;
  private sceneTarget: Target | null = null;
  private blurTemp: Target | null = null;
  private caustics: Caustics | null = null;
  private causticsFor: FluidSolver | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    this.scene = new Program(gl, VS_FULLSCREEN_RENDER, FS_SCENE);
    this.highlights = new Program(gl, VS_FULLSCREEN_RENDER, FS_HIGHLIGHTS);
    this.bubbles = new Program(gl, VS_BUBBLES, FS_BUBBLES);
    this.blur = new Program(gl, VS_FULLSCREEN_RENDER, FS_BLUR_PHI);
    this.drops = new Program(gl, VS_DROPS, FS_DROPS);
    this.copy = new Program(gl, VS_FULLSCREEN_RENDER, FS_COPY);
    this.whiteSplat = new Program(gl, VS_WHITEWATER, FS_WHITEWATER_SPLAT);
    this.whiteComposite = new Program(gl, VS_FULLSCREEN_RENDER, FS_WHITEWATER_COMPOSITE);
  }

  /** Сглаживает копию φ для отрисовки (σ в ячейках). */
  private smoothPhi(solver: FluidSolver, sigma: number) {
    const gl = this.gl;
    const t = solver.phiRender;
    if (!this.blurTemp || this.blurTemp.width !== t.width || this.blurTemp.height !== t.height) {
      this.blurTemp?.dispose();
      this.blurTemp = new Target(gl, t.width, t.height, ['R16F']);
    }
    gl.disable(gl.BLEND);
    this.blurTemp.bind();
    this.blur.use({ uSrc: t.texture, uDir: [1, 0], uSigma: sigma });
    drawFullscreen(gl);
    t.bind();
    this.blur.use({ uSrc: this.blurTemp.texture, uDir: [0, 1], uSigma: sigma });
    drawFullscreen(gl);
  }

  render(opts: {
    solver: FluidSolver;
    bubbles: Bubbles | null;
    spray?: Spray | null;
    whitewater?: Whitewater | null;
    background: WebGLTexture;
    backgroundSize: [number, number];
    width: number;
    height: number;
    flask: FlaskView;
    camera: Camera;
    time: number;
    /** Тяжесть (для дисперсии ряби) и волнение воды 0..1+. */
    gravity?: number;
    agitation?: number;
  }) {
    const gl = this.gl;
    const { solver, flask, camera, width, height } = opts;
    solver.prepareRender();
    this.smoothPhi(solver, 1.6);
    if (!this.caustics || this.causticsFor !== solver) {
      this.caustics?.dispose();
      this.caustics = new Caustics(gl, solver, flask.glass);
      this.causticsFor = solver;
    }
    this.caustics.update(flask.up, opts.gravity ?? 163, opts.time, opts.agitation ?? 0);

    // «cover»: фон заполняет холст без растяжения.
    const canvasAspect = width / height;
    const bgAspect = opts.backgroundSize[0] / opts.backgroundSize[1];
    const bgScale: [number, number] = canvasAspect > bgAspect ? [1, bgAspect / canvasAspect] : [canvasAspect / bgAspect, 1];

    const common: Record<string, UniformValue> = {
      ...solver.gridUniforms(),
      uPhi: solver.phiRender.texture,
      uResolution: [width, height],
      uViewCenter: camera.center,
      uViewHeight: camera.height,
      uFlaskPos: flask.position,
      uFlaskAngle: flask.angle,
      uFlaskHalf: flask.halfSize,
      uFlaskRadius: flask.radius,
      uGlass: flask.glass,
      uBevel: Math.min(0.3 * flask.halfSize[1], 0.6),
      uBg: opts.background,
      uBgScale: bgScale,
      uTime: opts.time,
      uUp: flask.up,
      uCaustics: this.caustics.target.texture,
      uSurfaceProfile: this.caustics.profile.texture,
      uCausticSize: [solver.cavityHalf[0], this.caustics.maxDepth],
    };

    // Сцену — в текстуру: капли преломляют то, что за ними (вода, стекло, комната).
    if (!this.sceneTarget || this.sceneTarget.width !== width || this.sceneTarget.height !== height) {
      this.sceneTarget?.dispose();
      this.sceneTarget = new Target(gl, width, height, ['RGBA8'], true);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.sceneTarget.bind();
    this.scene.use(common);
    drawFullscreen(gl);
    // Копия на экран проходом, а не blitFramebuffer: тот не пишет в
    // экранный буфер со сглаживанием (multisample).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    this.copy.use({ uSrc: this.sceneTarget.texture });
    drawFullscreen(gl);

    gl.enable(gl.BLEND);
    if (opts.bubbles) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.bubbles.use({ ...common, uBubbles: opts.bubbles.texture });
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, BUBBLE_COUNT);
    }
    if (opts.whitewater) {
      // Карта плотности белой воды — в половинном разрешении (пятна мягкие).
      const ww = Math.max(1, width >> 1), wh = Math.max(1, height >> 1);
      if (!this.whiteDensity || this.whiteDensity.width !== ww || this.whiteDensity.height !== wh) {
        this.whiteDensity?.dispose();
        this.whiteDensity = new Target(gl, ww, wh, ['RGBA16F'], true);
      }
      this.whiteDensity.bind();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ONE);
      const [wa, wb] = opts.whitewater.textures;
      this.whiteSplat.use({ ...common, uResolution: [ww, wh], uWA: wa, uWB: wb, uRow: PARTICLE_ROW });
      gl.drawArrays(gl.POINTS, 0, opts.whitewater.count);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.whiteComposite.use({ uDensity: this.whiteDensity.texture, uResolution: [width, height] });
      drawFullscreen(gl);
    }
    if (opts.spray) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const [a, b] = opts.spray.textures;
      this.drops.use({ ...common, uSprayA: a, uSprayB: b, uShutter: 1 / 60, uSceneTex: this.sceneTarget.texture });
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, SPRAY_COUNT);
    }
    gl.blendFunc(gl.ONE, gl.ONE);
    this.highlights.use(common);
    drawFullscreen(gl);
    gl.disable(gl.BLEND);
  }

  dispose() {
    this.scene.dispose();
    this.highlights.dispose();
    this.bubbles.dispose();
    this.blur.dispose();
    this.blurTemp?.dispose();
    this.caustics?.dispose();
    this.drops.dispose();
    this.copy.dispose();
    this.whiteSplat.dispose();
    this.whiteComposite.dispose();
    this.whiteDensity?.dispose();
    this.sceneTarget?.dispose();
  }
}
