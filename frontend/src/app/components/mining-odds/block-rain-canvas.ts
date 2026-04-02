import { EventEmitter } from '@angular/core';

export interface RainBlock {
  x: number;
  y: number;
  col: number;
  speed: number;
  color: string;
  opacity: number;
  isWinner: boolean;
  flash: number;
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
  private speedVariance = 0.7;
  private columnSpeeds: number[] = [];
  private columnLastSpawnY: number[] = [];

  // Hashrate-driven spawn accumulator
  private spawnAccumulator = 0;

  // Mining odds
  private networkHashrateHs = 0;
  private userHashrateHs = 0;

  // Counters
  totalBlocks = 0;
  foundBlocks = 0;

  // All colors read from CSS vars at runtime — no hardcoded fallbacks needed
  // because readCSSColors() always runs before the first draw.
  private c = {
    bg: '#0d1117',
    blockDark1: '#191c27',  // --block-side
    blockDark2: '#232838',  // --block-top
    blockMid: '#272f4e',    // --secondary
    blockBlue: '#007cfa',   // --primary (celeste)
    blockGreen: '#83fd00',  // --green
    winner: '#6225b2',      // --tertiary
    winnerGlow: '#6225b2',  // --tertiary
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
  }

  setHashrate(hashesPerSecond: number): void {
    this.userHashrateHs = hashesPerSecond;
  }

  setNetworkHashrate(hashesPerSecond: number): void {
    this.networkHashrateHs = hashesPerSecond;
  }

  get winProbability(): number {
    if (this.networkHashrateHs <= 0 || this.userHashrateHs <= 0) {
      return 1 / 50000;
    }
    return this.userHashrateHs / this.networkHashrateHs;
  }

