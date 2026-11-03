import { FluidSolver } from './solver';
import { FluidRenderer } from './renderer';
import { Bubbles } from './bubbles';
import { Spray } from './spray';
import { Whitewater } from './whitewater';
import { EARTH_GRAVITY, FlaskMotion, rotate, sloshingFrequency } from './motion';
import { BackgroundTexture, createFallbackBackground, loadBackground, textureFromSource, updateTexture } from './background';
import { DomBackdrop } from './backdrop';

// Колба с водой целиком, без React: решатель, частицы, отрисовка и цикл кадров на
// заданном холсте. Её используют и React-компонент демо, и встраивание в другие
// приложения (например, слот загрузки HoloDB).

/** Параметры, которые можно менять на лету. */
export interface FlaskLive {
  /** Доля воды 0..1. */
  progress: number;
  isWaving: boolean;
  /** Наклон в радианах (плюс — правый конец вниз). */
  tiltAngle: number;
  /** Множитель земной тяжести (0 — невесомость). */
  gravityScale: number;
  /** Скорость наполнения: доля полной колбы в секунду. */
  fillSpeed: number;
  /** Полупрозрачная панель между фоном и колбой: [r, g, b, a], всё 0..1. */
  backgroundTint?: [number, number, number, number];
}

/** Параметры, при смене которых колбу нужно создать заново. */
export interface FlaskOptions {
  flaskWidth?: number;
  flaskHeight?: number;
  /** Разрешение сетки решателя: 1 — 64 ячейки поперёк колбы. */
  resolution?: number;
  /** URL картинки, готовая картинка/холст или null — прозрачный холст. */
  background?: string | TexImageSource | null;
  /** 'cover' — фон по холсту; 'page' — по окну браузера, выровнен с холстом. */
  backgroundFit?: 'cover' | 'page';
  /** Элемент страницы, снимок которого преломляется в колбе (кнопки, текст, картинки). */
  backdrop?: HTMLElement | null;
  /** Как часто можно переснимать backdrop, мс. */
  backdropInterval?: number;
  /** true — камера демо (колба в верхней части полноэкранного холста); false — колба вписана в холст. */
  fullscreen?: boolean;
}

const FLASK_CENTER_Y = 3.0;
const VIEW_HEIGHT = 12.0;
// Шаг решателя и предел шагов за кадр: на медленной машине симуляция замедляется,
// но остаётся согласованной, а не «догоняет» всё более длинными кадрами.
const SIM_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 4;

export const DEFAULT_LIVE: FlaskLive = { progress: 0, isWaving: false, tiltAngle: 0, gravityScale: 1, fillSpeed: 0.35 };

