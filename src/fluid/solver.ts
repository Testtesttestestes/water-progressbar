import { Program, PingPong, Target, VS_FULLSCREEN, drawFullscreen, UniformValue } from './gl';
import * as S from './shaders';

// Несжимаемая двухфазная жидкость (вода + воздух) на сетке MAC в системе колбы.
//
// Шаг по времени (метод проекции Чорина):
//   1. перенос level set и скорости (MacCormack с ограничителем);
//   2. массовые силы: тяжесть и силы инерции от движения колбы;
//   3. реинициализация level set и точная поправка объёма воды под прогресс;
//   4. уравнение давления с переменной плотностью (красно-чёрный Гаусс–Зейдель
//      с верхней релаксацией) и вычитание градиента — поле скорости бездивергентно.
//
// Воздух тоже несжимаем, поэтому воздушные карманы не схлопываются, а всплывают.

export interface FluidConfig {
  /** Полуразмеры колбы по внешнему стеклу. */
  halfSize: [number, number];
  /** Радиус скругления углов колбы по внешнему стеклу. */
  radius: number;
  /** Толщина стекла. */
  glass: number;
  /** Число ячеек поперёк полости. */
  rows: number;
  /** Плотность воздуха относительно воды. Настоящая ≈ 0.0012; 0.05 почти не меняет
   *  поведение волн (частота ∝ √(Δρ/Σρ)), но многосеточный метод сходится намного лучше. */
  airDensity?: number;
  /** Начальная доля воды 0..1. */
  initialFill: number;
  /** Начальное направление «вверх» в системе колбы. */
  initialUp: [number, number];
}

export interface StepInput {
  dt: number;
  /** Тяжесть минус ускорение колбы, уже повёрнутые в систему колбы. */
  accel: [number, number];
  /** Угловая скорость и угловое ускорение колбы. */
  omega: number;
  omegaDot: number;
  /** Целевая доля воды 0..1. */
  fill: number;
}

// Давление: V-циклы многосеточного метода (на длинной сетке Гаусс–Зейдель сам
// почти не гасит длинные волны ошибки вдоль колбы).
const V_CYCLES = 3;
const INITIAL_V_CYCLES = 12;
const SMOOTH_ITERATIONS = 2;
const COARSEST_ITERATIONS = 12;
// Время затухания движения воды относительно колбы, с.
const DAMPING_TIME = 3.0;

interface Level {
  nx: number;
  ny: number;
  p: PingPong;
  rhs: Target;
  res: Target;
  coef: Target;
}

export class FluidSolver {
  readonly nx: number;
  readonly ny: number;
  readonly h: number;
  readonly origin: [number, number];
  readonly cavityHalf: [number, number];
  readonly cavityRadius: number;
  /** Площадь полости в площадях ячеек (для перевода доли воды в объём). */
  totalVolume = 0;

  readonly vel: PingPong;
  readonly phi: PingPong;
  readonly pressure: PingPong;
  readonly geo: Target;
  readonly phiRender: Target;
  private velHat: Target;
  private phiHat: Target;
  private phi0: Target;
  private ext: Target;
  private beta: Target;
  private rhs: Target;
  private columns: Target;
  private total: Target;

  private levels: Level[] = [];
  private programs: Record<string, Program> = {};
  private airDensity: number;
  private firstStep = true;
  private up: [number, number];

