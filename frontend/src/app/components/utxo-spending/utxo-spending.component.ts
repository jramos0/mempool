import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { combineLatest, Observable, Subscription } from 'rxjs';
import { map, startWith, tap, take } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { ThemeService } from '@app/services/theme.service';
import { Recommendedfees } from '@app/interfaces/websocket.interface';
import { feeLevels } from '@app/app.constants';

const INPUT_SIZES: Record<string, number> = {
  p2wpkh: 68,
  p2tr: 57.5,
  p2sh_p2wpkh: 91,
  p2pkh: 148,
};

const TYPE_ALIASES: Record<string, string> = {
  // p2pkh
  p2pkh: 'p2pkh',
  legacy: 'p2pkh',
  // p2sh_p2wpkh
  p2sh_p2wpkh: 'p2sh_p2wpkh',
  'p2sh-p2wpkh': 'p2sh_p2wpkh',
  'nested-segwit': 'p2sh_p2wpkh',
  nested_segwit: 'p2sh_p2wpkh',
  p2sh: 'p2sh_p2wpkh',
  // p2wpkh
  p2wpkh: 'p2wpkh',
  bech32: 'p2wpkh',
  segwit: 'p2wpkh',
  'native-segwit': 'p2wpkh',
  native_segwit: 'p2wpkh',
  v0_p2wpkh: 'p2wpkh',
  // p2tr
  p2tr: 'p2tr',
  taproot: 'p2tr',
  v1_p2tr: 'p2tr',
};

const OUTPUT_SIZES: Record<string, number> = {
  p2wpkh: 31,
  p2tr: 43,
  p2sh: 32,
  p2pkh: 34,
};

export interface CostRow {
  label: string;
  feeRate: number;
  totalSats: number;
  vsize: number;
}

