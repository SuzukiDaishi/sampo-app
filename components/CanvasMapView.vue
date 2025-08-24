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
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { usePlayer } from '../composables/usePlayer'

const props = defineProps<{ routeData?: GeoJSON.GeoJSON }>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null
let animationFrame: number | null = null
let isDragging = false

// Map state
const zoom = ref(16)
const mapBearing = ref(0)
const mapCenter = ref({ lat: 35.77134, lng: 139.81465 })

// Player state
const {
  position,
  heading,
  speed,
  isMoving,
  start,
  pause,
  handleKeyDown
} = usePlayer(() => mapBearing.value)

// Canvas dimensions
const canvasWidth = ref(800)
const canvasHeight = ref(600)

// Tile cache
const tileCache = new Map<string, HTMLImageElement>()
const TILE_SIZE = 256

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

// Render tiles
async function renderTiles() {
  if (!ctx) return
  
  const z = zoom.value
  const centerTileX = lngToTileX(mapCenter.value.lng, z)
  const centerTileY = latToTileY(mapCenter.value.lat, z)
  
  const tileRadius = 4
  const startTileX = Math.floor(centerTileX - tileRadius)
  const startTileY = Math.floor(centerTileY - tileRadius)
  const endTileX = Math.ceil(centerTileX + tileRadius)
  const endTileY = Math.ceil(centerTileY + tileRadius)
  
  for (let tileX = startTileX; tileX <= endTileX; tileX++) {
    for (let tileY = startTileY; tileY <= endTileY; tileY++) {
      if (tileX < 0 || tileY < 0 || tileX >= Math.pow(2, z) || tileY >= Math.pow(2, z)) {
        continue
      }
      
      const tile = await loadTile(tileX, tileY, z)
      if (tile) {
        const pixelX = (tileX - centerTileX) * TILE_SIZE + canvasWidth.value / 2
        const pixelY = (tileY - centerTileY) * TILE_SIZE + canvasHeight.value / 2
        ctx.drawImage(tile, pixelX, pixelY)
      }
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
async function render() {
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
  await renderTiles()
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
    zoom.value = Math.min(18, zoom.value + 1)
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
      mapBearing.value = (mapBearing.value - 15 + 360) % 360
      break
    case 'e':
    case 'E':
      event.preventDefault()
      event.stopPropagation()
      mapBearing.value = (mapBearing.value + 15) % 360
      break
  }
}

function zoomIn() {
  zoom.value = Math.min(18, zoom.value + 1)
}

function zoomOut() {
  zoom.value = Math.max(1, zoom.value - 1)
}

function startDrag(event: MouseEvent) {
  isDragging = true
  event.preventDefault()
  
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return
    
    const rect = canvasRef.value?.getBoundingClientRect()
    if (!rect) return
    
    const canvasX = e.clientX - rect.left
    const canvasY = e.clientY - rect.top
    
    const centerX = canvasWidth.value / 2
    const centerY = canvasHeight.value / 2
    
    let worldX = canvasX - centerX
    let worldY = canvasY - centerY
    
    if (mapBearing.value !== 0) {
      const angle = (-mapBearing.value * Math.PI) / 180
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      
      const rotatedX = worldX * cos - worldY * sin
      const rotatedY = worldX * sin + worldY * cos
      
      worldX = rotatedX
      worldY = rotatedY
    }
    
    const z = zoom.value
    const centerTileX = lngToTileX(mapCenter.value.lng, z)
    const centerTileY = latToTileY(mapCenter.value.lat, z)
    
    const clickTileX = centerTileX + worldX / TILE_SIZE
    const clickTileY = centerTileY + worldY / TILE_SIZE
    
    position.lng = tileXToLng(clickTileX, z)
    position.lat = tileYToLat(clickTileY, z)
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
  
  canvasRef.value.width = canvasWidth.value
  canvasRef.value.height = canvasHeight.value
  
  start()
  animate()
  
  document.addEventListener('keydown', handleKeyDown)
  document.addEventListener('keydown', handleMapKeyDown)
})

onUnmounted(() => {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame)
  }
  pause()
  
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('keydown', handleMapKeyDown)
})

// Watch player position
watch(
  () => [position.lat, position.lng],
  () => {
    mapCenter.value = { lat: position.lat, lng: position.lng }
  },
  { deep: true }
)
</script>

<style scoped>
.canvas-map-container {
  position: relative;
  width: 800px;
  height: 600px;
  background: #f0f8ff;
  overflow: hidden;
  border: 2px solid #333;
}

.map-canvas {
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
</style>