use std::collections::HashMap;

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

pub fn engine_init(sample_rate: f32) {
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        st.sr = if sample_rate > 0.0 { sample_rate } else { 48000.0 };
    });
}

pub fn engine_register_asset(id: &str, sample_rate: f32, channels: Vec<Vec<f32>>) -> bool {
    let ch_vec: Vec<Vec<f32>> = channels;
    if ch_vec.is_empty() { return false; }
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        st.assets.insert(id.to_string(), AudioAsset { sr: sample_rate, ch: ch_vec });
    });
    true
}

pub fn engine_create_track(track_id: &str, asset_id: &str, pan: f32, gain_db: f32) -> bool {
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        let asset = match st.assets.get(asset_id) { Some(x) => x.clone(), None => return false };
        let (pl, pr) = pan_coeffs(pan.clamp(-1.0, 1.0));
        let step = (asset.sr / st.sr) as f64;
        let t = AudioTrack {
            id: track_id.to_string(),
            bus: "sfx".to_string(),
            asset_id: asset_id.to_string(),
            pos: 0.0,
            step,
            gain: 10.0f32.powf(gain_db / 20.0),
            pan_l: pl,
            pan_r: pr,
            playing: false,
            loop_cfg: LoopCfg::default(),
            markers: Vec::new(),
            pending_switch: None,
            pending_switch_at: None,
        };
        st.tracks.insert(track_id.to_string(), t);
        true
    })
}

pub fn engine_create_track_bus(track_id: &str, bus: &str, asset_id: &str, pan: f32, gain_db: f32) -> bool {
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        let asset = match st.assets.get(asset_id) { Some(x) => x.clone(), None => return false };
        let (pl, pr) = pan_coeffs(pan.clamp(-1.0, 1.0));
        let step = (asset.sr / st.sr) as f64;
        let t = AudioTrack {
            id: track_id.to_string(),
            bus: bus.to_string(),
            asset_id: asset_id.to_string(),
            pos: 0.0,
            step,
            gain: 10.0f32.powf(gain_db / 20.0),
            pan_l: pl,
            pan_r: pr,
            playing: false,
            loop_cfg: LoopCfg::default(),
            markers: Vec::new(),
            pending_switch: None,
            pending_switch_at: None,
        };
        st.tracks.insert(track_id.to_string(), t);
        true
    })
}

pub fn engine_schedule_play(track_id: &str, offset_samples: u32, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    AUDIO.with(|a| {
        let sr_pair = {
            let st = a.borrow();
            if let Some(tro) = st.tracks.get(track_id) {
                if let Some(asset) = st.assets.get(&tro.asset_id) {
                    Some((asset.sr, st.sr))
                } else { None }
            } else { None }
        };
        let (asset_sr, st_sr) = match sr_pair { Some(v) => v, None => return false };
        let mut st = a.borrow_mut();
        if let Some(t) = st.tracks.get_mut(track_id) {
            t.pos = (offset_samples as f64) * (asset_sr as f64 / st_sr as f64);
            t.loop_cfg = loop_cfg(loop_mode, loop_start, loop_end, xfade_ms, asset_sr);
            t.playing = true;
            true
        } else { false }
    })
}

pub fn engine_set_loop(track_id: &str, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    AUDIO.with(|a| {
        let asset_sr_opt = {
            let st = a.borrow();
            if let Some(tro) = st.tracks.get(track_id) {
                st.assets.get(&tro.asset_id).map(|asst| asst.sr)
            } else { None }
        };
        let asset_sr = match asset_sr_opt { Some(v) => v, None => return false };
        let mut st = a.borrow_mut();
        if let Some(t) = st.tracks.get_mut(track_id) {
            t.loop_cfg = loop_cfg(loop_mode, loop_start, loop_end, xfade_ms, asset_sr);
            true
        } else { false }
    })
}

pub fn engine_set_markers(track_id: &str, markers: Vec<usize>) -> bool {
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        let t = match st.tracks.get_mut(track_id) { Some(x) => x, None => return false };
        let mut m = markers;
        m.sort_unstable();
        m.dedup();
        t.markers = m;
        true
    })
}

