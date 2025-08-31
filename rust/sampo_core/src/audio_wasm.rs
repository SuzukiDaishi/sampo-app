#![allow(clippy::not_unsafe_ptr_arg_deref)]
use wasm_bindgen::prelude::*;
use js_sys::{Array as JsArray, Float32Array};

use super::audio::*;

#[wasm_bindgen]
pub fn audio_init(sample_rate: f32) { engine_init(sample_rate) }

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
    engine_register_asset(id, sample_rate, ch_vec)
}

#[wasm_bindgen]
pub fn audio_create_track(track_id: &str, asset_id: &str, pan: f32, gain_db: f32) -> bool {
    engine_create_track(track_id, asset_id, pan, gain_db)
}

#[wasm_bindgen]
pub fn audio_create_track_bus(track_id: &str, bus: &str, asset_id: &str, pan: f32, gain_db: f32) -> bool {
    engine_create_track_bus(track_id, bus, asset_id, pan, gain_db)
}

#[wasm_bindgen]
pub fn audio_schedule_play(track_id: &str, offset_samples: u32, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    engine_schedule_play(track_id, offset_samples, loop_mode, loop_start, loop_end, xfade_ms)
}

#[wasm_bindgen]
pub fn audio_set_loop(track_id: &str, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    engine_set_loop(track_id, loop_mode, loop_start, loop_end, xfade_ms)
}

#[wasm_bindgen]
pub fn audio_set_markers(track_id: &str, markers: JsArray) -> bool {
    let mut v: Vec<usize> = Vec::new();
    for it in markers.values() {
        let vj = it.unwrap_or(JsValue::UNDEFINED);
        if let Some(n) = vj.as_f64() { if n >= 0.0 { v.push(n as usize) } }
    }
    engine_set_markers(track_id, v)
}

#[wasm_bindgen]
pub fn audio_transition(track_id: &str, at: &str, to_asset_id: &str, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    engine_transition(track_id, at, to_asset_id, loop_mode, loop_start, loop_end, xfade_ms)
}

#[wasm_bindgen]
pub fn audio_set_ducker(target_bus: &str, key_bus: &str, threshold_db: f32, ratio: f32, attack_ms: f32, release_ms: f32, max_atten_db: f32, makeup_db: f32) {
    engine_set_ducker(target_bus, key_bus, threshold_db, ratio, attack_ms, release_ms, max_atten_db, makeup_db)
}

#[wasm_bindgen]
pub fn audio_process_into(out_l: &mut [f32], out_r: &mut [f32]) -> u32 {
    engine_process_into(out_l, out_r)
}

