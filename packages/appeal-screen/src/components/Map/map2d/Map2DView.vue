<script setup lang="ts">
/**
 * 二维大屏地图（CIM 影像底图 · 标签页默认视图）
 *
 * ===== 为什么做这个视图 =====
 * 三维白模在大屏上的实际体验问题：加载慢（CIM 场景 + S3M + 瓦片拼接多层叠加）、
 * 业务点位被楼栋体块遮挡、状态色无从表达。标书对诉求大屏的要求是「图表 + 网格 + 地图联动」
 * （1.2 可视化大屏：热力分布、社区网格图层、管线图层、逐级下钻），本就没有三维要求，
 * 因此这里给出一个同数据、同联动的二维实现。
 *
 * ===== 硬约束 =====
 * 1. 底图必须是 CIM 2D 影像瓦片：大屏点位是抖动坐标（EPSG:4326），与 CIM 4490 影像配套；
 *    换其它影像源会出现几十米级偏移。
 * 2. CIM 不可达时**不伪造**：如实显示「CIM 影像不可达」+ 原因，底图留深色网格底，
 *    业务图层照常渲染（点位/网格仍按真实经纬度落图，位置本身是对的）。
 * 3. 所有交互与三维视图同构：`@pick` 回调、筛选驱动 flyTo、选中高亮。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import XYZ from 'ol/source/XYZ';
import TileGrid from 'ol/tilegrid/TileGrid';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import MultiPolygon from 'ol/geom/MultiPolygon';
import LineString from 'ol/geom/LineString';
import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj';
import { Style, Fill, Stroke, Circle as CircleStyle, Text as TextStyle } from 'ol/style';
import { defaults as defaultControls, ScaleLine } from 'ol/control';
import type { Coordinate } from 'ol/coordinate';
import 'ol/ol.css';

import {
  AMAP_GCJ_OFFSET_METERS,
  AMAP_MAX_LEVEL,
  amapLabelTileUrl,
  amapSatelliteTileUrl,
  buildCimTileGridParams,
  cimTileUrlTemplate,
  probeCimTiles,
  sourceLabel,
  type CimProbeResult,
  type TileSource,
} from './cimTileSource';
import { fetchGridBoundaries, boundarySourceLabel, type GridBoundary, type BoundaryPackInfo } from './gridLayer';
import { API_BASE } from '../../../stats/apiBase';
import { formalHeatColor, HEAT_COLORS, type AdministrativeHeat } from './administrativeHeat';
import {
  fetchPipelineLayers,
  PIPELINE_COLORS,
  type PipelineBusinessType,
  type PipelineCell,
  type PipelineLayerResult,
  type PipelineProject,
} from './pipelineLayer';
import {
  fetchShutdownLayer,
  filterMarkersByLayers,
  householdsText,
  CATEGORY_COLORS,
  CATEGORY_LABEL,
  SHUTDOWN_CATEGORIES,
  type ShutdownCategory,
  type ShutdownEvent,
  type ShutdownLayerResult,
  type ShutdownMarker,
} from './shutdownLayer';

/** 小区点位（与三维视图同一份数据契约：抖动坐标 EPSG:4326） */
export interface Map2DPoint {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  gridId?: string;
}

/** 网格着色数据：网格编码 → 诉求件数（来自真实 bootstrap） */
export interface GridMetric {
  code: string;
  count: number;
}

/** 地图状态回报（父组件用于状态条如实展示） */
export interface Map2DStatus {
  phase: 'boot' | 'ready' | 'degraded';
  /** 底图一句话说明 */
  basemap: string;
  /** 底图是否用了真实 CIM 影像 */
  cimOk: boolean;
  /** 实际生效的影像源（drs 官方优先 / gateway 网关兜底 / null=都不可达） */
  source: TileSource | null;
  /** 失败原因（cimOk=false 时有值） */
  reason?: string;
  /** 生效源的探测耗时 */
  probeMs?: number;
  /** 边界来源说明 */
  boundary: string;
  /** 已落图点位数 */
  points: number;
  /** 已渲染网格数 */
  grids: number;
  /** 管线图层（标书 1.2.7）一句话状态：燃气/供水各着了多少网格 */
  pipeline: string;
  /** 停水停气图层（标书 1.2.6）一句话状态：四类各多少事件/标识 */
  shutdown: string;
}

/** 管线图层点击载荷（父组件据此打开「改造项目详情」抽屉） */
export interface PipelinePickPayload {
  /** 被点击的网格编码 */
  gridCode: string;
  /** 网格名称（来自边界图层；无边界时回退为编码） */
  gridName: string;
  /** 该网格的聚合单元（含涉及的全部项目，燃气+供水） */
  cell: PipelineCell;
  /** 该网格里各项目所属的业务类型，便于抽屉按图层分组 */
  byBusinessType: Record<PipelineBusinessType, PipelineProject[]>;
  /** 是否至少有一层开着（父组件不关心，但便于调试） */
  layersOn: { gas: boolean; water: boolean };
}

/** 停水停气标识点击载荷（父组件据此打开「停水停气事件」面板） */
export interface ShutdownPickPayload {
  /** 被点击的标识 */
  marker: ShutdownMarker;
  /** 对应事件（含企业/业务类型/时间范围/涉及户数/应急预案/房屋信息等） */
  event: ShutdownEvent | null;
  /** 该事件涉及的网格数；>1 即标书要求的「多网格联动高亮」场景 */
  gridTotal: number;
  /** 该网格的停水停气历史数据（标书要求：可查看该网格历史数据） */
  gridHistory: import('./shutdownLayer').ShutdownGridHistory | null;
  dataSource: ShutdownLayerResult['dataSource'];
  dataSourceNote: ShutdownLayerResult['dataSourceNote'];
}

const props = withDefaults(
  defineProps<{
    points?: Map2DPoint[];
    gridMetrics?: GridMetric[];
    heat?: AdministrativeHeat | null;
    heatLoading?: boolean;
    /** 当前选中区县 adcode（高德边界情况下用它高亮） */
    districtCode?: string;
    /** 当前选中网格编码 */
    gridCode?: string;
    /**
     * 当前生效的「小区」筛选（点过查询的值）。
     * 用于自动定位并高亮该小区 —— 之前这个条件只存在于筛选条，地图侧完全没接，
     * 导致「筛选里选了小区，地图上看不出任何变化」。
     */
    communityCode?: string;
    /** 是否显示点位 */
    showPoints?: boolean;
  }>(),
  {
    points: () => [],
    gridMetrics: () => [],
    heat: null,
    heatLoading: false,
    districtCode: '',
    gridCode: '',
    communityCode: '',
    showPoints: true,
  }
);

const emit = defineEmits<{
  (e: 'pick', payload: { type: 'community' | 'grid'; items: Map2DPoint[]; code?: string; name?: string; formalHeatGrid?: boolean }): void;
  (e: 'status', payload: Map2DStatus): void;
  /** 点击改造项目网格（标书 1.2.7：点击可查看改造事件信息） */
  (e: 'pipeline-pick', payload: PipelinePickPayload): void;
  (e: 'pipeline-clear'): void;
  /** 点击停水停气打点标识（标书 1.2.6：点击标识可查看事件信息） */
  (e: 'shutdown-pick', payload: ShutdownPickPayload): void;
  (e: 'shutdown-clear'): void;
  /** 定位点在地图容器内的像素坐标（详情浮层据此贴点显示） */
  (e: 'anchor', payload: { x: number; y: number; width: number; height: number; lonLat: [number, number] } | null): void;
}>();

/* ------------------------------------------------------------------ 状态 */

const hostRef = ref<HTMLDivElement | null>(null);
const mapRef = shallowRef<OlMap | null>(null);
const probe = ref<CimProbeResult | null>(null);
/**
 * 当前底图是否是高德兜底。
 * 高德是 GCJ-02，与业务点位所用的 WGS84 在宜昌约有 680m 偏移 —— 只要切到高德，
 * 状态卡必须转黄色告警态并在顶部挂偏差横幅，不能让使用者误以为点位放错了。
 */
const amapActive = computed(() => probe.value?.ok === true && probe.value?.source === 'amap');
const boundaries = ref<GridBoundary[]>([]);
/** 边界降级原因（无边界/部分缺失时如实展示） */
const boundaryNote = ref<string | null>(null);
/** 街道层边界来源（official=正式 / buffer=点位缓冲近似） */
const streetSource = ref<'official' | 'pack' | 'buffer' | 'mixed' | 'none'>('none');
const streetCount = ref<{ official: number; pack: number; buffer: number }>({ official: 0, pack: 0, buffer: 0 });
/**
 * 街道/网格面图例（按真实来源拆分，不合并成一句"近似"）。
 *
 * 为什么必须拆：现在这一层可能同时有三种面 —— 甲方正式边界（实线）、
 * 边界数据包底稿（琥珀短虚线，OSM/商业数据）、点位缓冲近似（蓝虚线）。
 * 图例只写"近似"会让验收方以为琥珀面也是近似，或者误以为是正式行政界。
 */
const streetLegendText = computed(() => {
  const sc = streetCount.value;
  const parts: string[] = [];
  if (sc.official > 0) parts.push(`行政网格主数据 ${sc.official}`);
  /*
   * 街道面按**要素级 provider** 分组计数，而不是用包级 provider 一概而论：
   * 同一个数据包可以混装 OSM 实测面与点位推导面；只写一句「底稿 N」，
   * 验收方会把 35 个推导面当成 42 个实测面。
   */
  const byProvider: Record<string, number> = {};
  for (const b of boundaries.value) {
    if (b.level === 'district' || b.source !== 'pack') continue;
    const label = packProviderLabelOf(b.provider);
    byProvider[label] = (byProvider[label] ?? 0) + 1;
  }
  for (const [label, n] of Object.entries(byProvider)) parts.push(`${label} ${n}（虚线·非权威）`);
  if (sc.buffer > 0) parts.push(`点位缓冲近似 ${sc.buffer}（蓝虚线 ≈）`);
  // CIM 栅格边界（真网格线，但只能看不能填色）单独标出，避免被误认为可交互的网格面
  if (cimGridReady.value) parts.push('CIM 网格边界（栅格线·只读）');
  return parts.length ? `街道/网格面＝${parts.join(' + ')}` : '街道/网格面＝待接入';
});
/** 要素级 provider → 中文标注（与 gridLayer.packProviderLabel 同口径） */
function packProviderLabelOf(provider?: string): string {
  const p = String(provider ?? '').trim().toLowerCase();
  if (p === 'osm') return 'OSM 底稿';
  if (p === 'derived-voronoi') return '点位泰森多边形（近似）';
  if (p === 'amap-adat') return '高德企业智图';
  if (p === 'official-export') return '甲方导出';
  return p ? p : '边界数据包';
}

/** 边界数据包溯源（OSM 底稿等），状态条如实标注来源/抓取时间/许可证 */
const boundaryPack = ref<BoundaryPackInfo | null>(null);
/** 数据包中已与网格编码对齐的要素数（少于 pack 数说明有网格聚不上诉求） */
const packMatched = ref(0);
/**
 * 悬停信息（标书 1.2.4 要求：鼠标滑至网格可见「社区名称、网格名称、当前该网格的诉求量」）
 * 小区点位命中时展示小区名；网格/街道命中时展示网格名 + 社区提示 + 件数。
 */
const hoverName = ref('');
const hoverCount = ref<number | null>(null);
const hoverKind = ref<'community' | 'grid' | 'street' | 'pipeline-gas' | 'pipeline-water' | 'shutdown' | ''>('');
const hoverCode = ref('');
/** 悬停网格下的社区名称（标书 1.2.4 要求显示「社区名称」） */
const hoverCommunityNames = ref<string[]>([]);
const hoverFormalGrid = ref(false);
/** 该网格的社区总数（列表可能截断，用于「共 N 个」提示） */
const hoverCommunityTotal = ref(0);
const cursorStyle = ref<'default' | 'pointer'>('default');
const basemapLabel = ref('正在探测 CIM 影像…');

/* ------------------------------------------------- 管线图层（标书 1.2.7） */
/**
 * 燃气 / 供水两个**独立**图层开关（对应标书「燃气管线图层和供水管线图层」）。
 * 落图单位是「改造项目涉及的网格色块」，不是管线线条 —— 见 pipelineLayer.ts 顶部口径说明。
 */
const gasLayerOn = ref(true);
const waterLayerOn = ref(true);
/**
 * 业务数据图层开关（客户要求：和燃气/供水一样，所有数据效果都能独立开关）。
 *
 * 四层分别对应图上四类可独立开关的视觉元素：
 *   districtOn  区县参考边界
 *   streetOn    行政网格边界
 *   pointsOn    小区点位（标书 1.2.5 小区图层）
 *   heatOn      按已发布系数给正式行政网格着色
 */
const districtOn = ref(true);
const streetOn = ref(true);
const pointsOn = ref(true);
const heatOn = ref(true);
/**
 * 叠加对照模式（客户验收用）：
 * 打开后**去掉所有面填充、只留描边与标签**，影像完整露出，
 * 用来一眼核对「着色边界」是否真的贴在 CIM 影像上（而不是被半透明色块糊住看不清）。
 * 不影响图层开关与筛选口径，纯显示态。
 */
const compareOn = ref(false);
/** 燃气/供水各自的图层数据（分别独立拉取，互不覆盖） */
const pipeEmptyDismissed = ref(false);
/** 管线空态说明是否展开（默认收起，避免居中悬浮块挡住地图） */
const pipeEmptyExpanded = ref(false);
/** 控制条详情行是否展开 */
const layerDetailOpen = ref(false);

/** 小区点位数量（图层开关按钮上显示，让开关有"这层有多少东西"的直观反馈） */
const map2dPointCount = computed(() => (Array.isArray(props.points) ? props.points.length : 0));

/** 状态行摘要：边界数量 / 落图小区与网格数，压缩成一行短文本 */
const mapBriefText = computed(() => {
  const b = boundaries.value.length;
  const nComm = (props.points ?? []).length;
  const nGrid = (props.gridMetrics ?? []).filter((g) => g.count > 0).length;
  return `边界 ${b} · 落图 ${nComm} 小区 / ${nGrid} 网格`;
});

/** 详情行：完整口径说明（点击「详情」才展开，默认不占地方） */
const layerDetailText = computed(() => {
  const parts: string[] = [];
  const b = boundaries.value;
  const nDist = b.filter((x) => String(x.level) === 'district').length;
  const nStreet = b.filter((x) => String(x.level) !== 'district').length;
  parts.push(
    nStreet
      ? `边界：区县 ${nDist} · 街道 ${nStreet}（${streetLegendText.value.replace('街道/网格面＝', '')}）`
      : `边界：区县 ${nDist}（街道边界待接入）`,
  );
  const nComm = (props.points ?? []).length;
  const nGrid = (props.gridMetrics ?? []).filter((g) => Number(g.count) > 0).length;
  parts.push(`落图：${nComm} 个小区 · ${nGrid} 个网格`);
  if (pipelineNote.value) parts.push(`管线：${pipelineNote.value}`);
  if (shutdownData.value) {
    parts.push(
      `停水停气：${shutdownData.value.events?.length ?? 0} 条事件 / ${shutdownData.value.markers?.length ?? 0} 个标识 / ${shutdownData.value.gridCount ?? 0} 个网格`,
    );
  }
  return parts.join('；');
});

const pipelineGas = ref<PipelineLayerResult | null>(null);
const pipelineWater = ref<PipelineLayerResult | null>(null);
/** 图层数据是否加载中 */
const pipelineLoading = ref(false);
/** 点击选中的网格编码（用于描边高亮） */
const pipelineSelectedCode = ref('');
/** 因边界几何不可用而没能着色的网格（如实回报，不静默吞掉） */
const pipelineUnpainted = ref<{ gridCode: string; reason: string }[]>([]);
/** 管线图层悬停信息（网格名 + 项目数） */
const hoverPipeline = ref('');
/** 管线图层是否有任何可落图色块（用于空态提示） */
const pipelineHasCells = computed(
  () => Boolean(pipelineGas.value?.cells.length) || Boolean(pipelineWater.value?.cells.length)
);
/** 两个图层的空态/状态文案（如实说明数据现状，不粉饰） */
const pipelineNote = computed(() => {
  const g = pipelineGas.value;
  const w = pipelineWater.value;
  if (!g && !w) return '改造项目数据加载中…';
  const parts: string[] = [];
  if (g?.note) parts.push(`燃气：${g.note}`);
  if (w?.note) parts.push(`供水：${w.note}`);
  if (!parts.length) {
    parts.push(`燃气 ${g?.locatedProjectCount ?? 0} 个项目/${g?.gridCount ?? 0} 网格`);
    parts.push(`供水 ${w?.locatedProjectCount ?? 0} 个项目/${w?.gridCount ?? 0} 网格`);
  }
  return parts.join(' · ');
});
/** 缺网格的项目汇总（燃气+供水），供提示条如实列出 */
const unlocatedSummary = computed(() => {
  const g = pipelineGas.value;
  const w = pipelineWater.value;
  if (!g && !w) return '';
  const gN = g?.unlocatedCount ?? 0;
  const wN = w?.unlocatedCount ?? 0;
  const total = gN + wN;
  return total ? `${total} 个改造项目缺少「涉及网格」编码，无法在图上定位（燃气 ${gN} / 供水 ${wN}）` : '';
});

