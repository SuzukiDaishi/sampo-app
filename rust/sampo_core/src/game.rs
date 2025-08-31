use wasm_bindgen::prelude::*;
use std::collections::HashSet;
use std::cell::RefCell;

// このファイルでは、ゲームの「オーディオ・オーケストレーション」をRust(WASM)で実装します。
// 設計方針:
// - Rust側は「AudioWorkletへpostMessageすべきコマンドの配列(JSON)」を返すだけに限定。
//   例: [ {type:"createBus", ...}, {type:"createTrack", ...}, ... ]
// - 実際の音声バッファのfetch/decodeや、MessagePortへのpostMessageはTS側(composables/useAudioOrchestrator.ts)が担当。
// - これにより、WebAPI依存(fetch/AudioContext.decodeAudioData等)をTSに残しつつ、
//   重要なゲーム進行・音声切替ルールはRustで集中管理できます。
// - トラックID/アセットIDはフロントと約束された文字列を使用します。
//   例: BGMトラックIDは "bgm-root1" 等、アセットIDは "bgm_01", "interactive_01" など。
// - ここで返すコマンドのスキーマは public/audio/audio-engine.worklet.js の受理形式に準拠します。

// ----- Orchestrator state (moved from orchestrator.rs) -----
thread_local! {
    static ORCH: RefCell<OrchState> = RefCell::new(OrchState::default());
}

#[derive(Default)]
struct OrchState {
    initialized: bool,
    ducking: bool,
    last_road: Option<String>,
    start_played: bool,
    goal_played: bool,
    active_bgm_track: Option<String>,
}

fn loop_json(mode: &str, start: Option<u32>, end: Option<i32>, crossfade_ms: Option<u32>) -> serde_json::Value {
    let mut obj = serde_json::json!({ "mode": mode });
    if let serde_json::Value::Object(ref mut map) = obj {
        map.insert("start".to_string(), serde_json::Value::from(start.unwrap_or(0)));
        match end {
            Some(v) => { map.insert("end".to_string(), serde_json::Value::from(v)); },
            None => { map.insert("end".to_string(), serde_json::Value::Null); },
        }
        if let Some(x) = crossfade_ms { map.insert("crossfadeMs".to_string(), serde_json::Value::from(x)); }
    }
    obj
}

fn crossfade_to(cmds: &mut Vec<serde_json::Value>, track_id: &str, asset_id: &str, bus: &str, loop_v: serde_json::Value, fade_ms: u32) {
    // クロスフェード: 新トラックを-60dBで開始 → rampで0dBへ、旧トラック群を-60dBへ
    cmds.push(serde_json::json!({
        "type": "createTrack",
        "trackId": track_id,
        "busId": bus,
        "assetId": asset_id,
        "options": { "gainDb": -60, "pan": 0 }
    }));
    cmds.push(serde_json::json!({ "type": "schedulePlay", "trackId": track_id, "loop": loop_v }));
    // 新トラックをフェードイン
    cmds.push(serde_json::json!({ "type": "setGain", "scope": "track", "id": track_id, "gainDb": 0, "rampMs": fade_ms }));
    // 既知の他BGMトラックはフェードアウト（停止の明示は行わず、無音で回し続ける）
    for other in ["bgm-root1", "bgm-root2", "bgm-root3"].iter() {
        if *other != track_id {
            cmds.push(serde_json::json!({ "type": "setGain", "scope": "track", "id": other, "gainDb": -60, "rampMs": fade_ms }));
        }
    }
}

fn msgs_to_string(cmds: Vec<serde_json::Value>) -> String {
    serde_json::to_string(&cmds).unwrap_or_else(|_| "[]".to_string())
}

