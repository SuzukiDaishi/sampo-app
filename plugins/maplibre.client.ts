import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

export default defineNuxtPlugin(() => {
  return {
    provide: {
      maplibregl,
    },
  }
})
