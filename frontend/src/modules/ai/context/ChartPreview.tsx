/**
 * 图表工作区的可见预览（项目已有图表能力：`echarts-for-react`，单独成块按需加载）。
 *
 * 只做渲染：数据与聚合口径由 `../chart-data.ts` 决定，二者不在两处各写一套。
 */
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { ChartType } from './types';

export interface ChartPreviewProps {
  type: ChartType;
  points: Array<{ label: string; value: number }>;
  title: string;
  showLegend: boolean;
  smooth: boolean;
  stacked: boolean;
}

export default function ChartPreview({ type, points, title, showLegend, smooth, stacked }: ChartPreviewProps) {
  const option: EChartsOption =
    type === 'pie'
      ? {
          title: { text: title, left: 'center', textStyle: { fontSize: 13 } },
          tooltip: { trigger: 'item' },
          legend: { show: showLegend, bottom: 0, type: 'scroll' },
          series: [
            {
              type: 'pie',
              radius: '58%',
              center: ['50%', '48%'],
              data: points.map((point) => ({ name: point.label, value: point.value })),
            },
          ],
        }
      : {
          title: { text: title, left: 'center', textStyle: { fontSize: 13 } },
          tooltip: { trigger: 'axis' },
          legend: { show: showLegend, bottom: 0, type: 'scroll' },
          grid: { left: 56, right: 24, top: 44, bottom: 40 },
          xAxis: { type: 'category', data: points.map((point) => point.label), axisLabel: { hideOverlap: true } },
          yAxis: { type: 'value' },
          series: [
            {
              type: type === 'line' ? 'line' : 'bar',
              data: points.map((point) => point.value),
              smooth,
              ...(stacked ? { stack: 'total' } : {}),
            },
          ],
        };

  return <ReactECharts option={option} style={{ height: 300, width: '100%' }} notMerge lazyUpdate />;
}
