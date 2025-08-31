use geo::algorithm::{contains::Contains, euclidean_distance::EuclideanDistance};
use geo::{LineString, Point, Polygon};
use geojson::{Feature, GeoJson, Value};
use serde::Deserialize;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use js_sys::{Array as JsArray, Float32Array};

#[derive(Debug, Clone)]
struct Road {
    id: String,
    line: LineString<f64>,
}

#[derive(Debug, Clone)]
struct Area {
    id: String,
    poly: Polygon<f64>,
}

#[derive(Default)]
struct State {
    roads: Vec<Road>,
    areas: Vec<Area>,
}

thread_local! { static STATE: std::cell::RefCell<State> = std::cell::RefCell::new(State::default()); }

// Audio engine core module (pure Rust). Wasm wrappers will be introduced separately.
mod audio;
#[cfg(feature = "ffi")]
mod audio_ffi;

// ----- Geometry / Query Core -----

#[derive(Default)]
struct AudioState {
    sr: f32,
    assets: HashMap<String, AudioAsset>,
    tracks: HashMap<String, AudioTrack>,
    duckers: Vec<Ducker>,
}

#[derive(Clone)]
struct AudioAsset {
    sr: f32,
    ch: Vec<Vec<f32>>, // [channel][sample]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LoopMode { None, Seamless, Xfade }

#[derive(Clone, Copy)]
struct LoopCfg {
    mode: LoopMode,
    start: usize,
    end: Option<usize>,
    xfade: usize,
}

impl Default for LoopCfg {
    fn default() -> Self {
        LoopCfg { mode: LoopMode::None, start: 0, end: None, xfade: 0 }
    }
}

#[derive(Clone)]
struct AudioTrack {
    id: String,
    bus: String,
    asset_id: String,
    pos: f64,
    step: f64,
    gain: f32,
    pan_l: f32,
    pan_r: f32,
    playing: bool,
    loop_cfg: LoopCfg,
    markers: Vec<usize>,
    pending_switch: Option<(String, LoopCfg)>,
    pending_switch_at: Option<usize>,
}

thread_local! {
    static AUDIO: std::cell::RefCell<AudioState> = std::cell::RefCell::new(AudioState::default());
}

fn pan_coeffs(pan: f32) -> (f32, f32) {
    // equal-power pan
    let angle = (pan + 1.0) * 0.25 * std::f32::consts::PI;
    (angle.cos(), angle.sin())
}

fn loop_cfg(mode: &str, start: u32, end: i32, xfade_ms: u32, sr: f32) -> LoopCfg {
    let end_opt = if end >= 0 { Some(end as usize) } else { None };
    let m = match mode {
        "seamless" => LoopMode::Seamless,
        "xfade" => LoopMode::Xfade,
        _ => LoopMode::None,
    };
    let xfade = if m == LoopMode::Xfade { ((xfade_ms as f32) * sr / 1000.0).max(0.0) as usize } else { 0 };
    LoopCfg { mode: m, start: start as usize, end: end_opt, xfade }
}

#[derive(Clone)]
struct Ducker {
    target_bus: String,
    key_bus: String,
    threshold_db: f32,
    threshold_lin: f32,
    ratio: f32,
    attack: f32,
    release: f32,
    max_atten_db: f32,
    makeup_lin: f32,
    env: f32,
    gr: f32,
}

#[wasm_bindgen]
pub fn audio_init(sample_rate: f32) { crate::audio::engine_init(sample_rate) }

#[wasm_bindgen]
pub fn audio_register_asset(id: &str, sample_rate: f32, channels: JsArray) -> bool {
    let mut ch_vec: Vec<Vec<f32>> = Vec::new();
    for v in channels.values() {
        let v = v.unwrap_or(JsValue::UNDEFINED);
        let arr = Float32Array::from(v);
        let mut dst = vec![0.0f32; arr.length() as usize];
        arr.copy_to(&mut dst[..]);
        ch_vec.push(dst);
    }
    crate::audio::engine_register_asset(id, sample_rate, ch_vec)
}

#[wasm_bindgen]
pub fn audio_create_track(track_id: &str, asset_id: &str, pan: f32, gain_db: f32) -> bool {
    crate::audio::engine_create_track(track_id, asset_id, pan, gain_db)
}

#[wasm_bindgen]
pub fn audio_create_track_bus(track_id: &str, bus: &str, asset_id: &str, pan: f32, gain_db: f32) -> bool {
    crate::audio::engine_create_track_bus(track_id, bus, asset_id, pan, gain_db)
}

#[wasm_bindgen]
pub fn audio_schedule_play(track_id: &str, offset_samples: u32, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    crate::audio::engine_schedule_play(track_id, offset_samples, loop_mode, loop_start, loop_end, xfade_ms)
}

#[wasm_bindgen]
pub fn audio_set_loop(track_id: &str, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    crate::audio::engine_set_loop(track_id, loop_mode, loop_start, loop_end, xfade_ms)
}

fn sample_pair(asset: &AudioAsset, idx: usize, frac: f64) -> (f32, f32) {
    let ch0 = &asset.ch[0];
    let ch1 = if asset.ch.len() > 1 { &asset.ch[1] } else { &asset.ch[0] };
    let i0 = idx;
    let i1 = idx + 1;
    let s0l = ch0.get(i0).copied().unwrap_or(0.0);
    let s1l = ch0.get(i1).copied().unwrap_or(0.0);
    let s0r = ch1.get(i0).copied().unwrap_or(0.0);
    let s1r = ch1.get(i1).copied().unwrap_or(0.0);
    let l = (s1l - s0l) as f64 * frac + s0l as f64;
    let r = (s1r - s0r) as f64 * frac + s0r as f64;
    (l as f32, r as f32)
}

#[wasm_bindgen]
pub fn audio_set_ducker(target_bus: &str, key_bus: &str, threshold_db: f32, ratio: f32, attack_ms: f32, release_ms: f32, max_atten_db: f32, makeup_db: f32) {
    crate::audio::engine_set_ducker(target_bus, key_bus, threshold_db, ratio, attack_ms, release_ms, max_atten_db, makeup_db)
}

#[wasm_bindgen]
pub fn audio_process_into(out_l: &mut [f32], out_r: &mut [f32]) -> u32 {
    crate::audio::engine_process_into(out_l, out_r)
}

#[wasm_bindgen]
pub fn audio_set_markers(track_id: &str, markers: JsArray) -> bool {
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        let t = match st.tracks.get_mut(track_id) { Some(x) => x, None => return false };
        let mut v: Vec<usize> = Vec::new();
        for it in markers.values() {
            let vj = it.unwrap_or(JsValue::UNDEFINED);
            if let Some(n) = vj.as_f64() { if n >= 0.0 { v.push(n as usize) } }
        }
        v.sort_unstable();
        v.dedup();
        t.markers = v;
        true
    })
}

