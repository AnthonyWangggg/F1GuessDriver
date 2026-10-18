import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

export default createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior(to, _from, savedPosition) {
    return savedPosition ?? (to.hash ? { el: to.hash, top: 24 } : { top: 0 })
  },
  routes: [
    { path: '/match', name: 'match', component: () => import('../views/MatchView.vue') },
    { path: '/daily', name: 'daily', component: () => import('../views/DailyView.vue') },
    { path: '/game/:id?', name: 'game', component: () => import('../views/GameView.vue') },
    { path: '/', name: 'home', component: HomeView },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('../views/NotFoundView.vue'),
    },
  ],
})
