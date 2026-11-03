import React, { useEffect, useRef } from 'react';
import { WaterFlask } from '../fluid/flask';

interface RealisticProgressBarProps {
  /** Доля воды 0..1. */
  progress: number;
  isWaving?: boolean;
  /** Наклон в радианах (плюс — правый конец вниз). */
  tiltAngle?: number;
  className?: string;
  /** Разрешение сетки решателя: 1 — 64 ячейки поперёк колбы. */
  resolution?: number;
  /** Множитель земной тяжести (0 — невесомость). */
  gravityScale?: number;
  flaskWidth?: number;
  flaskHeight?: number;
  /** Скорость наполнения: доля полной колбы в секунду. */
  fillSpeed?: number;
  /**
   * Фон, который преломляется в стекле и воде: URL картинки, готовая картинка/холст
   * или null — прозрачный холст без преломления (WebGL не видит страницу под собой).
   */
  background?: string | TexImageSource | null;
  /**
   * 'cover' — фон натянут на холст (демо). 'page' — фон натянут на окно браузера
   * и выровнен с положением холста на странице: передайте ту же картинку, что
   * лежит фоном страницы (обои приложения), и стекло будет искажать именно то,
   * что за ним. Вне колбы холст прозрачный.
   */
  backgroundFit?: 'cover' | 'page';
  /**
   * Полупрозрачная панель между фоном и колбой: [r, g, b, a], всё 0..1.
   * Например, карточка rgba(255,255,255,.25) → [1, 1, 1, 0.25].
   */
  backgroundTint?: [number, number, number, number];
  /**
   * Элемент страницы, который виден сквозь колбу (панель с кнопками, окно
   * приложения). Его снимок — с текстом, кнопками и картинками на них —
   * преломляется в стекле и воде; обновляется, когда элемент меняется (DOM,
   * наведение, прокрутка). Вне колбы холст прозрачный. Перекрывает background.
   * Картинки внутри должны быть с того же сайта (или data:), иначе их не снять.
   */
  backdrop?: HTMLElement | null;
  /** Как часто можно переснимать backdrop, мс. */
  backdropInterval?: number;
  /**
   * true — холст на весь экран (демо); false — заполняет родителя
   * (родитель должен иметь размер и position: relative), камера держит колбу в кадре.
   */
  fullscreen?: boolean;
}

const BACKGROUND_URL = 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?q=80&w=2000&auto=format&fit=crop';

export const RealisticProgressBar: React.FC<RealisticProgressBarProps> = ({
  progress,
  isWaving = false,
  tiltAngle = 0,
  className,
  resolution = 1,
  gravityScale = 1,
  flaskWidth = 10,
  flaskHeight = 3,
  fillSpeed = 0.35,
  background = BACKGROUND_URL,
  backgroundFit = 'cover' as const,
  backgroundTint,
  backdrop = null,
  backdropInterval = 250,
  fullscreen = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flaskRef = useRef<WaterFlask | null>(null);
  const live = { progress, isWaving, tiltAngle, gravityScale, fillSpeed, backgroundTint };
  const liveRef = useRef(live);
  liveRef.current = live;

  // Колба пересоздаётся только при смене формы, разрешения или фона.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const flask = new WaterFlask(canvas, {
      flaskWidth, flaskHeight, resolution, background, backgroundFit, backdrop, backdropInterval, fullscreen,
    }, liveRef.current);
    flaskRef.current = flask;
    return () => {
      flask.dispose();
      flaskRef.current = null;
    };
  }, [flaskWidth, flaskHeight, resolution, background, backgroundFit, backdrop, backdropInterval, fullscreen]);

  // Остальное — на лету.
  useEffect(() => {
    flaskRef.current?.set(live);
  });

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: fullscreen ? 'fixed' : 'absolute',
        top: 0,
        left: 0,
        width: fullscreen ? '100vw' : '100%',
        height: fullscreen ? '100vh' : '100%',
        display: 'block',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
};
