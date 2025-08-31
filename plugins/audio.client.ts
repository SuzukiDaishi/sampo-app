// Client-only Audio plugin (Nuxt auto-registers from ./plugins)
export default defineNuxtPlugin((nuxtApp) => {
  // Guard: avoid double registration if loaded twice
  // @ts-expect-error
  if ((nuxtApp as any).$audio || (globalThis as any).__sampo_audio_provided) {
    try { console.info('[AUDIO][plugin] already provided; skipping duplicate load') } catch {}
    return { provide: {} }
  }
  ;(globalThis as any).__sampo_audio_provided = true
  try { console.info('[AUDIO][plugin] plugin executing (plugins/audio.client.ts)') } catch {}
  // Debug helper
  const log = (...args: any[]) => console.info('[AUDIO][plugin]', ...args)

  let ctx: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let ready = false
  let readyPromise: Promise<void> | null = null

  async function ensureContext() {
    if (!ctx) {
      // @ts-expect-error webkit fallback
      ctx = new (window.AudioContext || window.webkitAudioContext)()
      log('AudioContext created', { sampleRate: ctx.sampleRate, state: ctx.state })
    }
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); log('AudioContext resumed') } catch (e) { console.warn('[AUDIO][plugin] resume failed', e) }
    }
    return ctx
  }

  async function init(): Promise<void> {
    if (ready) return
    if (readyPromise) return readyPromise
    const ac = await ensureContext()
    log('Loading worklet module...')
    await ac.audioWorklet.addModule('/audio/audio-engine.worklet.js')
    log('Worklet module loaded')
    node = new AudioWorkletNode(ac, 'audio-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    node.connect(ac.destination)
    log('AudioWorkletNode created & connected')
    readyPromise = new Promise<void>((resolve) => {
      const onMessage = (e: MessageEvent) => {
        const msg = (e as MessageEvent).data as any
        if (msg?.type === 'ready') {
          ready = true
          node?.port.removeEventListener('message', onMessage)
          resolve()
        }
      }
      node!.port.addEventListener('message', (e) => {
        const m = (e as MessageEvent).data
        if (m && m.type && m.type !== 'time') {
          console.debug('[AUDIO][worklet->main]', m)
        }
      })
      node!.port.addEventListener('message', onMessage)
      // Required when using addEventListener with MessagePort
      try { node!.port.start() } catch {}
      node!.port.postMessage({ type: 'init', options: { sampleRate: ac.sampleRate } })
      // Switch to Wasm mixer to exercise Rust core (toggle back to 'js' if issues)
      try { node!.port.postMessage({ type: 'setEngineMode', mode: 'wasm' }) } catch {}
      log('Sent init to worklet', { sampleRate: ac.sampleRate })
    })
    return readyPromise
  }

  function port(): MessagePort | null {
    return node?.port ?? null
  }

  async function decodeAndLoadBuffer(bufferId: string, arrayBuffer: ArrayBuffer) {
    const ac = await ensureContext()
    const audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0))
    log('Decoded buffer', { bufferId, sr: audioBuffer.sampleRate, ch: audioBuffer.numberOfChannels, len: audioBuffer.length })
    const channels: Float32Array[] = []
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      const src = audioBuffer.getChannelData(i)
      channels.push(new Float32Array(src))
    }
    const transfer = channels.map((c) => c.buffer)
    node?.port.postMessage({ type: 'loadBuffer', bufferId, sampleRate: audioBuffer.sampleRate, channels }, transfer)
    log('Posted loadBuffer', { bufferId })
  }

  try { console.info('[AUDIO][plugin] providing $audio to NuxtApp') } catch {}
  return {
    provide: {
      audio: { init, context: () => ctx, port, ready: () => ready, decodeAndLoadBuffer }
    }
  }
})
