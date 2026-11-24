<script setup lang="ts">
import book from '../../assets/lucide/book-open.svg'
import calendar from '../../assets/lucide/calendar-days.svg'
import zap from '../../assets/lucide/zap.svg'
import users from '../../assets/lucide/users-round.svg'
import trophy from '../../assets/lucide/trophy.svg'
import RaceDialog from './RaceDialog.vue'
defineProps<{ open: boolean }>()
defineEmits<{ dismiss: [] }>()
</script>
<template>
  <RaceDialog :open="open" title="玩法说明" @dismiss="$emit('dismiss')">
    <div class="rules-grid">
      <section class="rules-section">
        <h3>
          <span class="rules-icon"><img :src="book" alt="" width="24" height="24" /></span>公共规则
        </h3>
        <p>
          输入中文或英文姓名，选择车手后提交。每局最多猜
          <strong>8 次</strong>，猜中同一位车手即获胜。
        </p>
        <p>
          <span class="rules-feedback"
            ><i class="swatch correct" aria-hidden="true" />绿色表示匹配</span
          >，<span class="rules-feedback"
            ><i class="swatch partial" aria-hidden="true" />黄色表示部分匹配</span
          >，<span class="rules-feedback"
            ><i class="swatch wrong" aria-hidden="true" />灰色表示不匹配</span
          >。↑ 表示答案数值更大，↓ 表示更小。国籍、生涯车队和数字属性共同帮助你缩小范围。
        </p>
        <p>
          新手、普通、历史困难提供不同的答案范围，均可搜索历史车手。刷新页面可恢复当前浏览器身份的游戏。
        </p>
      </section>
      <section class="rules-section">
        <h3>
          <span class="rules-icon"><img :src="calendar" alt="" width="24" height="24" /></span
          >每日挑战
        </h3>
        <p>
          每天按北京时间提供<strong>三个难度</strong>的独立题目，<strong>每个难度只能参与一次</strong>。题目在<strong>次日结束时截止</strong>，<strong>截止时刻起不再接受猜测</strong>。猜中各得
          <strong>1 分</strong>，积分归题目日期；未猜中或过期不加分。
        </p>
      </section>
      <section class="rules-section">
        <h3>
          <span class="rules-icon"><img :src="zap" alt="" width="24" height="24" /></span>快速游戏
        </h3>
        <p>
          随时练习，<strong>不计积分</strong>。未结束的游戏可以继续；新开游戏前需确认结束旧局。「查看答案」需要再次确认，<strong>确认后立即结束本局，无法继续猜测</strong>。
        </p>
      </section>
      <section class="rules-section">
        <h3>
          <span class="rules-icon"><img :src="users" alt="" width="24" height="24" /></span>BO3
          随机匹配
        </h3>
        <p>
          与相同难度的玩家对战，匹配最多等待 <strong>120 秒</strong>，可以取消等待。每局
          <strong>8 次机会</strong>、<strong>限时 8 分钟</strong
          >，先猜中者获胜；<strong>投降本局判负</strong>。率先赢下<strong>两局</strong>者赢得整场比赛。
        </p>
        <p>
          双方都未猜中时不加比分，换题继续。最多进行<strong>六道普通题</strong>，此时有领先者则结束；若仍同分，再进行<strong>一道决胜题</strong>。决胜题依次比较最佳猜测的匹配程度、达到该程度的先后和全部猜测的匹配总分；仍相同则按赛前确定的公平规则决定胜方。
        </p>
        <p>
          断线有
          <strong>45 秒宽限</strong
          >，超时由服务器判定。普通小局揭晓后会自动进入下一局，整场结果可手动关闭并再次查看。
        </p>
      </section>
      <section class="rules-section">
        <h3>
          <span class="rules-icon"><img :src="trophy" alt="" width="24" height="24" /></span
          >积分机制
        </h3>
        <p>
          BO3 整场获胜 <strong>+3</strong>，落败 <strong>−1</strong>，总积分最低为
          <strong>0</strong
          >；双方整场均未产生有效参与记录时<strong>不计积分</strong>。每日挑战各难度猜中
          <strong>+1</strong
          >，快速游戏<strong>不计积分</strong>。游客也能游玩并查看自己的积分与历史，注册可保留当前游客记录。
        </p>
      </section>
    </div>
  </RaceDialog>
</template>
<style scoped>
.rules-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.rules-section {
  padding: 20px;
  border: 2px solid var(--edge);
  border-radius: 12px;
  background: var(--surface-blue, #eef5fc);
  box-shadow: 2px 2px 0 var(--shadow-color);
}
.rules-section:first-child,
.rules-section:nth-child(4),
.rules-section:last-child {
  grid-column: 1 / -1;
}
.rules-section:first-child {
  background: var(--surface, #fff);
}
.rules-section:nth-child(2) {
  background: var(--surface-blue);
}
.rules-section:nth-child(3) {
  background: var(--surface-gold);
}
.rules-section:nth-child(4) {
  background: var(--surface-red);
}
.rules-section:last-child {
  background: var(--rules-score-surface);
}
.rules-feedback {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.rules-feedback .swatch {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border: 1px solid var(--edge);
}
.rules-section strong {
  color: var(--ink);
  font-weight: 800;
}
.rules-section h3 {
  display: flex;
  gap: 12px;
  align-items: center;
  margin: 0 0 14px;
  font-size: 17px;
  line-height: 1.4;
}
.rules-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  background: var(--surface);
  border: 2px solid var(--edge);
  border-radius: 9px;
}
.rules-icon img {
  filter: var(--icon-filter);
}
.rules-section p {
  font-size: 14px;
  line-height: 1.85;
}
.rules-section p + p {
  margin-top: 12px;
}
@media (max-width: 600px) {
  .rules-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  .rules-section {
    padding: 16px;
  }
}
</style>
