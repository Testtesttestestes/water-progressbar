import { Program, Target, drawFullscreen, UniformValue } from './gl';
import { FS_BLUR_PHI, FS_HIGHLIGHTS, FS_SCENE, FS_BUBBLES, VS_BUBBLES, VS_FULLSCREEN_RENDER } from './renderShaders';
import { BUBBLE_COUNT, Bubbles } from './bubbles';
import { Caustics } from './caustics';
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

/** Отрисовка колбы с водой: сцена → пузырьки → блики стекла. */
export class FluidRenderer {
  private scene: Program;
  private highlights: Program;
  private bubbles: Program;
  private blur: Program;
  private blurTemp: Target | null = null;
  private caustics: Caustics | null = null;
  private causticsFor: FluidSolver | null = null;

  constructor(private gl: WebGL2RenderingContext) {
    this.scene = new Program(gl, VS_FULLSCREEN_RENDER, FS_SCENE);
    this.highlights = new Program(gl, VS_FULLSCREEN_RENDER, FS_HIGHLIGHTS);
    this.bubbles = new Program(gl, VS_BUBBLES, FS_BUBBLES);
    this.blur = new Program(gl, VS_FULLSCREEN_RENDER, FS_BLUR_PHI);
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

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.scene.use(common);
    drawFullscreen(gl);

    gl.enable(gl.BLEND);
    if (opts.bubbles) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.bubbles.use({ ...common, uBubbles: opts.bubbles.texture });
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, BUBBLE_COUNT);
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
  }
}
