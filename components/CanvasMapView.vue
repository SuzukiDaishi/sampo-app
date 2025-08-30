<template>
  <div class="canvas-map-container">
    <canvas 
      ref="canvasRef" 
      class="map-canvas"
      @mousedown="startDrag"
      @wheel="handleWheel"
    ></canvas>
    
    <!-- ズームコントロール -->
    <div class="zoom-controls">
      <button @click="zoomIn" class="zoom-btn">+</button>
      <button @click="zoomOut" class="zoom-btn">−</button>
    </div>
    
    <!-- HUD -->
    <div class="hud">
      <div class="coords">
        {{ position.lat.toFixed(5) }}, {{ position.lng.toFixed(5) }}
      </div>
      <div class="heading">
        {{ heading.toFixed(0) }}°
      </div>
      <div class="zoom-level">
        Zoom: {{ zoom.toFixed(0) }}
      </div>
      <div class="map-bearing">
        Map: {{ mapBearing.toFixed(0) }}°
      </div>
      <div class="instructions">
        <small>
          WASD: Move (Screen Direction)<br>
          QE: Rotate Map<br>
          Mouse Wheel: Zoom<br>
          R: Reset Position
        </small>
      </div>
      <div class="wasm-info">
        <div class="wasm-row"><strong>Nearest road:</strong>
          <template v-if="nearestRoadId">{{ nearestRoadId }}</template>
          <template v-else>-</template>
          <template v-if="nearestRoadDist != null"> ({{ nearestRoadDist.toFixed(1) }} m)</template>
        </div>
        <div class="wasm-row"><strong>Area IDs:</strong> {{ currentAreaIds.length ? currentAreaIds.join(', ') : '-' }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { usePlayer } from '../composables/usePlayer'
import { useSampoCore } from '../composables/useSampoCore'

const props = defineProps<{ routeData?: GeoJSON.GeoJSON }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let animationFrame: number | null = null
let isDragging = false
let lastMouseX = 0
let lastMouseY = 0

// Map state
const zoom = ref(19)
const mapBearing = ref(0)
const mapCenter = ref({ lat: 35.77134, lng: 139.81465 })

// WASM query debug info
const nearestRoadId = ref<string | null>(null)
const nearestRoadDist = ref<number | null>(null)
const currentAreaIds = ref<string[]>([])
const wasmReady = ref(false)
const core = useSampoCore()

async function updateWasmQuery() {
  try {
    const { roadId, areaIds, distanceMeters } = await core.query(position.lat, position.lng)
    nearestRoadId.value = roadId
    currentAreaIds.value = areaIds
    nearestRoadDist.value = distanceMeters ?? null
  } catch (e) {
    // leave previous values; optional console for deep debug
    console.warn('[WASM] query failed', e)
  }
}

// Player state
const {
  position,
  heading,
  speed,
  isMoving,
  start,
  pause,
  handleKeyDown
} = usePlayer(() => mapBearing.value, () => zoom.value)

// Canvas dimensions
const canvasWidth = ref(800)
const canvasHeight = ref(600)

function updateCanvasSize() {
  if (!canvasRef.value) return
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const rect = canvasRef.value.getBoundingClientRect()
  canvasWidth.value = Math.floor(rect.width)
  canvasHeight.value = Math.floor(rect.height)
  canvasRef.value.width = Math.floor(rect.width * dpr)
  canvasRef.value.height = Math.floor(rect.height * dpr)
  // Scale drawing so all coordinates can stay in CSS pixels
  const context = canvasRef.value.getContext('2d')
  if (context) {
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}

// Tile cache
const tileCache = new Map<string, HTMLImageElement>()
const TILE_SIZE = 256
// OSM raster tiles are served up to z=19.
// For zoom > 19, draw z=19 tiles scaled up (client overzoom).
const MAX_TILE_ZOOM = 19

// Mercator projection
function lngToTileX(lng: number, z: number): number {
  return (lng + 180) / 360 * Math.pow(2, z)
}

function latToTileY(lat: number, z: number): number {
  const latRad = lat * Math.PI / 180
  return (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * Math.pow(2, z)
}

function tileXToLng(x: number, z: number): number {
  return x / Math.pow(2, z) * 360 - 180
}

function tileYToLat(y: number, z: number): number {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z)
  return Math.atan(Math.sinh(n)) * 180 / Math.PI
}

// Coordinate conversion
function geoToCanvas(lat: number, lng: number): { x: number, y: number } {
  const z = zoom.value
  const tileX = lngToTileX(lng, z)
  const tileY = latToTileY(lat, z)
  const centerTileX = lngToTileX(mapCenter.value.lng, z)
  const centerTileY = latToTileY(mapCenter.value.lat, z)
  
  const pixelX = (tileX - centerTileX) * TILE_SIZE + canvasWidth.value / 2
  const pixelY = (tileY - centerTileY) * TILE_SIZE + canvasHeight.value / 2
  
  return { x: pixelX, y: pixelY }
}

// Tile loading
async function loadTile(x: number, y: number, z: number): Promise<HTMLImageElement | null> {
  const key = `${z}/${x}/${y}`
  
  if (tileCache.has(key)) {
    return tileCache.get(key)!
  }
  
  try {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      img.onload = () => resolve(img)
      img.onerror = () => reject()
    })
    
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
    const result = await promise
    tileCache.set(key, result)
    return result
  } catch {
    return null
  }
}

