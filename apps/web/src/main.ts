import './styles/main.css'
import './styles/points.css'
import './styles/cel.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { initializeTheme } from './services/theme'
import { loadIdentity, identityTabId } from './services/identity'
initializeTheme()
if (typeof BroadcastChannel !== 'undefined') {
  const identityChanges = new BroadcastChannel('driver-guess:identity-v1')
  identityChanges.onmessage = (event: MessageEvent<unknown>) => {
    if (
      typeof event.data === 'object' &&
      event.data !== null &&
      'tabId' in event.data &&
      event.data.tabId !== identityTabId
    )
      window.location.reload()
  }
}

// Finish identity bootstrap before users can create a game with a competing cookie.
void loadIdentity()
  .catch(() => {
    /* Existing games remain usable if accounts are unavailable. */
  })
  .finally(() => {
    createApp(App).use(createPinia()).use(router).mount('#app')
  })
