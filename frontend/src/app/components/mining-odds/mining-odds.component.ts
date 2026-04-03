import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { combineLatest, Observable, Subscription } from 'rxjs';
import { map, startWith } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { MiningService } from '@app/services/mining.service';
import { ApiService } from '@app/services/api.service';
import { DifficultyAdjustment, RewardStats } from '@interfaces/node-api.interface';
import { BlockRainCanvas } from './block-rain-canvas';

export interface PoolEarningsRow {
  period: string;
  btc: number;
  sats: number;
  usd?: number;
}

export type MiningMode = 'solo' | 'pool';

const HASHRATE_UNITS = [
  { label: 'H/s',  multiplier: 1 },
  { label: 'kH/s', multiplier: 1e3 },
  { label: 'MH/s', multiplier: 1e6 },
  { label: 'GH/s', multiplier: 1e9 },
  { label: 'TH/s', multiplier: 1e12 },
  { label: 'PH/s', multiplier: 1e15 },
  { label: 'EH/s', multiplier: 1e18 },
];

const DEFAULT_UNIT_INDEX = 4; // TH/s


@Component({
  selector: 'app-mining-odds',
  templateUrl: './mining-odds.component.html',
  styleUrls: ['./mining-odds.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MiningOddsComponent implements OnInit, OnDestroy {
  @ViewChild('blockRainCanvas', { static: false })
  set blockRainCanvasRef(ref: ElementRef<HTMLCanvasElement> | undefined) {
    if (ref && !this.blockRain) {
      this._canvasRef = ref;
      setTimeout(() => this.initCanvas(), 0);
    } else if (!ref && this.blockRain) {
      this.destroyCanvas();
    }
  }
  private _canvasRef: ElementRef<HTMLCanvasElement> | undefined;

  form: FormGroup;
  units = HASHRATE_UNITS;
  miningMode: MiningMode = 'solo';
  showBlockFound = false;
  realisticMode = true;
  networkHashrateHs = 0;

  networkStats$: Observable<{ hashrate: number; timeAvg: number; difficulty: number }>;
  results$: Observable<{
    expectedTime: number | null;
    userHashrateHs: number;
    oddsPerBlock: number;
  } | null>;
  poolResults$: Observable<{
    earningsRows: PoolEarningsRow[];
    dailyBtc: number;
    monthlyBtc: number;
    fppsRate: number;
    subsidyPerBlock: number;
    avgFeesPerBlock: number;
    userHashrateHs: number;
  } | null>;

  private blockRain: BlockRainCanvas | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private blockFoundTimeout: any;
  private statsInterval: any;
  private subscriptions = new Subscription();

  constructor(
    private formBuilder: FormBuilder,
    private stateService: StateService,
    private miningService: MiningService,
    private apiService: ApiService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {}

  setMode(mode: MiningMode): void {
    this.miningMode = mode;
    // Canvas init/destroy is handled by the ViewChild setter reacting to *ngIf changes
  }

  ngOnInit(): void {
    this.form = this.formBuilder.group({
      hashrate: [1],
      unit: [DEFAULT_UNIT_INDEX],
      poolFee: [2],
    });

    // Network stats: hashrate (H/s) + avg block time (ms) + difficulty
    this.networkStats$ = combineLatest([
      this.miningService.getMiningStats('1w'),
      this.stateService.difficultyAdjustment$,
    ]).pipe(
      map(([stats, da]: [any, DifficultyAdjustment]) => ({
        // getMiningStats divides by hashrateDivider, so multiply back to get raw H/s
        hashrate: stats.lastEstimatedHashrate1w * stats.miningUnits.hashrateDivider,
        timeAvg: da.timeAvg,
        difficulty: da.difficultyChange,
      }))
    );

    const formValues$ = this.form.valueChanges.pipe(
      startWith(this.form.value)
    );

    // Solo mining results
    this.results$ = combineLatest([
      this.networkStats$,
      formValues$,
    ]).pipe(
      map(([network, formVal]) => {
        const unitMultiplier = HASHRATE_UNITS[formVal.unit]?.multiplier ?? 1e12;
        const userHashrateHs = parseFloat(formVal.hashrate) * unitMultiplier;

        if (!userHashrateHs || userHashrateHs <= 0 || !network.hashrate || !network.timeAvg) {
          return null;
        }

        // Update canvas with current values
        if (this.blockRain) {
          this.blockRain.setHashrate(userHashrateHs);
          this.blockRain.setNetworkHashrate(network.hashrate);
        }

        const ratio = userHashrateHs / network.hashrate;
        const avgBlockMs = network.timeAvg; // milliseconds

        // Expected time in seconds
        const expectedTime = avgBlockMs / ratio / 1000;

        // Per-block probability expressed as "1 in X"
        const oddsPerBlock = Math.round(1 / ratio);

        return { expectedTime, userHashrateHs, oddsPerBlock };
      })
    );

    // Pool mining (FPPS) results
    this.poolResults$ = combineLatest([
      this.networkStats$,
      this.apiService.getRewardStats$(144),
      formValues$,
    ]).pipe(
      map((combined: any[]) => {
        const network = combined[0];
        const rewardStats: RewardStats = combined[1];
        const formVal = combined[2];
        const unitMultiplier = HASHRATE_UNITS[formVal.unit]?.multiplier ?? 1e12;
        const userHashrateHs = parseFloat(formVal.hashrate) * unitMultiplier;
        const poolFee = (parseFloat(formVal.poolFee) || 0) / 100;

        if (!userHashrateHs || userHashrateHs <= 0 || !network.hashrate) {
          return null;
        }

        const blockCount = rewardStats.endBlock - rewardStats.startBlock + 1;
        const totalSubsidiesSats = rewardStats.totalReward - rewardStats.totalFee;
        const totalFeesSats = rewardStats.totalFee;

        // FPPS rate = 1 + (Sum of Block Transaction Fees / Sum of Block Subsidies)
        const fppsRate = 1 + (totalFeesSats / totalSubsidiesSats);

        const subsidyPerBlockBtc = totalSubsidiesSats / blockCount / 1e8;
        const avgFeesPerBlockBtc = totalFeesSats / blockCount / 1e8;
        const ratio = userHashrateHs / network.hashrate;
        const blocksPerDay = 144;

        // FPPS daily earnings = ratio × blocks_per_day × subsidy × fpps_rate × (1 - pool_fee)
        const dailyBtc = ratio * blocksPerDay * subsidyPerBlockBtc * fppsRate * (1 - poolFee);

        const periods: { label: string; days: number }[] = [
          { label: '1 hour',   days: 1 / 24 },
          { label: '1 day',    days: 1 },
          { label: '1 week',   days: 7 },
          { label: '1 month',  days: 30 },
          { label: '1 year',   days: 365 },
          { label: '10 years', days: 3650 },
        ];

        const earningsRows: PoolEarningsRow[] = periods.map(p => {
          const btc = dailyBtc * p.days;
          return {
            period: p.label,
            btc,
            sats: Math.round(btc * 1e8),
          };
        });

        return {
          earningsRows,
          dailyBtc,
          monthlyBtc: dailyBtc * 30,
          fppsRate,
          subsidyPerBlock: subsidyPerBlockBtc,
          avgFeesPerBlock: avgFeesPerBlockBtc,
          userHashrateHs,
        };
      })
    );

    // Keep canvas probabilities in sync with hashrate/network data
    this.subscriptions.add(
      combineLatest([this.networkStats$, formValues$]).subscribe(([network, formVal]) => {
        this.networkHashrateHs = network.hashrate;
        if (this.blockRain) {
          const unitMultiplier = HASHRATE_UNITS[formVal.unit]?.multiplier ?? 1e12;
          const userHashrateHs = parseFloat(formVal.hashrate) * unitMultiplier;
          const effectiveHashrate = (userHashrateHs > 0 && userHashrateHs <= network.hashrate)
            ? userHashrateHs : 0;
          this.blockRain.setHashrate(effectiveHashrate);
          this.blockRain.setNetworkHashrate(network.hashrate);
          this.blockRain.setAvgBlockTime(network.timeAvg / 1000);
        }
      })
    );

    // Reset found/total counters when hashrate changes so stats reflect the new value
    this.subscriptions.add(
      this.form.valueChanges.subscribe(() => {
        if (this.blockRain) {
          this.blockRain.resetCounters();
        }
      })
    );

  }

  ngOnDestroy(): void {
    this.destroyCanvas();
    this.subscriptions.unsubscribe();
    if (this.blockFoundTimeout) {
      clearTimeout(this.blockFoundTimeout);
    }
  }

  private initCanvas(): void {
    if (this.blockRain || !this._canvasRef) return;

    const canvas = this._canvasRef.nativeElement;
    const container = canvas.parentElement;
    if (!container) return;

    // Create canvas instance — resize() is NOT called in constructor,
    // ResizeObserver fires immediately with the real container dimensions.
    this.blockRain = new BlockRainCanvas(canvas);
    this.blockRain.setRealisticMode(this.realisticMode);

    this.subscriptions.add(
      this.blockRain.onBlockFound.subscribe(() => {
        this.showBlockFound = true;
        this.cdr.detectChanges();
        if (this.blockFoundTimeout) {
          clearTimeout(this.blockFoundTimeout);
        }
        this.blockFoundTimeout = setTimeout(() => {
          this.showBlockFound = false;
          this.cdr.detectChanges();
        }, 2000);
      })
    );

    // ResizeObserver fires immediately with the real rendered size,
    // then again on every subsequent resize.
    this.ngZone.runOutsideAngular(() => {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.blockRain) {
          this.blockRain.resize();
          if (!this.blockRain.isRunning) {
            this.blockRain.start();
          }
        }
      });
      this.resizeObserver.observe(container);

      // Periodically refresh overlay stats (foundBlocks / chance)
      this.statsInterval = setInterval(() => {
        this.cdr.detectChanges();
      }, 500);
    });
  }

  private destroyCanvas(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.blockRain) {
      this.blockRain.destroy();
      this.blockRain = null;
    }
  }

  onRealisticModeToggle(): void {
    this.realisticMode = !this.realisticMode;
    if (this.blockRain) {
      this.blockRain.setRealisticMode(this.realisticMode);
    }
  }

  get hashrateExceedsNetwork(): boolean {
    if (!this.networkHashrateHs) return false;
    const formVal = this.form?.value;
    if (!formVal) return false;
    const unitMultiplier = HASHRATE_UNITS[formVal.unit]?.multiplier ?? 1e12;
    const userHashrateHs = parseFloat(formVal.hashrate) * unitMultiplier;
    return userHashrateHs > this.networkHashrateHs;
  }

  get rainFoundBlocks(): number {
    return this.blockRain?.foundBlocks ?? 0;
  }

  get userHashrateIsSet(): boolean {
    const formVal = this.form?.value;
    if (!formVal) return false;
    const unitMultiplier = HASHRATE_UNITS[formVal.unit]?.multiplier ?? 1e12;
    return parseFloat(formVal.hashrate) * unitMultiplier > 0;
  }

  get rainChanceDisplay(): string {
    if (!this.blockRain) return '∞';
    const prob = this.blockRain.winProbability;
    if (prob <= 0) return '∞';
    return this.formatOddsNumber(Math.round(1 / prob));
  }

  formatOddsNumber(oddsOneIn: number): string {
    if (!isFinite(oddsOneIn) || oddsOneIn > 1e15) {
      return '∞';
    }
    return oddsOneIn.toLocaleString();
  }

  formatExpectedTime(seconds: number): string {
    if (!isFinite(seconds) || seconds <= 0) {
      return 'Never';
    }
    const minute = 60;
    const hour = 3600;
    const day = 86400;
    const year = 365 * day;

    if (seconds < minute) {
      return `${Math.round(seconds)} seconds`;
    } else if (seconds < hour) {
      return `~${Math.round(seconds / minute)} minutes`;
    } else if (seconds < day) {
      return `~${Math.round(seconds / hour)} hours`;
    } else if (seconds < year) {
      return `~${Math.round(seconds / day)} days`;
    } else {
      const years = seconds / year;
      if (years >= 1_000_000) {
        return `~${(years / 1_000_000).toFixed(1)}M years`;
      } else if (years >= 1_000) {
        return `~${Math.round(years / 1000)}K years`;
      }
      return `~${Math.round(years).toLocaleString()} years`;
    }
  }

  formatBtc(btc: number): string {
    if (btc < 0.00001) {
      return btc.toFixed(8);
    } else if (btc < 0.01) {
      return btc.toFixed(6);
    } else if (btc < 1) {
      return btc.toFixed(4);
    }
    return btc.toFixed(2);
  }

  formatSats(sats: number): string {
    return Math.round(sats).toLocaleString();
  }

  formatHashrate(hs: number): string {
    const units = HASHRATE_UNITS;
    for (let i = units.length - 1; i >= 0; i--) {
      if (hs >= units[i].multiplier) {
        return `${(hs / units[i].multiplier).toFixed(2)} ${units[i].label}`;
      }
    }
    return `${hs} H/s`;
  }
}
