import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RealisticProgressBar } from '../components/RealisticProgressBar';

export type WaterProgressBarOptions = {
  progress?: number;
  isWaving?: boolean;
  tiltAngle?: number;
  meshQuality?: 'high' | 'balanced' | 'low';
  width?: string;
  height?: string;
  position?: React.CSSProperties['position'];
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
  zIndex?: number;
  wrapperClassName?: string;
  canvasClassName?: string;
  borderRadius?: string;
};

const DEFAULT_OPTIONS: Required<Omit<WaterProgressBarOptions, 'top' | 'right' | 'bottom' | 'left' | 'wrapperClassName' | 'canvasClassName'>> = {
  progress: 0.5,
  isWaving: false,
  tiltAngle: 0,
  meshQuality: 'balanced',
  width: '420px',
  height: '140px',
  position: 'relative',
  zIndex: 1,
  borderRadius: '999px',
};

export type WaterProgressBarInstance = {
  update: (nextOptions: Partial<WaterProgressBarOptions>) => void;
  destroy: () => void;
  getOptions: () => WaterProgressBarOptions;
  element: HTMLDivElement;
};

const renderBar = (root: Root, wrapper: HTMLDivElement, options: WaterProgressBarOptions) => {
  wrapper.style.position = options.position ?? DEFAULT_OPTIONS.position;
  wrapper.style.width = options.width ?? DEFAULT_OPTIONS.width;
  wrapper.style.height = options.height ?? DEFAULT_OPTIONS.height;
  wrapper.style.top = options.top ?? '';
  wrapper.style.right = options.right ?? '';
  wrapper.style.bottom = options.bottom ?? '';
  wrapper.style.left = options.left ?? '';
  wrapper.style.zIndex = String(options.zIndex ?? DEFAULT_OPTIONS.zIndex);
  wrapper.style.overflow = 'hidden';
  wrapper.style.borderRadius = options.borderRadius ?? DEFAULT_OPTIONS.borderRadius;
  wrapper.className = options.wrapperClassName ?? '';

  root.render(
    <RealisticProgressBar
      progress={options.progress ?? DEFAULT_OPTIONS.progress}
      isWaving={options.isWaving ?? DEFAULT_OPTIONS.isWaving}
      tiltAngle={options.tiltAngle ?? DEFAULT_OPTIONS.tiltAngle}
      meshQuality={options.meshQuality ?? DEFAULT_OPTIONS.meshQuality}
      className={options.canvasClassName}
    />,
  );
};

export const createWaterProgressBar = (
  mountNode: HTMLElement,
  initialOptions: WaterProgressBarOptions = {},
): WaterProgressBarInstance => {
  const wrapper = document.createElement('div');
  mountNode.appendChild(wrapper);

  const root = createRoot(wrapper);
  let options: WaterProgressBarOptions = { ...DEFAULT_OPTIONS, ...initialOptions };

  renderBar(root, wrapper, options);

  return {
    update: (nextOptions) => {
      options = { ...options, ...nextOptions };
      renderBar(root, wrapper, options);
    },
    destroy: () => {
      root.unmount();
      wrapper.remove();
    },
    getOptions: () => ({ ...options }),
    element: wrapper,
  };
};