/* ------------------------------------------------- 停水停气图层（标书 1.2.6） */
/**
 * 四类**独立**图层开关（对应标书「计划性停水、计划性停气、突发性停水、突发性停气图层」）。
 * 落图单位是「事件 × 涉及网格」的**打点标识**，不是色块 —— 见 shutdownLayer.ts 顶部口径说明。
 */
const shutdownLayerOn = ref<Record<ShutdownCategory, boolean>>({
  planned_water: true,
  planned_gas: true,
  emergency_water: true,
  emergency_gas: true,
});
/** 停水停气图层数据（一次拉全部，四类在前端本地过滤） */
const shutdownData = ref<ShutdownLayerResult | null>(null);
/** 图层数据是否加载中 */
const shutdownLoading = ref(false);
/**
 * 当前选中的事件 ID（联动高亮的核心）。
 * 标书：「若停水停气事件涉及多个网格，当选去一个标识时，属于同一事件引起的标识会高亮显示」。
 * 因此这里存的是 **eventId** 而不是单个标记 ID —— 选中后所有同 eventId 的标识一起高亮。
 */
const shutdownSelectedEventId = ref('');
const shutdownSelectedMarkerId = ref('');
const shutdownPaintedMarkers = shallowRef<ShutdownMarker[]>([]);
/** 停水停气图层的悬停信息 */
const hoverShutdown = ref<{text: string; category: ShutdownCategory} | null>(null);
/** 因网格无几何而没能打点的标识（如实回报，不静默吞掉） */
const shutdownUnpainted = ref<{gridCode: string; reason: string}[]>([]);

/** 当前开着的四类里有多少标识（用于空态判断） */
const shutdownVisibleMarkers = computed(() => {
  return filterMarkersByLayers(shutdownPaintedMarkers.value, shutdownLayerOn.value);
});
const shutdownHighlightedCount = computed(() =>
  shutdownVisibleMarkers.value.filter((marker) => marker.eventId === shutdownSelectedEventId.value).length,
);
/** 是否有任何可落图标识 */
const shutdownHasMarkers = computed(() => Boolean(shutdownData.value?.markers.length));
/** 选中的事件（用于地图侧的状态提示） */
const shutdownSelectedEvent = computed(() => {
  const d = shutdownData.value;
  if (!d || !shutdownSelectedEventId.value) return null;
  return d.events.find((e) => e.eventId === shutdownSelectedEventId.value) ?? null;
});

/* ------------------------------------------------------------------ 图层 */

/** 点位图层（每次数据变化整体替换） */
const pointLayer = shallowRef<VectorLayer<VectorSource> | null>(null);
/** 网格边界 + 着色图层 */
const gridLayer = shallowRef<VectorLayer<VectorSource> | null>(null);
/** 网格质心气泡层（无真实边界时的兜底，见 renderGridCentroids） */
const centroidLayer = shallowRef<VectorLayer<VectorSource> | null>(null);
/** 选中高亮层（区县描边 / 网格描边） */
const highlightLayer = shallowRef<VectorLayer<VectorSource> | null>(null);
/*
 * 注：曾短暂加过「市域遮罩层」（把影像裁到行政界内）。
 * 2026-11-25 定位到真正的错位根因是瓦片网格 L0 分辨率取错（见 cimTileSource.ts 头部注释），
 * 那 37km 的「影像超铺」是错位造成的假象，不是影像真的多铺 —— 修正 L0 后影像天然落在
 * 正确地理范围，遮罩已移除，避免误裁掉正常影像。
 */
/**
 * 小区定位高亮层（标书 1.2.2 ④ 的「定位」交互）。
 * 独立于筛选条件：点 Top10 的小区 → 只飞视野 + 打光环，**不改任何筛选、不触发重新查询**。
 */
const locatedLayer = shallowRef<VectorLayer<VectorSource> | null>(null);
/** 管线图层：燃气 / 供水 各一层（独立开关，zIndex 高于普通网格热力、低于点位） */
const gasPipelineLayer = shallowRef<VectorLayer<VectorSource> | null>(null);
const waterPipelineLayer = shallowRef<VectorLayer<VectorSource> | null>(null);
/**
 * 停水停气图层（标书 1.2.6）：四类各一层，独立开关。
 * zIndex 高于管线色块与小区点位 —— 打点标识是 1.2.6 的主交互对象，必须点得到。
 */
const shutdownLayers = shallowRef<Record<ShutdownCategory, VectorLayer<VectorSource> | null>>({
  planned_water: null,
  planned_gas: null,
  emergency_water: null,
  emergency_gas: null,
});

/** 已渲染的网格质心数量（无真实边界时用于状态展示） */
const gridCentroidCount = computed(() => {
  const set = new Set<string>();
  const list = Array.isArray(props.points) ? props.points : [];
  for (let i = 0; i < list.length; i += 1) {
    const gid = list[i]?.gridId;
    if (gid) set.add(String(gid));
  }
  return set.size;
});

const gridCountByCode = computed(() => {
  const m = new Map<string, number>();
  for (const g of props.gridMetrics) m.set(String(g.code), g.count);
  return m;
});

/**
 * 点样式：**三级**，默认必须"安静"（用户反馈：一开始就全高亮是错的）。
 *
 *   · 选中（active）—— 用户点击定位的那个小区：大金点 + 白边（配 locatedLayer 的光环）
 *   · 范围内（inScope）—— 当前筛了网格/区县，落在范围内的小区：中等亮青色
 *   · 默认（其余全部）—— 小点、低透明。首屏视觉主体是**区域热力图**，点位只是"这里有小区"的底噪
 */
function pointStyle(feature: Feature): Style {
  const active = Boolean(feature.get('active'));
  const inScope = Boolean(feature.get('inScope'));
  const radius = active ? 9 : inScope ? 6 : 3.2;
  return new Style({
    image: new CircleStyle({
      radius,
      fill: new Fill({
        color: active
          ? '#ffe57a'
          : inScope
            ? 'rgba(134, 251, 231, 0.95)'
            : 'rgba(134, 251, 231, 0.34)'
      }),
      stroke: new Stroke({
        color: active ? '#ffffff' : 'rgba(4, 22, 23, 0.5)',
        width: active ? 2 : 0.6,
      }),
    }),
  });
}

/** 行政网格使用后端判定的档位，区县和参考面保留边线。 */
function gridStyle(feature: Feature, resolution: number): Style | Style[] {
  const count = Number(feature.get('count') ?? 0);
  const selected = Boolean(feature.get('selected'));
  const level = String(feature.get('level') ?? 'district');
  const source = String(feature.get('source') ?? 'amap');
  const isDistrict = level === 'district';
  const fill = formalHeatColor(props.heat, feature.get('heatLevel') ?? null, heatOn.value && !compareOn.value);
  const showLabel = isDistrict ? resolution < 0.006 : resolution < 0.0005;
  const hideBufferFace = source === 'buffer' && resolution < 0.00035;
  const base = hideBufferFace
    ? new Style({})
    : new Style({
        fill: new Fill({ color: fill ?? 'rgba(255,255,255,0.015)' }),
        stroke: new Stroke({
          color: selected
            ? '#ffe57a'
            : isDistrict
              ? 'rgba(190, 255, 240, 0.9)'
              : source === 'buffer'
                ? 'rgba(150, 200, 255, 0.62)'
                : source === 'pack'
                  // 琥珀色 + 短虚线：与「正式边界（青绿实线）」区分，提示这是数据包底稿
                  ? 'rgba(255, 206, 120, 0.78)'
                  : 'rgba(120, 220, 205, 0.55)',
          width: selected ? 4 : isDistrict ? 1.8 : source === 'buffer' ? 1.1 : source === 'pack' ? 1.3 : 1,
          lineDash: selected
            ? undefined
            : isDistrict
              ? undefined
              : source === 'buffer'
                ? [4, 4]
                : source === 'pack'
                  ? [2, 3]
                  : source === 'official' ? undefined : [5, 3],
        }),
      });
  // 标签门禁：区县按 0.006、街道按 0.0005（见上方 showLabel 注释）
  if (!showLabel) return base;
  const name = String(feature.get('name') ?? '');
  const code = String(feature.get('code') ?? '');
  if (!name && count <= 0) return base;
  /*
   * 缓冲近似的街道在标签上带「≈」：范围和颜色都是「点位 800m 缓冲」推出来的近似，
   * 不是行政边界。客户验收要能一眼分清「正式边界」和「近似范围」，
   * 避免再把近似面当成行政界去跟影像逐像素比对。
   */
  const approx = source === 'buffer' ? ' ≈' : '';
  const title = `${count > 0 ? `${name} ${count}` : name}${approx}`;

  const labelPoint = feature.get('labelPoint');
  const titleStyle = new Style({
    geometry: labelPoint ?? undefined,
    text: new TextStyle({
      text: title,
      font: '600 12px "Microsoft YaHei", sans-serif',
      fill: new Fill({ color: '#04211f' }),
      stroke: new Stroke({ color: 'rgba(255,255,255,0.8)', width: 3 }),
      overflow: true,
    }),
  });

  /*
   * 编码随标签一起显示（客户要求：方便和社区编码对照核对）。
   *
   * 注意不能用 `text: [名称, 编码]` + `font: [字体1, 字体2]` 的数组写法 ——
   * 实测该路径在 OL 里会抛 `n.match is not a function`（TextStyle 解析字体时拿到非字符串）。
   * 改成**两个独立 Style**：主标签在上、编码小字在下（offsetY 下移 14px），
   * 既不报错，也不用把编码塞进同一行把标签拉长。
   * 只在放大到能看清小字的尺度才出编码，概览时仍只有「名称 件数」。
   */
  if (code && resolution < 0.0003) {
    const codeStyle = new Style({
      geometry: labelPoint ?? undefined,
      text: new TextStyle({
        text: code,
        font: '500 9.5px "Microsoft YaHei", sans-serif',
        offsetY: 14,
        fill: new Fill({ color: '#0b3a35' }),
        stroke: new Stroke({ color: 'rgba(255,255,255,0.75)', width: 2.4 }),
        overflow: true,
      }),
    });
    return [base, titleStyle, codeStyle];
  }
  return [base, titleStyle];
}

/* ------------------------------------------------- 管线图层样式（标书 1.2.7） */

/**
 * 改造项目网格色块样式。
 *
 * 标书要求「若涉及改造事件的网格将形成色块高亮显示」，配色区分两个图层：
 *   燃气 = 橙红、供水 = 青蓝（见 pipelineLayer.PIPELINE_COLORS）
 * 技术方案要求「未批准/已取消与有效施工分开标识」：
 *   施工中/未开工/已完工 = 实心色块；未批准/已取消 = 虚线描边 + 更淡填充
 * 网格内项目数用标签显示（`N 项`），选中网格加黄色描边。
 */
const PIPELINE_INVALID_FILL: Record<PipelineBusinessType, string> = {
  gas: 'rgba(230, 126, 34, 0.18)',
  water: 'rgba(52, 152, 219, 0.18)',
};

function pipelineStyle(businessType: PipelineBusinessType) {
  const palette = PIPELINE_COLORS[businessType];
  return (feature: Feature, resolution: number): Style => {
    const count = Number(feature.get('projectCount') ?? 0);
    const onlyInvalid = Boolean(feature.get('onlyInvalid'));
    const selected = Boolean(feature.get('selected'));
    const name = String(feature.get('gridName') ?? '');
    const code = String(feature.get('gridCode') ?? '');

    // 未批准/已取消单独标识：淡填充 + 虚线描边（技术方案「分开标识」要求）
    const fillColor = onlyInvalid ? PIPELINE_INVALID_FILL[businessType] : palette.fill;
    const strokeColor = selected ? '#ffe57a' : palette.stroke;

    const showLabel = resolution < 0.006 && count > 0;
    return new Style({
      fill: new Fill({ color: fillColor }),
      stroke: new Stroke({
        color: strokeColor,
        width: selected ? 2.6 : 1.4,
        lineDash: onlyInvalid && !selected ? [5, 4] : undefined,
      }),
      text: showLabel
        ? new TextStyle({
            text: `${name && resolution < 0.004 ? name + ' ' : ''}${count}项`,
            font: '700 12px "Microsoft YaHei", sans-serif',
            fill: new Fill({ color: '#ffffff' }),
            stroke: new Stroke({ color: 'rgba(4,22,23,0.85)', width: 3 }),
            overflow: true,
          })
        : undefined,
    });
  };
}

/* ------------------------------------------------------------------ 初始化 */

/**
 * 底图图层：CIM 影像瓦片（自定义 4490 网格）。
 * 探测失败时不挂这一层，地图显示深色底 + 业务图层，状态条如实说明。
 * drs 与 gateway 是同一份影像、同一套网格，切换源不会导致底图与点位的配准偏移。
 */
function buildBasemapLayer(source: TileSource): TileLayer<XYZ> {
  // 高德底图：标准 WebMercator/XYZ，ol 内置 EPSG:3857 网格即可，不用自定义 TileGrid
  if (source === 'amap') {
    return new TileLayer({
      source: new XYZ({
        url: amapSatelliteTileUrl(),
        // 显式声明 3857 + 标准网格（ol 默认行为，写出来避免误用上面的自定义网格）
        projection: 'EPSG:3857',
        crossOrigin: 'anonymous',
        transition: 120,
        maxZoom: AMAP_MAX_LEVEL,
      }),
      properties: { name: 'amap-basemap', source },
    });
  }

  // CIM 影像：EPSG:4490 自定义网格
  const grid = buildCimTileGridParams();
  return new TileLayer({
    source: new XYZ({
      url: cimTileUrlTemplate(source),
      projection: 'EPSG:4326',
      tileGrid: new TileGrid({
        extent: grid.extent,
        origin: grid.origin,
        resolutions: grid.resolutions,
        tileSize: grid.tileSize,
      }),
      crossOrigin: 'anonymous',
      // 瓦片失败不抛异常刷屏，交给 status 如实展示
      transition: 120,
    }),
    // 没有影像时这层是空白，不影响业务层
    properties: { name: 'cim-basemap', source },
  });
}

/**
 * 高德底图需要**两层**：卫星影像 + 路网注记。
 * 只有影像时城市区域一片绿/灰，看不清路网与地名，叠加注记层才可读。
 */
function buildAmapLayers(): TileLayer<XYZ>[] {
  const imagery = new TileLayer({
    source: new XYZ({
      url: amapSatelliteTileUrl(),
      projection: 'EPSG:3857',
      crossOrigin: 'anonymous',
      transition: 120,
      maxZoom: AMAP_MAX_LEVEL,
    }),
    properties: { name: 'amap-imagery', source: 'amap' },
  });
  const labels = new TileLayer({
    source: new XYZ({
      url: amapLabelTileUrl(),
      projection: 'EPSG:3857',
      crossOrigin: 'anonymous',
      transition: 120,
      maxZoom: AMAP_MAX_LEVEL,
    }),
    opacity: 0.9,
    properties: { name: 'amap-labels', source: 'amap' },
  });
  return [imagery, labels];
}

/** 数据未到达时的视野：宜昌城区 */
const DEFAULT_CENTER_LONLAT: [number, number] = [111.2905, 30.6945];
const DEFAULT_ZOOM = 12;

/* ------------------------------------------------- 停水停气打点样式（标书 1.2.6） */

/**
 * 单条停水停气「打点标识」的样式。
 *
 * 标书要求「当网格产生一个停水停气事件则产生一个打点标识」——是**点**，不是色块。
 * 四类用不同颜色区分（计划停水蓝 / 计划停气橙 / 突发停水深红 / 突发停气紫）。
 *
 * 联动高亮（标书：「若事件涉及多个网格，选中一个标识时，同一事件引起的标识会高亮显示」）：
 *   `linked`=true 的标识 → 放大 + 亮黄描边 + 外圈光环，其余同层标识降透明度，
 *   让「同一事件的 8 个点」一眼看出来。
 *   `selected`=true（被直接点中的那个）→ 再加实心内点。
 */
function shutdownMarkerStyle(feature: Feature, category: ShutdownCategory): Style | Style[] {
  const palette = CATEGORY_COLORS[category];
  const selected = Boolean(feature.get('selected'));
  const linked = Boolean(feature.get('linked'));
  const multi = Number(feature.get('gridTotal') ?? 1);

  const baseRadius = 6.5;
  const radius = selected ? baseRadius + 3 : linked ? baseRadius + 1.8 : baseRadius;

  // 选中/联动时加一圈光晕，大屏深底上一眼可见
  const halo = new CircleStyle({
    radius: radius + (selected ? 7 : linked ? 5 : 0),
    fill: new Fill({ color: linked || selected ? 'rgba(255, 229, 122, 0.22)' : 'rgba(0,0,0,0)' }),
    stroke: linked || selected
      ? new Stroke({ color: 'rgba(255, 229, 122, 0.9)', width: 1.6 })
      : new Stroke({ color: 'rgba(0,0,0,0)', width: 0 }),
  });

  const dot = new CircleStyle({
    radius,
    fill: new Fill({ color: linked || selected ? '#ffe57a' : palette.fill }),
    stroke: new Stroke({
      color: linked || selected ? '#fffbe0' : palette.stroke,
      width: selected ? 2.4 : linked ? 2 : 1.2,
    }),
  });

  // 多网格事件在点上标「N网」，提示这条事件不止一个标识
  const text =
    multi > 1
      ? new TextStyle({
          text: `${multi}网`,
          offsetY: -(radius + 9),
          font: '600 10px "Microsoft YaHei", sans-serif',
          fill: new Fill({ color: linked || selected ? '#ffe57a' : '#eafffa' }),
          stroke: new Stroke({ color: 'rgba(2, 18, 17, 0.9)', width: 3 }),
        })
      : undefined;

  const pointStyle = new Style({ image: dot, text, zIndex: selected ? 4 : linked ? 3 : 0 });
  return linked ? [new Style({ image: halo, zIndex: 2 }), pointStyle] : pointStyle;
}

