# Sanpo App 音声実装計画（v0.1）

本計画は、ゲーム全体の完成像を見据えつつ、疎結合のオーディオコアを段階的に実装するためのタスクと設計指針をまとめる。音源は `public/audio/wavs` の WAV を前提とし、BGM/インタラクティブ音楽/SE/ボイスを同一の再生機構で制御する。

---

## 完成像（ゲーム体験の観点）

- 常時: BGM（ギャップレスループ/インタラクティブ遷移）
- 環境: エリアや状況に応じた Ambient（クロスフェードループ）
- 誘導: ボイス（分岐案内/開始/到達/逸脱注意）。発話中は BGM/Ambient を自然にダッキング
- 効果音: 軽微なSE（決定/通知）
- 状態遷移の例
  - Startエリア進入 → 開始ボイス（duck）
  - ルート分岐接近 → 右/左ボイス（duck）
  - ルート逸脱距離が閾値超 → BGMレイヤ切替/フィルタ（ローパス）
  - Goalエリア進入 → ゴールボイス＋BGM解放

---

## システム構成（疎結合）

- AudioEngine（本コア）: 再生/ミックス/ループ/ダッキング/LPF/リミッタ/スケジューラ（AudioWorklet）
- Orchestrator（フロント）: Geoイベントを受け取り、AudioEngine へコマンドを送る薄い層
- Game Logic: 位置/エリア/分岐/逸脱の判定（既存 Rust Wasm）とストーリー/分岐制御

---

## 既存の最小実装

- Worklet 雛形: `public/audio/audio-engine.worklet.js:1`
- Nuxtプラグイン: `plugins/audio.client.ts:1`（`init`, `decodeAndLoadBuffer` など）
- Composable: `composables/useAudioEngine.ts:1`

これを土台に DSP/コマンド処理を拡張する。

---

## アセット配置と命名（WAV）

- 配置: `public/audio/wavs`（例）
  - `bgm_01.wav`（常時BGM）
  - `interactive_01.wav`, `interactive_02.wav`（インタラクティブ切替用セグメント）
  - `voice_03_start.wav`, `voice_04_goal.wav`（案内ボイス）
  - 注意: `voice_01_right .wav` は拡張子前に空白あり。`voice_01_right.wav` への改名を推奨。
- フォーマット: 48kHz/mono or stereo/16bit（decode 後は 32bit float）。長尺BGMはメモリ使用量に注意。

### アセットマニフェスト（提案）

`public/audio/manifest.json` を用意し、ループ/マーカー/カテゴリを宣言:

```jsonc
{
  "buses": ["master", "bgm", "ambient", "sfx", "voice"],
  "assets": {
    "bgm_01": { "file": "/audio/wavs/bgm_01.wav", "category": "bgm", "loop": { "mode": "seamless", "start": 0, "end": null } },
    "interactive_01": { "file": "/audio/wavs/interactive_01.wav", "category": "bgm", "markers": [], "bpm": null },
    "interactive_02": { "file": "/audio/wavs/interactive_02.wav", "category": "bgm", "markers": [], "bpm": null },
    "voice_01_right": { "file": "/audio/wavs/voice_01_right.wav", "category": "voice" },
    "voice_02_left": { "file": "/audio/wavs/voice_02_left.wav", "category": "voice" },
    "voice_03_start": { "file": "/audio/wavs/voice_03_start.wav", "category": "voice" },
    "voice_04_goal": { "file": "/audio/wavs/voice_04_goal.wav", "category": "voice" }
  },
  "defaults": { "voiceDuckDb": 9, "ambientCrossfadeMs": 200 }
}
```

- ループ点（`start/end`）はサンプル単位で設定。未定時は `null`（素材末尾でループ不可に等しい）。
- インタラクティブ曲用 `markers` は小節境界などのサンプル位置。

---

## 実装フェーズ

### フェーズ1: エンジン基盤 + アセットローダ
- Worklet: `init`, `loadBuffer`、`query(time)` 応答を整備（既存）
- 追加: `createBus`, `createTrack`, `schedulePlay`, `stop`, `setGain`, `setLPF` の実装
- ミキサ: 等電力パン、ゲインスムージング、シームレスループ（`loop: seamless`）
- Nuxt: Orchestrator を作成（下記）し、manifest を読み込み、WAV を `decodeAudioData`→転送

### フェーズ2: ループ拡張/ダッキング/LPF
- Crossfade ループ（等電力）実装（Ambient 用）
- サイドチェインダッキング（Voice→BGM/Ambient）。`setDucker` で紐付け
- Bus ローパス（Biquad 12/24dB）

