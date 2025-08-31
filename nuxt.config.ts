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

  // Plugins are auto-registered from the ./plugins directory.

  app: {
    head: {
      script: [
        // Preload and auto-initialize wasm glue on client via ESM module
        { src: '/wasm/init.auto.js', type: 'module' }
      ]
    }
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