#[wasm_bindgen]
pub fn audio_transition(track_id: &str, at: &str, to_asset_id: &str, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    AUDIO.with(|a| {
        // 先に対象アセットのsrを取得
        let asset_sr_opt = { let st = a.borrow(); st.assets.get(to_asset_id).map(|asst| asst.sr) };
        let asset_sr = match asset_sr_opt { Some(v) => v, None => return false };
        let lc = loop_cfg(loop_mode, loop_start, loop_end, xfade_ms, asset_sr);
        let mut st = a.borrow_mut();
        if let Some(t) = st.tracks.get_mut(track_id) {
            match at {
                "now" => {
                    t.asset_id = to_asset_id.to_string();
                    t.loop_cfg = lc;
                    t.pos = lc.start as f64;
                    t.pending_switch = None;
                    t.pending_switch_at = None;
                }
                "loopEnd" => {
                    t.pending_switch = Some((to_asset_id.to_string(), lc));
                    t.pending_switch_at = None;
                }
                "nextMarker" => {
                    let idx = t.pos.floor() as usize;
                    if let Some(next) = t.markers.iter().copied().find(|&m| m > idx) {
                        t.pending_switch = Some((to_asset_id.to_string(), lc));
                        t.pending_switch_at = Some(next);
                    } else {
                        t.pending_switch = Some((to_asset_id.to_string(), lc));
                        t.pending_switch_at = None;
                    }
                }
                _ => {}
            }
            true
        } else { false }
    })
}

#[derive(Deserialize)]
struct IdProp {
    id: Option<String>,
    name: Option<String>,
}

