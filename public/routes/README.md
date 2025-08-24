# Routes

Place GeoJSON files here to define walking routes for the app. Each file
should be named `<id>.geojson` and normally contain a `LineString` or a
`FeatureCollection` of line features.

## Creating a new route

1. Generate or hand-edit a GeoJSON file describing the route.
2. Save it in this directory as `<id>.geojson` (for example, `city-walk.geojson`).
3. Start the dev server and open `/walk?id=<id>` in the browser to view it.

The files in this folder are served statically, so make sure coordinates are in
`[longitude, latitude]` order and use WGS84 (`EPSG:4326`).
