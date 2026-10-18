<script setup lang="ts">
import { attributeKeys, type GameResponse, type RulesVersion } from '@f1/shared'
import { computed } from 'vue'
import AttributeCell from './AttributeCell.vue'
import { driverName, englishName } from '../../services/display'
const props = defineProps<{
  guess: GameResponse['guesses'][number]
  constructors: Record<string, string>
  rulesVersion?: RulesVersion | undefined
  animate: boolean
  gameId?: string | undefined
}>()
const columns = computed(() => attributeKeys(props.rulesVersion ?? 'v1'))
</script>
<template>
  <tr class="guess-row" :class="{ 'winning-row': guess.isCorrect }">
    <th scope="row" class="driver-column">
      <span class="attempt-index">{{ String(guess.attemptNumber).padStart(2, '0') }}</span
      ><span class="driver-name" :title="englishName(guess.driver)"
        ><span class="driver-primary">{{ driverName(guess.driver) }}</span
        ><small v-if="driverName(guess.driver) !== englishName(guess.driver)">{{
          englishName(guess.driver)
        }}</small></span
      >
    </th>
    <AttributeCell
      v-for="(key, position) in columns"
      :key="key"
      :result="guess.attributes[key]!"
      :kind="key"
      :constructors="constructors"
      :position="position"
      :animate="animate"
      :game-id="gameId"
      :driver-id="guess.driver.id"
      :rules-version="rulesVersion"
    />
  </tr>
</template>
