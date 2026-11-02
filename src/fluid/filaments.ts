import { Target } from './gl';

// Нити света в толще воды: свет, преломлённый рябью поверхности, ложится на заднюю
// стенку отдельными тонкими кривыми. Каждая нить своя: начинается у поверхности,
// имеет свою длину (до дна не доходит), свои изгибы и иногда петлю; медленно
// шевелится. Кривые задаются в координатах (вдоль поверхности, глубина под ней),
// поэтому сами следуют за поверхностью при наклоне и волнах.
//
// Текстура RGBA32F (POINTS + 1)×COUNT: в столбцах 0..POINTS−1 — точки (u, d),
// в последнем — (uMin, uMax, dMax, яркость) для быстрого отсечения в шейдере.

export const FILAMENT_COUNT = 14;
export const FILAMENT_POINTS = 16;

interface FilamentSeed {
  u0: number; length: number; drift: number; strength: number;
  a1: number; w1: number; p1: number; v1: number;
  a2: number; w2: number; p2: number;
  loop: number; wl: number; pl: number;
}

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export class Filaments {
  readonly target: Target;
  private seeds: FilamentSeed[] = [];
  private data = new Float32Array((FILAMENT_POINTS + 1) * FILAMENT_COUNT * 4);

  constructor(gl: WebGL2RenderingContext, halfLength: number, seed = 11) {
    this.target = new Target(gl, FILAMENT_POINTS + 1, FILAMENT_COUNT, ['RGBA32F']);
    const rand = mulberry(seed);
    const span = 2 * (halfLength - 0.35);
    for (let i = 0; i < FILAMENT_COUNT; i++) {
      // Почти равномерно по длине колбы, но с разбросом — без регулярного шага.
      const u0 = -span / 2 + span * (i + 0.15 + 0.7 * rand()) / FILAMENT_COUNT;
      // Нити в основном клонятся в одну сторону (как свет от одного источника),
      // но с разбросом наклона; изгибы плавные, иногда одна мягкая петля или дуга.
      const lean = rand() < 0.7 ? -(0.15 + 0.6 * rand()) : 0.1 + 0.5 * rand();
      this.seeds.push({
        u0,
        length: 0.6 + 0.4 * rand(),
        drift: lean,
        strength: 0.3 + 0.35 * rand(),
        a1: 0.12 + 0.22 * rand(), w1: 4.5 + 4.5 * rand(), p1: 6.283 * rand(), v1: (rand() - 0.5) * 0.5,
        a2: 0.01 + 0.02 * rand(), w2: 4 + 3 * rand(), p2: 6.283 * rand(),
        loop: rand() < 0.3 ? 0.08 + 0.12 * rand() : 0, wl: 0.7 + 0.5 * rand(), pl: 6.283 * rand(),
      });
    }
  }

  /** Обновляет кривые на момент time при глубине воды depth. */
  update(time: number, depth: number) {
    const maxLen = Math.max(0.75 * depth, 0.05);
    const d = this.data;
    const row = (FILAMENT_POINTS + 1) * 4;
    this.seeds.forEach((f, i) => {
      const len = f.length * maxLen * (0.88 + 0.12 * Math.sin(time * 0.23 + f.p1));
      let uMin = 1e9, uMax = -1e9, dMax = 0;
      for (let k = 0; k < FILAMENT_POINTS; k++) {
        const s = k / (FILAMENT_POINTS - 1);
        const ph = f.p1 + time * f.v1;
        const u = f.u0 + 0.12 * Math.sin(time * 0.17 + f.p2)
          + f.drift * s * Math.max(len, 0.6) * 1.4
          + f.a1 * Math.sin(f.w1 * s + ph) * Math.min(1, 3 * s)
          + f.a2 * Math.sin(f.w2 * s + f.p2 + time * 0.4)
          + f.loop * (Math.cos(f.wl * s * 6.283 + f.pl) - Math.cos(f.pl)) * 1.6;
        const dd = 0.01 + s * len + f.loop * Math.sin(f.wl * s * 6.283 + f.pl) * s;
        d.set([u, Math.max(dd, 0)], i * row + 4 * k);
        uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); dMax = Math.max(dMax, dd);
      }
      d.set([uMin, uMax, dMax, f.strength], i * row + 4 * FILAMENT_POINTS);
    });
    this.target.upload(d);
  }

  dispose() {
    this.target.dispose();
  }
}
