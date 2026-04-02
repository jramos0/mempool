import { EventEmitter } from '@angular/core';

export type BlockType = 'network' | 'user';

export interface RainBlock {
  x: number;
  y: number;
  col: number;
  speed: number;
  color: string;
  opacity: number;
  isWinner: boolean;
  flash: number;
  type: BlockType;
  trail: { y: number }[];
}

export interface BlockFoundEvent {
  x: number;
  y: number;
  timestamp: number;
  ringRadius: number;
  opacity: number;
}

export class BlockRainCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private blocks: RainBlock[] = [];
  private blockFoundEvents: BlockFoundEvent[] = [];
  private animFrameId: number | null = null;
  private running = false;

  // Grid config
  private CELL_SIZE = 9;
  private GAP = 3;
  private STEP: number;
  private COLS = 0;
  private ROWS = 0;

  // Animation
  private BASE_SPEED = 1.2;
  private USER_SPEED_MULT = 1.8;
  private speedVariance = 0.7;
  private columnSpeeds: number[] = [];
  private columnLastSpawnY: number[] = [];

  // Spawn accumulators — one per particle type
  private spawnAccumulatorNetwork = 0;
  private spawnAccumulatorUser = 0;

  // Mode
  private realisticMode = false;
  private avgBlockTimeSec = 600;

  // Mining odds
  private networkHashrateHs = 0;
  private userHashrateHs = 0;

  // Counters (user hashes only)
  totalBlocks = 0;
  foundBlocks = 0;

  // All colors read from CSS vars at runtime — no hardcoded fallbacks needed
  // because readCSSColors() always runs before the first draw.
  private c = {
    bg: '#0d1117',
    blockDark1: '#191c27',
    blockDark2: '#232838',
    blockMid: '#272f4e',
    blockBlue: '#007cfa',
    blockGreen: '#83fd00',
    winner: '#6225b2',
    winnerGlow: '#6225b2',
    networkMagenta: '#d946ef',
    networkOrange: '#f97316',
    networkRed: '#ef4444',
  };

  onBlockFound = new EventEmitter<{ x: number; y: number; blockNumber: number }>();

  get isRunning(): boolean {
    return this.running;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.STEP = this.CELL_SIZE + this.GAP;
    this.readCSSColors();
  }

  private readCSSColors(): void {
    const style = getComputedStyle(document.documentElement);
    const get = (v: string) => style.getPropertyValue(v).trim();

    const bg        = get('--bg');
    const blockSide = get('--block-side');
    const blockTop  = get('--block-top');
    const secondary = get('--secondary');
    const primary   = get('--primary');
    const green     = get('--green');
    const tertiary  = get('--tertiary');
    const red       = get('--red');
    const orange    = get('--orange');
    const pink      = get('--pink');

    if (bg)        this.c.bg         = bg;
    if (blockSide) this.c.blockDark1 = green;
    if (blockTop)  this.c.blockDark2 = primary;
    if (secondary) this.c.blockMid   = secondary;
    if (primary)   this.c.blockBlue  = primary;
    if (green)     this.c.blockGreen = green;
    if (tertiary) {
      this.c.winner     = tertiary;
      this.c.winnerGlow = tertiary;
    }
    if (red)    this.c.networkRed     = red;
    if (orange) this.c.networkOrange  = orange;
    if (pink)   this.c.networkMagenta = pink;
  }

  setHashrate(hashesPerSecond: number): void {
    this.userHashrateHs = hashesPerSecond;
  }

  setNetworkHashrate(hashesPerSecond: number): void {
    this.networkHashrateHs = hashesPerSecond;
  }

  setAvgBlockTime(seconds: number): void {
    this.avgBlockTimeSec = seconds > 0 ? seconds : 600;
  }

  setRealisticMode(value: boolean): void {
    this.realisticMode = value;
    this.spawnAccumulatorNetwork = 0;
    this.spawnAccumulatorUser = 0;
  }

  get winProbability(): number {
    if (this.networkHashrateHs <= 0 || this.userHashrateHs <= 0) {
      return 1 / 50000;
    }
    return this.userHashrateHs / this.networkHashrateHs;
  }

  // --- Spawn rates (circles/frame) ---

  // Network density: always log-scaled — the background "ocean" of hashes, consistent in both modes
  private get networkCirclesPerFrame(): number {
    if (this.networkHashrateHs <= 0) return 0;
    const log = Math.log10(Math.max(this.networkHashrateHs, 1));
    return Math.max((log * 4.5) / 60, 0);
  }

  // User stars: always log-scaled for visual density consistency across both modes.
  // The "realistic" difference is only in the win probability (handled in tickRealisticWinCheck).
  private get userStarsPerFrame(): number {
    if (this.userHashrateHs <= 0) return 0;
    const log = Math.log10(Math.max(this.userHashrateHs, 1));
    return Math.max((log * 1.2) / 60, 0);
  }

  // --- Block makers ---

  private makeNetworkBlock(col: number, y: number): RainBlock {
    const roll = Math.random();
    let color: string;
    if (roll < 0.4) {
      color = this.c.networkMagenta;
    } else if (roll < 0.75) {
      color = this.c.networkOrange;
    } else {
      color = this.c.networkRed;
    }
    return {
      x: col * this.STEP,
      y,
      col,
      speed: this.columnSpeeds[col],
      color,
      opacity: 0.13 + Math.random() * 0.12,
      isWinner: false,
      flash: 0,
      type: 'network',
      trail: [],
    };
  }

  private makeUserStar(col: number, y: number): RainBlock {
    // In realistic mode winners are never decided per-star — tickRealisticWinCheck() handles that.
    const isWinner = this.realisticMode ? false : Math.random() < this.winProbability;
    let color: string;
    if (isWinner) {
      color = this.c.winner;
    } else if (Math.random() < 0.5) {
      color = this.c.blockBlue;
    } else {
      color = this.c.blockGreen;
    }
    return {
      x: col * this.STEP,
      y,
      col,
      speed: this.columnSpeeds[col] * this.USER_SPEED_MULT,
      color,
      opacity: isWinner ? 1.0 : 0.7 + Math.random() * 0.25,
      isWinner,
      flash: 0,
      type: 'user',
      trail: [],
    };
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = parent.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (w < 480) {
      this.CELL_SIZE = 6;
      this.GAP = 3;
    } else if (w < 768) {
      this.CELL_SIZE = 7;
      this.GAP = 3;
    } else {
      this.CELL_SIZE = 9;
      this.GAP = 3;
    }
    this.STEP = this.CELL_SIZE + this.GAP;

    this.COLS = Math.floor(w / this.STEP);
    this.ROWS = Math.floor(h / this.STEP);

    this.columnSpeeds = [];
    this.columnLastSpawnY = [];
    for (let i = 0; i < this.COLS; i++) {
      this.columnSpeeds[i] = this.BASE_SPEED + Math.random() * this.speedVariance;
      this.columnLastSpawnY[i] = h;
    }

    this.blocks = [];
    this.spawnAccumulatorNetwork = 0;
    this.spawnAccumulatorUser = 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.readCSSColors();
    if (this.COLS > 0) {
      this.animate();
    }
  }

  stop(): void {
    this.running = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  reset(): void {
    this.stop();
    this.blocks = [];
    this.blockFoundEvents = [];
    this.totalBlocks = 0;
    this.foundBlocks = 0;
    this.spawnAccumulatorNetwork = 0;
    this.spawnAccumulatorUser = 0;
    this.clearCanvas();
  }

  /** Clears in-flight blocks and resets counters without stopping the animation loop. */
  resetStats(): void {
    this.blocks = [];
    this.blockFoundEvents = [];
    this.totalBlocks = 0;
    this.foundBlocks = 0;
    this.spawnAccumulatorNetwork = 0;
    this.spawnAccumulatorUser = 0;
  }

  /** Resets only the found/total counters — animation and in-flight blocks continue uninterrupted. */
  resetCounters(): void {
    this.totalBlocks = 0;
    this.foundBlocks = 0;
    this.blockFoundEvents = [];
  }

  private clearCanvas(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.fillStyle = this.c.bg;
    this.ctx.fillRect(0, 0, w, h);
  }

  private spawnInColumns(count: number, maker: (col: number, y: number) => RainBlock): void {
    for (let i = 0; i < count; i++) {
      let col = Math.floor(Math.random() * this.COLS);
      let attempts = 0;
      while (this.columnLastSpawnY[col] < this.STEP * 2 && attempts < this.COLS) {
        col = (col + 1) % this.COLS;
        attempts++;
      }
      if (attempts >= this.COLS) break;
      this.blocks.push(maker(col, -this.CELL_SIZE));
      this.columnLastSpawnY[col] = -this.CELL_SIZE;
    }
  }

  private spawnBlocks(): void {
    if (this.COLS <= 0) return;

    this.spawnAccumulatorNetwork += this.networkCirclesPerFrame;
    const netCount = Math.min(Math.floor(this.spawnAccumulatorNetwork), this.COLS);
    this.spawnAccumulatorNetwork -= netCount;
    this.spawnInColumns(netCount, (col, y) => this.makeNetworkBlock(col, y));

    this.spawnAccumulatorUser += this.userStarsPerFrame;
    const userCount = Math.min(Math.floor(this.spawnAccumulatorUser), Math.ceil(this.COLS / 3));
    this.spawnAccumulatorUser -= userCount;
    this.spawnInColumns(userCount, (col, y) => this.makeUserStar(col, y));

    for (let col = 0; col < this.COLS; col++) {
      this.columnLastSpawnY[col] += this.columnSpeeds[col];
    }
  }

  private updateBlocks(): void {
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];

      if (block.type === 'user' && block.isWinner) {
        block.trail.unshift({ y: block.y });
        if (block.trail.length > 5) block.trail.pop();
      }

      block.y += block.speed;

      if (block.y > h + this.CELL_SIZE) {
        if (block.type === 'user') {
          this.totalBlocks++;
          if (block.isWinner) {
            this.foundBlocks++;
            const visibleY = Math.min(block.y - block.speed, h - this.CELL_SIZE * 2);
            this.triggerBlockFound(block.x, visibleY);
          }
        }
        this.blocks.splice(i, 1);
      }
    }
  }

  /**
   * Realistic-mode only: one probability check per animation frame.
   * Probability = (user/network) / (avgBlockTimeSec × 60fps)
   * This means winners appear at wall-clock intervals matching the expected block time.
   */
  private tickRealisticWinCheck(): void {
    if (!this.realisticMode || this.userHashrateHs <= 0 || this.networkHashrateHs <= 0) return;

    const probPerFrame = (this.userHashrateHs / this.networkHashrateHs) / (this.avgBlockTimeSec * 60);
    if (Math.random() >= probPerFrame) return;

    // Pick a random column to materialise the winner star
    const col = Math.floor(Math.random() * this.COLS);
    const x = col * this.STEP;
    const r = this.CELL_SIZE / 2;
    // Start near the top so the falling animation is visible before exit
    const y = r;

    const star = this.makeUserStar(col, y);
    star.isWinner = true;
    star.color = this.c.winner;
    star.opacity = 1.0;
    this.blocks.push(star);

    this.foundBlocks++;
    this.triggerBlockFound(x, this.CELL_SIZE * 4);
  }

  private triggerBlockFound(x: number, y: number): void {
    this.blockFoundEvents.push({
      x,
      y,
      timestamp: performance.now(),
      ringRadius: this.CELL_SIZE,
      opacity: 1.0,
    });
    this.onBlockFound.emit({ x, y, blockNumber: this.totalBlocks });
  }

  private drawBlocks(): void {
    // Network circles first (background layer), user stars on top
    for (const block of this.blocks) {
      if (block.type === 'network') {
        this.drawNetworkCircle(block);
      }
    }
    for (const block of this.blocks) {
      if (block.type === 'user') {
        this.drawUserStar(block);
      }
    }
    this.ctx.globalAlpha = 1;
  }

  private drawNetworkCircle(block: RainBlock): void {
    const ctx = this.ctx;
    const r = this.CELL_SIZE / 2;
    const cx = block.x + r;
    const cy = block.y + r;
    ctx.globalAlpha = block.opacity;
    ctx.fillStyle = block.color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Draws a 4-pointed ✦ star polygon centered at (cx, cy). */
  private traceStar(cx: number, cy: number, outerR: number, innerR: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI / 4) - Math.PI / 2;
      const r = i % 2 === 0 ? outerR : innerR;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  private drawUserStar(block: RainBlock): void {
    if (block.isWinner) {
      this.drawWinnerStar(block);
      return;
    }

    // Non-winner user hashes: plain circle in user colors (blue/green)
    const ctx = this.ctx;
    const r = this.CELL_SIZE / 2;
    const cx = block.x + r;
    const cy = block.y + r;
    ctx.globalAlpha = block.opacity;
    ctx.fillStyle = block.color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawWinnerStar(block: RainBlock): void {
    const ctx = this.ctx;
    const { x, y } = block;
    const pulse = 0.6 + 0.4 * Math.sin(block.flash);
    block.flash += 0.12;

    const r = this.CELL_SIZE / 2;
    const cx = x + r;
    const cy = y + r;
    const outerR = r * 2.5;   // 2× bigger than before
    const innerR = r * 0.55;

    // Trail with glow
    for (let t = 0; t < block.trail.length; t++) {
      const trailCy = block.trail[t].y + r;
      const trailOpacity = pulse * (1 - (t + 1) / (block.trail.length + 1)) * 0.7;
      ctx.globalAlpha = trailOpacity;
      ctx.fillStyle = this.c.winnerGlow;
      ctx.shadowColor = this.c.winnerGlow;
      ctx.shadowBlur = 14;
      this.traceStar(cx, trailCy, outerR * (1 - t * 0.15), innerR);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Outermost soft halo
    const haloR = this.CELL_SIZE * 7;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    grad.addColorStop(0, this.c.winnerGlow);
    grad.addColorStop(1, 'transparent');
    ctx.globalAlpha = pulse * 0.45;
    ctx.fillStyle = grad;
    ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);

    // Layered star glow (outermost → inner)
    ctx.fillStyle = this.c.winnerGlow;
    ctx.globalAlpha = pulse * 0.22;
    this.traceStar(cx, cy, outerR + 16, innerR + 5);
    ctx.fill();

    ctx.globalAlpha = pulse * 0.42;
    this.traceStar(cx, cy, outerR + 10, innerR + 3);
    ctx.fill();

    ctx.globalAlpha = pulse * 0.65;
    this.traceStar(cx, cy, outerR + 5, innerR + 1);
    ctx.fill();

    // Core star with canvas shadow blur
    ctx.shadowColor = this.c.winnerGlow;
    ctx.shadowBlur = 30 * pulse;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = this.c.winner;
    this.traceStar(cx, cy, outerR, innerR);
    ctx.fill();

    // Bright specular highlight
    ctx.shadowBlur = 0;
    ctx.globalAlpha = pulse * 0.7;
    ctx.fillStyle = '#9c95f7';
    ctx.beginPath();
    ctx.arc(cx - r * 0.25, cy - r * 0.25, Math.max(1, r * 0.35), 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
  }

  private drawBlockFoundRings(): void {
    const ctx = this.ctx;
    const now = performance.now();
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const maxDim = Math.max(w, h);

    for (let i = this.blockFoundEvents.length - 1; i >= 0; i--) {
      const event = this.blockFoundEvents[i];
      const elapsed = now - event.timestamp;
      const duration = 2000;

      if (elapsed > duration) {
        this.blockFoundEvents.splice(i, 1);
        continue;
      }

      const progress = elapsed / duration;
      const cx = event.x + this.CELL_SIZE / 2;
      const cy = event.y + this.CELL_SIZE / 2;

      const r1 = this.CELL_SIZE + progress * maxDim * 0.6;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, 0, Math.PI * 2);
      ctx.strokeStyle = this.c.winner;
      ctx.globalAlpha = (1 - progress) * 0.35;
      ctx.lineWidth = 2 * (1 - progress);
      ctx.stroke();

      if (progress > 0.1) {
        const p2 = (progress - 0.1) / 0.9;
        const r2 = this.CELL_SIZE + p2 * maxDim * 0.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r2, 0, Math.PI * 2);
        ctx.globalAlpha = (1 - p2) * 0.2;
        ctx.lineWidth = 1.5 * (1 - p2);
        ctx.stroke();
      }

      if (elapsed < 200) {
        ctx.fillStyle = this.c.winner;
        ctx.globalAlpha = (1 - elapsed / 200) * 0.08;
        ctx.fillRect(0, 0, w, h);
      }

      ctx.globalAlpha = 1;
    }
  }

  private animate = (): void => {
    if (!this.running) return;

    this.clearCanvas();
    this.tickRealisticWinCheck();
    this.spawnBlocks();
    this.updateBlocks();
    this.drawBlocks();
    this.drawBlockFoundRings();

    this.animFrameId = requestAnimationFrame(this.animate);
  };

  destroy(): void {
    this.stop();
    this.blocks = [];
    this.blockFoundEvents = [];
  }
}
