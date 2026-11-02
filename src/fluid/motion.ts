// Движение колбы: покачивание («волны») и наклон с плавным приводом.
// Всё аналитически, чтобы скорость и ускорение колбы, которые видит вода,
// точно соответствовали её реальному движению.

/** Масштаб: колба по умолчанию (10 единиц) ≈ 60 см, поэтому g ≈ 9.81·10/0.6 ед/с². */
export const EARTH_GRAVITY = 9.81 * (10 / 0.6);

const SWAY_AMP = 0.6;       // сдвиг вдоль колбы, ед.
const SWAY_FREQ = 0.8;      // рад/с
const ROCK_AMP = 0.1;       // медленное покачивание, рад
const ROCK_FREQ = 1.2;      // рад/с
const RESONANT_AMP = 0.009; // мелкая раскачка рядом с собственной частотой воды, рад
const WAVE_RAMP = 0.6;      // с, выход раскачивания на полную амплитуду
const TILT_OMEGA = 6.0;     // рад/с, «жёсткость» привода наклона (критическое демпфирование)

export interface MotionTargets {
  waving: boolean;
  /** Наклон в радианах (как ползунок Tilt: плюс — правый конец вниз). */
  tilt: number;
  /** Собственная частота первой моды колебаний воды, рад/с. */
  resonance: number;
}

export interface Kinematics {
  position: [number, number];
  /** Поворот колбы против часовой стрелки, рад. */
  angle: number;
  omega: number;
  omegaDot: number;
  /** Ускорение центра колбы в мире. */
  accel: [number, number];
}

export class FlaskMotion {
  private time = 0;
  private amp = 0;
  private tilt: number;
  private tiltVel = 0;
  private resonantPhase = 0;

  constructor(initialTilt = 0, private centerY = 0) {
    this.tilt = initialTilt;
  }

  step(dt: number, targets: MotionTargets): Kinematics {
    this.time += dt;
    this.amp += ((targets.waving ? 1 : 0) - this.amp) * (1 - Math.exp(-dt / WAVE_RAMP));

    // Привод наклона: критически демпфированная пружина (без рывков и перелёта).
    const tiltAcc = TILT_OMEGA * TILT_OMEGA * (targets.tilt - this.tilt) - 2 * TILT_OMEGA * this.tiltVel;
    this.tiltVel += dt * tiltAcc;
    this.tilt += dt * this.tiltVel;

    const t = this.time, W = this.amp;
    this.resonantPhase += dt * targets.resonance;
    const rp = this.resonantPhase, wr = targets.resonance;

    const x = W * SWAY_AMP * Math.sin(SWAY_FREQ * t);
    const ax = -W * SWAY_AMP * SWAY_FREQ * SWAY_FREQ * Math.sin(SWAY_FREQ * t);
    const rock = W * (ROCK_AMP * Math.sin(ROCK_FREQ * t) + RESONANT_AMP * Math.sin(rp));
    const rockVel = W * (ROCK_AMP * ROCK_FREQ * Math.cos(ROCK_FREQ * t) + RESONANT_AMP * wr * Math.cos(rp));
    const rockAcc = -W * (ROCK_AMP * ROCK_FREQ * ROCK_FREQ * Math.sin(ROCK_FREQ * t) + RESONANT_AMP * wr * wr * Math.sin(rp));

    // Плюс на ползунке наклона — правый конец вниз, то есть поворот по часовой.
    return {
      position: [x, this.centerY],
      angle: -(rock + this.tilt),
      omega: -(rockVel + this.tiltVel),
      omegaDot: -(rockAcc + tiltAcc),
      accel: [ax, 0],
    };
  }
}

/** Частота первой моды стоячей волны в колбе длиной 2·halfLength при глубине depth. */
export const sloshingFrequency = (g: number, halfLength: number, depth: number) => {
  const k = Math.PI / (2 * halfLength);
  return Math.sqrt(Math.max(g, 1e-3) * k * Math.tanh(k * Math.max(depth, 0.05)));
};

export const rotate = (a: number, v: [number, number]): [number, number] => [
  Math.cos(a) * v[0] - Math.sin(a) * v[1],
  Math.sin(a) * v[0] + Math.cos(a) * v[1],
];