/* ------------------------------------------------ CIM 社区网格边界（栅格） */
/*
 * 数据来自 CIM 平台「抖动-行政区划-社区网格」服务（《CIM-配置2》，EPSG:4490）。
 *
 * 为什么是栅格：2026-11-24 实测该服务 queryable=false，没有要素/属性通道
 * （queryResults/data/WMS/MVT 全 404）。所以这里只能按当前视野请求一张边界图，
 * 铺成 ImageStatic —— 网格线可见、与 CIM 影像完全贴合，但**不能按诉求量填色**。
 * 五色热力仍等 CIM 开放数据服务/矢量瓦片（见 server/docs/cim-grid-overlay.md）。
 *
 * 纪律：
 *   · 只请求当前视野 bbox（后端再夹到市域框），视野太小/太大都跳过，避免刷爆上游；
 *   · token 由后端持有，前端只带自己的登录令牌；
 *   · 拉不到就安静降级，不阻塞点位/热力图层。
 */
const cimGridLayer = shallowRef<ImageLayer<ImageStatic> | null>(null);
const cimGridReady = ref(false);
let cimGridTimer: number | null = null;
let cimGridSeq = 0;
/** 宜昌市域框（CIM 服务 bounds），视野超出部分裁掉 */
const CIM_CITY_BBOX = [110.251, 29.935, 112.089, 31.572];

async function refreshCimGridBoundary() {
  const m = mapRef.value;
  if (!m) return;
  const size = m.getSize();
  if (!size) return;
  const ext = m.getView().calculateExtent(size);
  const west = Math.max(ext[0], CIM_CITY_BBOX[0]);
  const south = Math.max(ext[1], CIM_CITY_BBOX[1]);
  const east = Math.min(ext[2], CIM_CITY_BBOX[2]);
  const north = Math.min(ext[3], CIM_CITY_BBOX[3]);
  if (!(east > west + 1e-3 && north > south + 1e-3)) return;
  const token = (() => { try { return sessionStorage.getItem('gqxq-token'); } catch { return null; } })();
  if (!token) return;
  /*
   * ⚠️ 出图纵横比必须按「度」等距算，**不能做 cos(纬度) 地面米校正**（2026-11-24 实测）。
   *
   * CIM 的 image.png 是「等度像素」网格：服务端按请求的 width×height 直接铺满 viewBounds。
   * 一旦按地面米做 cos 校正（把 height 放大 1/cos φ ≈ 1.16 倍），请求的像素纵横比就和 bbox
   * 的度纵横比不一致，服务端会按自己的比例扩边，前端再把整张图拉回 bbox —— 于是网格线整层
   * 上下偏移。实测 0.4°×0.3° 框叠加高德区县界：
   *   · 等度像素 → 偏差 0~2px（<100m，属两家边界概括差异，不是错位）；
   *   · cos 校正   → 偏差 44px ≈ 1.6km，就是「网格线跟影像/着色对不上」的来源。
   *
   * 另外夹上限时必须**等比例**缩放：只夹 height 会把纵横比又改回不平（同一个坑的第二半）。
   */
  const spanLon = Math.max(east - west, 1e-9);
  const spanLat = Math.max(north - south, 1e-9);
  const degAspect = spanLat / spanLon; // 度空间「高/宽」
  let width = 1024;
  let height = Math.round(width * degAspect);
  if (height > 1024) {
    height = 1024;
    width = Math.round(height / degAspect);
  }
  if (height < 160) {
    height = 160;
    width = Math.round(height / degAspect);
  }
  width = Math.max(128, Math.min(2048, width));
  height = Math.max(128, Math.min(2048, height));
  const bbox = [west, south, east, north].map((n) => n.toFixed(5)).join(',');
  const seq = ++cimGridSeq;
  try {
    const res = await fetch(API_BASE + '/cim/grid-overlay?level=sqwg&bbox=' + bbox + '&w=' + width + '&h=' + height, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (seq !== cimGridSeq) return;
    if (!res.ok) { cimGridReady.value = false; return; }
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const cvs = document.createElement('canvas');
    cvs.width = bmp.width;
    cvs.height = bmp.height;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    // CIM 出图是「黄线 + 透明底」；转青绿，避免与琥珀底稿、绿色底图撞色
    ctx.filter = 'hue-rotate(150deg) saturate(1.15)';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(bmp, 0, 0);
    const src = new ImageStatic({
      url: cvs.toDataURL('image/png'),
      imageExtent: [west, south, east, north],
      projection: 'EPSG:4326',
    });
    /*
     * 网格栅格是「参考层」，不是第二张底图：视角越广，它越该退到背景。
     * 市域视角几十条网格线糊满屏时很容易被误读成「多了一个底图」，所以按视野宽度给透明度分级。
     */
    const gridOpacity = spanLon > 1.2 ? 0.28 : spanLon > 0.6 ? 0.45 : 0.72;
    if (cimGridLayer.value) {
      cimGridLayer.value.setSource(src as never);
      cimGridLayer.value.setOpacity(gridOpacity);
    } else {
      const layer = new ImageLayer({ source: src, opacity: gridOpacity, zIndex: 3, className: 'cim-grid-layer' });
      cimGridLayer.value = layer as never;
      m.addLayer(layer);
    }
    cimGridReady.value = true;
  } catch {
    if (seq === cimGridSeq) cimGridReady.value = false;
  }
}

function scheduleCimGridBoundary() {
  if (cimGridTimer) window.clearTimeout(cimGridTimer);
  cimGridTimer = window.setTimeout(() => { void refreshCimGridBoundary(); }, 400);
}

async function initMap() {
  if (!hostRef.value) return;

  const view = new View({
    projection: 'EPSG:4326',
    center: DEFAULT_CENTER_LONLAT,
    zoom: DEFAULT_ZOOM,
    minZoom: 6,
    maxZoom: 18,
    extent: [-180, -90, 180, 90],
  });

  const map = new OlMap({
    target: hostRef.value,
    view,
    layers: [],
    controls: defaultControls({ zoom: false, rotate: false, attribution: false }).extend([
      new ScaleLine({ units: 'metric', bar: true }),
    ]),
  });
  mapRef.value = map;
  /*
   * 诊断钩子：把当前 scale / resolution 写到容器 dataset 上。
   * 生产环境也保留 —— 排查「标签该不该显示」「色块为什么这样分档」时，
   * 直接读 DOM 就能拿到真实缩放，不用靠截图估算（估出来的偏差很大）。
   */
  const syncScaleAttr = () => {
    const host = hostRef.value;
    if (!host) return;
    const res = map.getView().getResolution();
    if (typeof res === "number" && Number.isFinite(res)) {
      host.dataset.mapResolution = res.toFixed(7);
      host.dataset.mapMetersPerPx = (res * 111320 * Math.cos(((map.getView().getCenter()?.[1] ?? 30.7) * Math.PI) / 180)).toFixed(1);
    }
  };
  map.on("moveend", syncScaleAttr);
  setTimeout(syncScaleAttr, 0);

  /*
   * CIM 社区网格边界（栅格）：随视野刷新。
   * 首屏延迟 3s 再取 —— 底图瓦片优先，边界层是增强项，不能抢首屏带宽。
   */
  map.on('moveend', scheduleCimGridBoundary);
  window.setTimeout(() => { void refreshCimGridBoundary(); }, 3000);
  // 联调钩子：仅开发环境挂到 window，供自动化验证按经纬度取像素坐标（生产不挂）
  if (import.meta.env.DEV) {
    (window as any).__map2d = map;
  }

  // 小区定位高亮层：独立于筛选，用醒目样式标出「你刚点的那个小区」
  // 小区定位高亮层：独立于筛选，用醒目样式标出「你刚点的那个小区」
  locatedLayer.value = new VectorLayer({
    source: new VectorSource(),
    /*
     * 三层同心：中心金点 + 内环 + 外虚线光环，并在点上方标出小区名。
     * 原样式只有单圈 r=16、半透明填充，放大到城区尺度后几乎看不见，
     * 客户反馈「小区选择后没有突出的显示」。
     * 现在外层虚线环 r=34 + 名称标签，任何缩放下都能一眼锁定。
     */
    style: (feature) => {
      const label = String(feature.get('name') ?? '');
      return [
        new Style({
          image: new CircleStyle({
            radius: 34,
            fill: new Fill({ color: 'rgba(255, 214, 124, 0.06)' }),
            stroke: new Stroke({ color: 'rgba(255, 214, 124, 0.85)', width: 1.6, lineDash: [6, 5] }),
          }),
        }),
        new Style({
          image: new CircleStyle({
            radius: 18,
            fill: new Fill({ color: 'rgba(255, 214, 124, 0.22)' }),
            stroke: new Stroke({ color: '#ffd67c', width: 3 }),
          }),
        }),
        new Style({
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({ color: '#ffe57a' }),
            stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
          }),
          text: label
            ? new TextStyle({
                text: label,
                offsetY: -46,
                font: '600 14px "Microsoft YaHei", sans-serif',
                fill: new Fill({ color: '#fff6d6' }),
                stroke: new Stroke({ color: 'rgba(2, 18, 17, 0.92)', width: 4 }),
                backgroundFill: new Fill({ color: 'rgba(6, 38, 36, 0.78)' }),
                padding: [3, 7, 3, 7],
              })
            : undefined,
        }),
      ];
    },
    zIndex: 40,
    properties: { name: 'located-community' },
  });

  // 点图层
  pointLayer.value = new VectorLayer({
    source: new VectorSource(),
    style: pointStyle as any,
    zIndex: 20,
    properties: { name: 'communities' },
  });
  // 网格图层
  gridLayer.value = new VectorLayer({
    source: new VectorSource(),
    style: gridStyle as any,
    zIndex: 10,
    properties: { name: 'grids' },
  });
  // 高亮层
  highlightLayer.value = new VectorLayer({
    source: new VectorSource(),
    zIndex: 30,
    /*
     * 区县筛选高亮层：原来填充仅 0.08、描边 2.5px，压在彩色热力面上几乎看不出来
     * （用户反馈「筛选后的区域划界效果不明显」）。
     * 现在填充提到 0.16、描边 4px 并改成金色虚线 —— 边界一眼可辨，
     * 同时不会把影像/点位盖死。
     */
    style: new Style({
      fill: new Fill({ color: 'rgba(255, 229, 122, 0.16)' }),
      stroke: new Stroke({ color: '#ffe57a', width: 4, lineDash: [10, 6] }),
    }),
    properties: { name: 'highlight' },
  });

  centroidLayer.value = new VectorLayer({
    source: new VectorSource(),
    zIndex: 15,
    style: (feature) => {
      const count = Number(feature.get('count') ?? 0);
      const r = 10 + Math.min(18, Math.sqrt(count) * 1.8);
      return new Style({
        image: new CircleStyle({
          radius: r,
          fill: new Fill({ color: 'rgba(65, 130, 141, 0.5)' }),
          stroke: new Stroke({ color: 'rgba(134, 251, 231, 0.75)', width: 1.2 }),
        }),
        text: count > 0
          ? new TextStyle({
              text: String(count),
              font: '700 12px "Microsoft YaHei", sans-serif',
              fill: new Fill({ color: '#04211f' }),
              stroke: new Stroke({ color: 'rgba(255,255,255,0.8)', width: 3 }),
            })
          : undefined,
      });
    },
    properties: { name: 'grid-centroids' },
  });
  // 管线图层（标书 1.2.7）：燃气 / 供水各一层，独立开关；色块压在热力网格之上、点位之下
  gasPipelineLayer.value = new VectorLayer({
    source: new VectorSource(),
    style: pipelineStyle('gas') as any,
    visible: gasLayerOn.value,
    zIndex: 17,
    properties: { name: 'pipeline-gas' },
  });
  waterPipelineLayer.value = new VectorLayer({
    source: new VectorSource(),
    style: pipelineStyle('water') as any,
    visible: waterLayerOn.value,
    zIndex: 16,
    properties: { name: 'pipeline-water' },
  });
  // 停水停气图层（标书 1.2.6）：四类各一层，独立开关；zIndex 压在点位/高亮层之上，保证点得到
  const sdLayers: Record<ShutdownCategory, VectorLayer<VectorSource> | null> = {
    planned_water: null,
    planned_gas: null,
    emergency_water: null,
    emergency_gas: null,
  };
  SHUTDOWN_CATEGORIES.forEach((cat, idx) => {
    sdLayers[cat] = new VectorLayer({
      source: new VectorSource(),
      style: (feature) => shutdownMarkerStyle(feature, cat),
      visible: shutdownLayerOn.value[cat],
      zIndex: 21 + idx,
      properties: { name: `shutdown-${cat}` },
    });
  });
  shutdownLayers.value = sdLayers;

  map.addLayer(gridLayer.value);
  map.addLayer(centroidLayer.value);
  map.addLayer(waterPipelineLayer.value);
  map.addLayer(gasPipelineLayer.value);
  map.addLayer(pointLayer.value);
  map.addLayer(highlightLayer.value);
  map.addLayer(locatedLayer.value);
  // 停水停气四层加在最上面
  for (const cat of SHUTDOWN_CATEGORIES) {
    const l = shutdownLayers.value[cat];
    if (l) map.addLayer(l);
  }

  // 悬停 / 点击
  map.on('pointermove', (evt) => {
    if (evt.dragging) return;
    let hovered = '';
    let isFormal = false;
    let count: number | null = null;
    let kind: 'community' | 'grid' | 'street' | 'pipeline-gas' | 'pipeline-water' | 'shutdown' | '' = '';
    let code = '';
    let pipeText = '';
    map.forEachFeatureAtPixel(evt.pixel, (f, layer) => {
      // 停水停气打点在最上层，优先命中（标书 1.2.6 的主交互对象）
      for (const cat of SHUTDOWN_CATEGORIES) {
        if (layer === shutdownLayers.value[cat]) {
          const md = shutdownData.value;
          const m = md?.markers.find((x) => x.markerId === String(f.get('markerId') ?? ''));
          const ev = m ? md?.events.find((e) => e.eventId === m.eventId) : null;
          hoverShutdown.value = {
            text: ev
              ? `${ev.enterpriseName ?? '企业未提供'} · ${householdsText(ev)}`
              : String(f.get('gridName') ?? ''),
            category: cat,
          };
          hovered = String(f.get('gridName') ?? '');
          kind = 'shutdown';
          return true;
        }
      }
      // 管线图层优先（它压在最上面，且是标书 1.2.7 的主交互对象）
      if (layer === gasPipelineLayer.value || layer === waterPipelineLayer.value) {
        const bt = layer === gasPipelineLayer.value ? '燃气' : '供水';
        hovered = String(f.get('gridName') ?? f.get('gridCode') ?? '');
        count = Number(f.get('projectCount') ?? 0);
        code = String(f.get('gridCode') ?? '');
        kind = layer === gasPipelineLayer.value ? 'pipeline-gas' : 'pipeline-water';
        pipeText = `${bt}改造 ${count} 项`;
        return true;
      }
      if (layer === pointLayer.value) {
        hovered = String(f.get('name') ?? '');
        kind = 'community';
        return true;
      }
      if (layer === gridLayer.value) {
        isFormal = Boolean(f.get('formalHeatGrid'));
        // 推导面（泰森多边形）带 ≈：形状是推出来的，不是测绘边界（与缓冲近似同一套表达）
        const provider = String(f.get('provider') ?? '');
        hovered = String(f.get('name') ?? '') + (provider === 'derived-voronoi' ? ' ≈' : '');
        count = Number(f.get('count') ?? 0);
        code = String(f.get('code') ?? '');
        kind = String(f.get('level') ?? '') === 'district' ? 'grid' : 'street';
        // 标书 1.2.4 明确要求悬停显示社区名称
        const cn = f.get('communityNames');
        hoverCommunityNames.value = Array.isArray(cn) ? (cn as string[]) : [];
        hoverCommunityTotal.value = Number(f.get('communityCount') ?? 0);
        return true;
      }
      if (layer === centroidLayer.value) {
        hovered = String(f.get('name') ?? '');
        count = Number(f.get('count') ?? 0);
        code = String(f.get('code') ?? '');
        kind = 'street';
        const cn2 = f.get('communityNames');
        hoverCommunityNames.value = Array.isArray(cn2) ? (cn2 as string[]) : [];
        hoverCommunityTotal.value = Number(f.get('communityCount') ?? 0);
        return true;
      }
      return false;
    });
    cursorStyle.value = hovered ? 'pointer' : 'default';
    hoverName.value = hovered;
    hoverFormalGrid.value = isFormal;
    hoverCount.value = count;
    hoverKind.value = kind;
    hoverCode.value = code;
    hoverPipeline.value = pipeText;
    if (!hovered) {
      hoverShutdown.value = null;
      hoverCommunityNames.value = [];
      hoverCommunityTotal.value = 0;
    }
  });

  map.on('click', (evt) => {
    // 停水停气打点最高优先：标书 1.2.6 要求「点击标识可查看事件信息」，
    // 打点画在其他业务图层之上就是为了点得到，不能被管线/点位/网格抢走。
    let pickedShutdown = '';
    map.forEachFeatureAtPixel(evt.pixel, (f, layer) => {
      for (const cat of SHUTDOWN_CATEGORIES) {
        if (layer === shutdownLayers.value[cat]) {
          pickedShutdown = String(f.get('markerId') ?? '');
          return true;
        }
      }
      return false;
    });
    if (pickedShutdown) {
      dismissPipelinePick();
      openShutdownMarker(pickedShutdown);
      return;
    }

    // 管线网格优先：标书 1.2.7 明确要求「点击网格可查看改造事件信息」，
    // 若让普通网格/点位抢走点击，改造详情入口就形同虚设。
    let pickedPipeline = '';
    map.forEachFeatureAtPixel(evt.pixel, (f, layer) => {
      if (layer === gasPipelineLayer.value || layer === waterPipelineLayer.value) {
        pickedPipeline = String(f.get('gridCode') ?? '');
        return true;
      }
      return false;
    });
    if (pickedPipeline) {
      openPipelineGrid(pickedPipeline);
      return;
    }
    dismissPipelinePick();

    // 点优先于网格：点位是更细的业务对象
    const pickedPoints: Map2DPoint[] = [];
    let pickedGrid: { code: string; name: string; formalHeatGrid: boolean } | null = null;
    map.forEachFeatureAtPixel(evt.pixel, (f, layer) => {
      if (layer === pointLayer.value) {
        const raw = f.get('point') as Map2DPoint | undefined;
        if (raw) pickedPoints.push(raw);
        return false; // 继续找同位置的其它点位（可能多个小区共点）
      }
      if ((layer === gridLayer.value || layer === centroidLayer.value) && !pickedGrid) {
        pickedGrid = { code: String(f.get('code') ?? ''), name: String(f.get('name') ?? ''), formalHeatGrid: Boolean(f.get('formalHeatGrid')) };
        return false;
      }
      return false;
    });

    if (pickedPoints.length) {
      emit('pick', { type: 'community', items: pickedPoints });
      return;
    }
    if (pickedGrid) {
      emit('pick', { type: 'grid', items: [], code: pickedGrid.code, name: pickedGrid.name, formalHeatGrid: pickedGrid.formalHeatGrid });
    }
  });

  // 底图探测放在最后、**不阻塞**业务图层：探测要串行试 drs(6s)→网关(12s)→高德，
  // 全断时最长能拖 18s+，若 await 住它，边界与管线图层会一起被推迟到二十多秒，届时才出空态。
  // 业务数据的拉取与底图成败无关，因此并行发起，谁先好谁先渲染。
  const boundsTask = loadBoundaries().then(() => {
    renderPipeline();
    // 停水停气打点依赖边界面的质心算点位，边界到位后要重画一次
    renderShutdown();
  });
  const pipelineTask = loadPipeline();
  const shutdownTask = loadShutdown();
  // 首次数据（坐标与底图无关，先画出来）
  renderPoints();
  renderGrids();
  reportStatus();

  void Promise.all([boundsTask, pipelineTask, shutdownTask]).finally(() => reportStatus());
  await probeBasemap(map);
}

