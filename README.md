# Water ProgressBar (капсула с жидкостью)

Демо-проект с WebGL/SPH прогрессбаром в стиле «водной капсулы». По умолчанию гравитация направлена **влево**, как у классических Windows progressbar.

## Запуск

1. `npm install`
2. `npm run dev`
3. Открыть `http://localhost:3000`

## Подключаемый TypeScript API

API находится в `src/api/waterProgressBarApi.tsx` и позволяет встраивать капсулу в любую HTML-разметку через контейнер `div`.

### Импорт

```ts
import { createWaterProgressBar } from './api/waterProgressBarApi';
```

### Быстрый старт

```ts
const host = document.getElementById('capsule-host')!;

const bar = createWaterProgressBar(host, {
  progress: 0.62,
  width: '520px',
  height: '150px',
  position: 'absolute',
  top: '20px',
  left: '24px',
  isWaving: true,
  meshQuality: 'balanced',
  borderRadius: '999px',
});

bar.update({ progress: 0.8, isWaving: false });
// ...
bar.destroy();
```

## Контракт API

### `createWaterProgressBar(mountNode, initialOptions)`

Создаёт внутри `mountNode` обёртку и монтирует в неё WebGL-капсулу.

Возвращает `WaterProgressBarInstance`:

- `update(nextOptions)` — частичное обновление параметров.
- `destroy()` — удаление капсулы и размонтирование React-root.
- `getOptions()` — чтение текущей конфигурации.
- `element` — DOM-элемент обёртки капсулы.

### Параметры `WaterProgressBarOptions`

- `progress: number` — заполнение `0..1`.
- `isWaving: boolean` — анимация качки.
- `tiltAngle: number` — угол наклона **в радианах**.
- `meshQuality: 'high' | 'balanced' | 'low'` — плотность геометрии.
- `width: string` / `height: string` — размер капсулы (`'420px'`, `'60%'` и т.д.).
- `position: CSS position` — режим позиционирования обёртки.
- `top/right/bottom/left: string` — координаты обёртки в контейнере.
- `zIndex: number` — слой обёртки.
- `wrapperClassName: string` — CSS-классы обёртки.
- `canvasClassName: string` — CSS-классы canvas.
- `borderRadius: string` — радиус скругления обёртки.

## Стенд тестирования API

В `src/App.tsx` добавлен UI со слайдерами, кнопками и текстбоксами:

- управление `progress`, `tilt`, `width`, `height`;
- ввод `top`/`left`;
- переключение `meshQuality`;
- кнопки `Create capsule`, `Destroy capsule`, `Start/Stop wave motion`.

Это позволяет быстро проверять внедрение готового модуля на других TypeScript/HTML страницах.
