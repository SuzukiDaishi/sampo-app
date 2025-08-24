// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: [
    '@nuxt/content',
    '@nuxt/eslint',
    '@nuxt/image',
    '@nuxt/scripts',
    '@nuxt/test-utils',
    '@nuxt/ui'
  ],

  components: {
    global: true,
    dirs: ['~/components']
  },

  nitro: {
    publicAssets: [
      {
        baseURL: '/routes',
        dir: 'public/routes',
        maxAge: 60 * 60 * 24 * 7 // 7 days
      }
    ]
  }
})