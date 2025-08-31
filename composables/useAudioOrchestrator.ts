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
  let ducking = false
  let lastRoad: string | null = null
  let startPlayed = false
  let goalPlayed = false
  let activeBgmTrackId: string | null = null

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

    // create default buses with headroom
    const buses = ['bgm', 'ambient', 'sfx', 'voice']
    for (const id of buses) {
      p.postMessage({ type: 'createBus', busId: id, options: { gainDb: -6 } })
      dbg('createBus', id)
    }
    // Configure sidechain ducking: voice as key, attenuate bgm/ambient
    p.postMessage({ type: 'setDucker', targetBusId: 'bgm', keyBusId: 'voice', params: { thresholdDb: -30, ratio: 6, attackMs: 15, releaseMs: 200, maxAttenDb: 12, makeupDb: 0 } })
    p.postMessage({ type: 'setDucker', targetBusId: 'ambient', keyBusId: 'voice', params: { thresholdDb: -30, ratio: 6, attackMs: 15, releaseMs: 200, maxAttenDb: 12, makeupDb: 0 } })

    // subscribe messages (duck back on voice end)
    p.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data
      console.debug('[AUDIO][engine msg]', msg)
      if (msg?.type === 'trackEnded' && typeof msg.trackId === 'string' && msg.trackId.startsWith('voice-')) {
        if (ducking) {
          // ramp back over 150ms
          p.postMessage({ type: 'setGain', scope: 'bus', id: 'bgm', gainDb: -6, rampMs: 150 })
          p.postMessage({ type: 'setGain', scope: 'bus', id: 'ambient', gainDb: -6, rampMs: 150 })
          ducking = false
        }
      }
    })

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
    // Ensure BGM asset is loaded (in case init preload failed)
    try { await fetchAndLoad('bgm_01', '/audio/wavs/bgm_01.wav') } catch (e) { console.warn('[AUDIO][orchestrator] startBGM: ensure bgm_01 failed', e) }
    // create a track and schedule looped play
    const id = 'bgm-root1'
    dbg('startBGM createTrack', id)
    p.postMessage({ type: 'createTrack', trackId: id, busId: 'bgm', assetId: 'bgm_01', options: { gainDb: 0, pan: 0 } })
    dbg('startBGM schedulePlay', id)
    p.postMessage({ type: 'schedulePlay', trackId: id, loop: { mode: 'seamless', start: 0, end: null } })
    activeBgmTrackId = id
  }

  async function playVoice(id?: string) {
    await init()
    const p = audio.port()
    if (!p) return
    const assetId = id ?? 'voice_03_start'
    dbg('playVoice', assetId)
    // ensure loaded (ignore error)
    try { await fetchAndLoad(assetId, `/audio/wavs/${assetId}.wav`) } catch {}
    const trackId = `voice-${Date.now()}`
    p.postMessage({ type: 'createTrack', trackId, busId: 'voice', assetId, options: { gainDb: 0, pan: 0 } })
    p.postMessage({ type: 'schedulePlay', trackId })
    // core sidechain ducking handles attenuation (bgm/ambient keyed by voice)
    ducking = true
  }

  function crossfadeTo(trackId: string, assetId: string, busId: string, loop: any, fadeMs = 250) {
    const p = audio.port()
    if (!p) return
    dbg('crossfadeTo', { trackId, assetId, busId, fadeMs })
    // Create new track muted
    p.postMessage({ type: 'createTrack', trackId, busId, assetId, options: { gainDb: -60, pan: 0 } })
    p.postMessage({ type: 'schedulePlay', trackId, loop })
    // Fade in new
    p.postMessage({ type: 'setGain', scope: 'track', id: trackId, gainDb: 0, rampMs: fadeMs })
    // Fade out any other track in same bus and stop later (best-effort)
    // Note: core未提供の列挙が無いので、便宜的に想定IDを落とす
    const others = ['bgm-root1', 'bgm-root2', 'bgm-root3']
    for (const o of others) {
      if (o !== trackId) {
        p.postMessage({ type: 'setGain', scope: 'track', id: o, gainDb: -60, rampMs: fadeMs })
        setTimeout(() => p.postMessage({ type: 'stop', trackId: o }), fadeMs + 30)
      }
    }
    activeBgmTrackId = trackId
  }

  function onGeoUpdate(roadId: string | null, areaIds: string[]) {
    if (!audio.ready()) return
    const p = audio.port()
    if (!p) return
    dbg('onGeoUpdate', { roadId, areaIds })
    // area-triggered voices (one-shot)
    if (areaIds.includes('start') && !startPlayed) {
      void playVoice('voice_03_start'); startPlayed = true
    }
    if (areaIds.includes('goal') && !goalPlayed) {
      void playVoice('voice_04_goal'); goalPlayed = true
    }

    // road-based BGM/interactive selection
    if (roadId && roadId !== lastRoad) {
      if (roadId === 'root1') {
        // To root1: fade transition OK unless coming from root2 which must switch at loop end without fade
        if (lastRoad === 'root2' && activeBgmTrackId) {
          p.postMessage({ type: 'transition', trackId: activeBgmTrackId, at: 'loopEnd', toAssetId: 'bgm_01', loop: { mode: 'seamless', start: 0, end: null } })
        } else {
          crossfadeTo('bgm-root1', 'bgm_01', 'bgm', { mode: 'seamless', start: 0, end: null }, 300)
        }
      } else if (roadId === 'root2') {
        crossfadeTo('bgm-root2', 'interactive_01', 'bgm', { mode: 'seamless', start: 0, end: null }, 200)
      } else if (roadId === 'root3') {
        // Always move to interactive_02 when entering root3.
        // If a BGM track is active, schedule a loop-end transition for sample-accurate seam.
        if (activeBgmTrackId) {
          p.postMessage({ type: 'transition', trackId: activeBgmTrackId, at: 'loopEnd', toAssetId: 'interactive_02', loop: { mode: 'seamless', start: 0, end: null } })
        } else {
          // Fallback: if somehow no active track was tracked, start interactive_02 fresh
          crossfadeTo('bgm-root3', 'interactive_02', 'bgm', { mode: 'seamless', start: 0, end: null }, 0)
        }
      }
      // special: leaving root3 → stop at end: disable loop for the active BGM track if it represents root3 content
      if (lastRoad === 'root3' && roadId !== 'root3' && activeBgmTrackId) {
        p.postMessage({ type: 'setLoop', trackId: activeBgmTrackId, loop: { mode: 'none', start: 0, end: null } })
      }
      lastRoad = roadId
    }
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
    // create + schedule
    p.postMessage({ type: 'createTrack', trackId, busId: bus, assetId, options: { gainDb, pan: 0 } })
    const loop = opts?.loop ?? { mode: 'seamless', start: 0, end: null }
    p.postMessage({ type: 'schedulePlay', trackId, loop })
    return trackId
  }

  function setLoop(trackId: string, loop: { mode: 'seamless'|'xfade'|'none', start?: number, end?: number|null, crossfadeMs?: number }) {
    const p = audio.port()
    if (!p) return
    dbg('setLoop', { trackId, loop })
    if (loop.mode === 'none') {
      p.postMessage({ type: 'setLoop', trackId, loop: { mode: 'none', start: 0, end: null } })
    } else {
      p.postMessage({ type: 'setLoop', trackId, loop: { mode: loop.mode, start: loop.start ?? 0, end: loop.end ?? null, crossfadeMs: loop.crossfadeMs } })
    }
  }

  function stopTrack(trackId: string) {
    const p = audio.port()
    if (!p) return
    dbg('stopTrack', trackId)
    p.postMessage({ type: 'stop', trackId })
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