async function probeBasemap(map: OlMap) {
  const result = await probeCimTiles();
  probe.value = result;

  if (result.ok && result.source === 'amap') {
    // 高德兜底：影像 + 注记两层，插入到最底层
    const layers = buildAmapLayers();
    layers.forEach((l, idx) => map.getLayers().insertAt(idx, l));
    basemapLabel.value = '高德底图（兜底）';
  } else if (result.ok && result.source) {
    map.getLayers().insertAt(0, buildBasemapLayer(result.source));
    basemapLabel.value = `${sourceLabel(result.source)} · 宜昌市 2026 年 0.5 米影像`;
  } else {
    basemapLabel.value = `底图全部不可达：${result.reason ?? '未知原因'}`;
  }
  reportStatus();
}

async function loadBoundaries() {
  const result = await fetchGridBoundaries();
  boundaries.value = result.boundaries;
  boundaryNote.value = result.note;
  streetSource.value = result.streetSource;
  streetCount.value = result.streetCount;
  boundaryPack.value = result.pack;
  packMatched.value = result.packMatched;
  renderGrids();
  renderGridCentroids();
  reportStatus();
}

/**
 * 加载管线图层数据（标书 1.2.7）。
 *
 * 燃气/供水分别独立拉取，两个开关各控制一层。**不造任何数据**：
 * 后端返回空 cells 就画不出色块，页面如实显示「暂无可着色网格 + 缺网格项目 N 个」。
 */
async function loadPipeline() {
  if (pipelineLoading.value) return;
  dismissPipelinePick();
  pipelineLoading.value = true;
  try {
    const result = await fetchPipelineLayers();
    pipelineGas.value = result.gas;
    pipelineWater.value = result.water;
    console.warn('[Map2D] pipeline loaded', {
      gasCells: result.gas.cells.length,
      waterCells: result.water.cells.length,
      gasNote: result.gas.note,
      gasUnlocated: result.gas.unlocatedProjects.length,
    });
    renderPipeline();
    reportStatus();
  } catch (e) {
    console.warn('[Map2D] loadPipeline 失败:', (e as Error)?.message);
  } finally {
    pipelineLoading.value = false;
  }
}

/** 宜昌市域大致范围（用于识别边界数据里的脏点） */
const YICHANG_BOUNDS = { minLon: 108, maxLon: 114, minLat: 28, maxLat: 33 };

/**
 * 判断一个环能否安全用于落图。
 *
 * 背景：`admin_boundaryService` 的街道面是「同街道点位凸包/缓冲」近似，
 * 当某些小区点位坐标为 (0,0)（未定位）时会混进环里，把整个面拉成跨半球的畸形多边形。
 * 这类环必须剔除 —— 宁可这个网格不着色，也不能画一个明显错误的形状（不伪造）。
 */
function isCleanRing(ring: number[][]): boolean {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (let i = 0; i < ring.length; i += 1) {
    const pt = ring[i];
    if (!pt || pt.length < 2) return false;
    const lon = Number(pt[0]);
    const lat = Number(pt[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (lon < YICHANG_BOUNDS.minLon || lon > YICHANG_BOUNDS.maxLon) return false;
    if (lat < YICHANG_BOUNDS.minLat || lat > YICHANG_BOUNDS.maxLat) return false;
  }
  return true;
}

/**
 * 把「改造项目 → 网格」绘制成色块。
 *
 * 几何来源：优先用边界图层里**同编码的面**（区县 6 位 / 街道 9 位）。
 * 甲方 `admin_grid.geometry` 未接入时，街道面是「点位凸包近似」，这一点由边界状态条如实标注，
 * 色块本身位置不会虚构 —— 编码对不上就跳过并计入「无面」清单，而不是拿相近的网格凑数。
 */
function renderPipeline() {
  try {
    const gasLayer = gasPipelineLayer.value;
    const waterLayer = waterPipelineLayer.value;
    if (!gasLayer || !waterLayer) return;

    const gasSrc = gasLayer.getSource();
    const waterSrc = waterLayer.getSource();
    if (!gasSrc || !waterSrc) return;
    gasSrc.clear();
    waterSrc.clear();
    pipelineUnpainted.value = [];

    // 网格编码 → 面环（普通对象，避免 Map 迭代）
    // 注意：边界图层当前由「点位缓冲」生成，存在**含 (0,0) 空坐标的脏环**（实测 420502001/420502003
    // 各 33 个 (0,0) 顶点），直接用会把色块拉成覆盖整张图的畸形面。这里过滤掉出界环，
    // 宁可少画一个网格，也不画一个明显错误的形状。
    const rings: Record<string, { rings: number[][][]; name: string; source: string; level: string }> = {};
    for (let i = 0; i < boundaries.value.length; i += 1) {
      const b = boundaries.value[i];
      if (!b.polygons.length) continue;
      const key = String(b.code);
      if (!rings[key]) rings[key] = { rings: [], name: b.name, source: b.source, level: b.level };
      for (let j = 0; j < b.polygons.length; j += 1) {
        if (isCleanRing(b.polygons[j])) rings[key].rings.push(b.polygons[j]);
      }
    }

    const gasCells = Array.isArray(pipelineGas.value?.cells) ? pipelineGas.value!.cells : [];
    const waterCells = Array.isArray(pipelineWater.value?.cells) ? pipelineWater.value!.cells : [];

    const draw = (cells: PipelineCell[], src: VectorSource) => {
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i];
        const code = String(cell.gridCode ?? '');
        const geo = rings[code];
        // 编码在边界图层里找不到对应面：跳过（不拿相近网格凑数），由状态条说明
        if (!geo || !geo.rings.length) {
          pipelineUnpainted.value.push({
            gridCode: code,
            reason: geo ? '边界几何含 (0,0) 空坐标，已剔除' : '边界图层无该网格面',
          });
          continue;
        }
        for (let r = 0; r < geo.rings.length; r += 1) {
          const feature = new Feature({ geometry: new Polygon([geo.rings[r]]) });
          feature.set('gridCode', code);
          feature.set('gridName', geo.name || code);
          feature.set('projectCount', cell.projectCount);
          // 只有「未批准/已取消」的网格用虚线区分（技术方案分开标识要求）
          const sc = cell.statusCounts ?? {};
          const invalid = (sc.rejected ?? 0) + (sc.cancelled ?? 0);
          const valid = cell.projectCount - invalid;
          feature.set('onlyInvalid', valid <= 0 && invalid > 0);
          feature.set('selected', (pipelineSelectedCode.value || props.gridCode) === code);
          feature.set('boundarySource', geo.source);
          src.addFeature(feature);
        }
      }
    };

    draw(gasCells, gasSrc);
    draw(waterCells, waterSrc);
  } catch (e) {
    console.error('[Map2D] renderPipeline 失败:', (e as Error)?.message);
  }
}

/**
 * 点击管线网格 → 把该网格涉及的**全部项目**（燃气+供水）打包抛给父组件开抽屉。
 *
 * 标书要求点击可看：项目名称、企业名称、时间范围、现场施工人数、改造原因、影响区域、应急预案，
 * 并且「对于影响区域可查看每个网格历史产生的管道改造事件信息」—— 后者由同一网格的历史项目列表承担。
 */
function openPipelineGrid(gridCode: string) {
  const gasCell = (pipelineGas.value?.cells ?? []).find((c) => String(c.gridCode) === gridCode);
  const waterCell = (pipelineWater.value?.cells ?? []).find((c) => String(c.gridCode) === gridCode);

  // 燃气在前（标书原文顺序），两边项目合起来展示；**不合并不同项目**（技术方案约束）
  const gasProjects: PipelineProject[] = Array.isArray(gasCell?.projects) ? gasCell!.projects : [];
  const waterProjects: PipelineProject[] = Array.isArray(waterCell?.projects) ? waterCell!.projects : [];
  const projects = [...gasProjects, ...waterProjects];
  if (!projects.length) return;
  pipelineSelectedCode.value = gridCode;
  renderPipeline();

  const statusCounts: Record<string, number> = {};
  for (const p of projects) statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;

  const bHit = boundaries.value.find((b) => String(b.code) === gridCode);

  emit('pipeline-pick', {
    gridCode,
    gridName: bHit?.name ?? gridCode,
    cell: {
      gridCode,
      projectCount: projects.length,
      inProgressCount: projects.filter((p) => p.status === 'in_progress').length,
      statusCounts,
      projects,
    },
    byBusinessType: { gas: gasProjects, water: waterProjects },
    layersOn: { gas: gasLayerOn.value, water: waterLayerOn.value },
  });
}

function clearPipelineSelection() {
  if (!pipelineSelectedCode.value) return;
  pipelineSelectedCode.value = '';
  renderPipeline();
}

function dismissPipelinePick() {
  if (!pipelineSelectedCode.value) return;
  clearPipelineSelection();
  emit('pipeline-clear');
}

/* --------------------------------------------- 停水停气图层（标书 1.2.6） */

/**
 * 加载停水停气图层数据。
 *
 * 一次拉全部四类，图层开关在前端本地过滤（避免每次切开关都打接口）。
 * **不造任何数据**：后端没有可打点事件就画不出点，页面如实显示空态 + 数据堵点。
 */
async function loadShutdown() {
  if (shutdownLoading.value) return;
  if (shutdownSelectedEventId.value) {
    clearShutdownSelection();
    emit('shutdown-clear');
  }
  shutdownLoading.value = true;
  try {
    const result = await fetchShutdownLayer();
    shutdownData.value = result;
    console.warn('[Map2D] shutdown loaded', {
      dataSource: result.note ? `error:${result.note}` : 'ok',
      events: result.events.length,
      markers: result.markers.length,
      grids: result.gridCount,
      counts: result.categoryCounts,
    });
    renderShutdown();
    reportStatus();
  } catch (e) {
    console.warn('[Map2D] loadShutdown 失败:', (e as Error)?.message);
  } finally {
    shutdownLoading.value = false;
  }
}

/**
 * 网格编码 → 落点坐标。
 *
 * 库内 `admin_grid.geometry` 全为 null，网格面由边界图层（区县高德边界 / 街道点位凸包）提供。
 * 这里按网格面的**外环顶点均值**取一个代表点：
 *   · 有真实边界面 → 落在面内（近似质心，足够定位打点）
 *   · 无面 → 退回该网格下小区点位的均值；仍无则**如实不打点**（不臆造坐标）
 * 用普通对象缓存，避免 Map 迭代在 Vue 响应式下出问题。
 */
function buildGridAnchors(): Record<string, [number, number]> {
  const anchors: Record<string, [number, number]> = {};

  /*
   * 小区点位按网格分组：用来把"代表点"吸附到**真实小区位置**上。
   *
   * 为什么必须吸附：原来直接取网格面外环的**顶点均值**，这个点在几何上可能
   * 落在江面/库区里 —— 小溪塔街道的小区绕库区分布，顶点均值恰好在水中，
   * 于是停水停气标记和街道标签全都"漂在河上"，客户看到的就是「数据都在河里」。
   * 吸附到最近的真实小区坐标后，代表点一定落在陆地上。
   */
  const ptsByGrid: Record<string, Array<[number, number]>> = {};
  const pts = Array.isArray(props.points) ? props.points : [];
  for (let i = 0; i < pts.length; i += 1) {
    const gid = String(pts[i]?.gridId ?? '');
    if (!gid) continue;
    const lon = Number(pts[i].longitude);
    const lat = Number(pts[i].latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) continue;
    (ptsByGrid[gid] ?? (ptsByGrid[gid] = [])).push([lon, lat]);
  }

  /** 在候选点里找离 (lon,lat) 最近的那个真实小区点 */
  const snapToNearestPoint = (gid: string, lon: number, lat: number): [number, number] | null => {
    const cand = ptsByGrid[gid];
    if (!cand || !cand.length) return null;
    let best = cand[0];
    let bestD = Infinity;
    for (let k = 0; k < cand.length; k += 1) {
      const dx = cand[k][0] - lon;
      const dy = cand[k][1] - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = cand[k];
      }
    }
    return best;
  };

  // ① 有边界面：取外环顶点均值 → 再吸附到最近的真实小区点
  for (let i = 0; i < boundaries.value.length; i += 1) {
    const b = boundaries.value[i];
    if (!b.polygons.length) continue;
    /*
     * 服务端已按「全量小区」算好代表点（anchor），优先用它 ——
     * 前端 only 在筛选后的点位里找，筛网格后其它网格就没点位了，
     * 会退回多边形均值 → 锚点落水（停水停气打点会漂在库区上）。
     */
    if (b.anchor) {
      anchors[String(b.code)] = b.anchor as [number, number];
      continue;
    }
    const ring = b.polygons[0];
    if (!isCleanRing(ring)) continue;
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < ring.length; j += 1) {
      sx += Number(ring[j][0]);
      sy += Number(ring[j][1]);
    }
    const meanLon = sx / ring.length;
    const meanLat = sy / ring.length;
    const snapped = snapToNearestPoint(String(b.code), meanLon, meanLat);
    anchors[String(b.code)] = snapped ?? [meanLon, meanLat];
  }

  // ② 边界图层没覆盖的网格：用该网格下小区点位均值，同样吸附到最近真实点位
  const agg: Record<string, { sx: number; sy: number; n: number }> = {};
  for (const gid of Object.keys(ptsByGrid)) {
    const cand = ptsByGrid[gid];
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < cand.length; k += 1) {
      sx += cand[k][0];
      sy += cand[k][1];
    }
    agg[gid] = { sx, sy, n: cand.length };
  }
  for (const gid of Object.keys(agg)) {
    if (anchors[gid]) continue;
    const a = agg[gid];
    if (!a.n) continue;
    const meanLon = a.sx / a.n;
    const meanLat = a.sy / a.n;
    anchors[gid] = snapToNearestPoint(gid, meanLon, meanLat) ?? [meanLon, meanLat];
  }
  return anchors;
}

/**
 * 把打点标识画到四类图层上。
 *
 * 联动高亮（标书核心要求）：
 *   选中某个标识 → 记下它的 eventId → **所有同 eventId 的标识**（可能 8 个）一起高亮，
 *   其余标识降透明；不需要在后端做任何额外计算，用前端已有 markers 按 eventId 匹配即可。
 *
 * 重叠处理（实测必须做）：
 *   一个网格上可能压着几十个事件（突发停气 228 个标识只落在 22 个网格上，最多单网格 70+ 个）。
 *   若全部画在同一点，它们会完全重叠 → 后面那个把前面那个整个盖住，点不到也看不清。
 *   因此同网格内的标识按**阿基米德螺线**均匀铺开（每个约 26m 间距），保证每个点都独立可点。
 */
