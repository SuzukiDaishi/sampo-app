import { useAudioEngine } from './useAudioEngine'

type Orchestrator = {
  init: () => Promise<void>
  startBGM: () => Promise<void>
  playVoice: (id?: string) => Promise<void>
  onGeoUpdate: (roadId: string | null, areaIds: string[]) => void
  // Generic loop helpers
  playLoop: (assetId: string, opts?: { bus?: 'bgm'|'ambient'|'sfx'|'voice', loop?: { mode: 'seamless'|'xfade', start?: number, end?: number|null, crossfadeMs?: number }, gainDb?: number, trackId?: string }) => Promise<string>
  setLoop: (trackId: string, loop: { mode: 'seamless'|'xfade'|'none', start?: number, end?: number|null, crossfadeMs?: number }) => void
  stopTrack: (trackId: string) => void
  port: () => MessagePort | null
}

export function useAudioOrchestrator(): Orchestrator {
  const audio = useAudioEngine()
  const dbg = (...a: any[]) => console.info('[AUDIO][orchestrator]', ...a)
  let initialized = false
  const loaded = new Set<string>()

  // Lazily load wasm orchestrator if present
  let wasmMod: any | null = null
  async function ensureWasm() {
    if (wasmMod) return wasmMod
    try {
      // Prefer global initialized by /wasm/init.auto.js
      const w: any = (typeof window !== 'undefined') ? (window as any) : null
      if (w && w.sampo_core_ready && w.sampo_core) {
        const m = w.sampo_core
        if (typeof m.audio_orch_init === 'function') {
          wasmMod = m
          dbg('wasm orchestrator loaded (from window.sampo_core)')
          return wasmMod
        }
      }
      // Import from public/wasm built by wasm-pack
      const mod = await import('/wasm/sampo_core.js')
      if (typeof (mod as any).default === 'function') { await (mod as any).default() }
      // Sanity: check for one orchestrator fn
      if (mod && typeof (mod as any).audio_orch_init === 'function') {
        wasmMod = mod
        dbg('wasm orchestrator loaded')
        return wasmMod
      }
      try {
        const keys = Object.keys(mod || {})
        console.warn('[AUDIO][orchestrator] wasm loaded but audio_orch_* exports missing. Rebuild needed?', { keys })
      } catch {}
    } catch (e) {
      console.warn('[AUDIO][orchestrator] wasm load skipped', e)
    }
    return null
  }

  function postCmdsJSON(p: MessagePort, json: string) {
    if (!json) return
    let arr: any[] = []
    try { arr = JSON.parse(json) } catch {}
    if (!Array.isArray(arr)) return
    for (const m of arr) { try { p.postMessage(m) } catch {} }
  }

  async function fetchAndLoad(bufferId: string, url: string) {
    dbg('fetchAndLoad start', bufferId, url)
    if (loaded.has(bufferId)) return
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch ${url}`)
    const arr = await res.arrayBuffer()
    await audio.decodeAndLoadBuffer(bufferId, arr)
    loaded.add(bufferId)
    dbg('fetchAndLoad done', bufferId)
  }

  async function init() {
    if (initialized) return
    dbg('init begin')
    try { dbg('pre-init ready?', audio.ready()) } catch {}
    await audio.init()
    try { dbg('post-init ready?', audio.ready()) } catch {}
    const p = audio.port()
    if (!p) {
      console.error('[AUDIO][orchestrator] audio.port() not available after init')
      throw new Error('Audio port not ready')
    }
    dbg('port ready')

    // Bootstrap buses/duckers via Rust orchestrator (wasm)
    const wasm = await ensureWasm()
    if (wasm) {
      try { postCmdsJSON(p, wasm.audio_orch_init()) } catch (e) { console.warn('[AUDIO][orchestrator] audio_orch_init failed', e) }
      // Bridge engine messages back to wasm to emit follow-up cmds (e.g., ducking release)
      const onMsg = (e: MessageEvent) => {
        try {
          const json = JSON.stringify(e.data ?? {})
          const out = wasm.audio_orch_on_engine_message(json)
          postCmdsJSON(p, out)
        } catch {}
      }
      try { p.addEventListener('message', onMsg) } catch {}
      try { (p as any).start?.() } catch {}
    }

    // pre-load a minimal set of assets (best-effort)
    try { await fetchAndLoad('bgm_01', '/audio/wavs/bgm_01.wav') } catch (e) { console.warn('[AUDIO][orchestrator] preload bgm_01 failed', e) }
    // optional voices (ignore errors if file missing)
    try { await fetchAndLoad('voice_03_start', '/audio/wavs/voice_03_start.wav') } catch {}
    try { await fetchAndLoad('voice_04_goal', '/audio/wavs/voice_04_goal.wav') } catch {}
    try { await fetchAndLoad('interactive_01', '/audio/wavs/interactive_01.wav') } catch {}
    try { await fetchAndLoad('interactive_02', '/audio/wavs/interactive_02.wav') } catch {}
    try { await fetchAndLoad('voice_01_right', '/audio/wavs/voice_01_right.wav') } catch {}
    try { await fetchAndLoad('voice_02_left', '/audio/wavs/voice_02_left.wav') } catch {}

    initialized = true
    dbg('init end')
  }

  async function startBGM() {
    await init()
    const p = audio.port()
    if (!p) return
    const wasm = await ensureWasm()
    // Ensure BGM asset is loaded (in case init preload failed)
    try { await fetchAndLoad('bgm_01', '/audio/wavs/bgm_01.wav') } catch (e) { console.warn('[AUDIO][orchestrator] startBGM: ensure bgm_01 failed', e) }
    if (!wasm) { console.error('[AUDIO][orchestrator] wasm module missing; cannot startBGM'); return }
    try { postCmdsJSON(p, wasm.audio_orch_start_bgm()) } catch (e) { console.warn('[AUDIO][orchestrator] audio_orch_start_bgm failed', e) }
  }

  async function playVoice(id?: string) {
    await init()
    const p = audio.port()
    if (!p) return
    const assetId = id ?? 'voice_03_start'
    dbg('playVoice', assetId)
    // ensure loaded (ignore error)
    try { await fetchAndLoad(assetId, `/audio/wavs/${assetId}.wav`) } catch {}
    const wasm = await ensureWasm()
    if (!wasm) { console.error('[AUDIO][orchestrator] wasm module missing; cannot playVoice'); return }
    try { postCmdsJSON(p, wasm.audio_orch_play_voice(assetId)) } catch (e) { console.warn('[AUDIO][orchestrator] audio_orch_play_voice failed', e) }
  }

  function onGeoUpdate(roadId: string | null, areaIds: string[]) {
    if (!audio.ready()) return
    const p = audio.port()
    if (!p) return
    dbg('onGeoUpdate', { roadId, areaIds })
    try {
      const w = wasmMod
      if (w) {
        const json = (w as any).audio_orch_on_geo_update(roadId ?? undefined, JSON.stringify(areaIds))
        postCmdsJSON(p, json)
      } else {
        void ensureWasm().then((wasm) => {
          if (!wasm) { console.error('[AUDIO][orchestrator] wasm module missing; onGeoUpdate ignored'); return }
          const json = (wasm as any).audio_orch_on_geo_update(roadId ?? undefined, JSON.stringify(areaIds))
          postCmdsJSON(p, json)
        }).catch((e) => console.warn('[AUDIO][orchestrator] audio_orch_on_geo_update failed', e))
      }
    } catch (e) { console.warn('[AUDIO][orchestrator] audio_orch_on_geo_update failed', e) }
  }

  // ---- Generic Loop Utilities ----
  async function playLoop(assetId: string, opts?: { bus?: 'bgm'|'ambient'|'sfx'|'voice', loop?: { mode: 'seamless'|'xfade', start?: number, end?: number|null, crossfadeMs?: number }, gainDb?: number, trackId?: string }): Promise<string> {
    await init()
    const p = audio.port()
    if (!p) throw new Error('Audio port not ready')
    const bus = opts?.bus ?? 'sfx'
    const gainDb = opts?.gainDb ?? 0
    const trackId = opts?.trackId ?? `${bus}-loop-${Date.now()}`
    dbg('playLoop', { assetId, bus, trackId, loop: opts?.loop })
    // ensure asset
    try { await fetchAndLoad(assetId, `/audio/wavs/${assetId}.wav`) } catch {}
    const wasm = await ensureWasm()
    if (!wasm) { console.error('[AUDIO][orchestrator] wasm module missing; cannot playLoop'); return trackId }
    try {
      const loopJson = opts?.loop ? JSON.stringify(opts?.loop) : undefined
      postCmdsJSON(p, wasm.audio_orch_play_loop(assetId, bus, loopJson, gainDb, trackId))
    } catch (e) { console.warn('[AUDIO][orchestrator] audio_orch_play_loop failed', e) }
    return trackId
  }

  function setLoop(trackId: string, loop: { mode: 'seamless'|'xfade'|'none', start?: number, end?: number|null, crossfadeMs?: number }) {
    const p = audio.port()
    if (!p) return
    dbg('setLoop', { trackId, loop })
    try {
      const w = wasmMod
      const json = JSON.stringify(loop.mode === 'none' ? { mode: 'none', start: 0, end: null } : { mode: loop.mode, start: loop.start ?? 0, end: loop.end ?? null, crossfadeMs: loop.crossfadeMs })
      if (w) {
        postCmdsJSON(p, (w as any).audio_orch_set_loop(trackId, json))
      } else {
        void ensureWasm().then((wasm) => {
          if (!wasm) { console.error('[AUDIO][orchestrator] wasm module missing; cannot setLoop'); return }
          postCmdsJSON(p, (wasm as any).audio_orch_set_loop(trackId, json))
        }).catch((e) => console.warn('[AUDIO][orchestrator] audio_orch_set_loop failed', e))
      }
    } catch (e) { console.warn('[AUDIO][orchestrator] audio_orch_set_loop failed', e) }
  }

  function stopTrack(trackId: string) {
    const p = audio.port()
    if (!p) return
    dbg('stopTrack', trackId)
    try {
      const w = wasmMod
      if (w) {
        postCmdsJSON(p, (w as any).audio_orch_stop_track(trackId))
      } else {
        void ensureWasm().then((wasm) => {
          if (!wasm) { console.error('[AUDIO][orchestrator] wasm module missing; cannot stopTrack'); return }
          postCmdsJSON(p, (wasm as any).audio_orch_stop_track(trackId))
        }).catch(() => {})
      }
    } catch {}
  }

  return {
    init,
    startBGM,
    playVoice,
    onGeoUpdate,
    playLoop,
    setLoop,
    stopTrack,
    port: () => audio.port()
  }
}