  constructor(private gl: WebGL2RenderingContext, cfg: FluidConfig) {
    if (!gl.getExtension('EXT_color_buffer_float'))
      throw new Error('WebGL2 extension EXT_color_buffer_float is required.');

    const [hx, hy] = cfg.halfSize;
    this.cavityHalf = [hx - cfg.glass, hy - cfg.glass];
    this.cavityRadius = Math.max(cfg.radius - cfg.glass, 0.02);
    this.ny = Math.max(16, Math.round(cfg.rows));
    this.h = (2 * this.cavityHalf[1]) / this.ny;
    this.nx = Math.ceil((2 * this.cavityHalf[0]) / this.h);
    this.origin = [(-this.nx * this.h) / 2, (-this.ny * this.h) / 2];
    this.airDensity = cfg.airDensity ?? 0.05;
    this.up = cfg.initialUp;

    const { nx, ny } = this;
    this.vel = new PingPong(gl, nx + 1, ny + 1, ['RG32F']);
    this.velHat = new Target(gl, nx + 1, ny + 1, ['RG32F']);
    this.geo = new Target(gl, nx + 1, ny + 1, ['RGBA32F']);
    // .0 — коэффициенты (w·β, β), .1 — скачки давления на гранях.
    this.beta = new Target(gl, nx + 1, ny + 1, ['RGBA32F', 'RG32F']);
    this.phi = new PingPong(gl, nx, ny, ['R32F']);
    this.phiHat = new Target(gl, nx, ny, ['R32F']);
    this.phi0 = new Target(gl, nx, ny, ['R32F']);
    this.ext = new Target(gl, nx, ny, ['RG32F']);
    this.pressure = new PingPong(gl, nx, ny, ['R32F']);
    this.rhs = new Target(gl, nx, ny, ['R32F']);
    this.columns = new Target(gl, nx, 1, ['RG32F']);
    this.total = new Target(gl, 1, 1, ['RG32F']);
    this.phiRender = new Target(gl, nx, ny, ['R16F'], true);

    // Уровни многосеточного решателя: каждый вдвое грубее, пока сетка не станет крошечной.
    this.levels.push({ nx, ny, p: this.pressure, rhs: this.rhs, res: new Target(gl, nx, ny, ['R32F']), coef: this.beta });
    // Огрубляем, пока большая сторона не станет крошечной: на вытянутой колбе иначе
    // самый грубый уровень остаётся длинным, и его итерации не гасят ошибку вдоль колбы.
    while (Math.max(this.levels[this.levels.length - 1].nx, this.levels[this.levels.length - 1].ny) > 8) {
      const prev = this.levels[this.levels.length - 1];
      const lx = Math.ceil(prev.nx / 2), ly = Math.ceil(prev.ny / 2);
      this.levels.push({
        nx: lx, ny: ly,
        p: new PingPong(gl, lx, ly, ['R32F']),
        rhs: new Target(gl, lx, ly, ['R32F']),
        res: new Target(gl, lx, ly, ['R32F']),
        coef: new Target(gl, lx + 1, ly + 1, ['RGBA32F']),
      });
    }

    const sources: Record<string, string> = {
      geometry: S.FS_GEOMETRY, extensionMap: S.FS_EXTENSION_MAP, extendPhi: S.FS_EXTEND_PHI,
      advectVel: S.FS_ADVECT_VEL, maccormackVel: S.FS_MACCORMACK_VEL, forces: S.FS_FORCES,
      advectPhi: S.FS_ADVECT_PHI, maccormackPhi: S.FS_MACCORMACK_PHI, reinit: S.FS_REINIT,
      volumeColumns: S.FS_VOLUME_COLUMNS, volumeTotal: S.FS_VOLUME_TOTAL, volumeCorrect: S.FS_VOLUME_CORRECT,
      beta: S.FS_BETA, divergence: S.FS_DIVERGENCE, pressure: S.FS_PRESSURE, project: S.FS_PROJECT,
      copyPhi: S.FS_COPY_PHI, planarPhi: S.FS_PLANAR_PHI,
      mgCoarsen: S.FS_MG_COARSEN, mgResidual: S.FS_MG_RESIDUAL, mgRestrict: S.FS_MG_RESTRICT,
      mgProlong: S.FS_MG_PROLONG, clear: S.FS_CLEAR,
    };
    for (const [name, fs] of Object.entries(sources)) this.programs[name] = new Program(gl, VS_FULLSCREEN, fs);

    this.withState(() => {
      this.run('geometry', this.geo, {});
      this.run('extensionMap', this.ext, { uGeo: this.geo.texture });
      // Площадь полости: объём при φ = −∞.
      this.run('planarPhi', this.phi.write, { uUp: [0, 1], uLevel: 1e6 });
      this.phi.swap();
      this.measureVolume();
      this.totalVolume = this.total.read()[0];

      // Начальная поверхность — плоская на уровне нужного объёма.
      this.run('planarPhi', this.phi.write, { uUp: this.up, uLevel: this.levelForFill(cfg.initialFill) });
      this.phi.swap();
      for (let i = 0; i < 12; i++) this.correctVolume(cfg.initialFill);
    });
  }

