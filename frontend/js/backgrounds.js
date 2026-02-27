/* =======================================================
   SyncDrax — Virtual Backgrounds (MediaPipe Selfie Segmentation)
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
  bg9:  { type: 'image', src: 'images/bg-home.jpg' },
};

// --- Home Interior Scene Renderer --------------------------------------------
function _drawHomeScene(ctx, w, h) {
  const s = w / 640; // scale factor

  // -- Wall --
  const wallGrad = ctx.createLinearGradient(0, 0, 0, h * 0.72);
  wallGrad.addColorStop(0, '#f0e6d3');
  wallGrad.addColorStop(1, '#e8d5bc');
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, w, h * 0.72);

  // -- Floor --
  const floorGrad = ctx.createLinearGradient(0, h * 0.72, 0, h);
  floorGrad.addColorStop(0, '#a0724a');
  floorGrad.addColorStop(1, '#7a4f2e');
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, h * 0.72, w, h * 0.28);

  // Floor planks
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1 * s;
  for (let i = 0; i < 10; i++) {
    const y = h * 0.72 + (h * 0.28 / 10) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const x = (w / 5) * i + (i % 2 === 0 ? 0 : w / 10);
    ctx.beginPath(); ctx.moveTo(x, h * 0.72); ctx.lineTo(x, h); ctx.stroke();
  }
  ctx.restore();

  // Baseboard
  ctx.fillStyle = '#d4b896';
  ctx.fillRect(0, h * 0.72, w, 8 * s);

  // -- Window (back left) --
  const wx = w * 0.06, wy = h * 0.07, ww = w * 0.26, wh = h * 0.48;
  // Sky outside
  const skyGrad = ctx.createLinearGradient(wx, wy, wx, wy + wh);
  skyGrad.addColorStop(0, '#87ceeb');
  skyGrad.addColorStop(1, '#dff2fd');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(wx, wy, ww, wh);
  // Sun glow
  const sunGrad = ctx.createRadialGradient(wx + ww * 0.7, wy + wh * 0.25, 0, wx + ww * 0.7, wy + wh * 0.25, ww * 0.5);
  sunGrad.addColorStop(0, 'rgba(255,240,100,0.8)');
  sunGrad.addColorStop(0.4, 'rgba(255,220,60,0.3)');
  sunGrad.addColorStop(1, 'rgba(255,220,60,0)');
  ctx.fillStyle = sunGrad;
  ctx.fillRect(wx, wy, ww, wh);
  // Window frame
  ctx.strokeStyle = '#c8a87a';
  ctx.lineWidth = 6 * s;
  ctx.strokeRect(wx, wy, ww, wh);
  // Cross bars
  ctx.beginPath();
  ctx.moveTo(wx + ww / 2, wy); ctx.lineTo(wx + ww / 2, wy + wh);
  ctx.moveTo(wx, wy + wh / 2); ctx.lineTo(wx + ww, wy + wh / 2);
  ctx.stroke();
  // Light rays from window
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = '#ffe88a';
  ctx.beginPath();
  ctx.moveTo(wx + ww * 0.7, wy + wh * 0.25);
  ctx.lineTo(0, h * 0.72);
  ctx.lineTo(wx + ww, h * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();

  // -- Bookshelf (right side) --
  const bx = w * 0.73, by = h * 0.08, bw = w * 0.24, bh = h * 0.64;
  // Cabinet body
  ctx.fillStyle = '#8b5e3c';
  ctx.fillRect(bx, by, bw, bh);
  // Shelf planks (4 shelves)
  ctx.fillStyle = '#7a4f2d';
  for (let i = 0; i <= 4; i++) {
    ctx.fillRect(bx, by + (bh / 4) * i - 3 * s, bw, 6 * s);
  }
  // Books on shelves
  const bookColors = ['#c0392b','#2980b9','#27ae60','#8e44ad','#e67e22','#e74c3c','#1abc9c','#3498db','#f39c12','#d35400','#16a085','#7f8c8d'];
  let bookIdx = 0;
  for (let shelf = 0; shelf < 4; shelf++) {
    const shelfY = by + (bh / 4) * shelf + 6 * s;
    const shelfH = bh / 4 - 9 * s;
    let bkX = bx + 4 * s;
    while (bkX < bx + bw - 8 * s) {
      const bkW = (12 + Math.floor(((bookIdx * 7) % 8))) * s;
      const bkH = shelfH * (0.7 + (bookIdx % 3) * 0.1);
      ctx.fillStyle = bookColors[bookIdx % bookColors.length];
      ctx.fillRect(bkX, shelfY + shelfH - bkH, bkW, bkH);
      // Book spine
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.fillRect(bkX, shelfY + shelfH - bkH, 2 * s, bkH);
      bkX += bkW + 2 * s;
      bookIdx++;
    }
  }
  // Shelf side borders
  ctx.fillStyle = '#6b4423';
  ctx.fillRect(bx, by, 5 * s, bh);
  ctx.fillRect(bx + bw - 5 * s, by, 5 * s, bh);

  // -- Plant (potted, near window) --
  const px = w * 0.36, potY = h * 0.60;
  // Pot
  ctx.fillStyle = '#c0633a';
  ctx.beginPath();
  ctx.moveTo(px - 16 * s, potY + 35 * s);
  ctx.lineTo(px - 12 * s, potY);
  ctx.lineTo(px + 12 * s, potY);
  ctx.lineTo(px + 16 * s, potY + 35 * s);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#a0522d';
  ctx.fillRect(px - 17 * s, potY - 4 * s, 34 * s, 7 * s);
  // Soil
  ctx.fillStyle = '#4a2c10';
  ctx.beginPath();
  ctx.ellipse(px, potY - 1.5 * s, 13 * s, 4 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  // Stems
  ctx.strokeStyle = '#3d7a2f';
  ctx.lineWidth = 3 * s;
  const stems = [[-8, -50, -18, -90], [0, -45, 12, -88], [8, -48, 22, -72], [-4, -55, -28, -75]];
  stems.forEach(([x1, y1, x2, y2]) => {
    ctx.beginPath();
    ctx.moveTo(px + x1 * s, potY + y1 * s);
    ctx.bezierCurveTo(px + x1 * s, potY + (y1 + y2) / 2 * s, px + x2 * s, potY + y2 * s, px + x2 * s, potY + y2 * s);
    ctx.stroke();
  });
  // Leaves
  const leafPositions = [[-18, -90], [12, -88], [22, -72], [-28, -75], [0, -100]];
  leafPositions.forEach(([lx, ly]) => {
    ctx.fillStyle = '#4caf50';
    ctx.beginPath();
    ctx.ellipse(px + lx * s, potY + ly * s, 14 * s, 9 * s, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#388e3c';
    ctx.beginPath();
    ctx.ellipse(px + lx * s - 2 * s, potY + ly * s, 7 * s, 5 * s, -0.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // -- Ceiling line / crown molding --
  ctx.fillStyle = '#d4b896';
  ctx.fillRect(0, 0, w, 6 * s);

  // -- Subtle shadow at base of wall --
  const shadowGrad = ctx.createLinearGradient(0, h * 0.68, 0, h * 0.75);
  shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
  shadowGrad.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = shadowGrad;
  ctx.fillRect(0, h * 0.68, w, h * 0.08);
}

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

    // Offscreen canvas for sharpening the segmentation mask (removes feathering)
    this._maskCanvas = document.createElement('canvas');
    this._maskCtx    = this._maskCanvas.getContext('2d');

    // MediaPipe segmenter
    this._segmenter  = null;
    this._modelReady = false;

    // Canvas stream (for WebRTC track replacement)
    this._canvasStream = null;

    // Preload image backgrounds
    this._imgCache = {};
    Object.entries(BACKGROUNDS).forEach(([key, bg]) => {
      if (bg && bg.type === 'image') {
        const img = new Image();
        img.onload  = () => console.log(`[BG] Image loaded: ${bg.src}`);
        img.onerror = () => console.error(`[BG] Image FAILED to load: ${bg.src} — make sure the file exists at frontend/images/`);
        // resolve relative to the page (not the JS file)
        img.src = new URL(bg.src, window.location.href).href;
        this._imgCache[key] = img;
      }
    });

    this._initSegmenter();
  }

  // --- MediaPipe init ---------------------------------------
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

  // --- Called by MediaPipe for every frame -----------------
  _onResults(results) {
    if (!this.running || this.current === 'none') return;

    const { canvas, ctx } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const bg = BACKGROUNDS[this.current];
    if (!bg) return;

    // -- Step 1: draw the background --------------------------
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
    } else if (bg.type === 'scene' && bg.scene === 'home') {
      _drawHomeScene(ctx, w, h);
    } else if (bg.type === 'image') {
      const img = this._imgCache[this.current];
      if (img && img.complete && img.naturalWidth) {
        // Cover-fit: fill canvas preserving aspect ratio
        const ir = img.naturalWidth / img.naturalHeight;
        const cr = w / h;
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
        if (ir > cr) { sw = img.naturalHeight * cr; sx = (img.naturalWidth - sw) / 2; }
        else          { sh = img.naturalWidth  / cr; sy = (img.naturalHeight - sh) / 2; }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      } else {
        // Image not ready yet — draw a placeholder and wait
        ctx.fillStyle = '#1a2a1a';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = `${14 * (w/640)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('Loading background…', w / 2, h / 2);
        ctx.textAlign = 'left';
        // If image failed entirely, log it
        if (img && img.complete && !img.naturalWidth) {
          console.error('[BG] Image load failed — check file is at frontend/images/bg-home.jpg');
        }
      }
    }

    // -- Step 2: isolate the person using the segmentation mask -
    // segmentationMask is a canvas where person = bright, background = dark.
    // We draw the video frame onto a temp canvas, then use destination-in
    // with the mask so only the person's pixels remain.
    const pc   = this._personCanvas;
    const pctx = this._personCtx;
    pc.width  = w;
    pc.height = h;

    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(results.image, 0, 0, w, h);               // draw original frame

    // Sharpen the segmentation mask: high contrast makes soft feathered edges
    // binary again, so the person stays crisp instead of blurry/transparent
    const mc   = this._maskCanvas;
    const mctx = this._maskCtx;
    mc.width  = w;
    mc.height = h;
    mctx.filter = 'contrast(6) brightness(2.5)';
    mctx.drawImage(results.segmentationMask, 0, 0, w, h);
    mctx.filter = 'none';

    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(mc, 0, 0, w, h);                          // cut out using sharpened mask
    pctx.globalCompositeOperation = 'source-over';

    // -- Step 3: composite person on top of background ---------
    ctx.drawImage(pc, 0, 0, w, h);
  }

  // --- Animation loop ---------------------------------------
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

  // --- Public API -------------------------------------------

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

  // --- Download wallpaper -----------------------------------
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
    c.fillText('? SyncDrax', 40, 1050);
    c.globalAlpha = 1;

    tmp.toBlob(blob => {
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `syncdrax-wallpaper-${name || bgKey}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }
}

window.BackgroundEngine = BackgroundEngine;
window.BACKGROUNDS      = BACKGROUNDS;
