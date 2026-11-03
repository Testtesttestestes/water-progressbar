import { toCanvas } from 'html-to-image';

// Снимок живой страницы под колбой: WebGL не видит DOM под своим холстом, поэтому
// кнопки, текст и картинки на них «фотографируем» (SVG foreignObject → холст) и
// отдаём стеклу как фон. Снимок обновляется, когда страница меняется: правки DOM,
// наведение мыши (:hover не меняет DOM), прокрутка и размеры — не чаще interval мс.
// Между снимками картинка статична, но сама вода и преломление анимируются каждый кадр.

export interface BackdropSnapshot {
  canvas: HTMLCanvasElement;
  /** Прямоугольник снятого элемента на экране в момент снимка. */
  rect: DOMRect;
  /** Номер снимка: растёт, когда холст обновился. */
  version: number;
}

export class DomBackdrop {
  snapshot: BackdropSnapshot | null = null;
  /** Сколько занял последний снимок, мс (для настройки interval). */
  lastDuration = 0;
  private busy = false;
  private dirty = true;
  private last = 0;
  private version = 0;
  private timer = 0;
  private observer: MutationObserver;
  private disposed = false;
  private onEvent = () => this.invalidate();

  constructor(
    private element: HTMLElement,
    /** Что не снимать: сама колба (иначе она увидела бы себя). */
    private exclude: (node: Node) => boolean,
    private interval = 250,
    /** Резкость снимка: стекло и вода его всё равно размывают. */
    private pixelRatio = 1,
    /** Область, которая нужна (холст колбы): что далеко от неё, не снимаем. */
    private focus: HTMLElement | null = null,
    private margin = 60,
  ) {
    this.observer = new MutationObserver((records) => {
      // Изменения внутри самой колбы (холст, его стиль) — не повод переснимать.
      if (records.some((r) => !this.exclude(r.target))) this.invalidate();
    });
    this.observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const type of ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'focusin', 'focusout', 'transitionend', 'animationend'])
      element.addEventListener(type, this.onEvent, true);
    window.addEventListener('resize', this.onEvent);
    window.addEventListener('scroll', this.onEvent, true);
    // Подстраховка для CSS-анимаций без событий: раз в секунду.
    this.timer = window.setInterval(this.onEvent, 1000);
  }

  invalidate() {
    this.dirty = true;
  }

  /** Вызывать каждый кадр: при необходимости запускает новый снимок (асинхронно). */
  tick(now: number) {
    if (this.disposed || this.busy || !this.dirty || now - this.last < this.interval) return;
    this.busy = true;
    this.dirty = false;
    this.last = now;
    const rect = this.element.getBoundingClientRect();
    const t0 = performance.now();
    toCanvas(this.element, {
      pixelRatio: this.pixelRatio,
      // Размер снимка — ровно прямоугольник элемента (как он на экране): иначе
      // библиотека берёт scrollHeight и т. п., и снимок растягивается по вертикали.
      width: rect.width,
      height: rect.height,
      // Выкидывать из копии можно только колбу: любой другой выкинутый узел
      // сдвинул бы вёрстку остального (так съезжали кнопки).
      filter: (node) => !this.exclude(node),
      // Картинки рисуем сами (drawImages): библиотека каждый раз перекодирует их
      // в base64 — с ними снимок в десятки раз дольше. Загрузку для неё обрываем,
      // и в копию идёт пустая заглушка: место и размер картинки в вёрстке сохраняются.
      fetchRequestInit: { signal: ABORTED },
      imagePlaceholder: EMPTY_PIXEL,
      // Без кэш-бастинга: картинки приложения не меняются по одному адресу.
      cacheBust: false,
      // Шрифты не встраиваем: страница рисуется теми же системными/загруженными
      // шрифтами, а встраивание — самая долгая часть снимка (качает и кодирует файлы).
      skipFonts: true,
      // Копия корня кладётся в снимок как есть, со своими left/top/margin —
      // и содержимое съезжало. В снимке корень должен стоять в (0, 0).
      // Обои самого контейнера тоже рисуем сами, нижним слоем (drawUnderlay).
      style: { margin: '0', left: '0', top: '0', right: 'auto', bottom: 'auto', transform: 'none', translate: 'none', backgroundImage: 'none' },
    })
      .then((shot) => {
        if (this.disposed) return;
        // Полупрозрачный элемент снимается без того, что под ним: кладём снимок на
        // цвет ближайшего непрозрачного предка (лучше передавать непрозрачный контейнер).
        const canvas = document.createElement('canvas');
        canvas.width = shot.width;
        canvas.height = shot.height;
        const ctx = canvas.getContext('2d')!;
        const k = shot.width / Math.max(rect.width, 1);
        drawUnderlay(ctx, this.element, rect, k);
        ctx.drawImage(shot, 0, 0);
        this.drawImages(ctx, rect, k);
        this.snapshot = { canvas, rect, version: ++this.version };
        this.lastDuration = performance.now() - t0;
      })
      .catch((e) => {
        console.warn('DomBackdrop: snapshot failed', e);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  /** Картинки поверх снимка — прямо из уже загруженных <img> страницы. */
  private drawImages(ctx: CanvasRenderingContext2D, base: DOMRect, k: number) {
    for (const img of Array.from(this.element.querySelectorAll('img'))) {
      if (!img.complete || !img.naturalWidth || !this.nearFocus(img) || !sameOrigin(img.currentSrc || img.src)) continue;
      const style = getComputedStyle(img);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const r = img.getBoundingClientRect();
      const x = (r.left - base.left) * k, y = (r.top - base.top) * k, w = r.width * k, h = r.height * k;
      // object-fit: cover / contain / fill (по умолчанию) — как на странице.
      const iw = img.naturalWidth, ih = img.naturalHeight;
      let sx = 0, sy = 0, sw = iw, sh = ih, dx = x, dy = y, dw = w, dh = h;
      if (style.objectFit === 'cover') {
        const s2 = Math.max(w / iw, h / ih); sw = w / s2; sh = h / s2; sx = (iw - sw) / 2; sy = (ih - sh) / 2;
      } else if (style.objectFit === 'contain') {
        const s2 = Math.min(w / iw, h / ih); dw = iw * s2; dh = ih * s2; dx = x + (w - dw) / 2; dy = y + (h - dh) / 2;
      }
      ctx.save();
      ctx.globalAlpha = parseFloat(style.opacity) || 1;
      const radius = parseFloat(style.borderTopLeftRadius) || 0;
      if (radius > 0) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, Math.min(radius * k, w / 2, h / 2));
        ctx.clip();
      }
      try { ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh); } catch { /* не декодирована */ }
      ctx.restore();
    }
  }

  /** Элемент рядом с колбой? Картинки вдали от неё не рисуем. */
  private nearFocus(node: Node): boolean {
    if (!this.focus || !(node instanceof Element)) return true;
    const style = getComputedStyle(node);
    // У display: contents и фиксированных элементов прямоугольник ничего не говорит о детях.
    if (style.display === 'contents' || style.position === 'fixed') return true;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    const f = this.focus.getBoundingClientRect(), m = this.margin;
    return r.right >= f.left - m && r.left <= f.right + m && r.bottom >= f.top - m && r.top <= f.bottom + m;
  }

  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    for (const type of ['pointerover', 'pointerout', 'pointerdown', 'pointerup', 'focusin', 'focusout', 'transitionend', 'animationend'])
      this.element.removeEventListener(type, this.onEvent, true);
    window.removeEventListener('resize', this.onEvent);
    window.removeEventListener('scroll', this.onEvent, true);
    window.clearInterval(this.timer);
  }
}

