import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Input, OnChanges, ViewChild } from '@angular/core';
import { AverageCoinSplit, averageCoinSplit, COIN_MOON_RMAX } from '@app/shared/address-utils';

type MoonTarget = 'kept' | 'fee';

@Component({
  selector: 'app-coin-moons',
  templateUrl: './coin-moons.component.html',
  styleUrls: ['./coin-moons.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class CoinMoonsComponent implements OnChanges {
  @Input() balance: number;
  @Input() utxoCount: number;
  @Input() vsizePerInput: number;
  @Input() feerate: number;

  readonly rmax = COIN_MOON_RMAX;
  // keep a non-zero fee moon so a tiny-but-real fee reads as "almost nothing", not "gone"
  readonly minFeeRadius = 2;
  // below this share the percentage rounds to nothing, so label it "≈0%" instead of "0.0%"
  readonly tinyShare = 0.001;

  split: AverageCoinSplit | null = null;

  // hover detail tooltip — a bonus over the always-visible percentages; not needed to read the figure
  hoverTarget: MoonTarget | null = null;
  tooltipPosition = { x: 0, y: 0 };
  isMobile: boolean;

  @ViewChild('tooltip') tooltipElement: ElementRef<HTMLElement>;

  constructor() {
    this.onResize();
  }

  ngOnChanges(): void {
    // pure derivation from inputs; null when aggregates are unusable or the feerate is not yet seeded
    this.split = averageCoinSplit(this.balance, this.utxoCount, this.vsizePerInput, this.feerate);
  }

  get feeRadius(): number {
    if (!this.split) {
      return 0;
    }
    // floor a real fee to a visible dot; the frozen-whale case should read as healthy, not broken
    return this.split.feePerInput > 0 ? Math.max(this.split.rFee, this.minFeeRadius) : 0;
  }

  // template-bound pointer events trigger change detection on their own, so OnPush needs no markForCheck here
  showTooltip(target: MoonTarget, event: PointerEvent): void {
    this.hoverTarget = target;
    this.moveTooltip(event);
  }

  moveTooltip(event: PointerEvent): void {
    if (this.isMobile) {
      return; // mobile has no cursor; the tooltip is pinned via CSS instead
    }
    let x = event.clientX;
    const y = event.clientY - 12;
    if (this.tooltipElement) {
      // centre on the cursor and clamp inside the viewport
      const bounds = this.tooltipElement.nativeElement.getBoundingClientRect();
      x -= bounds.width / 2;
      x = Math.min(Math.max(x, 20), window.innerWidth - 20 - bounds.width);
    }
    this.tooltipPosition = { x, y };
  }

  hideTooltip(): void {
    this.hoverTarget = null;
  }

  @HostListener('window:resize')
  onResize(): void {
    this.isMobile = window.innerWidth <= 767.98;
  }
}
