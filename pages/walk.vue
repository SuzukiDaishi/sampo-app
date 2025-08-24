<template>
  <div>
    <p v-if="!id">Missing or malformed id</p>
    <p v-else-if="error">Failed to load route</p>
    <MapView v-else-if="data" :route-data="data" />
    <p v-else>Loading...</p>
  </div>
</template>

<script setup lang="ts">
import MapView from '~/components/MapView.vue'

const route = useRoute()
const idParam = route.query.id
const id = typeof idParam === 'string' ? idParam : null

const { data, error } = await useFetch<GeoJSON.GeoJSON>(() =>
  id ? `/routes/${id}.geojson` : null
)
</script>