  private common(): Record<string, UniformValue> {
    return {
      uN: [this.nx, this.ny],
      uH: this.h,
      uOrigin: this.origin,
      uCavityHalf: this.cavityHalf,
      uCavityRadius: this.cavityRadius,
    };
  }

  private run(name: string, target: Target, uniforms: Record<string, UniformValue>) {
    target.bind();
    this.programs[name].use({ ...this.common(), ...uniforms });
    drawFullscreen(this.gl);
  }

  private withState(fn: () => void) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    fn();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Нижняя и верхняя точки полости вдоль направления up. */
  private levelsAlong(up: [number, number]): [number, number] {
    const [cx, cy] = this.cavityHalf;
    const r = this.cavityRadius;
    const support = (cx - r) * Math.abs(up[0]) + (cy - r) * Math.abs(up[1]) + r;
    return [-support, support];
  }

  /** Приблизительный уровень плоской поверхности для доли fill (точнее подгоняет поправка объёма). */
  private levelForFill(fill: number): number {
    const [lo, hi] = this.levelsAlong(this.up);
    const [cx, cy] = this.cavityHalf;
    const r = this.cavityRadius;
    const sd = (x: number, y: number) => {
      const qx = Math.abs(x) - cx + r, qy = Math.abs(y) - cy + r;
      return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
    };
    const samples: number[] = [];
    const n = 120;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = -cx + ((i + 0.5) / n) * 2 * cx, y = -cy + ((j + 0.5) / n) * 2 * cy;
        if (sd(x, y) < 0) samples.push(x * this.up[0] + y * this.up[1]);
      }
    samples.sort((a, b) => a - b);
    if (!samples.length) return lo;
    const k = Math.min(samples.length - 1, Math.max(0, Math.floor(fill * samples.length)));
    return fill <= 0 ? lo - this.h : fill >= 1 ? hi + this.h : samples[k];
  }

  private measureVolume() {
    this.run('volumeColumns', this.columns, { uPhi: this.phi.read.texture, uGeo: this.geo.texture });
    this.run('volumeTotal', this.total, { uColumns: this.columns.texture });
  }

  private correctVolume(fill: number) {
    this.measureVolume();
    this.run('volumeCorrect', this.phi.write, {
      uPhi: this.phi.read.texture,
      uSum: this.total.texture,
      uTargetVolume: Math.min(Math.max(fill, 0), 1) * this.totalVolume,
      uTotalVolume: this.totalVolume,
      uUp: this.up,
      uLevels: this.levelsAlong(this.up),
    });
    this.phi.swap();
  }

  private extendPhi(into: Target) {
    this.run('extendPhi', into, { uPhi: this.phi.read.texture, uGeo: this.geo.texture, uExt: this.ext.texture });
  }

  step(input: StepInput) {
    const { dt } = input;
    const g = Math.hypot(input.accel[0], input.accel[1]);
    // «Вверх» — против эффективной тяжести; в невесомости сохраняем прежнее направление.
    if (g > 1e-3) this.up = [-input.accel[0] / g, -input.accel[1] / g];

    this.withState(() => {
      // 1. Перенос level set по скорости шага n.
      this.run('advectPhi', this.phiHat, { uVel: this.vel.read.texture, uPhi: this.phi.read.texture, uDt: dt });
      this.run('maccormackPhi', this.phi.write, {
        uVel: this.vel.read.texture, uPhi: this.phi.read.texture, uHat: this.phiHat.texture, uDt: dt,
      });
      this.phi.swap();

      // 2. Перенос скорости.
      this.run('advectVel', this.velHat, { uVel: this.vel.read.texture, uDt: dt });
      this.run('maccormackVel', this.vel.write, { uVel: this.vel.read.texture, uHat: this.velHat.texture, uDt: dt });
      this.vel.swap();

      // 3. Тяжесть и силы инерции, непротекание стенок.
      this.run('forces', this.vel.write, {
        uVel: this.vel.read.texture, uGeo: this.geo.texture, uOmega: input.omega, uOmegaDot: input.omegaDot,
        uDamping: Math.exp(-dt / DAMPING_TIME), uDt: dt,
      });
      this.vel.swap();

      // 4. Level set: продолжение в стекло, реинициализация, точный объём.
      this.extendPhi(this.phi0);
      this.run('reinit', this.phi.write, { uPhi: this.phi0.texture, uPhi0: this.phi0.texture, uGeo: this.geo.texture, uDtau: 0.3 * this.h });
      this.phi.swap();
      this.run('reinit', this.phi.write, { uPhi: this.phi.read.texture, uPhi0: this.phi0.texture, uGeo: this.geo.texture, uDtau: 0.3 * this.h });
      this.phi.swap();
      this.extendPhi(this.phi.write);
      this.phi.swap();
      this.correctVolume(input.fill);

      // 5. Давление с переменной плотностью и проекция.
      this.run('beta', this.beta, {
        uPhi: this.phi.read.texture, uGeo: this.geo.texture, uRhoAir: this.airDensity, uAccel: input.accel, uOmega: input.omega,
      });
      this.run('divergence', this.rhs, {
        uVel: this.vel.read.texture, uGeo: this.geo.texture, uBeta: this.beta.textures[0], uJump: this.beta.textures[1], uDt: dt,
      });
      for (let l = 1; l < this.levels.length; l++) {
        const lv = this.levels[l], fine = this.levels[l - 1];
        this.run('mgCoarsen', lv.coef, { uN: [lv.nx, lv.ny], uFine: fine.coef.texture, uFineN: [fine.nx, fine.ny] });
      }
      const cycles = this.firstStep ? INITIAL_V_CYCLES : V_CYCLES;
      this.firstStep = false;
      for (let k = 0; k < cycles; k++) this.vcycle(0);
      this.run('project', this.vel.write, {
        uVel: this.vel.read.texture, uP: this.pressure.read.texture, uBeta: this.beta.textures[0], uJump: this.beta.textures[1],
        uGeo: this.geo.texture, uDt: dt,
      });
      this.vel.swap();
    });
  }

  private smooth(lv: Level, iterations: number, omega: number) {
    for (let k = 0; k < iterations; k++)
      for (let parity = 0; parity < 2; parity++) {
        this.run('pressure', lv.p.write, {
          uN: [lv.nx, lv.ny], uP: lv.p.read.texture, uBeta: lv.coef.texture, uRhs: lv.rhs.texture, uParity: parity, uSor: omega,
        });
        lv.p.swap();
      }
  }

  private vcycle(l: number) {
    const lv = this.levels[l];
    if (l === this.levels.length - 1) {
      this.smooth(lv, COARSEST_ITERATIONS, 1.5);
      return;
    }
    const next = this.levels[l + 1];
    this.smooth(lv, SMOOTH_ITERATIONS, 1.0);
    this.run('mgResidual', lv.res, { uN: [lv.nx, lv.ny], uP: lv.p.read.texture, uCoef: lv.coef.texture, uRhs: lv.rhs.texture });
    this.run('mgRestrict', next.rhs, { uN: [next.nx, next.ny], uFineRes: lv.res.texture, uFineN: [lv.nx, lv.ny] });
    this.run('clear', next.p.read, { uN: [next.nx, next.ny] });
    this.vcycle(l + 1);
    this.run('mgProlong', lv.p.write, {
      uN: [lv.nx, lv.ny], uP: lv.p.read.texture, uCoarse: next.p.read.texture, uCoarseN: [next.nx, next.ny], uCoef: lv.coef.texture,
    });
    lv.p.swap();
    this.smooth(lv, SMOOTH_ITERATIONS, 1.0);
  }

  /** Обновляет копию φ для отрисовки (линейная фильтрация). */
  prepareRender() {
    this.withState(() => this.run('copyPhi', this.phiRender, { uPhi: this.phi.read.texture }));
  }

  /** Униформы сетки для шейдеров отрисовки. */
  gridUniforms(): Record<string, UniformValue> {
    return this.common();
  }

  dispose() {
    Object.values(this.programs).forEach((p) => p.dispose());
    [this.vel, this.phi, this.pressure].forEach((t) => t.dispose());
    [this.velHat, this.phiHat, this.phi0, this.ext, this.beta, this.rhs, this.columns, this.total, this.geo, this.phiRender]
      .forEach((t) => t.dispose());
    this.levels.forEach((lv, l) => {
      lv.res.dispose();
      if (l > 0) { lv.p.dispose(); lv.rhs.dispose(); lv.coef.dispose(); }
    });
  }
}
