<template>
  <div ref="mapContainer" class="map-view" />
  <div class="hud">
    <div class="controls">
      <button @click="start">Move</button>
      <button @click="pause">Pause</button>
      <button @click="rotate(-5)">⟲</button>
      <button @click="rotate(5)">⟳</button>
      <input
        v-model="speedModel"
        type="range"
        min="0"
        max="20"
        step="1"
      >
      <div class="coords">
        {{ position.lat.toFixed(5) }}, {{ position.lng.toFixed(5) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import maplibregl from 'maplibre-gl'
import { usePlayer } from '~/composables/usePlayer'

const mapContainer = ref<HTMLDivElement | null>(null)
let map: maplibregl.Map | null = null
let playerMarker: maplibregl.Marker | null = null
let cameraFrame: number | null = null

const {
  position,
  heading,
  speed,
  start,
  pause,
  updateHeading,
  updateSpeed
} = usePlayer()

const speedModel = computed({
  get: () => speed.value,
  set: (val: number) => updateSpeed(val)
})

function rotate(delta: number) {
  updateHeading((heading.value + delta + 360) % 360)
}

onMounted(async () => {
  if (!mapContainer.value) return

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://demotiles.maplibre.org/style.json',
    center: [position.lng, position.lat],
    zoom: 15
  })

  map.on('load', async () => {
    try {
      const res = await fetch('/routes/level.geojson')
      if (res.ok) {
        const data = await res.json()
        map!.addSource('route', { type: 'geojson', data })
        map!.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          paint: { 'line-color': '#0000ff', 'line-width': 4 }
        })
      }
    } catch (err) {
      console.error('Failed to load route', err)
    }
  })

  const el = document.createElement('div')
  el.className = 'player-marker'

  playerMarker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([position.lng, position.lat])
    .addTo(map)

  playerMarker.on('drag', () => {
    const lngLat = playerMarker!.getLngLat()
    position.lat = lngLat.lat
    position.lng = lngLat.lng
  })

  watch(
    () => [position.lng, position.lat],
    ([lng, lat]) => {
      playerMarker!.setLngLat([lng, lat])
    }
  )

  const cameraStep = () => {
    if (!map) return
    map.easeTo({
      center: [position.lng, position.lat],
      bearing: heading.value,
      duration: 100
    })
    cameraFrame = requestAnimationFrame(cameraStep)
  }

  cameraFrame = requestAnimationFrame(cameraStep)
})

onUnmounted(() => {
  if (cameraFrame !== null) {
    cancelAnimationFrame(cameraFrame)
  }
  if (map) {
    map.remove()
  }
})
</script>

<style scoped>
.map-view {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 100%;
}
.hud {
  position: absolute;
  top: 10px;
  left: 10px;
  background: rgba(255, 255, 255, 0.8);
  padding: 8px;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.player-marker {
  width: 20px;
  height: 20px;
  background: red;
  border: 2px solid #fff;
  border-radius: 50%;
}
</style>

