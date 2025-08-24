<!--
  MapView component responsible for rendering the MapLibre map and HUD.
  It draws the loaded GeoJSON route, displays a draggable player marker,
  offers basic movement controls, and keeps the camera centered on the
  player's position.
-->
<template>
  <div ref="mapContainer" class="map-view" />
  <!-- 手動でプレイヤーマーカーを作成 -->
  <div 
    v-if="map && mapLoaded"
    class="player-marker-overlay"
    :style="playerMarkerStyle"
    @mousedown="startDrag"
  >
  </div>
  <!-- ズームコントロール -->
  <div class="zoom-controls">
    <button @click="zoomIn" class="zoom-btn">+</button>
    <button @click="zoomOut" class="zoom-btn">−</button>
  </div>
  <!-- 簡素化されたHUD -->
  <div class="hud">
    <div class="coords">
      {{ position.lat.toFixed(5) }}, {{ position.lng.toFixed(5) }}
    </div>
    <div class="heading">
      {{ heading.toFixed(0) }}°
    </div>
    <div class="instructions">
      <small>
        WASD: Move (Player rotates to direction)<br>
        QE: Rotate Map<br>
        Mouse Wheel: Zoom<br>
        R: Reset Position
      </small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import maplibregl from 'maplibre-gl'
import { usePlayer } from '../composables/usePlayer'

const props = defineProps<{ routeData?: GeoJSON.GeoJSON }>()

const mapContainer = ref<HTMLDivElement | null>(null)
let map: maplibregl.Map | null = null
let playerMarker: maplibregl.Marker | null = null
let cameraFrame: number | null = null
let mapLoaded = false

const {
  position,
  heading,
  speed,
  isMoving,
  start,
  pause,
  handleKeyDown
} = usePlayer()

// プレイヤーマーカーの位置を計算
const playerMarkerStyle = computed(() => {
  if (!map) return { display: 'none' }
  
  const center = map.project([position.lng, position.lat])
  return {
    left: `${center.x}px`,
    top: `${center.y}px`,
    display: 'block',
    transform: `translate(-50%, -50%) rotate(${heading.value}deg)`
  }
})

let isDragging = false

function startDrag(event: MouseEvent) {
  isDragging = true
  event.preventDefault()
  
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging || !map) return
    
    const rect = mapContainer.value?.getBoundingClientRect()
    if (!rect) return
    
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const lngLat = map.unproject([x, y])
    
    position.lng = lngLat.lng
    position.lat = lngLat.lat
  }
  
  const handleMouseUp = () => {
    isDragging = false
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
  }
  
  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', handleMouseUp)
}

function rotate(delta: number) {
  heading.value = (heading.value + delta + 360) % 360
}

function zoomIn() {
  if (!map) return
  const currentZoom = map.getZoom()
  map.easeTo({
    zoom: currentZoom + 1,
    duration: 300
  })
}

function zoomOut() {
  if (!map) return
  const currentZoom = map.getZoom()
  map.easeTo({
    zoom: currentZoom - 1,
    duration: 300
  })
}

function handleMapKeyDown(event: KeyboardEvent) {
  // フォーム要素がフォーカスされている場合は無視
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return
  }

  console.log('Map key pressed:', event.key) // デバッグ用

  switch (event.key) {
    case 'q':
    case 'Q':
      event.preventDefault()
      event.stopPropagation()
      // マップを左に回転
      if (map) {
        const currentBearing = map.getBearing()
        console.log('Rotating left, current bearing:', currentBearing)
        map.easeTo({
          bearing: currentBearing - 15,
          duration: 200
        })
      }
      break
    case 'e':
    case 'E':
      event.preventDefault()
      event.stopPropagation()
      // マップを右に回転
      if (map) {
        const currentBearing = map.getBearing()
        console.log('Rotating right, current bearing:', currentBearing)
        map.easeTo({
          bearing: currentBearing + 15,
          duration: 200
        })
      }
      break
  }
}

function resetPlayer() {
  console.log('Resetting player position')
  // GeoJSONデータの中心に戻す
  position.lat = 35.77134
  position.lng = 139.81465
  heading.value = 0
  
  if (map) {
    map.easeTo({
      center: [position.lng, position.lat],
      zoom: 16,
      bearing: 0,
      duration: 1000
    })
  }
}

function addRoute(data: any) {
  if (!map) return
  
  // 既存のソースとレイヤーを削除
  if (map.getSource('route')) {
    if (map.getLayer('route-line')) map.removeLayer('route-line')
    if (map.getLayer('route-fill')) map.removeLayer('route-fill')
    map.removeSource('route')
  }
  
  // 新しいソースを追加
  map.addSource('route', { 
    type: 'geojson', 
    data: data
  })
  
  // LineString用のレイヤー
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: 'route',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 
      'line-color': '#0066ff', 
      'line-width': 3,
      'line-opacity': 0.8
    }
  })
  
  // Polygon用のレイヤー（塗り）
  map.addLayer({
    id: 'route-fill',
    type: 'fill',
    source: 'route',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'fill-color': '#00ff00',
      'fill-opacity': 0.3
    }
  })
  
  // Polygon用のレイヤー（枠線）
  map.addLayer({
    id: 'route-outline',
    type: 'line',
    source: 'route',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: {
      'line-color': '#00aa00',
      'line-width': 2,
      'line-opacity': 0.8
    }
  })
}