pub fn engine_transition(track_id: &str, at: &str, to_asset_id: &str, loop_mode: &str, loop_start: u32, loop_end: i32, xfade_ms: u32) -> bool {
    AUDIO.with(|a| {
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

pub fn engine_set_ducker(target_bus: &str, key_bus: &str, threshold_db: f32, ratio: f32, attack_ms: f32, release_ms: f32, max_atten_db: f32, makeup_db: f32) {
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        let atk = 1.0 - (-1.0f32 / (st.sr * attack_ms / 1000.0)).exp();
        let rel = 1.0 - (-1.0f32 / (st.sr * release_ms / 1000.0)).exp();
        let ducker = Ducker {
            target_bus: target_bus.to_string(),
            key_bus: key_bus.to_string(),
            threshold_db,
            threshold_lin: 10.0f32.powf(threshold_db / 20.0),
            ratio: if ratio < 1.0 { 1.0 } else { ratio },
            attack: atk,
            release: rel,
            max_atten_db: if max_atten_db < 0.0 { 0.0 } else { max_atten_db },
            makeup_lin: 10.0f32.powf(makeup_db / 20.0),
            env: 0.0,
            gr: 1.0,
        };
        st.duckers.retain(|d| d.target_bus != ducker.target_bus);
        st.duckers.push(ducker);
    })
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

pub fn engine_process_into(out_l: &mut [f32], out_r: &mut [f32]) -> u32 {
    let n = out_l.len().min(out_r.len());
    for i in 0..n { out_l[i] = 0.0; out_r[i] = 0.0; }
    AUDIO.with(|a| {
        let mut st = a.borrow_mut();
        use std::collections::HashMap;
        let mut bus_acc: HashMap<String, (Vec<f32>, Vec<f32>)> = HashMap::new();
        let ids: Vec<String> = st.tracks.keys().cloned().collect();
        for tid in ids {
            let mut tr = match st.tracks.get(&tid).cloned() { Some(t) => t, None => continue };
            if !tr.playing { continue; }
            let mut asset_id = tr.asset_id.clone();
            let mut asset = match st.assets.get(&asset_id) { Some(x) => x.clone(), None => continue };
            let len_src = asset.ch[0].len();
            let (pl, pr) = (tr.pan_l, tr.pan_r);
            let mut pos = tr.pos;
            let step = tr.step;
            let acc = bus_acc.entry(tr.bus.clone()).or_insert_with(|| (vec![0.0; n], vec![0.0; n]));
            for i in 0..n {
                let mut idx = pos.floor() as usize;
                let mut frac = (pos - idx as f64) as f64;
                if let Some(at) = tr.pending_switch_at {
                    if idx >= at {
                        if let Some((to_id, lc)) = tr.pending_switch.clone() {
                            if let Some(new_asset) = st.assets.get(&to_id).cloned() {
                                asset_id = to_id.clone();
                                asset = new_asset;
                                tr.asset_id = to_id;
                                tr.loop_cfg = lc;
                                pos = tr.loop_cfg.start as f64;
                                idx = pos.floor() as usize;
                                frac = pos - idx as f64;
                            }
                        }
                        tr.pending_switch = None;
                        tr.pending_switch_at = None;
                    }
                }
                // Handle loop boundary for position/asset state (no gap)
                match tr.loop_cfg.mode {
                    LoopMode::Seamless => {
                        let lstart = tr.loop_cfg.start;
                        let lend = tr.loop_cfg.end.unwrap_or(len_src);
                        if idx >= lend {
                            if let Some((to_id, lc)) = tr.pending_switch.clone() {
                                if let Some(new_asset) = st.assets.get(&to_id).cloned() {
                                    asset_id = to_id.clone();
                                    asset = new_asset;
                                    tr.asset_id = to_id;
                                    tr.loop_cfg = lc;
                                    pos = tr.loop_cfg.start as f64;
                                }
                                tr.pending_switch = None;
                            } else {
                                let over = pos - lend as f64;
                                pos = lstart as f64 + over;
                            }
                            idx = pos.floor() as usize;
                            frac = pos - idx as f64;
                        }
                    }
                    LoopMode::Xfade => {
                        let lstart = tr.loop_cfg.start;
                        let lend = tr.loop_cfg.end.unwrap_or(len_src);
                        if idx >= lend {
                            if let Some((to_id, lc)) = tr.pending_switch.clone() {
                                if let Some(new_asset) = st.assets.get(&to_id).cloned() {
                                    asset_id = to_id.clone();
                                    asset = new_asset;
                                    tr.asset_id = to_id;
                                    tr.loop_cfg = lc;
                                    pos = tr.loop_cfg.start as f64;
                                }
                                tr.pending_switch = None;
                            } else {
                                let over = pos - lend as f64;
                                pos = lstart as f64 + over;
                            }
                            idx = pos.floor() as usize;
                            frac = pos - idx as f64;
                        }
                    }
                    LoopMode::None => {}
                }
                // Sample-accurate interpolation with boundary-aware next sample
                if idx >= asset.ch[0].len().saturating_sub(1) && tr.loop_cfg.mode == LoopMode::None {
                    tr.playing = false; break;
                }
                // current sample
                let ch0 = &asset.ch[0];
                let ch1 = if asset.ch.len() > 1 { &asset.ch[1] } else { &asset.ch[0] };
                let s0l = *ch0.get(idx).unwrap_or(&0.0);
                let s0r = *ch1.get(idx).unwrap_or(&s0l);
                // next sample (for interpolation)
                let mut s1l;
                let mut s1r;
                let idx1 = idx + 1;
                let lend = tr.loop_cfg.end.unwrap_or(len_src);
                let lstart = tr.loop_cfg.start;
                let pending_to = tr.pending_switch.clone();
                if tr.loop_cfg.mode == LoopMode::Seamless && idx1 == lend {
                    // wrap to loop start
                    s1l = *ch0.get(lstart).unwrap_or(&0.0);
                    let ch1r = if asset.ch.len() > 1 { &asset.ch[1] } else { &asset.ch[0] };
                    s1r = *ch1r.get(lstart).unwrap_or(&s1l);
                } else if let Some((ref to_id, ref lc)) = pending_to {
                    if idx1 >= lend {
                        // transition at loopEnd: step into new asset at its start
                        if let Some(new_asset) = st.assets.get(to_id).cloned() {
                            let n_ch0 = &new_asset.ch[0];
                            let n_ch1 = if new_asset.ch.len() > 1 { &new_asset.ch[1] } else { &new_asset.ch[0] };
                            let start = lc.start;
                            s1l = *n_ch0.get(start).unwrap_or(&0.0);
                            s1r = *n_ch1.get(start).unwrap_or(&s1l);
                        } else {
                            s1l = *ch0.get(idx1.min(len_src-1)).unwrap_or(&0.0);
                            s1r = *ch1.get(idx1.min(len_src-1)).unwrap_or(&s1l);
                        }
                    } else {
                        s1l = *ch0.get(idx1).unwrap_or(&0.0);
                        s1r = *ch1.get(idx1).unwrap_or(&s1l);
                    }
                } else {
                    s1l = *ch0.get(idx1.min(len_src-1)).unwrap_or(&0.0);
                    s1r = *ch1.get(idx1.min(len_src-1)).unwrap_or(&s1l);
                }
                let sl = ((s1l as f64 - s0l as f64) * frac + s0l as f64) as f32;
                let sr_ = ((s1r as f64 - s0r as f64) * frac + s0r as f64) as f32;
                let g = tr.gain;
                acc.0[i] += sl * g * pl;
                acc.1[i] += sr_ * g * pr;
                pos += step;
            }
            tr.pos = pos;
            st.tracks.insert(tid.clone(), tr);
        }
        // Apply duckers
        for d in st.duckers.iter_mut() {
            // Borrow order: get key bus snapshot first (immutable, cloned),
            // then take mutable borrow of target bus to avoid E0502.
            let (k_l_vec, k_r_vec) = match bus_acc.get(&d.key_bus) {
                Some((l, r)) => (l.clone(), r.clone()),
                None => continue,
            };
            let (t_l, t_r) = match bus_acc.get_mut(&d.target_bus) {
                Some((l, r)) => (l, r),
                None => continue,
            };
            let n = t_l.len().min(k_l_vec.len());
            let mut env = d.env;
            let mut gr = d.gr;
            for i in 0..n {
                let mag = ((k_l_vec[i] * k_l_vec[i] + k_r_vec[i] * k_r_vec[i]).sqrt()) * 0.7071;
                let delta = mag - env;
                env += if delta > 0.0 { d.attack } else { d.release } * delta;
                let mut gtar = 1.0;
                if env > d.threshold_lin {
                    let env_db = 20.0 * (env + 1e-12).log10();
                    let exceed = env_db - d.threshold_db;
                    let atten_db = (1.0 - 1.0 / d.ratio) * exceed;
                    let gdb = -atten_db.clamp(0.0, d.max_atten_db);
                    gtar = 10.0_f32.powf(gdb / 20.0);
                }
                let dgr = gtar - gr;
                gr += if dgr > 0.0 { d.release } else { d.attack } * dgr;
                t_l[i] *= gr * d.makeup_lin;
                t_r[i] *= gr * d.makeup_lin;
            }
            d.env = env;
            d.gr = gr;
        }
        // Mix buses to master
        for (_id, (bl, br)) in bus_acc.into_iter() {
            for i in 0..n { out_l[i] += bl[i]; out_r[i] += br[i]; }
        }
    });
    n as u32
}

// (Bus-level gain/LPF and precise ducking are kept in JS for now; to be ported next.)
