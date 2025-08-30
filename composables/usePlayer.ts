/**
 * Composable that tracks and updates the player's state.
 * Handles position, heading, and speed, and moves the player
 * via small discrete steps from keyboard controls.
 */
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import destination from '@turf/destination'

interface Position {
  lat: number
  lng: number
}

export function usePlayer(getMapBearing?: () => number, getZoom?: () => number) {
  // Initial position is aligned with bundled GeoJSON example
  const position = reactive<Position>({ lat: 35.77134, lng: 139.81465 })
  const heading = ref(0) // degrees
  const speed = ref(5) // meters per second (reserved for future use)
  const isMoving = ref(false)

  function start() {
    isMoving.value = true
  }

  function pause() {
    isMoving.value = false
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // Ignore when typing in inputs
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      return
    }

    // Zoom-scaled step: base 1m at z=19, doubles per zoom-out, halves per zoom-in.
    const z = Math.max(0, Math.min(22, getZoom ? getZoom() : 19))
    const baseStep = Math.pow(2, 19 - z) // z=19 => 1m
    // Modifiers: Shift = coarse (x5), Alt = ultra-fine (x0.5)
    let stepMeters = baseStep
    if (event.shiftKey) stepMeters *= 5
    if (event.altKey) stepMeters *= 0.5

    switch (event.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        event.preventDefault()
        moveInScreenDirection('up', stepMeters)
        break
      case 'ArrowDown':
      case 's':
      case 'S':
        event.preventDefault()
        moveInScreenDirection('down', stepMeters)
        break
      case 'ArrowLeft':
      case 'a':
      case 'A':
        event.preventDefault()
        moveInScreenDirection('left', stepMeters)
        break
      case 'ArrowRight':
      case 'd':
      case 'D':
        event.preventDefault()
        moveInScreenDirection('right', stepMeters)
        break
      case 'r':
      case 'R':
        event.preventDefault()
        resetPosition()
        break
    }
  }

  const moveForward = (meters: number) => {
    const distKm = meters / 1000
    const dest = destination([position.lng, position.lat], distKm, heading.value, { units: 'kilometers' })
    const [lng, lat] = dest.geometry.coordinates
    if (typeof lat === 'number' && typeof lng === 'number') {
      position.lat = lat
      position.lng = lng
    }
  }

  const moveInDirection = (relativeAngle: number, meters: number) => {
    const distKm = meters / 1000
    const direction = (heading.value + relativeAngle + 360) % 360
    const dest = destination([position.lng, position.lat], distKm, direction, { units: 'kilometers' })
    const [lng, lat] = dest.geometry.coordinates
    if (typeof lat === 'number' && typeof lng === 'number') {
      position.lat = lat
      position.lng = lng
    }
  }

  const moveInAbsoluteDirection = (absoluteAngle: number, meters: number) => {
    const distKm = meters / 1000
    const dest = destination([position.lng, position.lat], distKm, absoluteAngle, { units: 'kilometers' })
    const [lng, lat] = dest.geometry.coordinates
    if (typeof lat === 'number' && typeof lng === 'number') {
      position.lat = lat
      position.lng = lng
    }
  }

  const moveInScreenDirection = (screenDirection: 'up' | 'down' | 'left' | 'right', meters: number) => {
    const distKm = meters / 1000
    const mapBearing = getMapBearing ? getMapBearing() : 0

    // Convert screen cardinal to geographic bearing accounting for map rotation
    let geoDirection = 0
    switch (screenDirection) {
      case 'up':
        geoDirection = 0 - mapBearing
        break
      case 'right':
        geoDirection = 90 - mapBearing
        break
      case 'down':
        geoDirection = 180 - mapBearing
        break
      case 'left':
        geoDirection = 270 - mapBearing
        break
    }

    geoDirection = (geoDirection + 360) % 360

    const dest = destination([position.lng, position.lat], distKm, geoDirection, { units: 'kilometers' })
    const [lng, lat] = dest.geometry.coordinates
    if (typeof lat === 'number' && typeof lng === 'number') {
      position.lat = lat
      position.lng = lng
    }
  }

  const resetPosition = () => {
    position.lat = 35.77134
    position.lng = 139.81465
    heading.value = 0
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown)
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeyDown)
  })

  return {
    position,
    heading,
    speed,
    isMoving,
    start,
    pause,
    handleKeyDown
  }
}
