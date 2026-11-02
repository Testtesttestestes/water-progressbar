// Небольшой слой над WebGL2 для расчётных проходов: текстуры-цели, пинг-понг
// и программы, которые сами ставят униформы по их типу.

export type TexFormat = 'R32F' | 'RG32F' | 'RGBA32F' | 'R16F' | 'RGBA16F' | 'RGBA8';

const FORMATS: Record<TexFormat, { internal: number; format: number; type: number }> = {
  R32F: { internal: WebGL2RenderingContext.R32F, format: WebGL2RenderingContext.RED, type: WebGL2RenderingContext.FLOAT },
  RG32F: { internal: WebGL2RenderingContext.RG32F, format: WebGL2RenderingContext.RG, type: WebGL2RenderingContext.FLOAT },
  RGBA32F: { internal: WebGL2RenderingContext.RGBA32F, format: WebGL2RenderingContext.RGBA, type: WebGL2RenderingContext.FLOAT },
  R16F: { internal: WebGL2RenderingContext.R16F, format: WebGL2RenderingContext.RED, type: WebGL2RenderingContext.HALF_FLOAT },
  RGBA16F: { internal: WebGL2RenderingContext.RGBA16F, format: WebGL2RenderingContext.RGBA, type: WebGL2RenderingContext.HALF_FLOAT },
  RGBA8: { internal: WebGL2RenderingContext.RGBA8, format: WebGL2RenderingContext.RGBA, type: WebGL2RenderingContext.UNSIGNED_BYTE },
};

export const CHANNELS: Record<TexFormat, number> = { R32F: 1, RG32F: 2, RGBA32F: 4, R16F: 1, RGBA16F: 4, RGBA8: 4 };

export const createTexture = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: TexFormat,
  { linear = false, data = null as ArrayBufferView | null } = {},
): WebGLTexture => {
  const f = FORMATS[format];
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, width, height, 0, f.format, f.type, data);
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
};

/** Цель рендера: одна или несколько текстур одного размера. */
export class Target {
  readonly fbo: WebGLFramebuffer;
  readonly textures: WebGLTexture[];
  constructor(
    private gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
    readonly formats: TexFormat[],
    linear = false,
  ) {
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    this.textures = formats.map((fmt, i) => {
      const tex = createTexture(gl, width, height, fmt, { linear });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      return tex;
    });
    gl.drawBuffers(formats.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`Framebuffer incomplete (${formats.join(', ')}): 0x${status.toString(16)}`);
  }

  get texture(): WebGLTexture {
    return this.textures[0];
  }

  bind() {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  /** Заливка данными (размер — width*height*каналы), по одной текстуре. */
  upload(data: Float32Array, index = 0) {
    const gl = this.gl;
    const f = FORMATS[this.formats[index]];
    gl.bindTexture(gl.TEXTURE_2D, this.textures[index]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, f.format, f.type, data);
  }

  /** Чтение текстуры на CPU (только для тестов и отладки: останавливает конвейер). */
  read(index = 0): Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + index);
    const out = new Float32Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return out;
  }

  dispose() {
    this.textures.forEach((t) => this.gl.deleteTexture(t));
    this.gl.deleteFramebuffer(this.fbo);
  }
}

/** Две цели для «читаем из одной, пишем в другую». */
export class PingPong {
  read: Target;
  write: Target;
  constructor(gl: WebGL2RenderingContext, width: number, height: number, formats: TexFormat[], linear = false) {
    this.read = new Target(gl, width, height, formats, linear);
    this.write = new Target(gl, width, height, formats, linear);
  }

  swap() {
    [this.read, this.write] = [this.write, this.read];
  }

  dispose() {
    this.read.dispose();
    this.write.dispose();
  }
}

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const numbered = source.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
    throw new Error(`Shader compile error:\n${log}\n${numbered}`);
  }
  return shader;
};

export type UniformValue = number | number[] | Float32Array | Int32Array | WebGLTexture | boolean;

/** Программа с автоматической установкой униформ (тип берётся из самой программы). */
export class Program {
  readonly program: WebGLProgram;
  private uniforms = new Map<string, { loc: WebGLUniformLocation; type: number }>();

  constructor(private gl: WebGL2RenderingContext, vs: string, fs: string) {
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, { loc: gl.getUniformLocation(program, info.name)!, type: info.type });
    }
  }

  use(values: Record<string, UniformValue | undefined>) {
    const gl = this.gl;
    gl.useProgram(this.program);
    let unit = 0;
    for (const [name, value] of Object.entries(values)) {
      const u = this.uniforms.get(name);
      if (!u || value === undefined) continue;
      const v = value as any;
      switch (u.type) {
        case gl.FLOAT: if (typeof v === 'number') gl.uniform1f(u.loc, v); else gl.uniform1fv(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, typeof v === 'boolean' ? (v ? 1 : 0) : v); break;
        case gl.INT_VEC2: gl.uniform2iv(u.loc, v); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(u.loc, false, v); break;
        case gl.SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, v);
          gl.uniform1i(u.loc, unit);
          unit++;
          break;
        default:
          throw new Error(`Unsupported uniform type for ${name}`);
      }
    }
  }

  dispose() {
    this.gl.deleteProgram(this.program);
  }
}

// Полноэкранный треугольник без вершинных буферов.
export const VS_FULLSCREEN = `#version 300 es
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const drawFullscreen = (gl: WebGL2RenderingContext) => {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};
