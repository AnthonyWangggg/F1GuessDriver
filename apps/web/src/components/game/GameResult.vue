<script setup lang="ts">
import { isPlaying, type GameResponse } from '@f1/shared'
import { driverName, englishName, modeLabels } from '../../services/display'
defineProps<{ game: GameResponse; busy: boolean; contextLabel?: string }>()
defineEmits<{ restart: [] }>()
</script>
<template>
  <section
    v-if="!isPlaying(game.status) && game.answer"
    class="result-panel"
    :class="game.status"
    role="status"
    aria-labelledby="result-title"
  >
    <div class="result-info">
      <div class="result-emblem" aria-hidden="true">
        {{ game.status === 'won' ? '✓' : game.status === 'revealed' ? 'i' : '⚑' }}
      </div>
      <div class="result-copy">
        <p class="eyebrow">
          {{
            game.status === 'won'
              ? 'CHEQUERED FLAG / 胜利'
              : game.status === 'revealed'
                ? 'ANSWER REVEALED / 已揭晓'
                : 'RACE COMPLETE / 本局结束'
          }}
        </p>
        <h2 id="result-title" tabindex="-1">
          {{
            game.status === 'won'
              ? '漂亮，猜中了！'
              : game.status === 'revealed'
                ? '本局已结束'
                : '这一次，答案是…'
          }}
        </h2>
        <p v-if="game.status === 'revealed'" class="revealed-reason">你选择查看答案</p>
        <h3>
          <span v-if="game.status === 'revealed'" class="answer-label">正确车手：</span
          >{{ driverName(game.answer) }}
        </h3>
        <p>
          <template v-if="driverName(game.answer) !== englishName(game.answer)"
            >{{ englishName(game.answer) }} · </template
          >{{ contextLabel ?? modeLabels[game.difficulty].name }} · 使用 {{ game.attemptsUsed }} /
          {{ game.maxAttempts }} 次猜测
        </p>
      </div>
    </div>
    <slot name="actions"
      ><button class="button primary" :disabled="busy" @click="$emit('restart')">
        {{ busy ? '正在发车…' : '再玩一局' }} →
      </button></slot
    >
  </section>
</template>