function renderShutdown() {
  const painted: ShutdownMarker[] = [];
  try {
    const anchors = buildGridAnchors();
    shutdownUnpainted.value = [];

    // 每类先清空
    for (const [index, cat] of SHUTDOWN_CATEGORIES.entries()) {
      const layer = shutdownLayers.value[cat];
      layer?.getSource()?.clear();
      layer?.setZIndex(shutdownSelectedEvent.value?.category === cat ? 25 : 21 + index);
    }

    const data = shutdownData.value;
    if (!data) return;

    const selEv = shutdownSelectedEvent.value;
    const hasSelection = Boolean(selEv);

    // 先按网格把所有标识分组（普通对象 + 数组，避免 Map/Set 迭代在响应式下出问题）
    const byGrid: Record<string, ShutdownMarker[]> = {};
    for (let i = 0; i < data.markers.length; i += 1) {
      const m = data.markers[i];
      const key = String(m.gridCode);
      (byGrid[key] ?? (byGrid[key] = [])).push(m);
    }

    // 螺线铺开：第 n 个点放在半径随 n 缓慢增大的螺线上
    // 间距 0.00026° 纬度 ≈ 29m，低缩放级别下也基本分得开；缩放大时视觉效果自然
    const SPACING = 0.00026;
    const GOLDEN_ANGLE = 2.399963229728653; // 黄金角，铺点最均匀

    // 同一事件在同一网格的重叠也按网格内序号错开；事件级 index 用于挑选显示的那个
    const gridCodes = Object.keys(byGrid);

    for (let gi = 0; gi < gridCodes.length; gi += 1) {
      const gridCode = gridCodes[gi];
      const anchor = anchors[gridCode];
      const envMarkers = byGrid[gridCode];

      if (!anchor) {
        for (let k = 0; k < envMarkers.length; k += 1) {
          shutdownUnpainted.value.push({
            gridCode,
            reason: '该网格无边界几何也无小区点位，无法定位',
          });
        }
        continue;
      }

      for (let idx = 0; idx < envMarkers.length; idx += 1) {
        const m = envMarkers[idx];
        const layer = shutdownLayers.value[m.category];
        const source = layer?.getSource();
        if (!source) continue;

        // 第 0 个点就在锚点上，其余按螺线外扩
        const r = idx === 0 ? 0 : SPACING * Math.sqrt(idx);
        const angle = idx * GOLDEN_ANGLE;
        const lon = anchor[0] + Math.cos(angle) * r;
        const lat = anchor[1] + Math.sin(angle) * r;

        const feature = new Feature({ geometry: new Point([lon, lat]) });
        feature.set('markerId', m.markerId);
        feature.set('eventId', m.eventId);
        feature.set('category', m.category);
        feature.set('gridCode', m.gridCode);
        feature.set('gridName', m.gridName ?? m.gridCode);
        const ev = data.events.find((e) => e.eventId === m.eventId);
        feature.set('gridTotal', ev?.gridCodes.length ?? 1);
        feature.set('selected', m.markerId === shutdownSelectedMarkerId.value);
        feature.set('linked', hasSelection && m.eventId === selEv?.eventId);
        source.addFeature(feature);
        painted.push(m);
      }
    }
  } catch (e) {
    console.error('[Map2D] renderShutdown 失败:', (e as Error)?.message);
  } finally {
    shutdownPaintedMarkers.value = painted;
  }
}

/**
 * 点击停水停气标识 → 选中该事件（触发同事件全部标识联动高亮）+ 通知父组件打开面板。
 *
 * 注意：选中粒度是 **eventId**，不是单个 markerId —— 标书要求「同一事件引起的标识会高亮显示」。
 */
function openShutdownMarker(markerId: string) {
  const data = shutdownData.value;
  if (!data || shutdownLoading.value) return;
  const m = data.markers.find((x) => x.markerId === markerId);
  if (!m) return;

  shutdownSelectedEventId.value = m.eventId;
  shutdownSelectedMarkerId.value = m.markerId;
  renderShutdown();

  const ev = data.events.find((e) => e.eventId === m.eventId) ?? null;
  emit('shutdown-pick', {
    marker: m,
    event: ev,
    /** 该事件涉及的网格数（>1 即多网格联动场景） */
    gridTotal: ev?.gridCodes.length ?? 1,
    gridHistory: data.gridHistory[String(m.gridCode)] ?? null,
    dataSource: data.dataSource,
    dataSourceNote: data.dataSourceNote,
  });
}

/** 清除停水停气选中态（面板关闭时调用） */
function clearShutdownSelection() {
  if (!shutdownSelectedEventId.value) return;
  shutdownSelectedEventId.value = '';
  shutdownSelectedMarkerId.value = '';
  renderShutdown();
}

/** 切换某一类停水停气图层显隐（四类**独立**开关，对应标书四个图层） */
function setShutdownVisible(cat: ShutdownCategory, visible: boolean) {
  shutdownLayerOn.value = { ...shutdownLayerOn.value, [cat]: visible };
  shutdownLayers.value[cat]?.setVisible(visible);
  reportStatus();
}

function toggleShutdown(cat: ShutdownCategory) {
  setShutdownVisible(cat, !shutdownLayerOn.value[cat]);
}

/**
 * 网格质心作为位置参考。
 *
 * 现状：后端 `/assessment/admin-grids` 已有 124 个网格（区县+街道）但 `hasGeometry` 全为 false，
 * 高德边界接口也尚未配置 key，因此网格面暂时画不出来。
 * 这里按「同网格内小区点位的经纬度均值」算出质心，用圆点 + 件数标签表达网格分布：
 *   · 有真实边界时：网格用面着色，本层自动清空
 *   · 无边界时：使用统一色的质心与件数标签。
 * 位置由真实点位推导，不虚构；边界接口就绪后自动切换为面渲染。
 */
function renderGridCentroids() {
  try {
    const layer = centroidLayer.value;
    if (!layer) return;
    const source = layer.getSource();
    if (!source) return;
    source.clear();

    const points = Array.isArray(props.points) ? props.points : [];
    // 用普通对象聚合（不用 Map，避免任何迭代器/Proxy 兼容问题）
    const agg: Record<string, { lon: number; lat: number; n: number }> = {};
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const gid = p.gridId;
      if (!gid) continue;
      if (!agg[gid]) agg[gid] = { lon: 0, lat: 0, n: 0 };
      agg[gid].lon += p.longitude;
      agg[gid].lat += p.latitude;
      agg[gid].n += 1;
    }
    const counts = gridCountByCode.value;
    // 街道已有面（正式或凸包）时，不再画质心气泡；只有面缺失的街道才用气泡兜底
    const streetCodesWithPolygon = new Set([
      ...boundaries.value.filter((b) => b.level !== 'district' && b.polygons.length > 0).map((b) => String(b.code)),
      ...(props.heat?.data.grids ?? []).filter(g => g.geometry).map(g => g.code),
    ]);
    const hasDistrictPolygon = boundaries.value.some((b) => b.level === 'district');
    const codes = Object.keys(agg);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      const v = agg[code];
      if (!v || !v.n) continue;
      // 6 位 = 区县（已有面边界），不画气泡
      if (code.length !== 9 && hasDistrictPolygon) continue;
      // 9 位街道：已有面则跳过（面着色已表达）
      if (code.length === 9 && streetCodesWithPolygon.has(code)) continue;
      const count = counts.get(code) ?? 0;
      const feature = new Feature({ geometry: new Point([v.lon / v.n, v.lat / v.n]) });
      feature.set('code', code);
      feature.set('name', code);
      feature.set('count', count);
      feature.set('centroid', true);
      source.addFeature(feature);
    }
  } catch (e) {
    console.error('[Map2D] renderGridCentroids 失败:', (e as Error)?.message, (e as Error)?.stack?.slice(0, 400));
  }
}

/* ------------------------------------------------------------------ 渲染 */

/**
 * 渲染小区点位。
 *
 * 语义（按用户要求修正）：
 *   · **默认不高亮** —— 首屏视觉主体是区域热力图，946 个点位若全部高亮会盖过热力、
 *     也会让人误以为"这些都被选中了"
 *   · **点击某个小区才高亮** —— 只有 locatedCommunity 命中的那个点是 active
 *   · **按网格/区县筛选时**，范围内点位给一点提亮（inScope），但仍是小点
 */
function renderPoints() {
  const layer = pointLayer.value;
  if (!layer) return;
  const source = layer.getSource();
  if (!source) return;
  source.clear();
  if (!props.showPoints || !pointsOn.value) return;

  const activeGrid = props.gridCode;
  const locatedId = locatedCommunity.value?.id ?? '';
  const list = Array.isArray(props.points) ? props.points : [];

  for (const p of list) {
    if (!Number.isFinite(p.longitude) || !Number.isFinite(p.latitude)) continue;
    const id = String(p.id ?? '');
    // 只有「被点击定位的那一个」算选中；有网格筛选时范围内点位额外提亮
    const isLocated = Boolean(locatedId) && id === String(locatedId);
    const inScope = Boolean(activeGrid) && String(p.gridId ?? '') === String(activeGrid);

    const feature = new Feature({
      geometry: new Point([p.longitude, p.latitude]),
    });
    feature.set('point', p);
    feature.set('name', p.name);
    feature.set('active', isLocated);
    feature.set('inScope', inScope);
    feature.set('precision', 'exact');
    feature.setStyle(pointStyle(feature));
    source.addFeature(feature);
  }
}

function renderGrids() {
  const layer = gridLayer.value;
  if (!layer) return;
  const source = layer.getSource();
  if (!source) return;
  source.clear();
  const counts = gridCountByCode.value;
  const formal = new Map((props.heat?.data.grids ?? []).filter(grid => grid.geometry).map(grid => [grid.code, grid]));
  const list = Array.isArray(boundaries.value) ? boundaries.value : [];
  // 标签锚点一次性算好（内部会做「吸附到最近真实小区点」），不要在循环里重复调用
  const anchorsAll = buildGridAnchors();
  for (const b of list) {
    // 图层开关：区县面与街道面各自独立（客户要求所有数据效果都能单独开关）
    if (b.level === 'district' && !districtOn.value) continue;
    if (b.level !== 'district' && (!streetOn.value || formal.has(b.code))) continue;
    const rings = Array.isArray(b.polygons) ? b.polygons : [];
    if (!rings.length) continue;
    /*
     * 一个行政单元只建**一个** feature。
     *
     * 原来是对每个环建一个 feature，于是多环的单元（秭归县 3 环、兴山县 3 环、
     * 当阳市 2 环、小溪塔街道 6 环…）会在图上重复出现同名标签
     * ——「秭归县 49」出现两次、「茅坪镇 4」出现两次，看着像两个不同的网格，
     * 也让客户怀疑编码是否一致。合并成 MultiPolygon 后标签只画一次。
     */
    const geometry: Polygon | MultiPolygon =
      rings.length === 1 ? new Polygon([rings[0]]) : new MultiPolygon(rings.map((r) => [r]));
    const feature = new Feature({ geometry });
    feature.set('code', b.code);
    feature.set('name', b.name);
    feature.set('count', counts.get(String(b.code)) ?? 0);
    // 选中态：区县用 districtCode 命中；街道用 gridCode 命中
    feature.set(
      'selected',
      (b.level === 'district' && Boolean(props.districtCode) && String(b.code) === String(props.districtCode)) ||
        (b.level === 'street' && Boolean(props.gridCode) && String(b.code) === String(props.gridCode))
    );
    feature.set('source', b.source);
    // 要素级来源（同一数据包可能混装 OSM 实测面与推导面），样式/悬停据此如实区分
    feature.set('provider', (b as {provider?: string}).provider ?? '');
    feature.set('level', b.level);
    // 标书 1.2.4：悬停要能看「社区名称」。社区列表随 feature 带上，悬停时直接读
    feature.set('communityNames', Array.isArray(b.communityNames) ? b.communityNames : []);
    feature.set('communityCount', Number(b.communityCount ?? 0));
    /*
     * 标签锚点：吸附到该网格下**真实小区坐标**，而不是让 OL 用多边形内部点。
     * 多边形是 420m 缓冲合并出来的，其内部点经常落在江面上，
     * 于是「小溪塔街道 14」这类标签会浮在库区中间 —— 客户看到就以为数据跑了。
     */
    const labelAnchor = (b.anchor as [number, number] | undefined) ?? anchorsAll[String(b.code)];
    if (labelAnchor) feature.set('labelPoint', new Point(labelAnchor));
    source.addFeature(feature);
  }
  if (!streetOn.value) return;
  for (const grid of formal.values()) {
    const shape = grid.geometry;
    if (!shape) continue;
    const geometry = shape.type === 'Polygon' ? new Polygon(shape.coordinates) : new MultiPolygon(shape.coordinates);
    const related = grid.communities ?? [];
    const feature = new Feature({
      geometry, code: grid.code, name: grid.name ?? grid.code,
      count: grid.count, heatLevel: grid.level, formalHeatGrid: true,
      level: 'grid', source: 'official', selected: props.gridCode === grid.code,
      communityNames: related.slice(0, 12), communityCount: related.length,
    });
    source.addFeature(feature);
  }
}

function renderHighlight() {
  const layer = highlightLayer.value;
  if (!layer) return;
  const source = layer.getSource();
  if (!source) return;
  source.clear();
  const wanted = String(props.districtCode || '');
  if (!wanted) return;
  for (const b of boundaries.value) {
    if (String(b.code) !== wanted) continue;
    for (const ring of b.polygons) {
      source.addFeature(new Feature({ geometry: new Polygon([ring]) }));
    }
  }
}

/* ------------------------------------------------------- 定位到小区（不改筛选） */

/**
 * 小区级定位高亮状态。
 *
 * 与 `props.communityCode`（筛选条件）**完全独立**：
 *   · 筛选会触发全局重新查询，所有面板数字随之变化 —— 这是「点一下小区 → 数据全变」的根源
 *   · 定位只移动视野 + 打高亮，不改任何筛选，面板数据保持
 *
 * 用户诉求：「高频诉求小区效果不对，不是筛选，应该是到具体的位置，需要看明细才展开明细」。
 */
const locatedCommunity = ref<{ id: string; name: string; lon: number; lat: number } | null>(null);

/**
 * 飞到指定小区点位并高亮，**不触碰任何筛选条件**。
 *
 * @param code 小区编码（优先）
 * @param name 小区名称（编码匹配不到时用名称兜底）
 * @returns 是否命中（未命中时前端如实提示，不假装定位成功）
 */
