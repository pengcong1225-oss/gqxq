import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/accept',
      name: 'accept',
      component: () => import('@/pages/accept/AcceptScreen.vue'),
    },
    {
      path: '/',
      redirect: { name: 'accept' },
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: { name: 'accept' },
    },
  ],
})

export default router
