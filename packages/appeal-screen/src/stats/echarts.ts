/**
 * ECharts 按需引入（04 文档 §7 要求「ECharts 按需引入」）
 * 只注册大屏实际用到的图表与组件：柱/折线/环 + tooltip/legend/grid/graphic。
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  GraphicComponent,
  MarkLineComponent,
  LabelLayout,
  CanvasRenderer,
]);

export { echarts };
export type { EChartsCoreOption, EChartsType } from 'echarts/core';