function locateCommunity(code: string | null | undefined, name: string | null | undefined): boolean {
  const map = mapRef.value;
  if (!map) return false;
  const pts = props.points ?? [];
  const hit =
    (code ? pts.find((p) => String(p.id) === String(code)) : undefined) ??
    (name ? pts.find((p) => String(p.name) === String(name)) : undefined);
  if (!hit) return false;

  const lon = Number(hit.longitude);
  const lat = Number(hit.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;

  locatedCommunity.value = { id: String(hit.id), name: String(hit.name), lon, lat };
  // 关键：把该点标记为 active 并重绘点位层，否则点完看不到"被选中"的视觉反馈
  renderPoints();
  renderLocatedCommunity();
  // 拖动/缩放地图时浮层要跟着点位走
  attachAnchorTracking();

  // 视野：以该点为中心，缩到能看清周边小区的级别（14 级约 1:35000，视野半径约 2km）
  /**
   * 锚点回报策略（三段，保证任何时机都有锚点）：
   *   ① 立刻回报一次 —— 浮层创建时就有位置，不出现"先弹兜底位再跳"
   *   ② 动画结束回报 —— 视野稳定，位置才准确
   *   ③ 900ms 兜底 —— 动画被用户拖动打断时回调不触发，靠这条补
   */
  reportAnchor([lon, lat]);
  map.getView().animate({ center: [lon, lat], zoom: 14, duration: 700 }, () => {
    reportAnchor([lon, lat]);
  });
  setTimeout(() => reportAnchor([lon, lat]), 900);
  return true;
}

/**
 * 选中网格 → 飞到该网格范围并高亮，**不改筛选**。
 *
 * 与 `flyToGrid`（依赖 props.gridCode，即筛选态）不同，这里是"临时选中"：
 * 只移动视野，不触发重新查询。用户点地图上的网格面时走这条路径，
 * 避免"点一下整屏数字变 0"。
 */
function locateGrid(code: string | null | undefined): boolean {
  const map = mapRef.value;
  if (!map || !code) return false;

  const official = formalGridGeometry(code);
  if (official) {
    map.getView().fit(official.getExtent(), { duration: 700, padding: mapFitPadding(), maxZoom: 13 });
    setTimeout(() => emitAnchorAtCenter(), 1000);
    return true;
  }

  // 有参考边界时，定位到参考范围。
  const hit = boundaries.value.find((b) => String(b.code) === String(code));
  if (hit) {
    const extent = polygonExtent(hit);
    if (extent) {
      map.getView().fit(extent as any, { duration: 700, padding: mapFitPadding(), maxZoom: 13 });
      // 用容器中点作锚点（不依赖坐标换算，动画中途换算值不稳定）
      setTimeout(() => emitAnchorAtCenter(), 1000);
      return true;
    }
  }

  // ② 没有边界几何：按该网格的点位包络飞（保底也要有响应）
  const pts = (props.points ?? []).filter((p) => String(p.gridId) === String(code));
  if (!pts.length) return false;
  const lons = pts.map((p) => Number(p.longitude)).filter(Number.isFinite);
  const lats = pts.map((p) => Number(p.latitude)).filter(Number.isFinite);
  if (!lons.length || !lats.length) return false;
  const env = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  map.getView().fit(env as any, { duration: 700, padding: mapFitPadding(), maxZoom: 13 });
  setTimeout(() => emitAnchorAtCenter(), 1000);
  return true;
}
/**
 * 详情浮层据此贴在点位旁边（而不是固定挂在右下角）——
 * 用户要求「小区窗体应该挂到地图上而不是右下角」。
 *
 * 同时约定：
 *   · 点位在容器内部但靠近边缘时，父组件负责翻转方向，保证浮层不出界
 *   · 地图平移/缩放后重新回报，浮层跟着动
 */
/**
 * 以「地图容器中心」为锚点回报。
 *
 * 适用于 fit / animate 到某目标之后 —— 此时中心就是目标，直接取容器中点像素，
 * 不依赖地理坐标换算（换算在动画未完成时拿到的值不稳定）。
 */
function emitAnchorAtCenter() {
  const map = mapRef.value;
  if (!map) return;
  const size = map.getSize();
  if (!size) return;
  emit('anchor', {
    x: size[0] / 2,
    y: size[1] / 2,
    width: size[0],
    height: size[1],
    lonLat: [0, 0],
  });
}

/** 把地理坐标换算成「地图容器内的像素坐标」，通过 anchor 事件回报给父组件。 */
function reportAnchor(lonLat: [number, number] | null) {
  const map = mapRef.value;
  if (!map || !lonLat) {
    emit('anchor', null);
    return;
  }
  /**
   * 坐标换算：地图 view 的 projection 是 **EPSG:4326**（经纬度），
   * 所以这里**不能**用 fromLonLat —— 那是把经纬度转成 EPSG:3857 米制坐标，
   * 两者混用会让像素值变成 361 亿这种天文数字（浮层直接飞出屏幕）。
   * EPSG:4326 下直接传 [lon, lat] 即可。
   */
  const px = map.getPixelFromCoordinate([lonLat[0], lonLat[1]]);
  if (!px || !Number.isFinite(px[0]) || !Number.isFinite(px[1])) {
    emit('anchor', null);
    return;
  }
  const size = map.getSize();
  emit('anchor', {
    x: px[0],
    y: px[1],
    width: size?.[0] ?? 0,
    height: size?.[1] ?? 0,
    lonLat,
  });
}

/** 地图移动结束事件监听（只挂一次），保证浮层锚点随视野变化刷新 */
let anchorMoveBound = false;
function attachAnchorTracking() {
  const map = mapRef.value;
  if (!map || anchorMoveBound) return;
  anchorMoveBound = true;
  const cur = () => {
    const lc = locatedCommunity.value;
    if (!lc) return;
    reportAnchor([lc.lon, lc.lat]);
  };
  // moveend 覆盖拖拽与滚轮缩放；postrender 会让频率过高，这里用 moveend 即可
  map.on('moveend', cur);
}

/** 清除小区定位高亮 */
function clearLocatedCommunity() {
  locatedCommunity.value = null;
  const layer = locatedLayer.value;
  layer?.getSource()?.clear();
  // 高亮取消后，点位要回到"未选中"的安静态
  renderPoints();
}

/** 渲染定位高亮：光环 + 中心点，明显区别于普通小区点位 */
function renderLocatedCommunity() {
  const layer = locatedLayer.value;
  if (!layer) return;
  const source = layer.getSource();
  if (!source) return;
  source.clear();
  const cur = locatedCommunity.value;
  if (!cur) return;
  source.addFeature(
    new Feature({
      geometry: new Point([cur.lon, cur.lat]),
      name: cur.name,
    })
  );
}
/* ------------------------------------------------------------------ 联动（筛选 → 地图） */

/** 选中区县 → 飞到该区县范围；未选 → 回到城区默认视野 */
function flyToDistrict() {
  const map = mapRef.value;
  if (!map) return;
  const view = map.getView();
  const target = String(props.districtCode || '');
  if (!target) {
    view.animate({ center: DEFAULT_CENTER_LONLAT, zoom: DEFAULT_ZOOM, duration: 600 });
    return;
  }
  const hit = boundaries.value.find((b) => String(b.code) === target);
  if (!hit) {
    // 边界还没到：先按点位包络飞（保底也要有响应）
    flyToPointsOfGrid();
    return;
  }
  const extent = polygonExtent(hit);
  if (extent) {
    view.fit(extent as any, { duration: 700, padding: mapFitPadding(), maxZoom: 12 });
  }
}

/**
 * 地图实际可见区域的 padding。
 *
 * 大屏左右两侧各有一列面板（各约 430px），顶部还有筛选条与状态卡，
 * 底部按钮条约 60px。如果 fit 时只用对称小 padding，ol 会按整个 canvas 计算，
 * 结果目标区域被塞到被面板遮住的部分 —— 用户看到的就是「飞过去但什么也看不见/放得过大」。
 * 这里按真实遮挡量给非对称 padding，让目标落在中间可视区。
 */
function mapFitPadding(): [number, number, number, number] {
  const host = hostRef.value;
  const w = host?.clientWidth ?? window.innerWidth;
  const h = host?.clientHeight ?? window.innerHeight;
  // 面板宽度按 1920 设计稿的 22.5% 估算，并设上下限，避免小屏时 padding 吃掉全部视野
  const side = Math.max(120, Math.min(Math.round(w * 0.235), 460));
  const top = Math.max(90, Math.min(Math.round(h * 0.16), 190));
  const bottom = Math.max(80, Math.min(Math.round(h * 0.075), 110));
  return [top, side, bottom, side];
}

/** 选中网格 → 飞到网格范围（边界没有该网格时退回点位） */
function flyToGrid() {
  const map = mapRef.value;
  if (!map || !props.gridCode) return;
  const view = map.getView();
  const official = formalGridGeometry(props.gridCode);
  if (official) {
    view.fit(official.getExtent(), { duration: 700, padding: mapFitPadding(), maxZoom: 14 });
    return;
  }
  const hit = boundaries.value.find((b) => String(b.code) === String(props.gridCode));
  if (hit) {
    const extent = polygonExtent(hit);
    if (extent) {
      // maxZoom 收敛到 14：街道级面在 15~16 会放得过大，只剩一个圆看不到周边点位分布
      view.fit(extent as any, { duration: 700, padding: mapFitPadding(), maxZoom: 14 });
      return;
    }
  }
  flyToPointsOfGrid();
}

function formalGridGeometry(code: string): Polygon | MultiPolygon | null {
  const shape = props.heat?.data.grids.find(grid => grid.code === code)?.geometry;
  if (!shape) return null;
  return shape.type === 'Polygon' ? new Polygon(shape.coordinates) : new MultiPolygon(shape.coordinates);
}

function flyToPointsOfGrid() {
  const map = mapRef.value;
  if (!map) return;
  const pts = props.points.filter((p) => !props.gridCode || p.gridId === props.gridCode);
  if (!pts.length) return;
  const lons = pts.map((p) => p.longitude);
  const lats = pts.map((p) => p.latitude);
  const pad = 0.01;
  const extent = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
  map.getView().fit(extent as any, { duration: 700, padding: [100, 100, 100, 100], maxZoom: 16 });
}

function polygonExtent(b: GridBoundary): [number, number, number, number] | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of b.polygons) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLon)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/** 复位：回到默认视野 */
function resetCamera() {
  const map = mapRef.value;
  if (!map) return;
  map.getView().animate({ center: DEFAULT_CENTER_LONLAT, zoom: DEFAULT_ZOOM, duration: 600 });
}

/* ------------------------------------------------------------------ 状态上报 */

/** 边界状态文案：有边界说来源，无边界说清降级原因（不粉饰） */
function borderSourcesLabel(): string {
  if (!boundaries.value.length) {
    return boundaryNote.value ?? '边界未接入（网格按点位质心着色）';
  }
  return boundarySourceLabel(
    boundaries.value,
    boundaryNote.value,
    streetSource.value,
    streetCount.value,
    boundaryPack.value,
    packMatched.value
  );
}

function reportStatus() {
  const p = probe.value;
  const source = p?.source ?? null;
  emit('status', {
    phase: p ? 'ready' : 'boot',
    basemap: basemapLabel.value,
    cimOk: Boolean(p?.ok),
    source,
    reason: p?.ok ? undefined : p?.reason,
    probeMs: source ? p?.timings?.[source] : undefined,
    boundary: borderSourcesLabel(),
    points: props.points.length,
    grids: boundaries.value.length || gridCentroidCount.value,
    pipeline: pipelineStatusText(),
    shutdown: shutdownStatusText(),
  });
}

/**
 * 停水停气图层状态一句话（标书 1.2.6）：如实说明四类各多少事件/标识，以及数据来源。
 * 来源为空时明确说出来，不让使用者以为是加载失败。
 */
function shutdownStatusText(): string {
  const d = shutdownData.value;
  if (!d) return '停水停气数据加载中…';
  if (d.note) return `停水停气数据不可用：${d.note}`;
  const c = d.categoryCounts;
  const on = (k: ShutdownCategory) => (shutdownLayerOn.value[k] ? '' : '（关）');
  const parts = [
    `计划停水${on('planned_water')} ${c.planned_water}`,
    `计划停气${on('planned_gas')} ${c.planned_gas}`,
    `突发停水${on('emergency_water')} ${c.emergency_water}`,
    `突发停气${on('emergency_gas')} ${c.emergency_gas}`,
  ];
  const visible = shutdownVisibleMarkers.value.length;
  parts.push(`${d.gridCount} 网格/${visible} 标识`);
  if (shutdownSelectedEventId.value) {
    parts.push(`已选事件高亮 ${shutdownHighlightedCount.value} 个标识`);
  }
  if (shutdownUnpainted.value.length) parts.push(`${shutdownUnpainted.value.length} 个标识因网格缺少定位未落图`);
  if (!d.markers.length) parts.push('暂无可打点事件');
  // 数据来源必须显式暴露：当前读的是来源快照，不是业务主表
  parts.push(d.dataSource === 'snapshot' ? '来源：快照(未落库)' : '来源：业务主表');
  return parts.join(' · ');
}

/** 管线图层状态一句话（标书 1.2.7）：如实说明两层各着了多少网格、多少项目落不了图 */
function pipelineStatusText(): string {
  const g = pipelineGas.value;
  const w = pipelineWater.value;
  if (!g && !w) return '改造项目数据加载中…';
  const parts: string[] = [];
  const on = (k: PipelineBusinessType) => (k === 'gas' ? gasLayerOn.value : waterLayerOn.value);
  parts.push(`燃气${on('gas') ? '' : '（关）'} ${g?.gridCount ?? 0} 网格/${g?.locatedProjectCount ?? 0} 项`);
  parts.push(`供水${on('water') ? '' : '（关）'} ${w?.gridCount ?? 0} 网格/${w?.locatedProjectCount ?? 0} 项`);
  const unlocated = (g?.unlocatedCount ?? 0) + (w?.unlocatedCount ?? 0);
  if (unlocated) parts.push(`${unlocated} 项缺网格`);
  const unpainted = pipelineUnpainted.value.length;
  if (unpainted) parts.push(`${unpainted} 个网格因边界几何异常未着色`);
  if (!pipelineHasCells) parts.push('暂无可着色网格');
  return parts.join(' · ');
}

/** 切换业务数据图层（区县 / 街道 / 小区点位 / 小区热力） */
function toggleDataLayer(kind: 'district' | 'street' | 'points' | 'heat') {
  if (kind === 'district') {
    districtOn.value = !districtOn.value;
    renderGrids();
  } else if (kind === 'street') {
    streetOn.value = !streetOn.value;
    renderGrids();
  } else if (kind === 'points') {
    pointsOn.value = !pointsOn.value;
    renderPoints();
  } else {
    heatOn.value = !heatOn.value;
    gridLayer.value?.changed();
  }
  reportStatus();
}

/* ------------------------------------------------- 叠加对照（让着色「贴」在底图上） */

/**
 * 叠加对照：去掉全部面填充，只留描边与标签，影像完整露出。
 *
 * 用途：客户/验收方一键确认「着色边界到底有没有贴在 CIM 影像上」。
 * 平时是半透明叠加（既看得见热力档位、又看得见地物），但总有人怀疑两层错位；
 * 对照模式下没有填充遮挡，边界与影像的对应关系一眼可辨 —— 边界压住长江、
 * 葛洲坝、城区就说明配准没问题；若整层斜移，则一眼能看出来。
 */
function toggleCompare() {
  compareOn.value = !compareOn.value;
  // 样式函数按 compareOn 现算，重建 feature 保证立刻按新透明度重绘
  renderGrids();
  mapRef.value?.render();
  reportStatus();
}

/* ------------------------------------------------- 管线图层开关（标书 1.2.7） */

/** 切换燃气/供水图层显隐（两个**独立**开关，对应标书两个管线图层） */
function setPipelineVisible(type: PipelineBusinessType, visible: boolean) {
  if (type === 'gas') {
    gasLayerOn.value = visible;
    gasPipelineLayer.value?.setVisible(visible);
  } else {
    waterLayerOn.value = visible;
    waterPipelineLayer.value?.setVisible(visible);
  }
  // 图层关掉后，选中态与悬停信息都要清掉，避免「看不见却还在高亮」
  if (!visible) dismissPipelinePick();
  /*
   * 后端**没有任何可着色网格**时，无论用户这次点的是「开」还是「关」，
   * 画面都不会有任何变化（本来就没东西可显示），用户会判定「按钮坏了」。
   * 所以只要点击管线开关且当前无数据，就直接把说明面板展开，
   * 明确告知是数据缺「涉及网格」编码，而不是交互失效。
   */
  if (!pipelineHasCells.value) {
    pipeEmptyDismissed.value = false;
    pipeEmptyExpanded.value = true;
  }
  reportStatus();
}

function togglePipeline(type: PipelineBusinessType) {
  setPipelineVisible(type, type === 'gas' ? !gasLayerOn.value : !waterLayerOn.value);
}

/* ------------------------------------------------------------------ 响应式联动 */

watch(
  () => props.points,
  () => {
    renderPoints();
    renderGridCentroids();
    reportStatus();
    /*
     * 点位是异步到达的：如果用户先在小区的下拉里选好、点了查询，
     * 而 loadSpatial 的结果还没回来，上面那个 communityCode 的 watch 会命中不到点位。
     * 这里在点位更新后补一次定位，保证「选了小区 → 地图一定飞过去并高亮」。
     */
    if (props.communityCode) locateCommunity(String(props.communityCode), null);
  },
  { deep: false }
);

watch(
  () => [props.gridMetrics, props.gridCode, props.heat],
  () => {
    renderGrids();
    renderGridCentroids();
    renderHighlight();
  },
  { deep: false }
);

watch(() => props.heat, () => {
  if (props.gridCode && props.heat?.data.grids.some(g => g.code === props.gridCode && g.geometry)) flyToGrid();
});

watch(
  () => props.districtCode,
  () => {
    renderGrids();
    renderHighlight();
    flyToDistrict();
  }
);

watch(
  () => props.gridCode,
  () => {
    renderPoints();
    renderHighlight();
    if (pipelineSelectedCode.value !== props.gridCode) dismissPipelinePick();
    renderPipeline();
    flyToGrid();
  }
);

watch(
  () => props.showPoints,
  () => {
    renderPoints();
  }
);

/*
 * 筛选条选了「小区」→ 自动定位并高亮该小区。
 *
 * 历史缺口：props.communityCode 在 Map2DView 里**完全没被使用**，
 * 所以用户在筛选条选中某个小区、点「查询」，地图毫无反应
 * （反馈「小区选择后没有突出的显示」）。
 * 这里复用 Top10 点击的定位高亮（金色光环 + 飞到该点），只做视觉强调，
 * 不改任何筛选状态，不触发额外查询。
 */
watch(
  () => props.communityCode,
  (code) => {
    if (!code) {
      clearLocatedCommunity();
      return;
    }
    const hit = locateCommunity(String(code), null);
    if (!hit) clearLocatedCommunity();
  }
);

/* ------------------------------------------------------------------ 生命周期 */

onMounted(() => {
  void initMap();
});

onBeforeUnmount(() => {
  const map = mapRef.value;
  if (map) {
    map.setTarget(undefined);
    map.dispose();
  }
  mapRef.value = null;
});

defineExpose({ resetCamera, flyToDistrict, setPipelineVisible, loadPipeline, clearPipelineSelection, setShutdownVisible, loadShutdown, clearShutdownSelection, shutdownHighlightedCount, locateCommunity, clearLocatedCommunity, locateGrid });
</script>

