/**
 * Minimal equirectangular panorama viewer.
 *
 * Rather than build a textured sphere, this renders a single full-screen quad
 * and inverts the projection in the fragment shader: for each pixel it computes
 * the view ray, rotates it by the camera's yaw and pitch, and converts that
 * direction to equirectangular texture coordinates. No geometry, no matrices,
 * and no three.js - about 4 KB of code instead of ~150 KB of dependency.
 *
 * Every panorama is redrawn to a 2048x1024 offscreen canvas before upload. That
 * guarantees a power-of-two, 2:1 texture, which is what lets plain WebGL1 use
 * REPEAT wrapping on S so the 360 seam is invisible - NPOT textures are limited
 * to CLAMP_TO_EDGE and would show a visible join.
 */

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform float uYaw;
uniform float uPitch;
uniform float uFov;
uniform float uAspect;

const float PI = 3.14159265359;

void main() {
  float t = tan(uFov * 0.5);
  vec3 dir = normalize(vec3(vUv.x * t * uAspect, vUv.y * t, -1.0));

  float cp = cos(uPitch);
  float sp = sin(uPitch);
  dir = vec3(dir.x, dir.y * cp - dir.z * sp, dir.y * sp + dir.z * cp);

  float cy = cos(uYaw);
  float sy = sin(uYaw);
  dir = vec3(dir.x * cy + dir.z * sy, dir.y, -dir.x * sy + dir.z * cy);

  float u = atan(dir.x, -dir.z) / (2.0 * PI) + 0.5;
  float v = 1.0 - acos(clamp(dir.y, -1.0, 1.0)) / PI;

  gl_FragColor = texture2D(uTexture, vec2(u, v));
}
`;

const TEXTURE_WIDTH = 2048;
const TEXTURE_HEIGHT = 1024;

export interface EquirectViewerOptions {
  minFovDeg?: number;
  maxFovDeg?: number;
  initialFovDeg?: number;
  maxPitchDeg?: number;
  /**
   * Where the view opens, in degrees clockwise from the panorama's own forward
   * direction - the image centre. Easy rounds pass the bearing to their
   * landmark so the player opens facing it.
   *
   * This class is the only place that knows which way a positive yaw turns.
   * The shader maps u = 0.5 - yaw / 2pi, and u increases to the right in an
   * equirectangular image, so turning the view clockwise means *decreasing*
   * yaw - hence the negation below. Verified against rendered pixels with
   * `node scripts/verify-viewer.mjs --yaw`, not from the algebra alone.
   */
  initialBearingDeg?: number;
  /**
   * Degrees per second the view sweeps when auto-pan is running. Positive
   * sweeps to the right, the way you would turn your head to look around.
   */
  autoPanDegreesPerSecond?: number;
}

const DEFAULTS: Required<EquirectViewerOptions> = {
  minFovDeg: 30,
  maxFovDeg: 100,
  initialFovDeg: 75,
  maxPitchDeg: 85,
  initialBearingDeg: 0,
  autoPanDegreesPerSecond: 6,
};

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** A single revolution, in radians. */
const FULL_TURN = Math.PI * 2;

/**
 * Longest single auto-pan step, in milliseconds.
 *
 * A backgrounded tab stops firing animation frames and comes back with a gap of
 * seconds or minutes; stepping that literally would spin the view through
 * several revolutions between one frame and the next. At 60fps the real gap is
 * ~16 ms, so this never binds in normal use.
 */
const MAX_PAN_STEP_MS = 100;

/**
 * Where the view should be after `elapsedMs` of panning at this speed.
 *
 * Pulled out of the class so it can be tested without a WebGL context. It also
 * cannot be checked by screenshot: Chromium's headless virtual-time mode
 * advances timers without producing matching animation frames, so a rendered
 * comparison shows a sweep that has barely moved whether the maths is right or
 * wrong - which is worse than no test.
 *
 * A positive speed turns the view to the RIGHT, which the shader reaches by
 * decreasing yaw. Same sign relationship as `initialBearingDeg`, which was
 * verified against rendered pixels.
 */
export function autoPanStep(
  yaw: number,
  degreesPerSecond: number,
  elapsedMs: number,
  maxStepMs: number = MAX_PAN_STEP_MS
): number {
  const step = Math.min(Math.max(elapsedMs, 0), maxStepMs) / 1000;
  const next = yaw - toRad(degreesPerSecond) * step;
  // Wrapped so a viewer left running for an hour does not accumulate a yaw
  // large enough to lose precision.
  return ((next % FULL_TURN) + FULL_TURN) % FULL_TURN;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

export class EquirectViewer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private options: Required<EquirectViewerOptions>;

  private yaw = 0;
  private pitch = 0;
  private fov: number;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pinchDistance = 0;
  private activePointers = new Map<number, { x: number; y: number }>();

  private frame = 0;
  private needsRender = true;
  private autoPan = false;
  /** Timestamp of the last auto-pan step, so the speed is per second and not per frame. */
  private lastPanAt = 0;
  private hasImage = false;
  private destroyed = false;

  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  constructor(canvas: HTMLCanvasElement, options: EquirectViewerOptions = {}) {
    this.canvas = canvas;
    this.options = { ...DEFAULTS, ...options };
    this.fov = toRad(this.options.initialFovDeg);

    const gl = canvas.getContext('webgl', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create program');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
    gl.useProgram(program);

    // Full-screen quad in clip space; vUv doubles as the -1..1 screen coordinate.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    const aPosition = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    for (const name of ['uTexture', 'uYaw', 'uPitch', 'uFov', 'uAspect']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');
    this.texture = texture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    this.attachEvents();
    this.resize();
    this.loop();
  }

  /**
   * Uploads a panorama. Throws if the source is cross-origin without CORS
   * headers, because the intermediate canvas would be tainted.
   */
  setImage(image: HTMLImageElement | ImageBitmap): void {
    const scratch = document.createElement('canvas');
    scratch.width = TEXTURE_WIDTH;
    scratch.height = TEXTURE_HEIGHT;
    const ctx = scratch.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.drawImage(image as CanvasImageSource, 0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT);

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scratch);

    this.hasImage = true;
    this.resetView();
  }

  resetView(): void {
    // Negated: a positive bearing turns the view clockwise, which the shader
    // reaches by decreasing yaw. See initialBearingDeg.
    this.yaw = -toRad(this.options.initialBearingDeg);
    this.pitch = 0;
    this.fov = toRad(this.options.initialFovDeg);
    this.needsRender = true;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
      this.needsRender = true;
    }
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.detachEvents();
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
  }

  // -- interaction ---------------------------------------------------------

  /**
   * Any deliberate interaction hands control back to the player.
   *
   * Now that the sweep starts on its own, this is the whole of the escape
   * hatch, so it has to cover every way of touching the view - pointer down for
   * click, touch and drag, and the wheel for zoom. Missing one leaves the view
   * turning under someone who has clearly asked it to stop.
   */
  private yieldToUser(): void {
    if (!this.autoPan) return;
    this.setAutoPan(false);
    this.onAutoPanChange?.(false);
  }

  private onPointerDown = (e: PointerEvent) => {
    this.yieldToUser();
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.activePointers.size === 1) {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    } else if (this.activePointers.size === 2) {
      this.dragging = false;
      this.pinchDistance = this.currentPinchDistance();
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.activePointers.has(e.pointerId)) return;
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size === 2) {
      const distance = this.currentPinchDistance();
      if (this.pinchDistance > 0 && distance > 0) {
        this.zoom((this.pinchDistance - distance) * 0.004);
      }
      this.pinchDistance = distance;
      return;
    }

    if (!this.dragging) return;
    // Drag distance maps to angle through the current FOV, so a drag moves the
    // scene by the amount under the finger regardless of zoom level.
    const scale = this.fov / Math.max(1, this.canvas.clientHeight);
    this.yaw -= (e.clientX - this.lastX) * scale;
    this.pitch += (e.clientY - this.lastY) * scale;
    this.clampPitch();
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.needsRender = true;
  };

  private onPointerUp = (e: PointerEvent) => {
    this.activePointers.delete(e.pointerId);
    if (this.activePointers.size < 2) this.pinchDistance = 0;
    if (this.activePointers.size === 0) this.dragging = false;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.yieldToUser();
    this.zoom(e.deltaY * 0.0015);
  };

  private currentPinchDistance(): number {
    const points = [...this.activePointers.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  private zoom(delta: number): void {
    const min = toRad(this.options.minFovDeg);
    const max = toRad(this.options.maxFovDeg);
    this.fov = Math.min(max, Math.max(min, this.fov + delta));
    this.clampPitch();
    this.needsRender = true;
  }

  private clampPitch(): void {
    const limit = toRad(this.options.maxPitchDeg);
    this.pitch = Math.min(limit, Math.max(-limit, this.pitch));
  }

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private detachEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  // -- render loop ---------------------------------------------------------

  private loop = (): void => {
    if (this.destroyed) return;
    this.resize();
    this.stepAutoPan();
    if (this.needsRender && this.hasImage) {
      this.render();
      this.needsRender = false;
    }
    this.frame = requestAnimationFrame(this.loop);
  };

  /**
   * Advances the view while auto-pan is running.
   *
   * Driven by elapsed time rather than by frame count, so the sweep takes the
   * same minute on a 60 Hz laptop and a 120 Hz phone. A positive speed turns the
   * view to the right, which the shader reaches by DECREASING yaw - the same
   * sign relationship as initialBearingDeg, verified against rendered pixels.
   */
  private stepAutoPan(): void {
    if (!this.autoPan || !this.hasImage) return;

    const now = performance.now();
    this.yaw = autoPanStep(
      this.yaw,
      this.options.autoPanDegreesPerSecond,
      now - this.lastPanAt
    );
    this.lastPanAt = now;
    this.needsRender = true;
  }

  /**
   * Called when the viewer stops auto-panning by itself, so a play/pause button
   * outside can follow. Without it, dragging would silently desync the button
   * from what the view is actually doing.
   */
  onAutoPanChange?: (panning: boolean) => void;

  /** Starts or stops the continuous sweep. Returns the state it settled on. */
  setAutoPan(on: boolean): boolean {
    if (on === this.autoPan) return this.autoPan;
    this.autoPan = on;
    // Reset the clock on start, so a long pause does not jump on resume.
    if (on) this.lastPanAt = performance.now();
    return this.autoPan;
  }

  isAutoPanning(): boolean {
    return this.autoPan;
  }

  private render(): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniforms.uTexture, 0);
    gl.uniform1f(this.uniforms.uYaw, this.yaw);
    gl.uniform1f(this.uniforms.uPitch, this.pitch);
    gl.uniform1f(this.uniforms.uFov, this.fov);
    gl.uniform1f(this.uniforms.uAspect, this.canvas.width / this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