// Render tiles without awaiting network; draw cached tiles and fire off loads.
function renderTiles() {
  if (!ctx) return
  
  const z = zoom.value
  const baseZ = Math.min(MAX_TILE_ZOOM, Math.floor(z))
  const scale = Math.pow(2, z - baseZ)

  // Center in current zoom coordinates
  const centerTileX_z = lngToTileX(mapCenter.value.lng, z)
  const centerTileY_z = latToTileY(mapCenter.value.lat, z)

  // Determine tile coverage in baseZ coordinates
  const centerTileX_base = lngToTileX(mapCenter.value.lng, baseZ)
  const centerTileY_base = latToTileY(mapCenter.value.lat, baseZ)
  const tilesX = Math.ceil(canvasWidth.value / (TILE_SIZE * scale)) + 2
  const tilesY = Math.ceil(canvasHeight.value / (TILE_SIZE * scale)) + 2
  const minX = Math.floor(centerTileX_base - tilesX / 2)
  const maxX = Math.floor(centerTileX_base + tilesX / 2)
  const minY = Math.floor(centerTileY_base - tilesY / 2)
  const maxY = Math.floor(centerTileY_base + tilesY / 2)

  const maxIndex = Math.pow(2, baseZ)

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (y < 0 || y >= maxIndex) continue
      // Wrap X horizontally
      let xWrapped = x
      if (xWrapped < 0) xWrapped = (xWrapped % maxIndex + maxIndex) % maxIndex
      if (xWrapped >= maxIndex) xWrapped = xWrapped % maxIndex

      const key = `${baseZ}/${xWrapped}/${y}`
      const img = tileCache.get(key)

      // Kick off load if missing (no await)
      if (!img) {
        // Fire-and-forget
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        loadTile(xWrapped, y, baseZ)
        continue
      }

      // Compute pixel position in current-zoom space
      const xAtZ = x * Math.pow(2, z - baseZ)
      const yAtZ = y * Math.pow(2, z - baseZ)
      const pixelX = (xAtZ - centerTileX_z) * TILE_SIZE + canvasWidth.value / 2
      const pixelY = (yAtZ - centerTileY_z) * TILE_SIZE + canvasHeight.value / 2

      const size = TILE_SIZE * scale
      ctx.drawImage(img, pixelX, pixelY, size, size)
    }
  }
}