  private makeBlock(col: number, y: number): RainBlock {
    const isWinner = Math.random() < this.winProbability;
    const roll = Math.random();
    let color: string;
    if (isWinner) {
      color = this.c.winner;
    } else if (roll < 0.05) {
      // 5% celeste brillante
      color = this.c.blockBlue;
    } else if (roll < 0.10) {
      // 5% verde
      color = this.c.blockGreen;
    } else if (roll < 0.35) {
      // 25% azul medio
      color = this.c.blockMid;
    } else if (roll < 0.65) {
      // 30% block-top
      color = this.c.blockDark2;
    } else {
      // 35% block-side (más oscuro)
      color = this.c.blockDark1;
    }
    return {
      x: col * this.STEP,
      y,
      col,
      speed: this.columnSpeeds[col],
      color,
      opacity: isWinner ? 1.0 : color === this.c.blockDark1 ? 0.7 : 0.25 + Math.random() * 0.45,
      isWinner,
      flash: 0,
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
    this.spawnAccumulator = 0;
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
    this.spawnAccumulator = 0;
    this.clearCanvas();
  }

  /** Clears in-flight blocks and resets counters without stopping the animation loop. */
  resetStats(): void {
    this.blocks = [];
    this.blockFoundEvents = [];
    this.totalBlocks = 0;
    this.foundBlocks = 0;
    this.spawnAccumulator = 0;
  }

  private clearCanvas(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.fillStyle = this.c.bg;
    this.ctx.fillRect(0, 0, w, h);
  }

  // Hashrate-driven spawn: each block = one hash attempt.
  // Log10 scale so the visual stays manageable across H/s → EH/s range.
  private get hashesPerFrame(): number {
    if (this.userHashrateHs <= 0) return 0;
    const log = Math.log10(Math.max(this.userHashrateHs, 1));
    const blocksPerSec = log * 2.5;
    return Math.max(blocksPerSec / 60, 0);
  }

  private spawnBlocks(): void {
    if (this.COLS <= 0) return;

    this.spawnAccumulator += this.hashesPerFrame;

    const maxPerFrame = Math.min(Math.floor(this.spawnAccumulator), this.COLS);
    this.spawnAccumulator -= maxPerFrame;

    for (let i = 0; i < maxPerFrame; i++) {
      let col = Math.floor(Math.random() * this.COLS);
      let attempts = 0;
      while (this.columnLastSpawnY[col] < this.STEP * 2 && attempts < this.COLS) {
        col = (col + 1) % this.COLS;
        attempts++;
      }
      if (attempts >= this.COLS) break;

      this.blocks.push(this.makeBlock(col, -this.CELL_SIZE));
      this.columnLastSpawnY[col] = -this.CELL_SIZE;
    }

    for (let col = 0; col < this.COLS; col++) {
      this.columnLastSpawnY[col] += this.columnSpeeds[col];
    }
  }

  private updateBlocks(): void {
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      block.y += block.speed;

      if (block.y > h + this.CELL_SIZE) {
        this.totalBlocks++;
        if (block.isWinner) {
          this.foundBlocks++;
          const visibleY = Math.min(block.y - block.speed, h - this.CELL_SIZE * 2);
          this.triggerBlockFound(block.x, visibleY);
        }
        this.blocks.splice(i, 1);
      }
    }
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
    const ctx = this.ctx;
    for (const block of this.blocks) {
      if (block.isWinner) {
        this.drawWinnerBlock(block);
      } else {
        ctx.fillStyle = block.color;
        ctx.globalAlpha = block.opacity;
        ctx.fillRect(block.x, block.y, this.CELL_SIZE, this.CELL_SIZE);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawWinnerBlock(block: RainBlock): void {
    const ctx = this.ctx;
    const { x, y } = block;
    const pulse = 0.6 + 0.4 * Math.sin(block.flash);
    block.flash += 0.12;

    const cx = x + this.CELL_SIZE / 2;
    const cy = y + this.CELL_SIZE / 2;

    // Outermost soft halo via radial gradient
    const haloR = this.CELL_SIZE * 3.5;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    grad.addColorStop(0, this.c.winnerGlow);
    grad.addColorStop(1, 'transparent');
    ctx.globalAlpha = pulse * 0.35;
    ctx.fillStyle = grad;
    ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);

    // Layered rect glow (outermost → inner)
    ctx.fillStyle = this.c.winnerGlow;
    ctx.globalAlpha = pulse * 0.18;
    ctx.fillRect(x - 9, y - 9, this.CELL_SIZE + 18, this.CELL_SIZE + 18);

    ctx.globalAlpha = pulse * 0.35;
    ctx.fillRect(x - 5, y - 5, this.CELL_SIZE + 10, this.CELL_SIZE + 10);

    ctx.globalAlpha = pulse * 0.55;
    ctx.fillRect(x - 2, y - 2, this.CELL_SIZE + 4, this.CELL_SIZE + 4);

    // Core block with canvas shadow for real blur glow
    ctx.shadowColor = this.c.winnerGlow;
    ctx.shadowBlur = 18 * pulse;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = this.c.winner;
    ctx.fillRect(x, y, this.CELL_SIZE, this.CELL_SIZE);

    // Bright white specular center 
    ctx.shadowBlur = 0;
    ctx.globalAlpha = pulse * 0.7;
    ctx.fillStyle = '#9c95f7';
    const hs = Math.max(2, Math.floor(this.CELL_SIZE / 3));
    ctx.fillRect(x + 1, y + 1, hs, hs);

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

      // Ring 1 — fast expanding
      const r1 = this.CELL_SIZE + progress * maxDim * 0.6;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, 0, Math.PI * 2);
      ctx.strokeStyle = this.c.winner;
      ctx.globalAlpha = (1 - progress) * 0.35;
      ctx.lineWidth = 2 * (1 - progress);
      ctx.stroke();

      // Ring 2 — delayed, slower
      if (progress > 0.1) {
        const p2 = (progress - 0.1) / 0.9;
        const r2 = this.CELL_SIZE + p2 * maxDim * 0.4;
        ctx.beginPath();
        ctx.arc(cx, cy, r2, 0, Math.PI * 2);
        ctx.globalAlpha = (1 - p2) * 0.2;
        ctx.lineWidth = 1.5 * (1 - p2);
        ctx.stroke();
      }

      // Screen flash
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