/// 初期化: バスの作成/ダッカー設定等のコマンド配列を返す
#[wasm_bindgen]
pub fn audio_orch_init() -> String {
    ORCH.with(|o| {
        let mut st = o.borrow_mut();
        if st.initialized { return "[]".to_string(); }
        let mut cmds: Vec<serde_json::Value> = Vec::new();
        for id in ["bgm", "ambient", "sfx", "voice"].iter() {
            cmds.push(serde_json::json!({
                "type": "createBus",
                "busId": id,
                "options": { "gainDb": -6 }
            }));
        }
        // サイドチェーン・ダッキング: voiceをkeyとしてbgm/ambientを抑える
        cmds.push(serde_json::json!({
            "type": "setDucker",
            "targetBusId": "bgm",
            "keyBusId": "voice",
            "params": { "thresholdDb": -30, "ratio": 6, "attackMs": 15, "releaseMs": 200, "maxAttenDb": 12, "makeupDb": 0 }
        }));
        cmds.push(serde_json::json!({
            "type": "setDucker",
            "targetBusId": "ambient",
            "keyBusId": "voice",
            "params": { "thresholdDb": -30, "ratio": 6, "attackMs": 15, "releaseMs": 200, "maxAttenDb": 12, "makeupDb": 0 }
        }));
        st.initialized = true;
        msgs_to_string(cmds)
    })
}

/// BGM開始: 既定のbgm_01を"bgm-root1"として無限ループ再生
#[wasm_bindgen]
pub fn audio_orch_start_bgm() -> String {
    ORCH.with(|o| {
        let mut st = o.borrow_mut();
        let mut cmds: Vec<serde_json::Value> = Vec::new();
        let id = "bgm-root1".to_string();
        cmds.push(serde_json::json!({
            "type": "createTrack", "trackId": id, "busId": "bgm", "assetId": "bgm_01", "options": { "gainDb": 0, "pan": 0 }
        }));
        let l = loop_json("seamless", Some(0), None, None);
        cmds.push(serde_json::json!({ "type": "schedulePlay", "trackId": "bgm-root1", "loop": l }));
        st.active_bgm_track = Some("bgm-root1".to_string());
        msgs_to_string(cmds)
    })
}

/// ボイス再生: id指定が無ければ開始ボイス（voice_03_start）。duck解除はengineイベントを別関数で処理
#[wasm_bindgen]
pub fn audio_orch_play_voice(id: Option<String>) -> String {
    ORCH.with(|o| {
        let mut st = o.borrow_mut();
        let asset_id = id.unwrap_or_else(|| "voice_03_start".to_string());
        let track_id = format!("voice-{}", js_sys::Date::now() as u64);
        let mut cmds: Vec<serde_json::Value> = Vec::new();
        cmds.push(serde_json::json!({
            "type": "createTrack", "trackId": track_id, "busId": "voice", "assetId": asset_id, "options": { "gainDb": 0, "pan": 0 }
        }));
        cmds.push(serde_json::json!({ "type": "schedulePlay", "trackId": track_id }));
        st.ducking = true;
        msgs_to_string(cmds)
    })
}