// Render GeoJSON
function renderGeoJSON() {
  if (!ctx || !props.routeData) return
  
  if (props.routeData.type === 'FeatureCollection') {
    props.routeData.features.forEach(feature => {
      if (feature.geometry.type === 'LineString') {
        ctx!.beginPath()
        ctx!.strokeStyle = '#0066ff'
        ctx!.lineWidth = 4
        
        const coordinates = feature.geometry.coordinates
        coordinates.forEach((coord, index) => {
          if (Array.isArray(coord) && coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
            const { x, y } = geoToCanvas(coord[1], coord[0])
            if (index === 0) {
              ctx!.moveTo(x, y)
            } else {
              ctx!.lineTo(x, y)
            }
          }
        })
        ctx!.stroke()
      } else if (feature.geometry.type === 'Polygon') {
        const rings = feature.geometry.coordinates
        rings.forEach(ring => {
          ctx!.beginPath()
          ctx!.fillStyle = 'rgba(0, 255, 0, 0.3)'
          
          ring.forEach((coord, index) => {
            if (Array.isArray(coord) && coord.length >= 2 && typeof coord[0] === 'number' && typeof coord[1] === 'number') {
              const { x, y } = geoToCanvas(coord[1], coord[0])
              if (index === 0) {
                ctx!.moveTo(x, y)
              } else {
                ctx!.lineTo(x, y)
              }
            }
          })
          
          ctx!.closePath()
          ctx!.fill()
          
          // 輪郭線
          ctx!.strokeStyle = '#00aa00'
          ctx!.lineWidth = 2
          ctx!.stroke()
        })
      }
    })
  }
}

// Render player
function renderPlayer() {
  if (!ctx) return
  
  const { x, y } = geoToCanvas(position.lat, position.lng)
  
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((heading.value * Math.PI) / 180)
  
  // Triangle
  ctx.beginPath()
  ctx.moveTo(0, -15)
  ctx.lineTo(-10, 10)
  ctx.lineTo(10, 10)
  ctx.closePath()
  
  ctx.fillStyle = '#ff0000'
  ctx.fill()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2
  ctx.stroke()
  
  ctx.restore()
}

// Main render function
function render() {
  if (!ctx || !canvasRef.value) return
  
  // Clear canvas
  ctx.fillStyle = '#f0f8ff'
  ctx.fillRect(0, 0, canvasWidth.value, canvasHeight.value)
  
  // Apply map rotation
  ctx.save()
  if (mapBearing.value !== 0) {
    ctx.translate(canvasWidth.value / 2, canvasHeight.value / 2)
    ctx.rotate((mapBearing.value * Math.PI) / 180)
    ctx.translate(-canvasWidth.value / 2, -canvasHeight.value / 2)
  }
  
  // Render tiles and GeoJSON
  renderTiles()
  renderGeoJSON()
  
  ctx.restore()
  
  // Render player (not rotated with map)
  renderPlayer()
}

// Animation loop
function animate() {
  render()
  animationFrame = requestAnimationFrame(animate)
}

// Event handlers
function handleWheel(event: WheelEvent) {
  event.preventDefault()
  
  if (event.deltaY < 0) {
    zoom.value = Math.min(22, zoom.value + 1)
  } else {
    zoom.value = Math.max(1, zoom.value - 1)
  }
}

function handleMapKeyDown(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return
  }

  switch (event.key) {
    case 'q':
    case 'Q':
      event.preventDefault()
      event.stopPropagation()
      mapBearing.value = (mapBearing.value - 5 + 360) % 360
      break
    case 'e':
    case 'E':
      event.preventDefault()
      event.stopPropagation()
      mapBearing.value = (mapBearing.value + 5) % 360
      break
  }
}

function zoomIn() {
  zoom.value = Math.min(22, zoom.value + 1)
}

function zoomOut() {
  zoom.value = Math.max(1, zoom.value - 1)
}