const ABORTED = (() => { const c = new AbortController(); c.abort(); return c.signal; })();
const EMPTY_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const sameOrigin = (src: string) => {
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;
  try { return new URL(src, location.href).origin === location.origin; } catch { return false; }
};

// Кэш декодированных обоев контейнера по адресу.
const wallpapers = new Map<string, HTMLImageElement>();

/**
 * Нижний слой снимка: цвет под элементом и его собственные обои
 * (background-image: url(...), размеры cover / contain / растянуть).
 */
const drawUnderlay = (ctx: CanvasRenderingContext2D, el: HTMLElement, rect: DOMRect, k: number) => {
  const style = getComputedStyle(el);
  const own = style.backgroundColor;
  ctx.fillStyle = underlyingColor(el);
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const m = style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
  if (m && sameOrigin(m[1])) {
    let img = wallpapers.get(m[1]);
    if (!img) { img = new Image(); img.src = m[1]; wallpapers.set(m[1], img); }
    if (img.complete && img.naturalWidth) {
      const w = rect.width * k, h = rect.height * k, iw = img.naturalWidth, ih = img.naturalHeight;
      const size = style.backgroundSize;
      const s2 = size === 'cover' ? Math.max(w / iw, h / ih) : size === 'contain' ? Math.min(w / iw, h / ih) : 0;
      if (s2 > 0) ctx.drawImage(img, (w - iw * s2) / 2, (h - ih * s2) / 2, iw * s2, ih * s2);
      else ctx.drawImage(img, 0, 0, w, h);
    }
  }
  // Свой полупрозрачный цвет элемента — его нарисует снимок; здесь не дублируем.
  void own;
};

/** Цвет фона первого непрозрачного предка (или белый). */
const underlyingColor = (el: HTMLElement): string => {
  for (let node: HTMLElement | null = el.parentElement; node; node = node.parentElement) {
    const c = getComputedStyle(node).backgroundColor;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map((v) => parseFloat(v));
      if (parts.length < 4 || parts[3] > 0.99) return c;
    }
  }
  return '#ffffff';
};