### フェーズ3: インタラクティブ音楽
- `markers`/`bpm` を Track に設定
- `transition`（`now`/`nextMarker`/bar 指定）を実装（シームレス or xfade）
- 簡易ステムグループ（同報切替）

### フェーズ4: ポリフォニー/テレメトリ
- `setPolyphony(busId, maxVoices)` とドロップポリシー
- `levels`（RMS）/`time`/`clipCount` 送出、HUD表示

### フェーズ5: 最適化/Wasm化（任意）
- DSP を Rust/Wasm へ移行（ミキサ/リミッタ/biquad）
- `SharedArrayBuffer`（COOP/COEP）でリングバッファ化（将来）

---

## Orchestrator（Nuxt/Vue層）の設計

- 役割: ゲームイベント → エンジンコマンドへの写像
- 実装: `composables/useAudioOrchestrator.ts`（新規）
  - `init(audio: useAudioEngine)`: コンテキスト解放、Worklet初期化、manifest読込、アセット事前ロード
  - Bus初期化: `bgm`, `ambient`, `voice`, `sfx` を作成し、`setDucker(voice→bgm/ambient)`
  - API:
    - `playBGM(id, {loop})`
    - `switchBGM(toId, {at: 'nextMarker'|'now', mode: 'seamless'|'xfade', xfadeMs?})`
    - `playVoice(id, {duckDb?})`
    - `setAmbient(id, {loop: 'xfade', crossfadeMs})`
    - `setLPF(bus, cutoff, q, rampMs)` / `setGain(scope, id?, db, rampMs)`
  - コールバック: `onTrackStarted/Ended/Looped`, `onLevels`

### ゲームイベントとの接続（Canvas/歩行ページ）
- `app/pages/walk.vue:35` で GeoJSON 読込完了後に Orchestrator `init`
- `components/CanvasMapView.vue` の WASM クエリ結果（エリアID/距離）を監視:
  - `start` 入域で `voice_03_start`
  - `goal` 入域で `voice_04_goal`
  - 分岐接近時に `voice_01_right` / `voice_02_left`（距離/角度に応じ選択）
  - 逸脱距離が閾超で BGM を `interactive_02` へ遷移（`at:'nextMarker'`）＋LPFを強めに

---

## UI/UX（初期解放とHUD）

- 初回タップで `audio.init()`（Autoplay規制回避）。HUDに「サウンド開始」ボタンを表示
- HUD 表示（デバッグ）: 出力RMS、BGM/Voice状態、現在サンプル時刻、クリップ数

---

## メモリ/性能方針（WAV前提）

- WAV はデータサイズが大きく、`decodeAudioData` 後は 32bit Float で更に増える
  - 例: 48kHz/180s/2ch → 約 66MB（Float）
- 対策
  - 長尺BGMはループポイントを工夫し、素材長を短縮（ループ/セグメント化）
  - ルート進行に応じプリロード順序を制御（近傍セグメントのみ）
  - 将来、BGMのみ Ogg/Vorbis/Opus への移行を検討

---

## タスクリスト（実装順）

1. マニフェスト仕様合意とファイル整備（命名統一・空白除去）
2. Worklet: `createBus/createTrack/schedulePlay/stop/setGain` 実装
3. Orchestrator作成・初期化コード（manifest読込→事前デコード→転送→Bus作成）
4. シームレスループ検証（`bgm_01.wav`）
5. ダッキング検証（`voice_*` 再生時にBGM -9dB）
6. Crossfadeループ検証（Ambient素材追加後）
7. インタラクティブ遷移（`interactive_01/02` を `nextMarker` で切替）
8. HUD とテレメトリ（`levels/time/clipCount`）
9. 逸脱/分岐イベントの接続（CanvasMapView から Orchestrator）
10. 最適化（必要に応じ Wasm化、バッチング、リングバッファ）

---

## 既知の課題

- `voice_01_right .wav` のファイル名末尾空白はローダの不具合原因になり得る（改名推奨）
- Safari でのサンプルレート/初期解放の挙動差異
- 長尺WAVのメモリ圧、端末差変動

---

## 参考: コードエントリ

- Worklet: `public/audio/audio-engine.worklet.js`
- Nuxtプラグイン: `plugins/audio.client.ts`
- Composable: `composables/useAudioEngine.ts`
- 仕様: `docs/audio-core-spec.md`

