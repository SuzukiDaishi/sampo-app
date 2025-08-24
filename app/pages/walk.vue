<!--
  Page for walking routes. Reads the `id` query parameter, fetches the
  matching GeoJSON route from `public/routes`, and passes it to the
  `CanvasMapView` component for display.
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
// 明示的にインポート
import CanvasMapView from '../../components/CanvasMapView.vue'

const route = useRoute()

// リアクティブに id を取得
const id = computed(() => {
  const idParam = route.query.id
  return typeof idParam === 'string' ? idParam : null
})

// useAsyncDataを使用（リアクティブなキーで）
const { data, error } = await useAsyncData(() => `route-${id.value}`, async () => {
  if (!id.value) return null
  const response = await $fetch(`/api/routes/${id.value}`)
  return response
}, {
  watch: [id]
})
</script>