function fitToRoute(data: any) {
  if (!map || !data) return
  
  try {
    // GeoJSONデータから境界を計算
    const source = map.getSource('route') as maplibregl.GeoJSONSource
    if (source) {
      // 少し遅延を入れてからfitBounds
      setTimeout(() => {
        const bounds = new maplibregl.LngLatBounds()
        
        // すべての座標を境界に追加
        if (data.features) {
          data.features.forEach((feature: any) => {
            if (feature.geometry.type === 'LineString') {
              feature.geometry.coordinates.forEach((coord: [number, number]) => {
                bounds.extend(coord)
              })
            } else if (feature.geometry.type === 'Polygon') {
              feature.geometry.coordinates[0].forEach((coord: [number, number]) => {
                bounds.extend(coord)
              })
            }
          })
        }
        
        // 境界がある場合は地図をフィット
        if (!bounds.isEmpty()) {
          map!.fitBounds(bounds, { padding: 50 })
        }
      }, 100)
    }
  } catch (error) {
    console.error('Error fitting to route:', error)
  }
}

watch(
  () => props.routeData,
  (val) => {
    if (mapLoaded && val) {
      addRoute(val)
      fitToRoute(val)
    }
  }
)

onMounted(async () => {
  if (!mapContainer.value) return

  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://demotiles.maplibre.org/style.json',
    center: [position.lng, position.lat],
    zoom: 16
  })

  map.on('load', () => {
    console.log('Map loaded')
    mapLoaded = true
    
    if (props.routeData) {
      addRoute(props.routeData)
      fitToRoute(props.routeData)
    }
    
    console.log('Player marker should be visible now at:', position.lng, position.lat)
  })

  const cameraStep = () => {
    if (!map) return
    map.easeTo({
      center: [position.lng, position.lat],
      duration: 100
    })
    cameraFrame = requestAnimationFrame(cameraStep)
  }

  cameraFrame = requestAnimationFrame(cameraStep)
  
  // マップ回転のキーリスナーを追加
  window.addEventListener('keydown', handleMapKeyDown)
  
  // マウススクロールでズーム
  if (mapContainer.value) {
    mapContainer.value.addEventListener('wheel', (event: WheelEvent) => {
      event.preventDefault()
      if (!map) return
      
      const currentZoom = map.getZoom()
      // 上スクロール（負の値）でズームイン、下スクロール（正の値）でズームアウト
      const zoomDelta = event.deltaY < 0 ? 0.5 : -0.5
      
      console.log('Wheel event:', event.deltaY, 'zoom delta:', zoomDelta)
      
      map.easeTo({
        zoom: Math.max(0, Math.min(22, currentZoom + zoomDelta)),
        duration: 100
      })
    }, { passive: false })
  }
})

onUnmounted(() => {
  if (cameraFrame !== null) {
    cancelAnimationFrame(cameraFrame)
  }
  if (map) {
    map.remove()
  }
  // マップ回転のキーリスナーを削除
  window.removeEventListener('keydown', handleMapKeyDown)
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
  background: rgba(255, 255, 255, 0.9);
  padding: 12px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  min-width: 200px;
}

.controls button {
  padding: 6px 12px;
  margin: 2px;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
}

.controls button:hover {
  background: #f0f0f0;
}

.controls button.active {
  background: #007bff;
  color: white;
}

.speed-control {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.speed-control label {
  font-size: 12px;
  font-weight: bold;
}

.speed-control input {
  width: 100%;
}

.coords, .heading {
  font-family: monospace;
  font-size: 12px;
  background: #f5f5f5;
  padding: 4px 6px;
  border-radius: 3px;
}

.instructions {
  border-top: 1px solid #eee;
  padding-top: 8px;
  margin-top: 4px;
}

.instructions small {
  color: #666;
  line-height: 1.3;
}

.debug-controls {
  border-top: 1px solid #eee;
  padding-top: 8px;
  margin-top: 8px;
}

.debug-controls button {
  display: block;
  width: 100%;
  margin-bottom: 4px;
  padding: 4px 8px;
  font-size: 11px;
  background: #f8f9fa;
  border: 1px solid #ccc;
  border-radius: 3px;
  cursor: pointer;
}

.debug-controls button:hover {
  background: #e9ecef;
}

.player-marker {
  width: 24px !important;
  height: 24px !important;
  background: #ff0000 !important;
  border: 4px solid #ffffff !important;
  border-radius: 50% !important;
  box-shadow: 0 0 20px rgba(255, 0, 0, 0.8) !important;
  cursor: grab !important;
  position: relative !important;
  z-index: 9999 !important;
}

.player-marker-overlay {
  position: absolute;
  width: 0;
  height: 0;
  border-left: 12px solid transparent;
  border-right: 12px solid transparent;
  border-bottom: 20px solid #ff0000;
  cursor: grab;
  z-index: 9999;
  pointer-events: auto;
  transform: translate(-50%, -50%) rotate(0deg);
  transform-origin: center center;
  box-shadow: 0 0 10px rgba(255, 0, 0, 0.8);
}

.player-marker-overlay:active {
  cursor: grabbing;
}
</style>

