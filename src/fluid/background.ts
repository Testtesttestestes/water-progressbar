// Фон для преломления: картинка или запасной градиент (без сети колба всё равно рисуется).

export interface BackgroundTexture {
  texture: WebGLTexture;
  size: [number, number];
}

const configure = (gl: WebGL2RenderingContext) => {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
};

export const createFallbackBackground = (gl: WebGL2RenderingContext): BackgroundTexture => {
  const w = 4, h = 256;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    for (let x = 0; x < w; x++) data.set([40 + 150 * t, 70 + 140 * t, 110 + 130 * t, 255], 4 * (y * w + x));
  }
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  configure(gl);
  return { texture, size: [16, 9] };
};

export const loadBackground = (gl: WebGL2RenderingContext, url: string): Promise<BackgroundTexture> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      configure(gl);
      resolve({ texture, size: [image.naturalWidth, image.naturalHeight] });
    };
    image.onerror = reject;
    image.src = url;
  });
