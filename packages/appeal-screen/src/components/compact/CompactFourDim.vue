<script setup lang="ts">
/**
 * 集成式大屏 · 左栏「供气/供水四维摘要」精简版
 * 类型 Top5 / 六区分布 / 企业万户占比（缺户数时显示「不可计算：缺户数」，不画 0）。
 * 点击任意条目：地图定位高亮 + 同条件下钻明细。
 */
import { computed } from 'vue';
import PanelShell from '@/stats/components/PanelShell.vue';
import { UNCOMPUTABLE_TEXT, type CommunityRow, type DistrictStat, type DrillQuery, type EnterpriseRatio, type IndustryFilter, type PanelState, type PeriodMeta, type SupplyData, type TypeStat } from '@/stats/types';

const props = defineProps<{
  supply: PanelState<SupplyData>;
  industry: IndustryFilter;
  periodMeta: PeriodMeta;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'drill', q: DrillQuery): void;
}>();

const data = computed(() => props.supply.data);
const industryLabel = computed(() => (props.industry === 'ALL' ? '供水+供气' : props.industry === 'WATER' ? '供水' : '供气'));
const topTypes = computed<TypeStat[]>(() => (data.value?.typeStats ?? []).slice(0, 5));
const maxType = computed(() => Math.max(1, ...topTypes.value.map((t) => t.count)));
const topCommunity = computed<CommunityRow | null>(() => data.value?.communityTop.items[0] ?? null);

const drill = (partial: Partial<DrillQuery> & { title: string; source: string }) => {
  emit('drill', {
    period: props.periodMeta.key,
    industry: props.industry,
    ...partial,
  } as DrillQuery);
};

const drillType = (t: TypeStat) => drill({ source: '集成屏 · 四维 · 类型', title: `${t.name} · 类型明细`, typeId: t.typeId });
const drillDistrict = (d: DistrictStat) => drill({ source: '集成屏 · 四维 · 区域', title: `${d.name} · 区域明细`, districtCode: d.districtCode });
const drillCommunity = (row: CommunityRow) =>
  drill({ source: '集成屏 · 四维 · 高频小区', title: `${row.communityName} · 小区明细`, communityName: row.communityName });
const drillEnterprise = (e: EnterpriseRatio) =>
  drill({ source: '集成屏 · 四维 · 企业万户', title: `${e.name} · 企业明细`, enterpriseId: e.enterpriseId });
</script>

<template>
  <PanelShell
    title="供气 / 供水四维摘要"
    :caption="`${industryLabel} · ${periodMeta.range} · 点击联动地图`"
    :state="supply"
    empty-text="当前筛选无四维数据"
    @retry="emit('retry')"
  >
    <template #extra>
      <span class="st-chip">类型/区域/企业</span>
    </template>

    <div v-if="data" class="cf">
      <div class="cf__block">
        <div class="cf__block-title">诉求类型 Top5</div>
        <button v-for="t in topTypes" :key="t.typeId" type="button" class="cf__row" @click="drillType(t)">
          <span class="cf__name">{{ t.name }}</span>
          <span class="cf__bar"><i :style="{ width: `${(t.count / maxType) * 100}%` }"></i></span>
          <span class="cf__count">{{ t.count }}</span>
        </button>
        <div v-if="!topTypes.length" class="cf__empty">暂无类型数据（空态）</div>
      </div>

      <div class="cf__block">
        <div class="cf__block-title">六区分布（未定位 {{ data.district.unlocated }} 件单列）</div>
        <button
          v-for="d in data.district.items"
          :key="d.districtCode"
          type="button"
          class="cf__row"
          :class="{ 'is-zero': d.count === 0 }"
          @click="drillDistrict(d)"
        >
          <span class="cf__name">{{ d.name }}</span>
          <span class="cf__bar cf__bar--district"><i :style="{ width: `${d.share}%` }"></i></span>
          <span class="cf__count">{{ d.count }}</span>
        </button>
      </div>

      <div class="cf__block cf__block--wide">
        <div class="cf__block-title">企业万户诉求占比（分母日期 {{ data.denominatorDate }}）</div>
        <div class="cf__ents">
          <button
            v-for="e in data.enterpriseRatio"
            :key="e.enterpriseId"
            type="button"
            class="cf__ent"
            @click="drillEnterprise(e)"
          >
            <span class="cf__ent-name">{{ e.name }}</span>
            <span v-if="e.ratio.value !== null" class="cf__ent-ratio">{{ e.ratio.value.toFixed(2) }} <i>件/万户</i></span>
            <span v-else class="st-uncomputable" :title="`不可计算：${UNCOMPUTABLE_TEXT[e.ratio.reason]}`">
              不可计算：{{ UNCOMPUTABLE_TEXT[e.ratio.reason] }}
            </span>
            <span class="cf__ent-demand">诉求 {{ e.demandCount }} 件</span>
          </button>
        </div>
      </div>

      <button v-if="topCommunity" type="button" class="cf__top1" @click="drillCommunity(topCommunity)">
        高频小区 Top1：<b>{{ topCommunity.communityName }}</b> · {{ topCommunity.gridName }} · {{ topCommunity.count }} 件
        <i>点击下钻 →</i>
      </button>
    </div>
  </PanelShell>
