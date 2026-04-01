import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { EChartsOption } from '@app/graphs/echarts';

@Component({
  selector: 'app-utxo-consolidation-chart',
  templateUrl: './utxo-consolidation-chart.component.html',
  styleUrls: ['./utxo-consolidation-chart.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UtxoConsolidationChartComponent implements OnChanges {
  @Input() numInputs: number = 1;
  @Input() inputSize: number = 68;
  @Input() txSize: number = 0;
  @Input() futureFeeRate: number = 1;
  @Input() fastestFeeRate: number = 1;
  @Input() halfHourFeeRate: number = 1;
  @Input() hourFeeRate: number = 1;

  chartOptions: EChartsOption = {};
  chartInitOptions = { renderer: 'svg' };

  constructor(private cd: ChangeDetectorRef) {}

  ngOnChanges(_changes: SimpleChanges): void {
    if (this.txSize > 0) {
      this.prepareChartOptions();
      this.cd.markForCheck();
    }
  }

  private prepareChartOptions(): void {
    const maxX = Math.max(300, this.futureFeeRate * 1.5);
    const steps = 200;

    const highConst = Math.ceil(this.txSize * this.fastestFeeRate);
    const midConst  = Math.ceil(this.txSize * this.halfHourFeeRate);
    const lowConst  = Math.ceil(this.txSize * this.hourFeeRate);

    const inputCostData: [number, number][] = [];
    const areaBaseData:  [number, number][] = [];
    const areaFillData:  [number, number][] = [];
    const highData:      [number, number][] = [];
    const midData:       [number, number][] = [];
    const lowData:       [number, number][] = [];

    for (let i = 0; i <= steps; i++) {
      const rate = 1 + (i / steps) * (maxX - 1);
      const inputCost = Math.ceil(this.numInputs * this.inputSize * rate);
      inputCostData.push([rate, inputCost]);
      areaBaseData.push([rate, highConst]);
      areaFillData.push([rate, Math.max(0, inputCost - highConst)]);
      highData.push([rate, highConst]);
      midData.push([rate, midConst]);
      lowData.push([rate, lowConst]);
    }

    const markXValue = Math.min(this.futureFeeRate, maxX);

    // Capture for tooltip closure
    const numInputs = this.numInputs;
    const inputSize = this.inputSize;

    this.chartOptions = {
      grid: { top: 20, right: 20, bottom: 85, left: 80 },
      dataZoom: [{
        type: 'inside',
        realtime: true,
        moveOnMouseMove: false,
        xAxisIndex: 0,
      }, {
        show: true,
        type: 'slider',
        brushSelect: false,
        realtime: true,
        xAxisIndex: 0,
        left: 80,
        right: 20,
        bottom: 10,
        selectedDataBackground: {
          lineStyle: { color: '#fff', opacity: 0.45 },
          areaStyle: { opacity: 0 },
        },
      }] as any,
      xAxis: {
        type: 'value',
        name: 'sat/vB',
        nameLocation: 'middle',
        nameGap: 30,
        min: 1,
        max: maxX,
        axisLabel: {
          color: 'var(--transparent-fg)',
          fontSize: 11,
        },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
        axisTick: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
      },
      yAxis: {
        type: 'value',
        name: 'sats',
        nameLocation: 'middle',
        nameGap: 60,
        axisLabel: {
          color: 'var(--transparent-fg)',
          fontSize: 11,
          formatter: (val: number): string => {
            if (val >= 1_000_000) { return (val / 1_000_000).toFixed(1) + 'M'; }
            if (val >= 1_000)     { return (val / 1_000).toFixed(0) + 'k'; }
            return String(val);
          },
        },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
        axisTick: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
      },
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
          const feeRate: number = Array.isArray(params) && params[0]?.data?.[0] != null
            ? params[0].data[0]
            : 0;
          if (!feeRate) { return ''; }
          const inputCost = Math.ceil(numInputs * inputSize * feeRate);
          const dot = (color: string) =>
            `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle"></span>`;
          const fmt = (n: number) => n.toLocaleString();
          return [
            `<div style="font-weight:600;margin-bottom:6px">${Math.round(feeRate * 10) / 10} sat/vB</div>`,
            `${dot('#E24B4A')}Input cost: <b>${fmt(inputCost)} sats</b><br>`,
            `${dot('#5DCAA5')}High priority: <b>${fmt(highConst)} sats</b>` +
              ` <span style="color:#5DCAA5;font-size:11px">(−${fmt(Math.max(0, inputCost - highConst))})</span><br>`,
            `${dot('#EF9F27')}Medium priority: <b>${fmt(midConst)} sats</b>` +
              ` <span style="color:#EF9F27;font-size:11px">(−${fmt(Math.max(0, inputCost - midConst))})</span><br>`,
            `${dot('#85B7EB')}Low priority: <b>${fmt(lowConst)} sats</b>` +
              ` <span style="color:#85B7EB;font-size:11px">(−${fmt(Math.max(0, inputCost - lowConst))})</span>`,
          ].join('');
        },
      },
      legend: { show: false },
      series: [
        // Invisible base at high-priority level (bottom of stacked area band)
        {
          name: '_areaBase',
          type: 'line',
          data: areaBaseData,
          stack: 'savingsArea',
          areaStyle: { color: 'transparent' },
          lineStyle: { width: 0, opacity: 0 },
          symbol: 'none',
          silent: true,
        } as any,
        // Fill between high-priority and input-cost lines (savings area)
        {
          name: '_areaFill',
          type: 'line',
          data: areaFillData,
          stack: 'savingsArea',
          areaStyle: { color: 'rgba(93,202,165,0.10)' },
          lineStyle: { width: 0, opacity: 0 },
          symbol: 'none',
          silent: true,
        } as any,
        // Input cost future — red solid
        {
          name: 'Input cost (future)',
          type: 'line',
          data: inputCostData,
          lineStyle: { color: '#E24B4A', width: 2.5 },
          itemStyle: { color: '#E24B4A' },
          symbol: 'none',
          z: 10,
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ xAxis: markXValue }],
            lineStyle: { color: 'rgba(255,255,255,0.3)', type: 'dashed', width: 1.5 },
            label: {
              show: true,
              position: 'end',
              formatter: `${Math.round(markXValue)} sat/vB`,
              color: 'rgba(255,255,255,0.45)',
              fontSize: 10,
            },
          },
        } as any,
        // Consolidate now — High priority, green dashed
        {
          name: 'High priority',
          type: 'line',
          data: highData,
          lineStyle: { color: '#5DCAA5', width: 2, type: 'dashed' },
          itemStyle: { color: '#5DCAA5' },
          symbol: 'none',
        } as any,
        // Consolidate now — Medium priority, orange dashed
        {
          name: 'Medium priority',
          type: 'line',
          data: midData,
          lineStyle: { color: '#EF9F27', width: 2, type: 'dashed' },
          itemStyle: { color: '#EF9F27' },
          symbol: 'none',
        } as any,
        // Consolidate now — Low priority, blue dashed
        {
          name: 'Low priority',
          type: 'line',
          data: lowData,
          lineStyle: { color: '#85B7EB', width: 2, type: 'dashed' },
          itemStyle: { color: '#85B7EB' },
          symbol: 'none',
        } as any,
      ],
    };
  }
}
