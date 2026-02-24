/* =======================================================
   Crewly — Virtual Backgrounds (MediaPipe Selfie Segmentation)
   Real person segmentation — works like Zoom / Google Meet
   ======================================================= */

const BACKGROUNDS = {
  none: null,
  blur: { type: 'blur' },
  bg1:  { type: 'gradient', colors: ['#1e3a5f', '#0f2027'] },
  bg2:  { type: 'gradient', colors: ['#200122', '#6f0000'] },
  bg3:  { type: 'gradient', colors: ['#0f3460', '#533483'] },
  bg4:  { type: 'gradient', colors: ['#134e5e', '#71b280'] },
  bg5:  { type: 'gradient', colors: ['#373B44', '#4286f4'] },
  bg6:  { type: 'gradient', colors: ['#4e0000', '#9b1a1a'] },
  bg7:  { type: 'radial',   colors: ['#1a1a2e', '#16213e', '#0f3460'] },
  bg8:  { type: 'gradient', colors: ['#f5f7fa', '#c3cfe2'] },
};

class BackgroundEngine {
  constructor(videoEl, canvasEl) {
    this.video   = videoEl;
    this.canvas  = canvasEl;
    this.ctx     = canvasEl.getContext('2d');
    this.current = 'none';
    this.running = false;
    this._raf    = null;

    // Offscreen canvas used to isolate the person using the segmentation mask
    this._personCanvas = document.createElement('canvas');
    this._personCtx    = this._personCanvas.getContext('2d');

    // MediaPipe segmenter
    this._segmenter  = null;
    this._modelReady = false;

    // Canvas stream (for WebRTC track replacement)
    this._canvasStream = null;

    this._initSegmenter();
  }

  // ─── MediaPipe init ───────────────────────────────────────
  _initSegmenter() {
    if (typeof SelfieSegmentation === 'undefined') {
      console.warn('[BackgroundEngine] MediaPipe SelfieSegmentation not loaded.');
      return;
    }
    this._segmenter = new SelfieSegmentation({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
    });
    this._segmenter.setOptions({
      modelSelection: 1,   // 1 = landscape model (more accurate for wide frames)
    });
    this._segmenter.onResults((res) => this._onResults(res));

    // Warm up: send first frame as soon as video is ready so the model
    // pre-compiles its shaders and is instant when user picks a background.
    const warmUp = () => {
      this._segmenter.send({ image: this.video })
        .then(() => { this._modelReady = true; })
        .catch(() => {});
    };
    if (this.video.readyState >= 2) warmUp();
    else this.video.addEventListener('loadeddata', warmUp, { once: true });
  }

  // ─── Called by MediaPipe for every frame ─────────────────
  _onResults(results) {
    if (!this.running || this.current === 'none') return;

    const { canvas, ctx } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const bg = BACKGROUNDS[this.current];
    if (!bg) return;

    // ── Step 1: draw the background ──────────────────────────
    if (bg.type === 'blur') {
      // Blur the real camera frame to use as background
      ctx.filter = 'blur(20px) brightness(0.6)';
      ctx.drawImage(results.image, 0, 0, w, h);
      ctx.filter = 'none';
    } else if (bg.type === 'gradient') {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, bg.colors[0]);
      grad.addColorStop(1, bg.colors[1]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    } else if (bg.type === 'radial') {
      const grad = ctx.createRadialGradient(w * 0.2, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.8);
      grad.addColorStop(0, bg.colors[0]);
      grad.addColorStop(0.5, bg.colors[1]);
      grad.addColorStop(1, bg.colors[2] || bg.colors[1]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // ── Step 2: isolate the person using the segmentation mask ─
    // segmentationMask is a canvas where person = bright, background = dark.
    // We draw the video frame onto a temp canvas, then use destination-in
    // with the mask so only the person's pixels remain.
    const pc   = this._personCanvas;
    const pctx = this._personCtx;
    pc.width  = w;
    pc.height = h;

    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(results.image, 0, 0, w, h);               // draw original frame
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(results.segmentationMask, 0, 0, w, h);    // cut out using mask
    pctx.globalCompositeOperation = 'source-over';

    // ── Step 3: composite person on top of background ─────────
    ctx.drawImage(pc, 0, 0, w, h);
  }

  // ─── Animation loop ───────────────────────────────────────
  async _runLoop() {
    if (!this.running) return;

    const { video, canvas } = this;

    if (video.readyState >= 2) {
      const w = video.videoWidth  || 640;
      const h = video.videoHeight || 480;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w;
        canvas.height = h;
      }
      if (this._segmenter) {
        try {
          await this._segmenter.send({ image: video });
        } catch {
          this._fallbackDraw();
        }
      } else {
        this._fallbackDraw();
      }
    }

    this._raf = requestAnimationFrame(() => this._runLoop());
  }

  // Fallback while the model is still loading
  _fallbackDraw() {
    const { video, canvas, ctx } = this;
    if (video.readyState < 2) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.filter = 'blur(10px)';
    ctx.drawImage(video, 0, 0, w, h);
    ctx.filter = 'none';
  }

  // ─── Public API ───────────────────────────────────────────

  /**
   * Set the active background.
   * Returns the canvas MediaStreamTrack when a background is active
   * (for WebRTC track replacement), or null when set to 'none'.
   */
  setBackground(bgKey) {
    this.current = bgKey;
    if (bgKey === 'none') {
      this.stop();
      this.canvas.classList.add('hidden');
      this.video.style.display = '';
      return null;
    } else {
      this.canvas.classList.remove('hidden');
      this.video.style.display = 'none';
      this.start();
      return this.getCanvasTrack();
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._runLoop();
  }

  stop() {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  /** Returns a MediaStream captured from the output canvas (30 fps) */
  getCanvasStream(fps = 30) {
    if (!this._canvasStream) {
      this._canvasStream = this.canvas.captureStream(fps);
    }
    return this._canvasStream;
  }

  /** Convenience: first video track of the canvas stream */
  getCanvasTrack() {
    return this.getCanvasStream().getVideoTracks()[0] || null;
  }

  // ─── Download wallpaper ───────────────────────────────────
  downloadBackground(bgKey, name) {
    const bg = BACKGROUNDS[bgKey];
    if (!bg) return;

    const tmp   = document.createElement('canvas');
    tmp.width   = 1920;
    tmp.height  = 1080;
    const c     = tmp.getContext('2d');

    if (bg.type === 'gradient') {
      const grad = c.createLinearGradient(0, 0, 1920, 1080);
      grad.addColorStop(0, bg.colors[0]);
      grad.addColorStop(1, bg.colors[1]);
      c.fillStyle = grad;
      c.fillRect(0, 0, 1920, 1080);
    } else if (bg.type === 'radial') {
      const grad = c.createRadialGradient(384, 540, 0, 960, 540, 1536);
      grad.addColorStop(0, bg.colors[0]);
      grad.addColorStop(0.5, bg.colors[1]);
      grad.addColorStop(1, bg.colors[2] || bg.colors[1]);
      c.fillStyle = grad;
      c.fillRect(0, 0, 1920, 1080);
    } else {
      c.fillStyle = '#1a1a2e';
      c.fillRect(0, 0, 1920, 1080);
    }

    c.globalAlpha = 0.12;
    c.font        = 'bold 36px Lato, sans-serif';
    c.fillStyle   = '#fff';
    c.fillText('⚡ Crewly', 40, 1050);
    c.globalAlpha = 1;

    tmp.toBlob(blob => {
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `crewly-wallpaper-${name || bgKey}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }
}

window.BackgroundEngine = BackgroundEngine;
window.BACKGROUNDS      = BACKGROUNDS;