@Component({
  selector: 'app-utxo-spending',
  templateUrl: './utxo-spending.component.html',
  styleUrls: ['./utxo-spending.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UtxoSpendingComponent implements OnInit, OnDestroy {
  form: FormGroup;

  gradient = 'linear-gradient(to right, var(--skeleton-bg), var(--skeleton-bg))';
  noPriority = 'var(--skeleton-bg)';

  private fees: Recommendedfees;
  private themeSubscription: Subscription;

  results$: Observable<{
    vsize: number;
    numInputs: number;
    inputSize: number;
    futureFeeRate: number;
    economy: CostRow;
    hour: CostRow;
    halfHour: CostRow;
    fastest: CostRow;
    custom: CostRow | null;
    rows: CostRow[];
    consolidationNow: number;
    inputCostFuture: number;
    delta: number;
  } | null>;

  constructor(
    private formBuilder: FormBuilder,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private themeService: ThemeService,
    private cd: ChangeDetectorRef,
    private route: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    this.websocketService.want(['stats']);

    this.form = this.formBuilder.group({
      numInputs:     [1, [Validators.required, Validators.min(1)]],
      inputType:     ['p2wpkh'],
      numOutputs:    [1, [Validators.required, Validators.min(1)]],
      outputType:    ['p2wpkh'],
      futureFeeRate: [1, [Validators.min(1), Validators.max(1000)]],
    });

    this.route.queryParamMap.pipe(take(1)).subscribe(params => {
      const utxos = params.get('utxos');
      const type = params.get('type');
      if (utxos) {
        const count = parseInt(utxos, 10);
        if (!isNaN(count) && count >= 1) {
          this.form.patchValue({ numInputs: count });
        }
      }
      if (type) {
        const canonical = TYPE_ALIASES[type.toLowerCase()];
        if (canonical) {
          this.form.patchValue({ inputType: canonical });
        }
      }
    });

    this.themeSubscription = this.themeService.themeState$.subscribe((state) => {
      if (!state.loading) {
        this.setFeeGradient();
      }
    });

    this.results$ = (combineLatest([
      this.form.valueChanges.pipe(startWith(this.form.value)) as Observable<any>,
      this.stateService.recommendedFees$.pipe(
        tap((fees) => {
          this.fees = fees;
          this.setFeeGradient();
        })
      ) as Observable<Recommendedfees>,
    ]) as Observable<[any, Recommendedfees]>).pipe(
      map(([formValue, fees]: [any, Recommendedfees]) => {
        const numInputs     = Number(formValue.numInputs);
        const numOutputs    = Number(formValue.numOutputs);
        const futureFeeRate = Number(formValue.futureFeeRate) || 0;

        if (!this.form.valid || numInputs < 1 || numOutputs < 1) {
          return null;
        }

        const inputSize  = INPUT_SIZES[formValue.inputType]  ?? 68;
        const outputSize = OUTPUT_SIZES[formValue.outputType] ?? 31;
        const isLegacy   = formValue.inputType === 'p2pkh';
        const overhead   = isLegacy ? 10 : 10.5;

        const vsize    = Math.ceil(overhead + (numInputs * inputSize) + (numOutputs * outputSize));
        const makeSats = (rate: number) => Math.ceil(vsize * rate);

        const makeRow = (label: string, feeRate: number): CostRow => ({
          label, feeRate, totalSats: makeSats(feeRate), vsize,
        });

        const economy  = makeRow('No Priority',     fees.economyFee);
        const hour     = makeRow('Low Priority',    fees.hourFee);
        const halfHour = makeRow('Medium Priority', fees.halfHourFee);
        const fastest  = makeRow('High Priority',   fees.fastestFee);
        const custom   = futureFeeRate >= 1 ? makeRow('Custom', futureFeeRate) : null;

        const rows: CostRow[] = [economy, hour, halfHour, fastest];
        if (custom) { rows.push(custom); }

        const consolidationNow  = makeSats(fees.fastestFee);
        const inputCostFuture   = futureFeeRate > 0
          ? Math.ceil(numInputs * inputSize * futureFeeRate)
          : 0;
        const delta = consolidationNow - inputCostFuture;

        return { vsize, numInputs, inputSize, futureFeeRate, economy, hour, halfHour, fastest, custom, rows, consolidationNow, inputCostFuture, delta };
      })
    );
  }

  setFeeGradient(): void {
    if (!this.fees || !this.themeService.mempoolFeeColors) {
      return;
    }
    let idx = feeLevels.slice().reverse().findIndex((lvl) => this.fees.minimumFee >= lvl);
    idx = idx >= 0 ? feeLevels.length - idx : idx;
    const startColor = '#' + (this.themeService.mempoolFeeColors[idx - 1] || this.themeService.mempoolFeeColors[this.themeService.mempoolFeeColors.length - 1]);

    idx = feeLevels.slice().reverse().findIndex((lvl) => this.fees.fastestFee >= lvl);
    idx = idx >= 0 ? feeLevels.length - idx : idx;
    const endColor = '#' + (this.themeService.mempoolFeeColors[idx - 1] || this.themeService.mempoolFeeColors[this.themeService.mempoolFeeColors.length - 1]);

    this.gradient  = `linear-gradient(to right, ${startColor}, ${endColor})`;
    this.noPriority = startColor;
    this.cd.markForCheck();
  }

  getSliderBackground(rate: number): string {
    const colors = this.themeService.mempoolFeeColors;
    if (!colors?.length) {
      return '';
    }
    let idx = feeLevels.slice().reverse().findIndex((lvl: number) => rate >= lvl);
    idx = idx >= 0 ? feeLevels.length - idx : 0;
    const color = '#' + (colors[idx - 1] || colors[colors.length - 1]);
    const pct = Math.round(((rate - 1) / (1000 - 1)) * 100);
    return `linear-gradient(to right, ${color} 0%, ${color} ${pct}%, var(--skeleton-bg-light) ${pct}%, var(--skeleton-bg-light) 100%)`;
  }

  ngOnDestroy(): void {
    this.themeSubscription.unsubscribe();
  }
}
