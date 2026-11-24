import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'

export default createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior(to, _from, savedPosition) {
    return savedPosition ?? (to.hash ? { el: to.hash, top: 24 } : { top: 0 })
  },
  routes: [
    { path: '/bo3/:id?', component: () => import('../views/Bo3View.vue') },
    {
      path: '/play/:mode(quick|daily|match)',
      component: () => import('../views/ModeSelectView.vue'),
    },
    { path: '/quick/:id', component: () => import('../views/ModeGameView.vue') },
    { path: '/daily-v2/:id', component: () => import('../views/ModeGameView.vue') },
    { path: '/leaderboards', component: () => import('../views/LeaderboardView.vue') },
    { path: '/profile', component: () => import('../views/ProfileView.vue') },
    { path: '/profiles/:principalId', component: () => import('../views/ProfileView.vue') },
    { path: '/account', name: 'account', component: () => import('../views/AccountView.vue') },
    { path: '/', name: 'home', component: HomeView },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('../views/NotFoundView.vue'),
    },
  ],
})