fn prop_id(props: &Option<serde_json::Map<String, serde_json::Value>>, fallback: &str) -> String {
    if let Some(map) = props {
        // Try `id` first
        if let Some(v) = map.get("id").and_then(|v| v.as_str()) {
            return v.to_string();
        }
        // Then `name`
        if let Some(v) = map.get("name").and_then(|v| v.as_str()) {
            return v.to_string();
        }
        // Then any string value
        for (_k, v) in map.iter() {
            if let Some(s) = v.as_str() {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    fallback.to_string()
}

fn to_linestring(coords: &Vec<Vec<f64>>) -> Option<LineString<f64>> {
    let mut pts = Vec::with_capacity(coords.len());
    for c in coords {
        if c.len() < 2 { return None; }
        pts.push((c[0], c[1]));
    }
    Some(LineString::from(pts))
}

fn to_polygon(coords: &Vec<Vec<Vec<f64>>>) -> Option<Polygon<f64>> {
    if coords.is_empty() { return None; }
    let outer = to_linestring(&coords[0])?;
    let holes = if coords.len() > 1 {
        coords[1..].iter().filter_map(|ring| to_linestring(ring)).collect()
    } else { Vec::new() };
    Some(Polygon::new(outer, holes))
}

fn point_to_mercator(p: &Point<f64>) -> Point<f64> {
    // Web Mercator (approx) in meters for small extents
    let lon = p.x().to_radians();
    let lat = p.y().to_radians();
    let r = 6378137.0f64;
    let x = r * lon;
    let y = r * (0.5 * (std::f64::consts::PI / 4.0 + lat / 2.0)).tan().ln();
    Point::new(x, y)
}

fn linestring_mercator(line: &LineString<f64>) -> LineString<f64> {
    LineString::from(
        line
            .points()
            .map(|p| {
                let m = point_to_mercator(&p);
                (m.x(), m.y())
            })
            .collect::<Vec<_>>(),
    )
}

#[wasm_bindgen]
pub fn init_geojson(geojson_text: &str) -> Result<(), JsValue> {
    let parsed = geojson_text
        .parse::<GeoJson>()
        .map_err(|e| JsValue::from_str(&format!("GeoJSON parse error: {e}")))?;

    let mut state = State::default();

    match parsed {
        GeoJson::FeatureCollection(fc) => {
            for (idx, feat) in fc.features.into_iter().enumerate() {
                ingest_feature(&mut state, feat, idx);
            }
        }
        GeoJson::Feature(feat) => {
            ingest_feature(&mut state, feat, 0);
        }
        GeoJson::Geometry(_) => {
            return Err(JsValue::from_str("Top-level Geometry is not supported; wrap in Feature/FeatureCollection"));
        }
    }

    STATE.with(|cell| *cell.borrow_mut() = state);
    Ok(())
}

fn ingest_feature(state: &mut State, feat: Feature, idx: usize) {
    let id = prop_id(&feat.properties, &format!("feature-{idx}"));
    match feat.geometry {
        Some(geom) => match geom.value {
            Value::LineString(coords) => {
                if let Some(line) = to_linestring(&coords) {
                    state.roads.push(Road { id, line });
                }
            }
            Value::Polygon(coords) => {
                if let Some(poly) = to_polygon(&coords) {
                    state.areas.push(Area { id, poly });
                }
            }
            Value::MultiLineString(lines) => {
                for (i, ls) in lines.iter().enumerate() {
                    if let Some(line) = to_linestring(ls) {
                        state.roads.push(Road { id: format!("{id}:{i}"), line });
                    }
                }
            }
            Value::MultiPolygon(polys) => {
                for (i, poly) in polys.iter().enumerate() {
                    if let Some(p) = to_polygon(poly) {
                        state.areas.push(Area { id: format!("{id}:{i}"), poly: p });
                    }
                }
            }
            _ => {}
        },
        None => {}
    }
}

// ----- Core compute helpers (pure functions) -----
fn compute_nearest_road(state: &State, lat: f64, lng: f64) -> (Option<String>, f64) {
    let p = Point::new(lng, lat);
    let p_m = point_to_mercator(&p);
    let mut best_id: Option<String> = None;
    let mut best_dist: f64 = f64::INFINITY;
    for road in &state.roads {
        let line_m = linestring_mercator(&road.line);
        let d = p_m.euclidean_distance(&line_m);
        if d < best_dist {
            best_dist = d;
            best_id = Some(road.id.clone());
        }
    }
    (best_id, best_dist)
}

fn compute_nearest_road_id(state: &State, lat: f64, lng: f64) -> Option<String> {
    let (id, _dist) = compute_nearest_road(state, lat, lng);
    id
}

fn compute_area_ids(state: &State, lat: f64, lng: f64) -> Vec<String> {
    let p = Point::new(lng, lat);
    let mut ids = Vec::new();
    for area in &state.areas {
        if area.poly.contains(&p) {
            ids.push(area.id.clone());
        }
    }
    ids
}

#[wasm_bindgen]
pub fn nearest_road_id(lat: f64, lng: f64) -> Option<String> {
    STATE.with(|cell| {
        let state = cell.borrow();
        compute_nearest_road_id(&state, lat, lng)
    })
}

#[wasm_bindgen]
pub fn current_area_id(lat: f64, lng: f64) -> Option<String> {
    STATE.with(|cell| {
        let state = cell.borrow();
        compute_area_ids(&state, lat, lng).into_iter().next()
    })
}

#[wasm_bindgen]
pub fn current_area_ids(lat: f64, lng: f64) -> String {
    STATE.with(|cell| {
        let state = cell.borrow();
        let ids = compute_area_ids(&state, lat, lng);
        serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
    })
}

#[wasm_bindgen]
pub fn nearest_road_distance_m(lat: f64, lng: f64) -> f64 {
    STATE.with(|cell| {
        let state = cell.borrow();
        let (id, dist) = compute_nearest_road(&state, lat, lng);
        if id.is_some() { dist } else { f64::NAN }
    })
}

#[wasm_bindgen]
pub fn query_point(lat: f64, lng: f64) -> String {
    STATE.with(|cell| {
        let state = cell.borrow();
        let (road, dist) = compute_nearest_road(&state, lat, lng);
        let areas = compute_area_ids(&state, lat, lng);
        let obj = serde_json::json!({
            "roadId": road,
            "areaIds": areas,
            "distanceMeters": if dist.is_finite() { serde_json::Value::from(dist) } else { serde_json::Value::Null }
        });
        serde_json::to_string(&obj).unwrap_or_else(|_| "{}".to_string())
    })
}

#[wasm_bindgen]
pub fn summarize() -> String {
    STATE.with(|cell| {
        let st = cell.borrow();
        format!("roads: {}, areas: {}", st.roads.len(), st.areas.len())
    })
}

// Placeholder for future main loop and audio pipeline planning
#[wasm_bindgen]
pub fn planned_components() -> String {
    // High-level plan for future: event system, audio graph, time scheduler.
    let plan: HashMap<&str, &str> = HashMap::from([
        ("events", "enter/leave area, near-road, waypoint, branching"),
        ("audio", "bgm layers, sfx, voice cues, spatial panning"),
        ("engine", "tick scheduler, time-based envelopes, state machine"),
    ]);
    serde_json::to_string(&plan).unwrap()
}

// ----- Tests -----
#[cfg(test)]
mod tests {
    use super::*;

    fn state_from_str(s: &str) -> State {
        let parsed = s.parse::<GeoJson>().expect("parse geojson");
        let mut st = State::default();
        match parsed {
            GeoJson::FeatureCollection(fc) => {
                for (idx, feat) in fc.features.into_iter().enumerate() {
                    ingest_feature(&mut st, feat, idx);
                }
            }
            GeoJson::Feature(feat) => ingest_feature(&mut st, feat, 0),
            GeoJson::Geometry(_) => panic!("Top-level Geometry not supported"),
        }
        st
    }

    #[test]
    fn test_query_inside_start_area() {
        let s = include_str!("../../../public/routes/level.geojson");
        let st = state_from_str(s);
        let lat = 35.77128;
        let lng = 139.81470;
        let areas = super::compute_area_ids(&st, lat, lng);
        assert!(areas.contains(&"start".to_string()), "expected to contain 'start', got {:?}", areas);
        let road = super::compute_nearest_road_id(&st, lat, lng);
        assert!(road.is_some(), "nearest road should exist");
    }

    #[test]
    fn test_query_outside_any_area() {
        let s = include_str!("../../../public/routes/level.geojson");
        let st = state_from_str(s);
        let lat = 35.77134;
        let lng = 139.81465;
        let areas = super::compute_area_ids(&st, lat, lng);
        assert!(areas.is_empty(), "expected empty areas at initial point, got {:?}", areas);
        let road = super::compute_nearest_road_id(&st, lat, lng);
        assert!(road.is_some(), "nearest road should exist");
    }
}