function startDrag(event: MouseEvent) {
  if (!canvasRef.value) return
  isDragging = true
  event.preventDefault()

  const rect = canvasRef.value.getBoundingClientRect()
  lastMouseX = event.clientX - rect.left
  lastMouseY = event.clientY - rect.top

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging || !canvasRef.value) return
    const r = canvasRef.value.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top

    // Delta in canvas pixels
    let dx = x - lastMouseX
    let dy = y - lastMouseY
    lastMouseX = x
    lastMouseY = y

    // Account for map rotation so drag feels like pulling the map
    if (mapBearing.value !== 0) {
      const angle = (-mapBearing.value * Math.PI) / 180
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const rx = dx * cos - dy * sin
      const ry = dx * sin + dy * cos
      dx = rx
      dy = ry
    }

    const z = zoom.value
    // Convert center position to tile coords at current zoom
    let tileX = lngToTileX(position.lng, z)
    let tileY = latToTileY(position.lat, z)

    // Move center opposite to drag to make map follow the cursor
    tileX -= dx / TILE_SIZE
    tileY -= dy / TILE_SIZE

    // Update player position; view will remain centered on player
    position.lng = tileXToLng(tileX, z)
    position.lat = tileYToLat(tileY, z)
  }

  const handleMouseUp = () => {
    isDragging = false
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
  }

  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', handleMouseUp)
}

// Lifecycle
onMounted(() => {
  if (!canvasRef.value) return
  
  ctx = canvasRef.value.getContext('2d')
  if (!ctx) {
    console.error('Failed to get 2D context')
    return
  }
  
  updateCanvasSize()
  
  start()
  animate()
  
  document.addEventListener('keydown', handleKeyDown)
  document.addEventListener('keydown', handleMapKeyDown)

  window.addEventListener('resize', updateCanvasSize)

  // Initialize WASM with route data if provided and run first query
  ;(async () => {
    try {
      if (props.routeData) {
        await core.init(props.routeData as any)
      }
      await updateWasmQuery()
      wasmReady.value = true
    } catch (e) {
      console.warn('[WASM] init in CanvasMapView failed', e)
    }
  })()
})

onUnmounted(() => {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
  }
  pause()
  
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('keydown', handleMapKeyDown)
  window.removeEventListener('resize', updateCanvasSize)
})

// Watch player position
watch(
  () => [position.lat, position.lng],
  () => {
    mapCenter.value = { lat: position.lat, lng: position.lng }
    scheduleQuery()
  },
  { deep: true }
)

let queryTimer: number | null = null
function scheduleQuery() {
  if (queryTimer !== null) return
  queryTimer = window.setTimeout(async () => {
    queryTimer = null
    await updateWasmQuery()
  }, 120)
}

// Re-init WASM when routeData changes
watch(
  () => props.routeData,
  async (val) => {
    if (val) {
      try {
        await core.init(val as any)
        await updateWasmQuery()
      } catch (e) {
        console.warn('[WASM] re-init failed', e)
      }
    }
  }
)
</script>

<style scoped>
.canvas-map-container {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  background: #f0f8ff;
  overflow: hidden;
}

.map-canvas {
  width: 100%;
  height: 100%;
  cursor: grab;
}

.map-canvas:active {
  cursor: grabbing;
}

.zoom-controls {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  z-index: 10;
}

.zoom-btn {
  width: 40px;
  height: 40px;
  background: white;
  border: 2px solid #333;
  border-radius: 4px;
  font-size: 18px;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.zoom-btn:hover {
  background: #f0f8ff;
}

.hud {
  position: absolute;
  top: 10px;
  left: 10px;
  background: rgba(255, 255, 255, 0.9);
  padding: 10px;
  border-radius: 4px;
  font-family: monospace;
  border: 2px solid #333;
  z-index: 10;
}

.coords {
  font-weight: bold;
  color: #333;
}

.heading {
  color: #666;
}

.zoom-level {
  color: #666;
}

.map-bearing {
  color: #666;
}

.instructions {
  margin-top: 10px;
  font-size: 11px;
  color: #888;
  line-height: 1.3;
}

.wasm-info {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed #ddd;
  font-size: 11px;
  color: #444;
}
.wasm-row {
  margin-top: 2px;
}
</style>
