import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { combineLatest, Observable } from 'rxjs';
import { map, startWith } from 'rxjs/operators';
import { StateService } from '@app/services/state.service';
import { MiningService } from '@app/services/mining.service';
import { DifficultyAdjustment } from '@interfaces/node-api.interface';

export interface OddsRow {
  period: string;
  blocks: number;
  probability: number;
  oddsOneIn: number;
  equivalent: string;
}

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

// Static fun equivalents keyed by rough order-of-magnitude of "1 in X"
// We display the one whose threshold is closest to the actual odds
const EQUIVALENTS: { threshold: number; text: string }[] = [
  { threshold: 1,          text: 'Certain' },
  { threshold: 10,         text: 'Very likely' },
  { threshold: 100,        text: 'Likely' },
  { threshold: 1_000,      text: 'Coin flip, roughly' },
  { threshold: 10_000,     text: 'Rolling a 10,000-sided die' },
  { threshold: 100_000,    text: 'Being struck by lightning (lifetime)' },
  { threshold: 1_000_000,  text: 'Winning a national lottery' },
  { threshold: 10_000_000, text: 'Winning the Powerball jackpot' },
  { threshold: 1e9,        text: 'Flipping heads 30 times in a row' },
  { threshold: 1e12,       text: 'Flipping heads 40 times in a row' },
  { threshold: Infinity,   text: 'Astronomically unlikely' },
];

function getEquivalent(oddsOneIn: number): string {
  for (let i = 0; i < EQUIVALENTS.length - 1; i++) {
    if (oddsOneIn < EQUIVALENTS[i + 1].threshold) {
      return EQUIVALENTS[i].text;
    }
  }
  return EQUIVALENTS[EQUIVALENTS.length - 1].text;
}

@Component({
  selector: 'app-mining-odds',
  templateUrl: './mining-odds.component.html',
  styleUrls: ['./mining-odds.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MiningOddsComponent implements OnInit {
  form: FormGroup;
  units = HASHRATE_UNITS;

  networkStats$: Observable<{ hashrate: number; timeAvg: number; difficulty: number }>;
  results$: Observable<{
    oddsRows: OddsRow[];
    expectedTime: number | null;
    userHashrateHs: number;
    oddsPerBlock: number;
  } | null>;

  constructor(
    private formBuilder: FormBuilder,
    private stateService: StateService,
    private miningService: MiningService,
  ) {}

  ngOnInit(): void {
    this.form = this.formBuilder.group({
      hashrate: [1],
      unit: [DEFAULT_UNIT_INDEX],
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

        const ratio = userHashrateHs / network.hashrate;
        const avgBlockMs = network.timeAvg; // milliseconds

        const periods: { label: string; ms: number }[] = [
          { label: '1 hour',     ms: 60 * 60 * 1000 },
          { label: '1 day',      ms: 24 * 60 * 60 * 1000 },
          { label: '1 week',     ms: 7 * 24 * 60 * 60 * 1000 },
          { label: '1 month',    ms: 30 * 24 * 60 * 60 * 1000 },
          { label: '1 year',     ms: 365 * 24 * 60 * 60 * 1000 },
          { label: '10 years',   ms: 10 * 365 * 24 * 60 * 60 * 1000 },
        ];

        const oddsRows: OddsRow[] = periods.map(p => {
          const n = p.ms / avgBlockMs; // expected number of blocks in this period
          const prob = 1 - Math.pow(1 - ratio, n);
          const oddsOneIn = prob > 0 ? Math.round(1 / prob) : Infinity;
          return {
            period: p.label,
            blocks: Math.round(n),
            probability: prob,
            oddsOneIn,
            equivalent: getEquivalent(oddsOneIn),
          };
        });

        // Expected time in seconds
        const expectedTime = avgBlockMs / ratio / 1000;

        // Per-block probability expressed as "1 in X"
        const oddsPerBlock = Math.round(1 / ratio);

        return { oddsRows, expectedTime, userHashrateHs, oddsPerBlock };
      })
    );
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