</template>

<style scoped>
.cf {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr auto auto;
  gap: 8px;
  height: 100%;
  min-height: 0;
  overflow: auto;
}
.cf__block {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 6px;
  background: rgba(8, 28, 46, 0.45);
  border: 1px solid rgba(53, 224, 255, 0.12);
}
.cf__block--wide {
  grid-column: 1 / -1;
}
.cf__block-title {
  font-size: 11px;
  color: var(--st-muted);
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cf__row {
  display: grid;
  grid-template-columns: 56px 1fr 32px;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 1px 0;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--st-text);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
}
.cf__row:hover {
  color: #fff;
  background: rgba(53, 224, 255, 0.08);
}
.cf__name {
  color: var(--st-sub);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cf__bar {
  height: 7px;
  background: rgba(53, 224, 255, 0.08);
}
.cf__bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, rgba(53, 224, 255, 0.35), #35e0ff);
}
.cf__bar--district i {
  background: linear-gradient(90deg, rgba(166, 139, 255, 0.35), #a68bff);
}
.cf__count {
  text-align: right;
  color: #9ff2ff;
  font-variant-numeric: tabular-nums;
}
.cf__row.is-zero .cf__count {
  color: var(--st-muted);
}
.cf__empty {
  font-size: 11px;
  color: var(--st-muted);
}
.cf__ents {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cf__ent {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 2px 4px;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--st-text);
  background: rgba(12, 40, 64, 0.5);
  border: 1px solid rgba(52, 152, 219, 0.18);
  cursor: pointer;
  text-align: left;
}
.cf__ent:hover {
  border-color: rgba(53, 224, 255, 0.5);
}
.cf__ent-name {
  color: #eaf8ff;
  min-width: 62px;
}
.cf__ent-ratio {
  color: #9ff2ff;
  font-variant-numeric: tabular-nums;
}
.cf__ent-ratio i {
  font-style: normal;
  font-size: 10px;
  color: var(--st-muted);
}
.cf__ent-demand {
  margin-left: auto;
  color: var(--st-muted);
  font-size: 10.5px;
}
.cf__top1 {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--st-sub);
  background: rgba(53, 224, 255, 0.06);
  border: 1px dashed rgba(53, 224, 255, 0.25);
  cursor: pointer;
  text-align: left;
}
.cf__top1 b {
  color: #eaf8ff;
}
.cf__top1 i {
  margin-left: auto;
  font-style: normal;
  color: var(--st-cyan);
}
.cf__top1:hover {
  border-color: var(--st-cyan);
}
</style>
