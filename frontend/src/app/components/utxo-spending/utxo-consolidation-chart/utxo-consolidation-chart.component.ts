import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
} from '@angular/core';
import { echarts, EChartsOption } from '@app/graphs/echarts';
import { ApiService } from '@app/services/api.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-utxo-consolidation-chart',
  templateUrl: './utxo-consolidation-chart.component.html',
  styleUrls: ['./utxo-consolidation-chart.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UtxoConsolidationChartComponent implements OnInit, OnChanges, OnDestroy {
  @Input() numInputs: number = 1;
  @Input() inputSize: number = 68;
  @Input() txSize: number = 0;
  @Input() futureFeeRate: number = 1;
  @Input() fastestFeeRate: number = 1;
  @Input() halfHourFeeRate: number = 1;
  @Input() hourFeeRate: number = 1;

  chartOptions: EChartsOption = {};
  chartInitOptions = { renderer: 'svg' };
  futureDotColor = '#E23B6C';

  private historicalData: { timestamp: number; median: number }[] = [];
  private apiSub: Subscription;

  constructor(private apiService: ApiService, private cd: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.apiSub = this.apiService.getHistoricalBlockFeeRates$('6m').subscribe({
      next: (response: any) => {
        const data: any[] = response.body ?? [];
        this.historicalData = data.map((d: any) => ({
          timestamp: d.timestamp * 1000,
          median: Math.max(0, d.avgFee_50),
        }));
        if (this.txSize > 0) {
          this.buildChart();
          this.cd.markForCheck();
        }
      },
    });
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (this.historicalData.length > 0 && this.txSize > 0) {
      this.buildChart();
      this.cd.markForCheck();
    }
  }

  private buildChart(): void {
    const now = Date.now();
    const pastWindow  = 6 * 30 * 24 * 60 * 60 * 1000;
    const futureWindow = 14 * 24 * 60 * 60 * 1000;
    const firstTimestamp = now - pastWindow;
    const futureTime = now + futureWindow;

    const visibleData = this.historicalData.filter(d => d.timestamp >= firstTimestamp);

    // ── Aggregate to weekly medians for a smoother line ────────────────────────
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const weeklyBuckets = new Map<number, number[]>();
    for (const d of visibleData) {
      const bucket = Math.floor(d.timestamp / weekMs) * weekMs;
      if (!weeklyBuckets.has(bucket)) weeklyBuckets.set(bucket, []);
      weeklyBuckets.get(bucket)!.push(d.median);
    }
    const weeklyData: { timestamp: number; median: number }[] = [];
    for (const [bucket, values] of weeklyBuckets) {
      values.sort((a, b) => a - b);
      const mid = Math.floor(values.length / 2);
      const median = values.length % 2 !== 0 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
      weeklyData.push({ timestamp: bucket + weekMs / 2, median });
    }
    weeklyData.sort((a, b) => a.timestamp - b.timestamp);

    const txSize = this.txSize;
    const currentRate = this.fastestFeeRate;
    const futureRate = this.futureFeeRate;

    // Future is cheaper → green (good to wait), future is pricier → magenta (pay now)
    const futureIsLower = futureRate < currentRate;
    this.futureDotColor = futureIsLower ? '#00E5BF' : '#E23B6C';
    const futureColor        = futureIsLower ? '#00E5BF' : '#E23B6C';
    const futureBgRgba       = futureIsLower ? 'rgba(0,229,191,0.04)'  : 'rgba(226,59,108,0.04)';
    const futureBorderRgba   = futureIsLower ? 'rgba(0,229,191,0.40)'  : 'rgba(226,59,108,0.40)';
    // Threshold-exceeded fill: magenta when historical was above target (always means "it was expensive")
    const threshExcessColor  = 'rgba(226,59,108,0.12)';

    // ── Past data series (capped at now, extended to now with currentRate) ──────
    const cappedWeekly = weeklyData.filter(d => d.timestamp <= now);
    const pastData: [number, number][] = cappedWeekly.map(d => [d.timestamp, d.median]);
    pastData.push([now, currentRate]);
    const threshBase: [number, number][] = cappedWeekly.map(d => [d.timestamp, Math.max(0, futureRate)]);
    threshBase.push([now, Math.max(0, futureRate)]);
    const threshExcess: [number, number][] = cappedWeekly.map(d => [
      d.timestamp,
      Math.max(0, d.median - futureRate),
    ]);
    threshExcess.push([now, Math.max(0, currentRate - futureRate)]);

    // ── Connection line: Now dot → Future dot ─────────────────────────────────
    const connectionData: [number, number][] = [
      [now, currentRate],
      [futureTime, futureRate],
    ];

    // ── Y axis range ───────────────────────────────────────────────────────────
    const maxHistorical = weeklyData.length > 0
      ? Math.max(...weeklyData.map(d => d.median))
      : futureRate;
    const yMaxRaw = Math.max(maxHistorical, futureRate, currentRate) * 1.15;
    const yInterval = Math.ceil(yMaxRaw / 5) || 1;
    const yMax = yInterval * 5;

    // Match the formulas from utxo-spending.component.ts
    const nowCost    = Math.ceil(txSize * currentRate);
    const futureCost = futureRate > 0
      ? Math.ceil(this.numInputs * this.inputSize * futureRate)
      : 0;

    // Stepped gradient breakpoints for past line color
    const oneThird = firstTimestamp + pastWindow / 3;
    const twoThirds = firstTimestamp + (pastWindow * 2) / 3;

    this.chartOptions = {
      animation: false,
      grid: { top: 30, right: 95, bottom: 36, left: 78 },
      visualMap: [{
        show: false,
        type: 'piecewise',
        dimension: 0,
        seriesIndex: 3,
        pieces: [
          { min: firstTimestamp, max: oneThird, color: '#6C5CE7' },
          { min: oneThird, max: twoThirds, color: '#A855F7' },
          { min: twoThirds, max: now, color: '#00E5BF' },
        ],
      }] as any,

      xAxis: {
        type: 'time',
        min: firstTimestamp,
        max: futureTime,
        axisLabel: {
          color: 'var(--transparent-fg)',
          fontSize: 11,
          hideOverlap: true,
          formatter: (value: number): string => {
            if (value > now) return '';
            const d = new Date(value);
            const day = d.getDate();
            if (day <= 7) {
              return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            }
            return '';
          },
        },
        splitLine: { show: false },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
        axisTick: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
      },

      yAxis: [
        {
          type: 'value',
          name: 'sat/vB',
          nameLocation: 'middle',
          nameGap: 52,
          min: 0,
          max: yMax,
          interval: yInterval,
          position: 'left',
          axisLabel: {
            color: 'var(--transparent-fg)',
            fontSize: 11,
            formatter: (val: number) => String(Math.round(val)),
          },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
          axisTick: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
        },
        {
          type: 'value',
          name: 'cost (sats)',
          nameLocation: 'middle',
          nameGap: 55,
          min: 0,
          max: yMax * txSize,
          interval: yInterval * txSize,
          position: 'right',
          axisLabel: {
            color: 'var(--transparent-fg)',
            fontSize: 11,
            inside: false,
            margin: 8,
            formatter: (val: number): string => {
              if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + 'M';
              if (val >= 1_000) return (val / 1_000).toFixed(0) + 'k';
              return String(Math.round(val));
            },
          },
          splitLine: { show: false },
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
          axisTick: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
        },
      ],

      tooltip: {
        trigger: 'axis',
        backgroundColor: '#2d2f45',
        borderColor: 'rgba(255,255,255,0.1)',
        textStyle: { color: '#fff', fontSize: 12 },
        axisPointer: {
          type: 'line',
          lineStyle: { color: 'rgba(255,255,255,0.3)', type: 'dashed' },
        },
        formatter: (params: any): string => {
          if (!Array.isArray(params) || !params.length) return '';

          // Check for Now dot
          const nowHit = params.find((p: any) => p.seriesName === 'nowDot');
          if (nowHit) {
            return [
              `<div style="font-weight:600;margin-bottom:4px">Now</div>`,
              `Fee rate: <b>${currentRate.toFixed(1)} sat/vB</b><br>`,
              `Cost: <b>${nowCost.toLocaleString()} sats</b>`,
            ].join('');
          }

          // Check for Future dot
          const futureHit = params.find((p: any) => p.seriesName === 'futureDot');
          if (futureHit) {
            return [
              `<div style="font-weight:600;margin-bottom:4px">Future scenario</div>`,
              `Fee rate: <b>${futureRate.toFixed(1)} sat/vB</b><br>`,
              `Cost: <b>${futureCost.toLocaleString()} sats</b>`,
            ].join('');
          }

          // Historical data
          const ts: number = params[0].data?.[0];
          if (!ts || ts > now) return '';
          const rate: number =
            params.find((p: any) => p.seriesName === 'feeRateLine')?.data?.[1] ?? 0;
          if (rate === 0) return '';
          const cost = Math.round(rate * txSize);
          const date = new Date(ts).toLocaleDateString(undefined, {
            month: 'short', year: 'numeric', day: 'numeric',
          });
          return [
            `<div style="font-weight:600;margin-bottom:4px">${date}</div>`,
            `Fee rate: <b>${rate.toFixed(1)} sat/vB</b><br>`,
            `Cost: <b>${cost.toLocaleString()} sats</b>`,
          ].join('');
        },
      },

      series: [
        // ── 1. Past gradient area fill (rendered first, beneath everything) ────
        {
          name: 'medianArea',
          type: 'line',
          data: pastData,
          yAxisIndex: 0,
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: 'rgba(108,92,231,0.20)' },
              { offset: 0.5, color: 'rgba(168,85,247,0.20)' },
              { offset: 1, color: 'rgba(0,229,191,0.20)' },
            ]),
          },
          symbol: 'none',
          silent: true,
          z: 1,
        } as any,

        // ── 2. Threshold base (invisible stacking anchor at futureRate) ──────────
        //    Hosts background zone markAreas (past cyan / future dynamic tint)
        {
          name: '_threshBase',
          type: 'line',
          data: threshBase,
          yAxisIndex: 0,
          stack: 'thresh',
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: 'transparent' },
          symbol: 'none',
          silent: true,
          z: 2,
          markArea: {
            silent: true,
            data: [
              [
                { xAxis: firstTimestamp, itemStyle: { color: 'rgba(0,229,191,0.04)' } },
                { xAxis: now },
              ],
              [
                { xAxis: now, itemStyle: { color: futureBgRgba } },
                { xAxis: futureTime },
              ],
            ] as any,
          },
        } as any,

        // ── 3. Threshold excess (magenta fill where historical median > futureRate)
        {
          name: '_threshExcess',
          type: 'line',
          data: threshExcess,
          yAxisIndex: 0,
          stack: 'thresh',
          lineStyle: { width: 0, opacity: 0 },
          areaStyle: { color: threshExcessColor },
          symbol: 'none',
          silent: true,
          z: 3,
        } as any,

        // ── 4. Historical fee rate line (past only) ────────────────────────────
        //    Color is driven by visualMap pieces (purple → violet → cyan)
        {
          name: 'feeRateLine',
          type: 'line',
          data: pastData,
          yAxisIndex: 0,
          lineStyle: { width: 1.5 },
          areaStyle: { color: 'transparent' },
          symbol: 'none',
          z: 4,
          markLine: {
            silent: true,
            symbol: 'none',
            data: [
              {
                yAxis: futureRate,
                lineStyle: { color: 'rgba(255,255,255,0.45)', type: 'dashed', width: 1 },
                label: {
                  show: true,
                  position: 'insideEndTop',
                  formatter: `${futureRate} sat/vB`,
                  color: 'rgba(255,255,255,0.50)',
                  fontSize: 10,
                },
              },
            ] as any,
          },
        } as any,

        // ── 5. Now → Future connection line ──────────────────────────────────────
        {
          name: 'nowToFuture',
          type: 'line',
          data: connectionData,
          yAxisIndex: 0,
          lineStyle: { width: 1.5, color: futureColor },
          symbol: 'none',
          z: 4,
        } as any,

        // ── 6. Current fee rate dot (cyan with glow ring) ───────────────────────
        {
          name: 'nowDot',
          type: 'scatter',
          data: [[now, currentRate]],
          yAxisIndex: 0,
          symbol: 'circle',
          symbolSize: 10,
          itemStyle: {
            color: '#00E5BF',
            borderColor: 'rgba(0,229,191,0.40)',
            borderWidth: 8,
          },
          z: 10,
        } as any,

        {
          name: 'futureDot',
          type: 'scatter',
          data: [[futureTime, futureRate]],
          yAxisIndex: 0,
          symbol: 'circle',
          symbolSize: 10,
          itemStyle: {
            color: futureColor,
            borderColor: futureBorderRgba,
            borderWidth: 8,
          },
          z: 10,
        } as any,
      ],
    };
  }

  ngOnDestroy(): void {
    this.apiSub?.unsubscribe();
  }
}
