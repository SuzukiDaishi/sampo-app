<!--
  Walk page: reads ?id=, loads the matching GeoJSON, renders Canvas map,
  and initializes the Rust->Wasm core with that GeoJSON.
-->
<template>
  <div>
    <p v-if="!id">Missing or malformed id (current id: "{{ route.query.id }}")</p>
    <p v-else-if="error">Failed to load route: {{ error }}</p>
    <CanvasMapView v-else-if="data" :route-data="data" />
    <p v-else>Loading route "{{ id }}"...</p>
  </div>
  
</template>

<script setup lang="ts">
import CanvasMapView from '../../components/CanvasMapView.vue'
import { useSampoCore } from '../../composables/useSampoCore'

const route = useRoute()

const id = computed(() => {
  const idParam = route.query.id
  return typeof idParam === 'string' ? idParam : null
})

const { data, error } = await useAsyncData(() => `route-${id.value}`, async () => {
  if (!id.value) return null
  const response = await $fetch(`/api/routes/${id.value}`)
  return response
}, {
  watch: [id]
})

// Initialize Rust->Wasm core once route data is ready
const core = useSampoCore()
watch(() => data.value, async (val) => {
  if (!val) return
  try {
    await core.init(val as any)
    console.log('[WASM] summary:', core.summarize())
    // Demo query at initial position used in app (center of sample)
    const lat = 35.77134
    const lng = 139.81465
    console.log('[WASM] nearest road id:', core.nearestRoadId(lat, lng))
    console.log('[WASM] current area id:', core.currentAreaId(lat, lng))
  } catch (e) {
    console.error('[WASM] initialization failed. Did you run npm run wasm:build?', e)
  }
}, { immediate: true })
</script>

<style scoped>
</style>