/// 位置更新: 道路ID/エリアIDに基づき、BGM切替やボイス発火のコマンド配列を返す
#[wasm_bindgen]
pub fn audio_orch_on_geo_update(road_id: Option<String>, area_ids_json: &str) -> String {
    ORCH.with(|o| {
        let mut st = o.borrow_mut();
        let area_ids: HashSet<String> = serde_json::from_str(area_ids_json).unwrap_or_default();
        let mut cmds: Vec<serde_json::Value> = Vec::new();
        // エリア入場で一度だけ発火するボイス（ここで直接コマンドを生成し、再入借用を避ける）
        if area_ids.contains("start") && !st.start_played {
            let track_id = format!("voice-{}", js_sys::Date::now() as u64);
            cmds.push(serde_json::json!({
                "type": "createTrack", "trackId": track_id, "busId": "voice", "assetId": "voice_03_start", "options": { "gainDb": 0, "pan": 0 }
            }));
            cmds.push(serde_json::json!({ "type": "schedulePlay", "trackId": track_id }));
            st.ducking = true;
            st.start_played = true;
        }
        if area_ids.contains("goal") && !st.goal_played {
            let track_id = format!("voice-{}", js_sys::Date::now() as u64);
            cmds.push(serde_json::json!({
                "type": "createTrack", "trackId": track_id, "busId": "voice", "assetId": "voice_04_goal", "options": { "gainDb": 0, "pan": 0 }
            }));
            cmds.push(serde_json::json!({ "type": "schedulePlay", "trackId": track_id }));
            st.ducking = true;
            st.goal_played = true;
        }

        // 道路遷移に基づくBGM/インタラクティブの切替
        if let Some(ref rid) = road_id {
            if st.last_road.as_ref() != Some(rid) {
                if rid == "root1" {
                    if st.last_road.as_deref() == Some("root2") {
                        if let Some(ref active) = st.active_bgm_track {
                            cmds.push(serde_json::json!({
                                "type": "transition", "trackId": active, "at": "loopEnd", "toAssetId": "bgm_01", "loop": loop_json("seamless", Some(0), None, None)
                            }));
                        }
                    } else {
                        let l = loop_json("seamless", Some(0), None, None);
                        crossfade_to(&mut cmds, "bgm-root1", "bgm_01", "bgm", l, 300);
                        st.active_bgm_track = Some("bgm-root1".to_string());
                    }
                } else if rid == "root2" {
                    let l = loop_json("seamless", Some(0), None, None);
                    crossfade_to(&mut cmds, "bgm-root2", "interactive_01", "bgm", l, 200);
                    st.active_bgm_track = Some("bgm-root2".to_string());
                } else if rid == "root3" {
                    if let Some(ref active) = st.active_bgm_track {
                        cmds.push(serde_json::json!({
                            "type": "transition", "trackId": active, "at": "loopEnd", "toAssetId": "interactive_02", "loop": loop_json("seamless", Some(0), None, None)
                        }));
                    } else {
                        let l = loop_json("seamless", Some(0), None, None);
                        crossfade_to(&mut cmds, "bgm-root3", "interactive_02", "bgm", l, 0);
                        st.active_bgm_track = Some("bgm-root3".to_string());
                    }
                }
                // 特例: root3から離脱時、アクティブBGMのループを止めて末尾で終了させる
                if st.last_road.as_deref() == Some("root3") && rid != "root3" {
                    if let Some(ref active) = st.active_bgm_track {
                        cmds.push(serde_json::json!({
                            "type": "setLoop", "trackId": active, "loop": loop_json("none", Some(0), None, None)
                        }));
                    }
                }
                st.last_road = Some(rid.clone());
            }
        }

        msgs_to_string(cmds)
    })
}

/// 任意ループの開始: bus/gain/trackIdを指定可能。戻りは実行コマンド
#[wasm_bindgen]
pub fn audio_orch_play_loop(asset_id: &str, bus: Option<String>, loop_json_str: Option<String>, gain_db: Option<f32>, track_id: Option<String>) -> String {
    let bus = bus.unwrap_or_else(|| "sfx".to_string());
    let track_id = track_id.unwrap_or_else(|| format!("{}-loop-{}", bus, js_sys::Date::now() as u64));
    let loop_v: serde_json::Value = match loop_json_str {
        Some(s) => serde_json::from_str(&s).unwrap_or_else(|_| loop_json("seamless", Some(0), None, None)),
        None => loop_json("seamless", Some(0), None, None),
    };
    let g = gain_db.unwrap_or(0.0);
    let cmds = vec![
        serde_json::json!({ "type": "createTrack", "trackId": track_id, "busId": bus, "assetId": asset_id, "options": { "gainDb": g, "pan": 0 } }),
        serde_json::json!({ "type": "schedulePlay", "trackId": track_id, "loop": loop_v })
    ];
    msgs_to_string(cmds)
}

/// ループ設定の変更
#[wasm_bindgen]
pub fn audio_orch_set_loop(track_id: &str, loop_json_str: &str) -> String {
    let loop_v: serde_json::Value = serde_json::from_str(loop_json_str).unwrap_or_else(|_| loop_json("none", Some(0), None, None));
    msgs_to_string(vec![serde_json::json!({ "type": "setLoop", "trackId": track_id, "loop": loop_v })])
}