export class WaterFlask {
  /** false — WebGL2 или нужные расширения недоступны; колба не рисуется. */
  readonly ok: boolean = false;
  private live: FlaskLive;
  private disposeFn: () => void = () => {};
  private loseContext: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement, options: FlaskOptions = {}, live: Partial<FlaskLive> = {}) {
    this.live = { ...DEFAULT_LIVE, ...live };
    const {
      flaskWidth = 10, flaskHeight = 3, resolution = 1, background: bgSource = null, backgroundFit = 'cover',
      backdrop = null, backdropInterval = 250, fullscreen = false,
    } = options;
    const halfX = Math.max(1.5, flaskWidth / 2);
    const halfY = Math.max(0.8, flaskHeight / 2);
    const radius = Math.min(halfX, halfY) * 0.5;
    const glass = Math.min(0.11, 0.08 * halfY);

    const transparent = bgSource === null && !backdrop;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true });
    if (!gl) {
      console.error('WaterFlask: WebGL2 unsupported.');
      return;
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      console.error('WaterFlask: WebGL2 extension "EXT_color_buffer_float" unsupported.');
      return;
    }

    const tilt0 = this.live.tiltAngle;
    let fill = Math.min(Math.max(this.live.progress, 0), 1);
    const motion = new FlaskMotion(tilt0, FLASK_CENTER_Y);

    let solver: FluidSolver, bubbles: Bubbles, spray: Spray, whitewater: Whitewater, renderer: FluidRenderer;
    try {
      solver = new FluidSolver(gl, {
        halfSize: [halfX, halfY], radius, glass,
        rows: Math.round(64 * Math.min(Math.max(resolution, 0.5), 2)),
        initialFill: fill, initialUp: rotate(tilt0, [0, 1]),
      });
      bubbles = new Bubbles(gl, solver);
      spray = new Spray(gl, solver);
      whitewater = new Whitewater(gl, solver);
      renderer = new FluidRenderer(gl);
    } catch (e) {
      console.error(e);
      return;
    }
    (this as { ok: boolean }).ok = true;

    let background: BackgroundTexture = createFallbackBackground(gl);
    let disposed = false;
    if (backdrop) { /* фон — снимок страницы, картинка не нужна */ }
    else if (typeof bgSource === 'string') loadBackground(gl, bgSource)
      .then((bg) => {
        if (disposed) {
          gl.deleteTexture(bg.texture);
          return;
        }
        gl.deleteTexture(background.texture);
        background = bg;
      })
      .catch(() => {
        // Частая причина — сервер картинки не разрешает загрузку с другого сайта (CORS):
        // тогда остаётся ровный градиент, и преломлять стеклу нечего.
        console.warn(`WaterFlask: background "${bgSource}" did not load (CORS or network); using a plain gradient, so the glass shows no distortion.`);
      });
    else if (bgSource) {
      try {
        gl.deleteTexture(background.texture);
        background = textureFromSource(gl, bgSource);
      } catch (e) {
        console.warn('WaterFlask: background source could not be used (cross-origin image without CORS?).', e);
        background = createFallbackBackground(gl);
      }
    }

    let frame = 0;
    let last: number | null = null;
    let accumulator = 0;
    let simTime = 0;
    // Сглаженное волнение воды: растит рябь (каустики) и пузырьки у поверхности.
    let waviness = 0;
    let kin = motion.step(0, { waving: false, tilt: tilt0, resonance: 1 });

    // Камера встроенного режима: колба целиком в кадре при любом наклоне и качании.
    // Масштаб сглажен, чтобы кадр не «дышал» вместе с наклоном.
    let viewHeight = 0;
    const fitCamera = () => {
      const aspect = canvas.width / Math.max(canvas.height, 1);
      const c = Math.abs(Math.cos(kin.angle)), sn = Math.abs(Math.sin(kin.angle));
      const sway = this.live.isWaving ? 0.7 : 0.15;   // запас на качание колбы (motion.ts)
      const bw = 2 * (halfX * c + halfY * sn) + 2 * sway, bh = 2 * (halfX * sn + halfY * c) + 0.3;
      const target = 1.06 * Math.max(bh, bw / aspect);
      viewHeight = viewHeight === 0 ? target : viewHeight + (target - viewHeight) * 0.05;
      return { center: [0, FLASK_CENTER_Y] as [number, number], height: viewHeight };
    };

    // Снимок живой страницы под колбой (кнопки, картинки, текст).
    const dom = backdrop ? new DomBackdrop(backdrop, (node) => node === canvas, backdropInterval, 1, canvas) : null;
    let domVersion = 0;
    const backdropRect = () => {
      const c = canvas.getBoundingClientRect(), e = backdrop!.getBoundingClientRect();
      return {
        rect: [c.left - e.left, c.top - e.top, c.width, c.height] as [number, number, number, number],
        viewport: [Math.max(e.width, 1), Math.max(e.height, 1)] as [number, number],
        fit: 'stretch' as const,
      };
    };
    const pageRect = () => {
      const r = canvas.getBoundingClientRect();
      return {
        rect: [r.left, r.top, r.width, r.height] as [number, number, number, number],
        viewport: [window.innerWidth, window.innerHeight] as [number, number],
      };
    };

    const loop = (now: number) => {
      if (disposed) return;
      const frameDt = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
      last = now;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const params = this.live;
      const g = EARTH_GRAVITY * Math.max(params.gravityScale, 0);
      accumulator += frameDt;
      let steps = Math.floor(accumulator / SIM_DT);
      if (steps > MAX_STEPS_PER_FRAME) {
        steps = MAX_STEPS_PER_FRAME;
        accumulator = 0;
      } else accumulator -= steps * SIM_DT;

      for (let i = 0; i < steps; i++) {
        const target = Math.min(Math.max(params.progress, 0), 1);
        const maxDelta = Math.max(params.fillSpeed, 0.01) * SIM_DT;
        fill += Math.min(Math.max(target - fill, -2 * maxDelta), maxDelta);

        const resonance = 0.92 * sloshingFrequency(g, solver.cavityHalf[0], fill * 2 * solver.cavityHalf[1]);
        kin = motion.step(SIM_DT, { waving: params.isWaving, tilt: params.tiltAngle, resonance });
        // Тяжесть минус ускорение колбы — в систему колбы.
        const accel = rotate(-kin.angle, [-kin.accel[0], -g - kin.accel[1]]);
        solver.step({ dt: SIM_DT, accel, omega: kin.omega, omegaDot: kin.omegaDot, fill });
        // Волнение для пузырьков у поверхности: угловое ускорение и тряска относительно g.
        const agitation = (Math.abs(kin.omegaDot) * solver.cavityHalf[0] + Math.hypot(kin.accel[0], kin.accel[1])) / Math.max(g, 1);
        bubbles.update(SIM_DT, rotate(-kin.angle, [0, 1]), 40 * agitation);
        spray.update(SIM_DT, accel, EARTH_GRAVITY);
        whitewater.update(SIM_DT, accel, EARTH_GRAVITY);
        waviness += (Math.min(25 * agitation, 2) - waviness) * (1 - Math.exp(-SIM_DT / 1.5));
        simTime += SIM_DT;
      }

      if (dom) {
        dom.tick(now);
        const snap = dom.snapshot;
        if (snap && snap.version !== domVersion) {
          domVersion = snap.version;
          updateTexture(gl, background, snap.canvas);
        }
      }
      renderer.render({
        solver, bubbles, spray, whitewater,
        background: background.texture, backgroundSize: background.size,
        width: canvas.width, height: canvas.height,
        flask: { position: kin.position, angle: kin.angle, halfSize: [halfX, halfY], radius, glass, up: rotate(-kin.angle, [0, 1]) },
        camera: fullscreen ? { center: [0, 0], height: VIEW_HEIGHT } : fitCamera(),
        time: simTime,
        // Пока первого снимка страницы нет — прозрачный режим, а не градиент.
        transparent: transparent || (!!dom && !dom.snapshot),
        backgroundTint: params.backgroundTint,
        page: dom && dom.snapshot ? backdropRect() : backgroundFit === 'page' && !transparent ? pageRect() : undefined,
        gravity: g,
        agitation: waviness,
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    this.disposeFn = () => {
      disposed = true;
      cancelAnimationFrame(frame);
      dom?.dispose();
      gl.deleteTexture(background.texture);
      solver.dispose();
      bubbles.dispose();
      spray.dispose();
      whitewater.dispose();
      renderer.dispose();
    };
    this.loseContext = () => gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** Обновить параметры без пересоздания (прогресс, волны, наклон…). */
  set(live: Partial<FlaskLive>) {
    this.live = { ...this.live, ...live };
  }

  /**
   * @param releaseContext отпустить WebGL-контекст сразу (браузер держит лишь
   *   несколько). Только если холст больше не понадобится: на этом холсте новый
   *   контекст уже не создать (React StrictMode переиспользует холст — там false).
   */
  dispose(releaseContext = false) {
    this.disposeFn();
    this.disposeFn = () => {};
    if (releaseContext) this.loseContext();
    this.loseContext = () => {};
  }
}
