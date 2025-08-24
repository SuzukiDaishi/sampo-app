/**
 * Composable that tracks and updates the player's state.
 * Handles position, heading, and speed, and moves the player
 * over time using `requestAnimationFrame` so that UI and
 * keyboard controls can manipulate movement consistently.
 */
import { ref, reactive, onMounted, onUnmounted } from 'vue'
import destination from '@turf/destination'

interface Position {
  lat: number
  lng: number
}

export function usePlayer(getMapBearing?: () => number) {
  // GeoJSONデータの中心付近に配置
  const position = reactive<Position>({ lat: 35.77134, lng: 139.81465 }) // 新しいGeoJSONの中心
  const heading = ref(0) // degrees
  const speed = ref(5) // meters per second (固定)
  const isMoving = ref(false) // 使用しないが互換性のため残す

  function start() {
    // 互換性のため残すが何もしない
    isMoving.value = true
  }

  function pause() {
    // 互換性のため残すが何もしない
    isMoving.value = false
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    // フォーム要素がフォーカスされている場合は無視
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      return
    }

    switch (event.key) {
      case 'ArrowUp':
      case 'w':
      case 'W':
        event.preventDefault()
        // マップの画面上方向に移動
        moveInScreenDirection('up', 5)
        break
      case 'ArrowDown':
      case 's':
      case 'S':
        event.preventDefault()
        // マップの画面下方向に移動
        moveInScreenDirection('down', 5)
        break
      case 'ArrowLeft':
      case 'a':
      case 'A':
        event.preventDefault()
        // マップの画面左方向に移動
        moveInScreenDirection('left', 5)
        break
      case 'ArrowRight':
      case 'd':
      case 'D':
        event.preventDefault()
        // マップの画面右方向に移動
        moveInScreenDirection('right', 5)
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
    // 移動はするが、向きは変更しない（左右移動時）
    const dest = destination([position.lng, position.lat], distKm, direction, { units: 'kilometers' })
    const [lng, lat] = dest.geometry.coordinates
    if (typeof lat === 'number' && typeof lng === 'number') {
      position.lat = lat
      position.lng = lng
    }
  }

  const moveInAbsoluteDirection = (absoluteAngle: number, meters: number) => {
    const distKm = meters / 1000
    // 絶対方向で移動（0度=北、90度=東、180度=南、270度=西）
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
    
    // 画面方向を地理的方向に変換
    let geoDirection = 0
    switch (screenDirection) {
      case 'up':
        geoDirection = 0 - mapBearing  // 北から現在のマップ回転を引く
        break
      case 'right':
        geoDirection = 90 - mapBearing  // 東から現在のマップ回転を引く
        break
      case 'down':
        geoDirection = 180 - mapBearing  // 南から現在のマップ回転を引く
        break
      case 'left':
        geoDirection = 270 - mapBearing  // 西から現在のマップ回転を引く
        break
    }
    
    // 0-360度の範囲に正規化
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

