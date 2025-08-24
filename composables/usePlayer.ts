import { ref, reactive, onMounted, onUnmounted } from 'vue'
import destination from '@turf/destination'

interface Position {
  lat: number
  lng: number
}

export function usePlayer() {
  const position = reactive<Position>({ lat: 0, lng: 0 })
  const heading = ref(0) // degrees
  const speed = ref(0) // meters per second
  const isMoving = ref(false)

  let frameId: number | null = null
  let lastTime: number | null = null

  const step = (timestamp: number) => {
    if (lastTime == null) {
      lastTime = timestamp
    }

    if (isMoving.value) {
      const dt = (timestamp - lastTime) / 1000 // seconds
      const distKm = (speed.value * dt) / 1000 // convert m/s to km
      const dest = destination([position.lng, position.lat], distKm, heading.value, { units: 'kilometers' })
      const [lng, lat] = dest.geometry.coordinates
      position.lat = lat
      position.lng = lng
    }

    lastTime = timestamp
    frameId = requestAnimationFrame(step)
  }

  function start() {
    if (!isMoving.value) {
      isMoving.value = true
      if (frameId === null) {
        frameId = requestAnimationFrame(step)
      }
    }
  }

  function pause() {
    isMoving.value = false
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowUp':
        speed.value += 1
        break
      case 'ArrowDown':
        speed.value = Math.max(0, speed.value - 1)
        break
      case 'ArrowLeft':
        heading.value = (heading.value - 5 + 360) % 360
        break
      case 'ArrowRight':
        heading.value = (heading.value + 5) % 360
        break
      case ' ':
        isMoving.value ? pause() : start()
        break
    }
  }

  const updateHeading = (value: number) => {
    heading.value = value
  }

  const updateSpeed = (value: number) => {
    speed.value = value
  }

  onMounted(() => {
    frameId = requestAnimationFrame(step)
  })

  onUnmounted(() => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
    }
  })

  return {
    position,
    heading,
    speed,
    isMoving,
    start,
    pause,
    handleKeyDown,
    updateHeading,
    updateSpeed
  }
}

