export function useAudioEngine() {
  // Defer injection lookup until call-time to avoid undefined capture
  // when the plugin hasn’t initialized yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const get = () => (useNuxtApp() as any).$audio as undefined | {
    init: () => Promise<void>
    context: () => AudioContext | null
    port: () => MessagePort | null
    ready: () => boolean
    decodeAndLoadBuffer: (bufferId: string, arrayBuffer: ArrayBuffer) => Promise<void>
  }

  // In some environments (hot reload, plugin order), the plugin may not be
  // immediately available at the exact click timing. Provide a short wait.
  async function waitForPlugin(ms: number = 3000): Promise<ReturnType<typeof get> | undefined> {
    console.info('[AUDIO][engine] waitForPlugin start', { timeoutMs: ms })
    const start = Date.now()
    let a = get()
    if (!a) console.info('[AUDIO][engine] $audio not present yet, polling...')
    while (!a && Date.now() - start < ms) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 50))
      a = get()
    }
    console.info('[AUDIO][engine] waitForPlugin done', { elapsed: Date.now() - start, present: !!a })
    return a
  }

  return {
    async init() {
      const now = get()
      if (now) { console.info('[AUDIO][engine] init using existing $audio') }
      const a = (now ?? await waitForPlugin())
      if (!a) {
        console.error('[AUDIO][engine] $audio still missing after wait')
        throw new Error('Audio plugin not ready')
      }
      console.info('[AUDIO][engine] calling $audio.init()')
      return a.init()
    },
    context() { const a = get(); return a ? a.context() : null },
    port() { const a = get(); if (!a) { console.warn('[AUDIO][engine] port requested but $audio missing') } return a ? a.port() : null },
    ready() { const a = get(); const r = !!(a && a.ready()); if (!r) console.warn('[AUDIO][engine] ready=false (no plugin or not init)'); return r },
    async decodeAndLoadBuffer(bufferId: string, arrayBuffer: ArrayBuffer) {
      const a = (get() ?? await waitForPlugin()); if (!a) { console.error('[AUDIO][engine] decode requested but $audio missing'); throw new Error('Audio plugin not ready') }
      return a.decodeAndLoadBuffer(bufferId, arrayBuffer)
    }
  }
}
