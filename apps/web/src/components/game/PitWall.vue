<script setup lang="ts">
import { V3_NUMERIC_THRESHOLDS, type RulesVersion } from '@f1/shared'
withDefaults(defineProps<{ rulesVersion?: RulesVersion | undefined; statsAsOf: string }>(), {
  rulesVersion: 'v1',
})
</script>
<template>
  <aside class="game-note" aria-label="本局判定规则">
    <span class="eyebrow">PIT WALL / 小提示</span>
    <div class="pit-summary">
      <p>
        绿色：属性匹配<span v-if="rulesVersion === 'v3'">。生涯车队项为双方最后效力车队相同</span
        ><span v-else>；生涯车队项为生涯有共同车队</span>。
      </p>
      <p v-if="rulesVersion === 'v3'">
        黄色：属性接近。国籍项为同大洲；生涯车队项为最后车队不同但生涯有相同车队；数字差值在部分匹配范围内。
      </p>
      <p v-else-if="rulesVersion === 'v1'">黄色：参赛年代有交集，但集合不完全相同。</p>
      <p>灰色：不匹配{{ rulesVersion === 'v3' ? '或差距较大' : '' }}。</p>
      <p>↑：隐藏答案数值更大。</p>
      <p>↓：隐藏答案数值更小。</p>
      <p>?：数据未知。</p>
      <p>
        {{
          rulesVersion === 'v3'
            ? '点击车队数量，查看按赛事记录排列的生涯效力经历。'
            : '点击车队数量查看生涯集合；此版本未提供认证的有序时间线。'
        }}
      </p>
    </div>
    <details class="full-rules">
      <summary>查看完整判定规则</summary>
      <ul v-if="rulesVersion === 'v3'">
        <li>国籍：代码相同为绿色；代码不同但同审核大洲为黄色；不同大洲为灰色。</li>
        <li>首次起步：相等为绿色；相差 {{ V3_NUMERIC_THRESHOLDS.debutYear }} 年以内为黄色。</li>
        <li>车队：最后车队相同为绿色；最后不同但生涯有交集为黄色；无交集为灰色。</li>
        <li>世界冠军：相等为绿色；相差 {{ V3_NUMERIC_THRESHOLDS.championships }} 次以内为黄色。</li>
        <li>分站冠军：相等为绿色；相差 {{ V3_NUMERIC_THRESHOLDS.wins }} 次以内为黄色。</li>
        <li>领奖台：相等为绿色；相差 {{ V3_NUMERIC_THRESHOLDS.podiums }} 次以内为黄色。</li>
        <li>正式起步：相等为绿色；相差 {{ V3_NUMERIC_THRESHOLDS.raceStarts }} 次以内为黄色。</li>
        <li>杆位次数：相等为绿色；相差 {{ V3_NUMERIC_THRESHOLDS.polePositions }} 次以内为黄色。</li>
      </ul>
      <ul v-else>
        <li>国籍：代码相同为绿色，否则灰色。</li>
        <li>首次起步：年份相等为绿色，否则灰色。</li>
        <li>车队：生涯车队集合有交集为绿色，无交集为灰色。</li>
        <li>世界冠军：次数相等为绿色，否则灰色。</li>
        <li>分站冠军：次数相等为绿色，否则灰色。</li>
        <li>领奖台：次数相等为绿色，否则灰色。</li>
        <li>正式起步：次数相等为绿色，否则灰色。</li>
        <li v-if="rulesVersion === 'v1'">
          参赛年代：集合相同为绿色；有交集但不相同为黄色；无交集为灰色。
        </li>
        <li v-else>杆位次数：次数相等为绿色，否则灰色。</li>
      </ul>
      <p>
        数字不相等时箭头始终指向答案的高低方向；缺失数据为未知，不视为 0。胜利只按车手唯一 ID 判断。
      </p>
    </details>
    <span class="dataset-note">数据截止 {{ statsAsOf }} · 本局数据版本固定</span>
  </aside>
</template>
