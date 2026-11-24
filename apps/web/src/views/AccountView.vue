<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import { identitySession, loadIdentity, identityAction } from '../services/identity'
const route = useRoute()
const mode = ref<'login' | 'register' | 'reset' | 'legacy'>(
    route.query.mode === 'register' ? 'register' : 'login',
  ),
  username = ref(''),
  email = ref(''),
  renameName = ref(''),
  addEmail = ref(''),
  emailPassword = ref(''),
  rotationPassword = ref(''),
  nextPassword = ref(''),
  nextConfirmation = ref(''),
  password = ref(''),
  confirmation = ref(''),
  currentPassword = ref(''),
  recovery = ref(''),
  shownCode = ref(''),
  error = ref(''),
  notice = ref(''),
  ready = ref(false),
  busy = ref(false)
const accountModes = ['login', 'register', 'reset', 'legacy'] as const
function selectMode(value: (typeof accountModes)[number]) {
  mode.value = value
  error.value = ''
  password.value = ''
  confirmation.value = ''
  recovery.value = ''
  shownCode.value = ''
}
const account = computed(() => identitySession.value?.account)
onMounted(async () => {
  if (location.hash) history.replaceState(null, '', location.pathname)
  await refresh()
})
async function refresh() {
  try {
    await loadIdentity()
    ready.value = true
  } catch {
    error.value = '无法恢复登录状态，请重试。'
  }
}
async function action(path: string, fields: Record<string, unknown> = {}, method = 'POST') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  shownCode.value = ''
  try {
    const result = await identityAction(
      path,
      { ...fields, idempotencyKey: crypto.randomUUID() },
      method,
    )
    if ('recoveryCode' in result && typeof result.recoveryCode === 'string')
      shownCode.value = result.recoveryCode
    password.value = ''
    confirmation.value = ''
    if (path === '/me/password') {
      currentPassword.value = ''
      nextPassword.value = ''
      nextConfirmation.value = ''
    } else if (path === '/account/email') {
      addEmail.value = ''
      emailPassword.value = ''
    } else if (path === '/account/recovery/rotate') rotationPassword.value = ''
    else if (path === '/account/username') renameName.value = ''
    recovery.value = ''
    await loadIdentity()
    notice.value = '操作已完成。'
    if (path === '/auth/logout') {
      selectMode('login')
      username.value = ''
      email.value = ''
    }
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : '操作失败；若密码重置响应丢失，请先使用新密码登录。'
  } finally {
    busy.value = false
  }
}
function submit() {
  if (mode.value === 'login')
    return action('/account/login', { email: email.value, password: password.value })
  if (mode.value === 'legacy')
    return action('/account/login', { identifier: username.value, password: password.value })
  if (mode.value === 'register')
    return action('/account/register', {
      username: username.value,
      email: email.value,
      password: password.value,
      confirmPassword: confirmation.value,
    })
  return action('/account/reset', {
    username: username.value,
    recoveryCode: recovery.value,
    password: password.value,
    confirmPassword: confirmation.value,
  })
}
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell account-main">
    <p class="eyebrow">DRIVER GUESS / ACCOUNT</p>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <section v-if="shownCode" aria-label="备用恢复码" class="notice">
      <h2>请立即离线保存备用恢复码</h2>
      <p>仅此次显示。使用后失效并生成新码。丢失且无法登录时，无法绕过身份验证恢复账号。</p>
      <code style="overflow-wrap: anywhere">{{ shownCode }}</code
      ><button class="button secondary" @click="shownCode = ''">已保存，关闭显示</button>
    </section>
    <button v-if="!ready" class="button secondary" @click="refresh">重新读取账户状态</button>
    <p v-else-if="!identitySession?.enabled" class="notice">账号功能暂未开放。</p>
    <section v-else-if="account">
      <h1>账号管理</h1>
      <p>
        {{ account.username }}<span v-if="account.email"> · {{ account.email }}</span>
      </p>
      <form @submit.prevent="action('/account/username', { username: renameName }, 'PATCH')">
        <h2>修改用户名</h2>
        <label
          >新用户名（3–32 位字母、数字或下划线）
          <input v-model="renameName" required maxlength="32" autocomplete="off" />
        </label>
        <button class="button secondary" :disabled="busy">保存用户名</button>
      </form>
      <form
        v-if="!account.email"
        @submit.prevent="
          action('/account/email', { email: addEmail, currentPassword: emailPassword })
        "
      >
        <h2>补录登录邮箱</h2>
        <p>补录成功后使用邮箱和原密码登录。游戏记录和积分保留。</p>
        <label
          >邮箱地址<input
            v-model="addEmail"
            type="email"
            required
            maxlength="254"
            autocomplete="section-add-email email"
        /></label>
        <label
          >当前密码<input
            v-model="emailPassword"
            type="password"
            required
            autocomplete="section-add-email current-password"
        /></label>
        <button class="button secondary" :disabled="busy">保存登录邮箱</button>
      </form>
      <form
        @submit.prevent="
          action(
            '/me/password',
            { currentPassword, password: nextPassword, confirmPassword: nextConfirmation },
            'PATCH',
          )
        "
      >
        <h2>修改密码</h2>
        <label
          >当前密码<input
            v-model="currentPassword"
            type="password"
            required
            autocomplete="section-change current-password" /></label
        ><label
          >新密码<input
            v-model="nextPassword"
            type="password"
            required
            minlength="12"
            maxlength="128"
            autocomplete="section-change new-password" /></label
        ><label
          >确认密码<input
            v-model="nextConfirmation"
            type="password"
            required
            autocomplete="section-change new-password" /></label
        ><button class="button secondary" :disabled="busy">修改密码并撤销其他会话</button>
      </form>
      <form
        @submit.prevent="action('/account/recovery/rotate', { currentPassword: rotationPassword })"
      >
        <h2>账号安全 · 备用恢复码</h2>
        <p>
          当无法通过常规方式登录时，备用恢复码可能帮助你恢复账号。请妥善保管，不要分享给其他人。
        </p>
        <p>
          使用用户名及备用恢复码可以重置密码。恢复后旧码和旧会话失效。生成新码需要当前密码，并会立即替换旧码。
        </p>
        <p v-if="!account.loginName">请先保存一个可用于恢复的用户名。</p>
        <label
          >当前密码<input
            v-model="rotationPassword"
            type="password"
            required
            autocomplete="section-recovery current-password" /></label
        ><button class="button secondary" :disabled="busy || !account.loginName">
          生成新备用恢复码
        </button>
      </form>
      <button class="button secondary" :disabled="busy" @click="action('/me/revoke-sessions')">
        退出其他设备</button
      ><button class="button secondary" :disabled="busy" @click="action('/auth/logout')">
        退出登录
      </button>
    </section>
    <section v-else>
      <h1>
        {{
          mode === 'register'
            ? '注册账号'
            : mode === 'reset'
              ? '使用备用恢复码重置密码'
              : mode === 'legacy'
                ? '旧账号登录'
                : '登录'
        }}
      </h1>
      <nav class="account-tabs" aria-label="账号操作">
        <button v-for="m in accountModes" :key="m" class="button secondary" @click="selectMode(m)">
          {{
            m === 'login'
              ? '登录'
              : m === 'register'
                ? '注册'
                : m === 'legacy'
                  ? '未绑定邮箱'
                  : '恢复密码'
          }}
        </button>
      </nav>
      <p v-if="mode === 'register'">注册会保留当前游客的游戏记录和积分。请填写可长期使用的邮箱。</p>
      <p v-else-if="mode === 'legacy'">使用原用户名和密码登录，然后在账号管理中补录邮箱。</p>
      <p v-else-if="mode === 'reset'">输入用户名和备用恢复码重置密码。邮箱无法用来自动找回密码。</p>
      <form @submit.prevent="submit">
        <label v-if="mode !== 'login'">
          用户名（3–32 位字母、数字或下划线）
          <input v-model="username" required maxlength="32" autocomplete="username" />
        </label>
        <label v-if="mode === 'login' || mode === 'register'">
          邮箱地址
          <input
            v-model="email"
            type="email"
            required
            maxlength="254"
            :autocomplete="mode === 'login' ? 'username' : 'email'"
          /> </label
        ><label v-if="mode === 'reset'"
          >备用恢复码<input
            v-model="recovery"
            type="password"
            required
            maxlength="100"
            autocomplete="off"
            spellcheck="false" /></label
        ><label
          >{{ mode === 'login' || mode === 'legacy' ? '密码' : '密码（12–128个字符）'
          }}<input
            v-model="password"
            type="password"
            required
            :minlength="mode === 'login' || mode === 'legacy' ? 1 : 12"
            maxlength="128"
            :autocomplete="
              mode === 'login' || mode === 'legacy' ? 'current-password' : 'new-password'
            " /></label
        ><label v-if="mode === 'register' || mode === 'reset'"
          >确认密码<input
            v-model="confirmation"
            type="password"
            required
            maxlength="128"
            autocomplete="new-password" /></label
        ><button class="button" :disabled="busy">{{ busy ? '处理中…' : '提交' }}</button>
      </form>
    </section>
  </main>
  <AppFooter />
</template>
<style scoped>
.account-main {
  max-width: 760px;
  padding-block: 36px 60px;
}
.account-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-block: 24px;
}
form {
  display: grid;
  gap: 16px;
  margin-block: 24px;
  padding: 20px;
  border: var(--stroke-control);
  border-radius: var(--radius-card);
  background: var(--surface);
}
label {
  display: grid;
  gap: 8px;
  font-weight: 600;
}
input {
  width: 100%;
  min-width: 0;
  min-height: 44px;
  padding: 10px;
  border: var(--stroke-control);
  border-radius: var(--radius-control);
  font: inherit;
}
button {
  min-height: 44px;
}
section > button {
  margin: 8px 8px 8px 0;
}
h1 {
  overflow-wrap: anywhere;
}
</style>
