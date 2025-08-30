let initialized = false
let mod: any = null

async function ensureLoaded() {
  if (initialized && mod) return

  // SSRガード（サーバーではno-opのスタブを用意）
  if (typeof window === 'undefined') {
    mod = {
      init_geojson: (_: any) => {},
      summarize: () => 'server',
      nearest_road_id: (_lat: number, _lng: number) => undefined,
      current_area_id: (_lat: number, _lng: number) => undefined
    }
    initialized = true
    return
  }

  // Prefer global that nuxt head script initializes
  const w: any = window as any
  if (!w.sampo_core_ready) {
    // wait a bit for auto init
    const start = performance.now()
    while (!w.sampo_core_ready && performance.now() - start < 8000) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 50))
    }
  }
  let m: any = w.sampo_core
  if (!m) {
    // Fallback: try direct import
    try {
      m = await import(/* @vite-ignore */ '/wasm/sampo_core.js')
    } catch (e) {
      console.warn('[WASM] direct import failed, injecting <script type=module> init.auto.js', e)
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.type = 'module'
        s.src = '/wasm/init.auto.js'
        s.async = true
        s.onload = () => resolve()
        s.onerror = (err) => reject(err)
        document.head.appendChild(s)
      })
      m = (window as any).sampo_core
    }
  }

  // Initialize wasm (prefer module-resolved default init without args)
  const wasmUrl = '/wasm/sampo_core_bg.wasm'
  // Try a sequence of initializers without relying on typeof checks
  const attempts: Array<() => Promise<void>> = [
    async () => { if ((m as any).default) { await (m as any).default() } else { throw new Error('no default()') } },
    async () => { if ((m as any).default) { await (m as any).default(wasmUrl) } else { throw new Error('no default(url)') } },
    async () => { if ((m as any).__wbg_init) { await (m as any).__wbg_init() } else { throw new Error('no __wbg_init()') } },
    async () => { if ((m as any).__wbg_init) { await (m as any).__wbg_init(wasmUrl) } else { throw new Error('no __wbg_init(url)') } },
    async () => { if ((m as any).init) { await (m as any).init() } else { throw new Error('no init()') } },
    async () => { if ((m as any).init) { await (m as any).init(wasmUrl) } else { throw new Error('no init(url)') } },
    async () => {
      if ((m as any).initSync) {
        const bytes = await fetch(wasmUrl).then(r => r.arrayBuffer())
        ;(m as any).initSync(bytes)
      } else {
        throw new Error('no initSync(bytes)')
      }
    },
    // Wrapper fallback (in case direct module namespace object is opaque)
    async () => {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script')
        s.type = 'module'
        s.src = '/wasm/init.auto.js'
        s.async = true
        s.onload = () => resolve()
        s.onerror = (err) => reject(err)
        document.head.appendChild(s)
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      if (w.sampo_core_ready && w.sampo_core) {
        m = w.sampo_core
      } else {
        throw new Error('no wrapper auto ready')
      }
    },
  ]

  let ok = false
  for (const run of attempts) {
    try {
      await run()
      ok = true
      break
    } catch (e) {
      console.error('[WASM] init attempt failed:', (e as Error)?.message)
    }
  }
  if (!ok) {
    console.error('[WASM] module object', m)
    throw new Error('WASM init function not found on module exports')
  }

  mod = m
  initialized = true
}

export function useSampoCore() {
  return {
    load: ensureLoaded,
    async init(geojson: any) {
      await ensureLoaded()
      mod.init_geojson(JSON.stringify(geojson))
    },
    async query(lat: number, lng: number): Promise<{ roadId: string | null, areaIds: string[], distanceMeters: number | null }> {
      await ensureLoaded()
      if (typeof mod.query_point === 'function') {
        const json: string = mod.query_point(lat, lng)
        try {
          const obj = JSON.parse(json)
          return {
            roadId: obj.roadId ?? null,
            areaIds: Array.isArray(obj.areaIds) ? obj.areaIds : [],
            distanceMeters: typeof obj.distanceMeters === 'number' ? obj.distanceMeters : null
          }
        } catch (e) {
          console.warn('[WASM] failed to parse query_point json', json, e)
        }
      }
      // Fallback via separate calls
      const r = mod.nearest_road_id(lat, lng) ?? null
      let areas: string[] = []
      let dist: number | null = null
      if (typeof mod.current_area_ids === 'function') {
        try {
          const s: string = mod.current_area_ids(lat, lng)
          areas = JSON.parse(s)
        } catch (e) {
          console.warn('[WASM] failed to parse current_area_ids json', e)
        }
      } else {
        const one = mod.current_area_id(lat, lng)
        if (one != null) areas = [one]
      }
      if (typeof mod.nearest_road_distance_m === 'function') {
        const d = Number(mod.nearest_road_distance_m(lat, lng))
        dist = Number.isFinite(d) ? d : null
      }
      return { roadId: r, areaIds: areas, distanceMeters: dist }
    },
    summarize(): string {
      if (!initialized) return 'not-initialized'
      return mod.summarize()
    },
    nearestRoadId(lat: number, lng: number): string | null {
      if (!initialized) return null
      const v = mod.nearest_road_id(lat, lng)
      return v ?? null
    },
    currentAreaId(lat: number, lng: number): string | null {
      if (!initialized) return null
      const v = mod.current_area_id(lat, lng)
      return v ?? null
    }
  }
}