/// トラック停止
#[wasm_bindgen]
pub fn audio_orch_stop_track(track_id: &str) -> String {
    msgs_to_string(vec![serde_json::json!({ "type": "stop", "trackId": track_id })])
}

/// エンジンからのイベント（例: trackEnded）を受け取り、追従コマンドを返す
/// TS側でMessagePortイベントをJSON化して渡してください
#[wasm_bindgen]
pub fn audio_orch_on_engine_message(msg_json: &str) -> String {
    ORCH.with(|o| {
        let mut st = o.borrow_mut();
        let v: serde_json::Value = match serde_json::from_str(msg_json) { Ok(v) => v, Err(_) => return "[]".to_string() };
        let mut cmds: Vec<serde_json::Value> = Vec::new();
        if v.get("type").and_then(|t| t.as_str()) == Some("trackEnded") {
            if let Some(tid) = v.get("trackId").and_then(|t| t.as_str()) {
                if tid.starts_with("voice-") && st.ducking {
                    cmds.push(serde_json::json!({ "type": "setGain", "scope": "bus", "id": "bgm", "gainDb": -6, "rampMs": 150 }));
                    cmds.push(serde_json::json!({ "type": "setGain", "scope": "bus", "id": "ambient", "gainDb": -6, "rampMs": 150 }));
                    st.ducking = false;
                }
            }
        }
        msgs_to_string(cmds)
    })
}

thread_local! {
    static GAME: std::cell::RefCell<GameState> = std::cell::RefCell::new(GameState::default());
}

#[derive(Default)]
struct GameState {
    prev_road: Option<String>,
    prev_areas: HashSet<String>,
    profile_json: Option<String>,
}

#[wasm_bindgen]
pub fn game_load_profile(json: &str) -> Result<(), JsValue> {
    // 形式は自由。柔軟性優先のため、生文字列を保持します。
    // バリデーションは必要に応じてご自身で追加してください。
    GAME.with(|g| {
        let mut st = g.borrow_mut();
        st.profile_json = Some(json.to_string());
    });
    Ok(())
}

#[wasm_bindgen]
pub fn game_reset() {
    GAME.with(|g| {
        let mut st = g.borrow_mut();
        st.prev_road = None;
        st.prev_areas.clear();
    });
}

// 返却は JSON 文字列。将来的に { cmds: [...], debug: {...} } 等へ拡張しても互換維持しやすいよう
// まずは空配列 [] を返す土台のみ用意します（移行のみに留める）。
#[wasm_bindgen]
pub fn game_tick(lat: f64, lng: f64, _dt_ms: u32) -> String {
    // 既存の地理クエリ関数を利用
    let cur_road = crate::nearest_road_id(lat, lng);
    let cur_areas_json = crate::current_area_ids(lat, lng);
    let cur_areas: HashSet<String> = serde_json::from_str::<Vec<String>>(&cur_areas_json)
        .unwrap_or_default().into_iter().collect();

    // 前回との差分（トリガ計算の雛形）
    let (prev_road, prev_areas) = GAME.with(|g| {
        let st = g.borrow();
        (st.prev_road.clone(), st.prev_areas.clone())
    });

    let _road_changed = prev_road.as_deref() != cur_road.as_deref();
    let _entered: Vec<String> = cur_areas.difference(&prev_areas).cloned().collect();
    let _left: Vec<String> = prev_areas.difference(&cur_areas).cloned().collect();

    // 状態更新のみ。実際のコマンド生成はご自身のルール実装に置き換えてください。
    GAME.with(|g| {
        let mut st = g.borrow_mut();
        st.prev_road = cur_road.clone();
        st.prev_areas = cur_areas.clone();
        let _ = &st.profile_json; // ここからルールを評価して cmd を作る想定
    });

    // いまは移行の雛形として空配列を返します。
    "[]".to_string()
}