<template>
  <div class="map2d">
    <div ref="hostRef" class="map2d__canvas" :style="{ cursor: cursorStyle }"></div>

    <!-- 悬停提示（不抢点击） -->
    <!-- 悬停信息：标书 1.2.4 要求可见「社区名称、网格名称、当前该网格的诉求量」 -->
    <div v-if="hoverName" class="map2d__hover">
      <template v-if="hoverKind === 'community'">
        <span class="map2d__hover-tag">小区</span>
        <b>{{ hoverName }}</b>
      </template>
      <template v-else-if="hoverKind === 'shutdown' && hoverShutdown">
        <span class="map2d__hover-tag is-sd" :style="{ background: CATEGORY_COLORS[hoverShutdown.category].fill }">
          {{ CATEGORY_LABEL[hoverShutdown.category] }}
        </span>
        <b>{{ hoverName }}</b>
        <span class="map2d__hover-count">{{ hoverShutdown.text }}</span>
      </template>
      <template v-else-if="hoverKind === 'pipeline-gas' || hoverKind === 'pipeline-water'">
        <span class="map2d__hover-tag" :class="hoverKind === 'pipeline-gas' ? 'is-gas' : 'is-water'">
          {{ hoverKind === 'pipeline-gas' ? '燃气改造' : '供水改造' }}
        </span>
        <b>{{ hoverName }}</b>
        <span v-if="hoverCode" class="map2d__hover-code">{{ hoverCode }}</span>
        <span class="map2d__hover-count">{{ hoverPipeline }}</span>
      </template>
      <template v-else>
        <span class="map2d__hover-tag">{{ hoverKind === 'grid' ? '区县' : hoverFormalGrid ? '行政网格' : '参考范围' }}</span>
        <b>{{ hoverName }}</b>
        <span v-if="hoverCode" class="map2d__hover-code">{{ hoverCode }}</span>
        <span v-if="hoverCount !== null" class="map2d__hover-count">{{ hoverCount }} 件诉求</span>
        <div v-if="hoverFormalGrid" class="map2d__hover-comm">行政社区名称未配置</div>
        <div v-if="hoverCommunityNames.length" class="map2d__hover-comm">
          <span class="map2d__hover-comm-label">关联小区</span>
          <span class="map2d__hover-comm-list">{{ hoverCommunityNames.join('、') }}</span>
          <span v-if="hoverCommunityTotal > hoverCommunityNames.length" class="map2d__hover-comm-more">
            等 {{ hoverCommunityTotal }} 个
          </span>
        </div>
      </template>
    </div>

    <!-- 底图状态：如实说明当前走的是 drs 官方源 / 网关兜底 / 高德兜底，以及探测延迟 -->
    <div
      class="map2d__basemap"
      :class="{ 'is-error': probe && !probe.ok, 'is-warn': amapActive }"
    >
      <i></i>
      <span>{{ basemapLabel }}</span>
      <small v-if="probe?.ok && probe.source">
        {{ probe.source === 'drs' ? '官方源' : probe.source === 'gateway' ? '网关兜底' : '最终兜底' }}
        · {{ probe.timings?.[probe.source] }}ms
      </small>
    </div>

    <!--
      高德兜底 = GCJ-02 底图 + WGS84 点位，二者约有 680m 相对偏移。
      必须显式提示，否则使用者会把底图偏移误读成「点位放错了」。
    -->
    <div v-if="amapActive" class="map2d__coordwarn">
      <b>坐标偏差</b>
      <span>
        当前为高德底图兜底（GCJ-02），CIM 影像不可达。业务点位按真实 WGS84 落图，底图与点位约有
        {{ AMAP_GCJ_OFFSET_METERS }}m 的相对偏差 —— 点位数值本身正确，仅为底图视觉参照。
      </span>
    </div>

    <!--
      图层控制条：**只留开关**。
      按客户要求移除了原有的状态行（CIM 网关地址 / 边界 N / 落图 N 小区 · N 网格 /
      业务主表 / 详情）—— 那是实现侧诊断信息，业务人员看不懂，
      数据异常时还会显示「边界 0 · 落图 0 小区」像系统坏了。
      现在所有图层都像燃气/供水一样有独立开关。
    -->
    <div class="map2d__layerbar" role="group" aria-label="地图图层控制">
      <!-- 数据图层开关 -->
      <div class="map2d__layerbar-switches">
        <span class="map2d__layerbar-label">数据</span>
        <button
          type="button"
          class="map2d__pipebtn"
          :class="{ 'is-on': districtOn }"
          :aria-pressed="districtOn"
          title="区县分级设色（按各区县诉求量分五档）"
          @click="toggleDataLayer('district')"
        >
          <i class="map2d__pipedot is-district"></i>区县
        </button>
        <button
          type="button"
          class="map2d__pipebtn"
          :class="{ 'is-on': streetOn }"
          :aria-pressed="streetOn"
          title="行政网格及街道参考边界"
          @click="toggleDataLayer('street')"
        >
          <i class="map2d__pipedot is-street"></i>网格
        </button>
        <button
          type="button"
          class="map2d__pipebtn"
          :class="{ 'is-on': pointsOn }"
          :aria-pressed="pointsOn"
          title="小区点位（标书 1.2.5 小区图层）"
          @click="toggleDataLayer('points')"
        >
          <i class="map2d__pipedot is-point"></i>小区点位<em>{{ map2dPointCount }}</em>
        </button>
        <button
          type="button"
          class="map2d__pipebtn"
          :class="{ 'is-on': heatOn }"
          :aria-pressed="heatOn"
          title="按已发布系数显示行政网格热力"
          @click="toggleDataLayer('heat')"
        >
          <i class="map2d__pipedot is-heat"></i>网格热力
        </button>
        <!--
          叠加对照：让客户自己核对「着色边界有没有贴在影像上」。
          打开后区县/街道面填充归零，只留描边与标签 —— 影像里的长江、葛洲坝、城区
          应该正好被边界压住；如果整层偏移，这个模式下一眼就能看出来。
        -->
        <button
          type="button"
          class="map2d__pipebtn map2d__comparebtn"
          :class="{ 'is-on': compareOn }"
          :aria-pressed="compareOn"
          title="叠加对照：去掉色块填充只留描边，核对边界与 CIM 影像是否重合"
          @click="toggleCompare"
        >
          <i class="map2d__pipedot is-compare"></i>叠加对照
        </button>
        <span class="map2d__layerbar-vsep"></span>
        <span class="map2d__layerbar-label">管线</span>
        <button
          type="button"
          class="map2d__pipebtn"
          :class="{ 'is-on': gasLayerOn }"
          :aria-pressed="gasLayerOn"
          title="燃气管线图层：改造项目涉及的网格色块"
          @click="togglePipeline('gas')"
        >
          <i class="map2d__pipedot is-gas"></i>燃气
          <em v-if="pipelineGas">{{ pipelineGas.gridCount }}</em>
        </button>
        <button
          type="button"
          class="map2d__pipebtn"
          :class="{ 'is-on': waterLayerOn }"
          :aria-pressed="waterLayerOn"
          title="供水管线图层：改造项目涉及的网格色块"
          @click="togglePipeline('water')"
        >
          <i class="map2d__pipedot is-water"></i>供水
          <em v-if="pipelineWater">{{ pipelineWater.gridCount }}</em>
        </button>
        <button type="button" class="map2d__pipereload" title="重新拉取改造项目数据" @click="loadPipeline">
          {{ pipelineLoading ? '…' : '⟳' }}
        </button>
        <span class="map2d__layerbar-vsep"></span>
        <span class="map2d__layerbar-label">停水停气</span>
      <button
        v-for="cat in SHUTDOWN_CATEGORIES"
        :key="cat"
        type="button"
        class="map2d__sdb btn"
        :class="{ 'is-on': shutdownLayerOn[cat] }"
        :aria-pressed="shutdownLayerOn[cat]"
        :title="`${CATEGORY_LABEL[cat]}图层`"
        @click="toggleShutdown(cat)"
      >
        <i class="map2d__sddot" :style="{ background: CATEGORY_COLORS[cat].fill }"></i>
        {{ CATEGORY_COLORS[cat].short }}
        <em>{{ shutdownData?.categoryCounts?.[cat] ?? 0 }}</em>
      </button>
      <button type="button" class="map2d__sdreload" title="重新拉取停水停气事件" @click="loadShutdown">
        {{ shutdownLoading ? '…' : '刷新' }}
      </button>
      </div>
    </div>

    <!--
      管线图层空态：没有可着色网格时如实说明，绝不造色块。
      注意：这块曾固定居中悬浮（left/top 50%）且没有关闭按钮，结果永久挡住地图中央，
      用户点不到下面的点位、也看不清街道面 —— 是「地图没效果」的主要观感来源之一。
      现改为：① 默认收起成小角标；② 展开后有关闭按钮；③ 关闭后本次会话不再弹。
    -->
    <div
      v-if="!pipelineLoading && !pipelineHasCells && pipelineGas && !pipeEmptyDismissed && (gasLayerOn || waterLayerOn)"
      class="map2d__pipeempty"
      :class="{ 'is-collapsed': !pipeEmptyExpanded }"
    >
      <template v-if="!pipeEmptyExpanded">
        <button type="button" class="map2d__pipeempty-pill" title="点击查看说明" @click.stop="pipeEmptyExpanded = true">
          管线图层：暂无可着色网格（点击说明）
        </button>
      </template>
      <template v-else>
        <div class="map2d__pipeempty-head">
          <b>暂无可着色网格</b>
          <button type="button" class="map2d__pipeempty-close" title="关闭" @click.stop="pipeEmptyDismissed = true">×</button>
        </div>
        <span>
          已达改造项目数据（燃气 {{ pipelineGas?.projectCount ?? 0 }} 个 / 供水
          {{ pipelineWater?.projectCount ?? 0 }} 个），但暂无项目上报「涉及网格」编码。
        </span>
        <span v-if="unlocatedSummary" class="map2d__pipeempty-sub">{{ unlocatedSummary }}</span>
        <span class="map2d__pipeempty-sub">落图口径：按项目上报的影响网格形成色块，不绘制虚构管线。</span>
        <button type="button" class="map2d__pipeempty-collapse" @click.stop="pipeEmptyExpanded = false">收起</button>
      </template>
    </div>

    <!-- 有数据但网格面画不出来：如实警示，不静默 -->
    <div v-else-if="pipelineUnpainted.length" class="map2d__pipewarn">
      <b>边界缺失</b>
      <span>
        {{ pipelineUnpainted.length }} 个改造网格因边界几何异常未着色（
        {{ pipelineUnpainted.slice(0, 3).map((x) => x.gridCode + '：' + x.reason).join('；') }}）——
        改造项目数据本身已到，是网格边界待接入。
      </span>
    </div>

    <!--
      停水停气图层开关（标书 1.2.6）
      标书要求「根据停水停气事件的划分也将图层划分为计划性停水、计划性停气、
      突发性停水、突发性停气图层」—— 四个**独立**开关，缺一不可。
      某类恰好没数据时按钮仍保留（如实显示 0），不隐藏 —— 隐藏会让人以为没做这一层。
    -->

    <!-- 数据来源标签已并入 .map2d__layerbar 状态行（显示为「快照（未落库）」/「业务主表」），此处不再重复 -->

    <!-- 联动高亮状态提示（标书：选中一个标识，同一事件的其它标识高亮） -->
    <div v-if="shutdownSelectedEvent" class="map2d__sdlinked">
      <b>联动高亮</b>
      <span>
        {{ shutdownSelectedEvent.categoryLabel }} · {{ shutdownSelectedEvent.enterpriseName ?? '企业未提供' }}
        —— 该事件涉及 {{ shutdownSelectedEvent.gridCodes.length }} 个网格，
        当前图层已高亮 {{ shutdownHighlightedCount }} 个标识
      </span>
    </div>

    <!-- 停水停气空态：没有可打点事件时如实说明，绝不造点 -->
    <div v-if="!shutdownLoading && shutdownData && !shutdownHasMarkers" class="map2d__sdempty">
      <b>暂无可打点事件</b>
      <span>{{ shutdownData.dataNote ?? '后端未返回停水停气事件数据。' }}</span>
      <span class="map2d__sdempty-sub">
        落图口径：事件按「涉及网格」关联后打点，无网格不臆造位置。
      </span>
    </div>

 <!-- 图例（标书 1.2.4 热力五色 + 1.2.6 停水停气四类 + 1.2.7 管线） -->
 <!--
   精简原则：同一信息只出现一次。
   原实现里「管线图层：暂无可着色网格」在图例和底部胶囊各出现一次（用户截图可见重复）；
   这里图例只保留**颜色含义**，状态性文案统一交给底部胶囊，避免重复刷屏。
 -->
 <div class="map2d__legend">
   <div v-if="heatLoading" class="map2d__legend-row map2d__legend-note" role="status">网格热力加载中…</div>
   <template v-else-if="heatOn">
     <div v-if="heat?.reason || !heat" class="map2d__legend-row map2d__legend-note" role="status">
       <span>网格热力：{{ heat?.reason ?? '查询结果不可用' }}</span>
     </div>
     <div v-if="heat?.state !== 'unavailable' && heat?.data.thresholds && heat?.data.grids.length" class="map2d__legend-row">
       <span class="map2d__legend-label">阈值</span>
       <span v-for="(color, index) in Object.values(HEAT_COLORS)" :key="color" class="map2d__legend-scale">
         <i :style="{ background: color }"></i>{{ heat.data.thresholds[index] }}
       </span>
     </div>
     <div v-if="heat?.state !== 'unavailable' && heat?.data.thresholds && heat?.data.grids.length" class="map2d__legend-row map2d__legend-note">
       {{ heat.data.days }} 天 × 系数 · {{ heat.data.ruleVersion }}
     </div>
   </template>
      <div v-if="streetOn" class="map2d__legend-row map2d__legend-note">
        <span>{{ streetLegendText }}</span>
      </div>
 <!-- 点位与网格 -->
 <div class="map2d__legend-row">
 <span><i class="dot exact"></i>小区点位</span>
 <span v-if="shutdownHasMarkers"><i class="dot" style="background: #ffe57a"></i>联动高亮</span>
 </div>
 <!-- 停水停气四类（标书 1.2.6 要求四类独立） -->
 <div class="map2d__legend-row">
 <span><i class="dot" style="background: #3498db"></i>计划停水</span>
 <span><i class="dot" style="background: #e67e22"></i>计划停气</span>
 <span><i class="dot" style="background: #c0392b"></i>突发停水</span>
 <span><i class="dot" style="background: #8e44ad"></i>突发停气</span>
 </div>
 <!-- 管线（标书 1.2.7）：只在确有可着色网格时才显示图例，否则不占地方、不重复提示 -->
 <div v-if="pipelineHasCells" class="map2d__legend-row">
 <span><i class="swatch is-gas"></i>燃气改造</span>
 <span><i class="swatch is-water"></i>供水改造</span>
 <span><i class="swatch is-invalid"></i>未批准</span>
 </div>
 </div>

    <!-- 操作按钮 -->
    <div class="map2d__actions">
      <button type="button" @click="resetCamera">复位</button>
      <button type="button" @click="flyToDistrict">定位选区</button>
    </div>
  </div>
</template>

<style scoped>
.map2d {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #06181a;
}

.map2d__canvas {
  position: absolute;
  inset: 0;
}

/* ol 自带的链接/边框去掉，融入大屏风格 */
.map2d__canvas :deep(.ol-viewport) {
  background: #06181a;
}
.map2d__canvas :deep(.ol-scale-line) {
  background: rgba(4, 22, 23, 0.55);
  border-radius: 2px;
  left: 50%;
  transform: translateX(-50%);
  bottom: 12px;
}
.map2d__canvas :deep(.ol-scale-line-inner) {
  border-color: rgba(134, 251, 231, 0.7);
  color: rgba(200, 255, 250, 0.9);
  font-size: 11px;
}

.map2d__hover {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 12px;
  border-radius: 3px;
  background: rgba(4, 34, 32, 0.82);
  border: 1px solid rgba(134, 251, 231, 0.35);
  color: #d8fffb;
  font-size: 12px;
  pointer-events: none;
  white-space: nowrap;
}
.map2d__hover b {
  color: #86fbe7;
}
.map2d__hover-tag {
  padding: 1px 5px;
  border-radius: 2px;
  background: rgba(134, 251, 231, 0.18);
  color: #86fbe7;
  font-size: 11px;
}
.map2d__hover-code {
  color: rgba(200, 255, 250, 0.5);
  font-size: 11px;
}
.map2d__hover-count {
  padding-left: 8px;
  border-left: 1px solid rgba(134, 251, 231, 0.25);
  color: #ffd67c;
  font-weight: 600;
}

.map2d__basemap {
  position: absolute;
  left: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 3px;
  background: rgba(4, 34, 32, 0.78);
  border: 1px solid rgba(134, 251, 231, 0.28);
  color: rgba(200, 255, 250, 0.9);
  font-size: 11.5px;
}
.map2d__basemap i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4be7a0;
  box-shadow: 0 0 6px #4be7a0;
}
.map2d__basemap.is-error {
  border-color: rgba(255, 138, 128, 0.6);
  color: #ffd7d2;
}
.map2d__basemap.is-error i {
  background: #ff6b5a;
  box-shadow: 0 0 6px #ff6b5a;
}
.map2d__basemap small {
  opacity: 0.7;
}
/* 悬停浮层里的社区名列表（标书 1.2.4）：街道网格含 30~60 个小区，需限宽换行 */
.map2d__hover-comm {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(83, 191, 173, 0.25);
  max-width: 340px;
  font-size: 10.5px;
  line-height: 1.5;
}
.map2d__hover-comm-label {
  flex: none;
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(83, 191, 173, 0.22);
  color: #9fe3d3;
  font-size: 10px;
}
.map2d__hover-comm-list {
  flex: 1 1 auto;
  min-width: 0;
  color: #c8e8e0;
  word-break: break-all;
}
.map2d__hover-comm-more {
  flex: none;
  color: #ffd98a;
}
.map2d__basemap.is-warn {
  border-color: rgba(255, 200, 100, 0.6);
  color: #ffe0a3;
}
.map2d__basemap.is-warn i {
  background: #ffb648;
  box-shadow: 0 0 6px #ffb648;
}

