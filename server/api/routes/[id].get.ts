import { readFile } from 'fs/promises'
import { join } from 'path'

export default defineEventHandler(async (event) => {
  const routeId = getRouterParam(event, 'id')
  
  if (!routeId) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing route id'
    })
  }

  try {
    const filePath = join(process.cwd(), 'public', 'routes', `${routeId}.geojson`)
    const content = await readFile(filePath, 'utf-8')
    
    // Content-Typeを設定
    setHeader(event, 'content-type', 'application/geo+json')
    
    return JSON.parse(content)
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: `Route ${routeId} not found`
    })
  }
})