/* 高德兜底时的坐标偏差横幅：顶部居中，醒目但不挡操作 */
.map2d__coordwarn {
  position: absolute;
  top: 46px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 720px;
  padding: 7px 14px;
  border-radius: 3px;
  background: rgba(58, 36, 6, 0.9);
  border: 1px solid rgba(255, 182, 72, 0.55);
  color: #ffe0a3;
  font-size: 11.5px;
  line-height: 1.5;
  z-index: 30;
  pointer-events: none;
}
.map2d__coordwarn b {
  flex: none;
  padding: 0 6px;
  border-radius: 2px;
  background: #ffb648;
  color: #2a1800;
  font-size: 11px;
}

.map2d__legend {
  position: absolute;
  /*
   * 贴到**地图区最左边**（即左栏卡片右缘之外的第一处空白）。
   *
   * 历史问题：
   *   · right:14px 时压在右栏「高频诉求小区」卡片上，文字叠在小区名上没法读；
   *   · 改成 left: calc(23.4% + 12px) 后又离左边太远 —— 左栏卡片实际右缘在 23.4% 处，
   *     但 +12px 是相对**整个屏幕宽度**算的，缩放后看着仍像悬在中间。
   *
   * 现在直接贴左栏右缘：left 与左栏卡片的 right 对齐（同一套 23.4% 基准），
   * 只留 6px 呼吸位。这样无论窗口多大、缩放多少，图例都紧紧靠在地图区左侧。
   */
  right: auto;
  left: 23.4%;
  margin-left: 0.35%;
  bottom: 112px;
  min-width: 0;
  max-width: 260px;
  padding: 6px 9px;
  border-radius: 3px;
  background: rgba(4, 34, 32, 0.9);
  border: 1px solid rgba(134, 251, 231, 0.28);
  color: rgba(200, 255, 250, 0.88);
  font-size: 11px;
  line-height: 1.5;
  z-index: 20;
}
/* 每行一个语义分组：横向排布，省纵向空间 */
.map2d__legend-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 9px;
  padding: 2px 0;
  white-space: nowrap;
}
.map2d__legend-row + .map2d__legend-row {
  border-top: 1px solid rgba(134, 251, 231, 0.12);
}
.map2d__legend-label {
  color: #86fbe7;
  font-weight: 600;
}
.map2d__legend-scale {
  display: inline-flex;
  gap: 0;
}
.map2d__legend-scale i {
  display: inline-block;
  width: 15px;
  height: 9px;
  margin: 0;
  border-radius: 0;
}
.map2d__legend-scale i:first-child { border-radius: 2px 0 0 2px; }
.map2d__legend-scale i:last-child { border-radius: 0 2px 2px 0; }
.map2d__legend-note {
  opacity: 0.72;
  font-size: 10px;
  letter-spacing: 0.2px;
}
.map2d__legend-minmax {
  color: #7ea8a0;
  font-size: 10px;
}
.map2d__legend-title {
  margin-bottom: 5px;
  color: #86fbe7;
  font-weight: 600;
}
.map2d__legend ul {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.map2d__legend li {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.map2d__legend li i {
  display: block;
  width: 14px;
  height: 10px;
  border-radius: 1px;
}
.map2d__legend-note {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(134, 251, 231, 0.16);
}
.map2d__legend-note .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 50%;
  background: rgba(134, 251, 231, 0.92);
  vertical-align: middle;
}
.map2d__legend-note .warn {
  color: #ffd28a;
}

/* ---- 管线图层开关（标书 1.2.7）----
   定位要点（都按实测像素定的，别再往左挪）：
   · 父页面顶栏（日期/标题）盖在 y≈0~103px，开关必须落到它下面；
   · 左栏卡片占 x≈38~441px，开关放在 left:14px 会被卡片压住（点了没反应）；
   · 因此落在「左栏右侧、筛选条下方」的空白地图区（实测 x≈452, y≈130 起是空的）。*/
/* ============================================================ 图层控制条（合并版） */
/*
 * 把原来 4 个各自绝对定位的悬浮块合并成一条：
 *   上行 = 底图状态 + 简短摘要 + 数据来源 + 「详情」按钮
 *   下行 = 管线（燃气/供水）+ 停水停气（四类）开关
 * 目的是消除左上角"挤成一团"的观感：主次分明、行高统一、间距规整。
 */
.map2d__layerbar {
  position: absolute;
  left: 23.4%;
  top: 22%;
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
  max-width: min(760px, 54%);
  border-radius: 4px;
  background: rgba(4, 34, 32, 0.92);
  border: 1px solid rgba(134, 251, 231, 0.34);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.map2d__layerbar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid rgba(134, 251, 231, 0.16);
}
.map2d__layerbar-brief {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #b8ded6;
  font-size: 10.5px;
}
.map2d__layerbar-src {
  flex: none;
  padding: 0 5px;
  border-radius: 2px;
  background: rgba(134, 251, 231, 0.12);
  color: #9fe3d3;
  font-size: 10px;
  line-height: 15px;
}
.map2d__layerbar-src.is-snapshot {
  background: rgba(255, 214, 124, 0.14);
  color: #ffe0a3;
}
.map2d__layerbar-more {
  flex: none;
  padding: 1px 7px;
  border-radius: 2px;
  border: 1px solid rgba(134, 251, 231, 0.4);
  background: transparent;
  color: #86fbe7;
  font-family: inherit;
  font-size: 10px;
  line-height: 15px;
  cursor: pointer;
}
.map2d__layerbar-more:hover {
  background: rgba(134, 251, 231, 0.16);
}
.map2d__layerbar-detail {
  padding: 4px 8px;
  border-bottom: 1px solid rgba(134, 251, 231, 0.16);
  color: #8ab9b0;
  font-size: 10px;
  line-height: 1.6;
  max-height: 4.8em;
  overflow-y: auto;
}
.map2d__layerbar-switches {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 5px;
  padding: 5px 8px;
}
.map2d__layerbar-label {
  flex: none;
  color: #7ea8a0;
  font-size: 10px;
  margin-right: 1px;
}
.map2d__layerbar-sep,
.map2d__layerbar-vsep {
  flex: none;
  background: rgba(134, 251, 231, 0.2);
}
.map2d__layerbar-sep {
  width: 1px;
  height: 12px;
}
.map2d__layerbar-vsep {
  width: 1px;
  height: 14px;
  margin: 0 2px;
}
/* 底图状态胶囊在控制条内改为内联，不再绝对定位 */
.map2d__layerbar-status .map2d__basemap {
  position: static;
  flex: none;
  padding: 1px 6px;
  font-size: 10.5px;
  line-height: 16px;
  cursor: pointer;
  font-family: inherit;
}
.map2d__pipeline {
  position: absolute;
  left: 23.4%;
  /* 与筛选条（top:13.6%，会折两行）上下错开，避免盖住「查询/重置」——历史坑 */
  top: 22%;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px;
  border-radius: 3px;
  background: rgba(4, 34, 32, 0.88);
  border: 1px solid rgba(134, 251, 231, 0.34);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
}
.map2d__pipeline-title {
  margin-right: 2px;
  color: #86fbe7;
  font-size: 11.5px;
  font-weight: 600;
}
.map2d__pipebtn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 2px;
  border: 1px solid rgba(134, 251, 231, 0.3);
  background: rgba(6, 30, 29, 0.9);
  color: rgba(200, 255, 250, 0.55);
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
}
.map2d__pipebtn.is-on {
  color: #eafffa;
  border-color: rgba(134, 251, 231, 0.75);
  background: rgba(13, 58, 53, 0.95);
}
.map2d__pipebtn em {
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(134, 251, 231, 0.18);
  color: #86fbe7;
  font-size: 10.5px;
  font-style: normal;
}
.map2d__pipedot {
  width: 8px;
  height: 8px;
  border-radius: 1px;
}
.map2d__pipedot.is-gas,
.swatch.is-gas {
  background: rgba(230, 126, 34, 0.85);
}
.map2d__pipedot.is-water,
.swatch.is-water {
  background: rgba(52, 152, 219, 0.85);
}
/* 业务数据图层小圆点（区县 / 网格 / 小区点位 / 小区热力） */
.map2d__pipedot.is-district {
  background: rgba(230, 126, 34, 0.85);
}
.map2d__pipedot.is-street {
  background: rgba(241, 196, 15, 0.85);
}
.map2d__pipedot.is-point {
  background: rgba(134, 251, 231, 0.85);
  border-radius: 50%;
}
.map2d__pipedot.is-heat {
  background: linear-gradient(90deg, rgba(46, 204, 113, 0.9), rgba(231, 76, 60, 0.9));
  border-radius: 50%;
}
/* 叠加对照：空心方框 —— 一眼区分「显示态开关」而非某一层数据 */
.map2d__pipedot.is-compare {
  background: transparent;
  border: 1.5px solid #b6fff1;
  box-sizing: border-box;
}
.map2d__comparebtn.is-on {
  border-color: rgba(182, 255, 241, 0.75);
  background: rgba(134, 251, 231, 0.12);
}
.map2d__pipebtn:not(.is-on) .map2d__pipedot {
  opacity: 0.28;
}
.map2d__pipereload {
  padding: 3px 7px;
  border-radius: 2px;
  border: 1px solid rgba(134, 251, 231, 0.22);
  background: transparent;
  color: rgba(200, 255, 250, 0.65);
  font-size: 10.5px;
  font-family: inherit;
  cursor: pointer;
}
.map2d__pipereload:hover {
  border-color: #86fbe7;
  color: #86fbe7;
}

/* 管线图层空态：如实说明「没数据」而不是画个假色块 */
/*
 * 管线空态块。
 *
 * 历史问题：固定 left/top 50% 居中 + pointer-events:none + 无关闭入口
 * → 永久悬浮在地图正中，既挡视线又挡点击，是「地图没有任何效果」的主要来源。
 *
 * 现在两种形态：
 *   · 收起（默认）：缩成右下角一个小角标，不挡地图，可点击展开
 *   · 展开：原位显示完整说明，带关闭按钮，关闭后本会话不再弹
 */
.map2d__pipeempty {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 12px;
  border-radius: 3px;
  background: rgba(4, 34, 32, 0.92);
  border: 1px dashed rgba(255, 214, 124, 0.55);
  color: #ffe0a3;
  font-size: 11px;
  line-height: 1.55;
  z-index: 26;
}

/* 收起态：右下角小角标（避开左右面板与底部按钮条） */
.map2d__pipeempty.is-collapsed {
  left: calc(23.4% + 12px);
  right: auto;
  bottom: 78px;
  max-width: 260px;
  opacity: 0.8;
  padding: 0;
  background: transparent;
  border: none;
  pointer-events: auto;
}
.map2d__pipeempty-pill {
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px dashed rgba(255, 214, 124, 0.5);
  background: rgba(4, 34, 32, 0.88);
  color: #ffe0a3;
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
}
.map2d__pipeempty-pill:hover {
  border-color: rgba(255, 214, 124, 0.85);
  color: #ffd67c;
}

/* 展开态：居中但**可交互、可关闭** */
.map2d__pipeempty:not(.is-collapsed) {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  max-width: 520px;
  pointer-events: auto;
}
.map2d__pipeempty-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.map2d__pipeempty-close,
.map2d__pipeempty-collapse {
  border: 1px solid rgba(255, 214, 124, 0.5);
  background: transparent;
  color: #ffd67c;
  border-radius: 2px;
  font-size: 11px;
  line-height: 1;
  padding: 2px 7px;
  cursor: pointer;
}
.map2d__pipeempty-close:hover,
.map2d__pipeempty-collapse:hover {
  background: rgba(255, 214, 124, 0.16);
}
.map2d__pipeempty-collapse {
  align-self: flex-end;
  margin-top: 2px;
}
.map2d__pipeempty b {
  color: #ffd67c;
  font-size: 12px;
}

/* 有数据但网格面缺失：位置与空态一致，用告警色区分 */
.map2d__pipewarn {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 560px;
  padding: 10px 16px;
  border-radius: 3px;
  background: rgba(58, 36, 6, 0.92);
  border: 1px dashed rgba(255, 182, 72, 0.6);
  color: #ffe0a3;
  font-size: 11px;
  line-height: 1.55;
  pointer-events: none;
  z-index: 25;
}
.map2d__pipewarn b {
  color: #ffb648;
  font-size: 12px;
}
.map2d__pipeempty-sub {
  color: rgba(255, 224, 163, 0.72);
  font-size: 10.5px;
}

.map2d__hover-tag.is-gas {
  background: rgba(230, 126, 34, 0.26);
  color: #ffc58a;
}
.map2d__hover-tag.is-water {
  background: rgba(52, 152, 219, 0.26);
  color: #9ed3f7;
}
.swatch {
  display: inline-block;
  width: 14px;
  height: 10px;
  margin-right: 5px;
  border-radius: 1px;
  vertical-align: middle;
}
.swatch.is-invalid {
  background: rgba(160, 160, 160, 0.18);
  border: 1px dashed rgba(200, 200, 200, 0.8);
}

.map2d__actions {
  position: absolute;
  right: 14px;
  top: 14px;
  display: flex;
  gap: 6px;
}
.map2d__actions button {
  padding: 4px 10px;
  border-radius: 3px;
  border: 1px solid rgba(134, 251, 231, 0.35);
  background: rgba(4, 34, 32, 0.78);
  color: rgba(200, 255, 250, 0.9);
  font-size: 11.5px;
  cursor: pointer;
}
.map2d__actions button:hover {
  border-color: #86fbe7;
  color: #86fbe7;
}

/* ---- 停水停气图层开关（标书 1.2.6）----
   位置：管线图层开关在 left:452px / top:130px，停水停气开关紧贴其下一行（top:172px），
   同在「左栏右侧、筛选条下方」的空白地图区，不遮挡左栏卡片与顶栏。 */
.map2d__shutdown {
  position: absolute;
  /*
   * 位置约束：必须落在筛选条（.accept-filters，top:13.6% ≈ 147px、left:23.4% ≈ 449px、
   * 高约 60px，且 flex-wrap 可能折成两行）的**下方**。
   *
   * 原来写死 left:452px; top:172px —— 正好压在筛选条第二行上，把「查询 / 重置」按钮
   * 盖住了（实测 Playwright 点不到「查询」，提示 map2d__sdb 拦截点击）。
   * 现在用百分比定位并留足余量：top 22% ≈ 238px，低于筛选条两行后的底部。
   */
  left: 23.4%;
  top: calc(22% + 38px);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px;
  border-radius: 3px;
  background: rgba(4, 34, 32, 0.88);
  border: 1px solid rgba(134, 251, 231, 0.34);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
}
.map2d__shutdown-title {
  margin-right: 2px;
  color: #86fbe7;
  font-size: 11.5px;
  font-weight: 600;
}
.map2d__sddot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.55);
}
.map2d__sdreload {
  padding: 3px 7px;
  border-radius: 2px;
  border: 1px solid rgba(134, 251, 231, 0.22);
  background: transparent;
  color: rgba(200, 255, 250, 0.65);
  font-size: 10.5px;
  font-family: inherit;
  cursor: pointer;
}
.map2d__sdreload:hover {
  border-color: #86fbe7;
  color: #86fbe7;
}

/* 数据来源标签：快照直读时用琥珀色提醒「不是正式台账」 */
.map2d__sdsrc {
  position: absolute;
  left: 23.4%;
  /* 排在 pipeline / shutdown 两块之后 */
  top: calc(22% + 112px);
  padding: 3px 8px;
  border-radius: 2px;
  background: rgba(4, 34, 32, 0.82);
  border: 1px solid rgba(134, 251, 231, 0.22);
  color: rgba(200, 255, 250, 0.72);
  font-size: 10px;
}
.map2d__sdsrc.is-snapshot {
  border-color: rgba(255, 214, 124, 0.5);
  color: #ffd28a;
}

/* 联动高亮提示条 */
.map2d__sdlinked {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 3px;
  background: rgba(58, 48, 6, 0.92);
  border: 1px solid rgba(255, 229, 122, 0.6);
  color: #ffeab0;
  font-size: 11.5px;
  pointer-events: none;
}
.map2d__sdlinked b {
  color: #ffe57a;
  font-weight: 600;
}

/* 停水停气空态 */
.map2d__sdempty {
  position: absolute;
  left: 50%;
  top: 58%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 560px;
  padding: 10px 16px;
  border-radius: 3px;
  background: rgba(4, 34, 32, 0.9);
  border: 1px dashed rgba(255, 214, 124, 0.55);
  color: #ffe0a3;
  font-size: 11px;
  line-height: 1.55;
  pointer-events: none;
  z-index: 25;
}
.map2d__sdempty b {
  color: #ffd67c;
  font-size: 12px;
}
.map2d__sdempty-sub {
  color: rgba(255, 224, 163, 0.72);
  font-size: 10.5px;
}
.map2d__hover-tag.is-sd {
  border: 1px solid rgba(255, 255, 255, 0.5);
  color: #fff;
}
</style>
