# Sanpo App 音声コア 仕様（v0.1）

本ドキュメントは Sanpo App における音声再生の“コア”の仕様を定義する。ゲーム全体に依存しない最小の責務で、BGM（インタラクティブ含む）/SE/ボイスを同一の再生機構で扱い、無音ギャップやクリッピングのない高信頼な再生を提供する。

---

## 目的と非機能要件

- 依存最小: ブラウザ標準の Web Audio API（AudioWorklet）＋最小限の自前ロジック。外部DSPライブラリに極力依存しない。
- 無クリッピング: マスター段でのハードクリップ禁止。十分なヘッドルームとリミッタで保護。
- 無ギャップ: 1サンプルの隙間もないループ／セクション接続（インタラクティブ音楽）。
- ループ機能: 通常ループ、クロスフェードループ、将来のテンポ同期ループ。
- ダッキング: ボイス/SE 再生時に BGM/Ambient を自動減衰（サイドチェイン）。
- 音量調整: マスター/バス/トラックの階層的ゲイン。スムージングでクリック回避。
- フィルタ: シンプルなローパス（Biquad 12/24dB）を各バスに提供。将来拡張可能なエフェクトチェーン。
- 多バス合成: BGM/Voice/SE/Ambient など複数バスをミックスして 2ch 出力に合成。
- リアルタイム: AudioWorklet による別スレッド処理、サンプル精度のスケジューリング、無同期待ち。
- 汎用機構: BGM/SE/ボイスを同じ Track/Bus 機構で再生（カテゴリはラベルのみ）。

---

## システム境界と疎結合方針

- 音声コアは「再生エンジン」として完結し、ゲームドメイン（座標、エリア、イベント種別）を一切知らない。
  - 受け取るのは「時刻つきコマンド」と「PCM資産」のみ。ドメイン層はそれらのコマンドを組み立てて送信する。
- エンジン外部に置くもの
  - ゲーム状態の保持・遷移（ルート進行、分岐選択、台詞キュー管理）
  - アセットの取得元（ネットワーク/キャッシュ戦略）
  - オーディオUI（HUD、メータ表示）
- エンジン内部に置くもの
  - サンプル精度のスケジューラ、ミキサ、ループ、ダッキング、フィルタ、リミッタ等のDSP
  - リアルタイム安全なイベント適用とミックスダウン

---

## 用語

- Asset: デコード済みPCM（Float32、各チャンネル配列、サンプルレートは AudioContext に一致）。
- Track: ひとつの Asset を再生するプレイヤー。再生/停止/ループ/ボリューム/パンなどを持つ。
- Bus: 複数 Track を受け取り、ゲイン/フィルタ/ダッキング処理を行うまとまり。
- Master: 全 Bus を合成する最終段。ヘッドルームとマスターリミッタを持つ。
- Event: サンプル時刻で指定される再生・停止・パラメータ変更などの命令。
- Timeline: サンプル単位のイベントキュー。

---

## アーキテクチャ概要

1. メイン（UI）スレッド
   - ファイルのロード/デコード（`decodeAudioData`）。
   - `AudioWorklet` 登録、`AudioWorkletNode` 生成、双方向メッセージング。
   - 資産（Asset）を Worklet へ転送（Float32Array）し、ID で参照。
   - ゲーム状態に応じたイベント発行（開始/停止/遷移/音量/ダッキング等）。

2. AudioWorklet（リアルタイム）
   - DSP コア（JS or Wasm）で 128 サンプルのブロック処理。
   - イベントキューをサンプル精度で消化し、Track→Bus→Master の順で合成。
   - 無割り込み・無アロケーション（初期化時に確保／リングバッファ）。

3. Wasm（Rust）コア（任意）
   - 主要 DSP（リサンプラ、ミキサ、エンベロープ、Biquad、リミッタ、サイドチェイン等）を Rust で実装し Wasm へ。
   - Worklet 側 JS は薄いグルー（メッセージデコード、バッファ参照、Wasm 呼び出し）。

---

## 処理モデル（ブロック/サンプル精度）

- AudioWorklet の `process()` は通常 128 フレーム単位。内部は「サンプル単位」のミニループでイベント境界を処理。
- 時間表現
  - `sampleTime`（int64）: コンテキスト開始からの累積サンプル数。
  - `sr`（float）: サンプルレート。
  - UI からのイベントは `whenSamples`（絶対）または `whenSec`（相対/絶対）で指定可能。
- イベント適用
  - ブロック開始〜終了の間に発生するイベントは、イベントのサンプル位置まで“部分レンダー→パラメータ更新→続き”で処理。

### 時間同期（UI↔Worklet）
- 基準時刻: Worklet が `currentSample` と `sampleRate` を定期送信。
- UI は「ルックアヘッド」を持ってスケジュール推奨:
  - `nowSamples = currentSample + floor(sr * lookaheadSec)` を基準に `whenSamples` を計算し送信。
  - `lookaheadSec` は 10–30ms 程度を推奨（ポストメッセージ遅延吸収）。
- 連続遷移（インタラクティブ音楽）
  - `nextMarker` 指定は Worklet 側で marker 配列から次境界サンプルを解決し、その境界に正確に遷移させる。

---

## オブジェクト構成

### Asset
- 構造: `{ id, sampleRate, channels: Float32Array[] }`（各チャネルの長さは同一）。
- 要件: `sampleRate === context.sampleRate`。異なる場合は Worklet 受信時に高品質リサンプルして保管（オフライン実施）。

### Track
- 再生: `assetId`, `offsetSamples`, `gainDb`, `pan`, `loop` 設定。
- ループ:
  - `none`: ループなし。
  - `seamless`: ループポイント `[loopStart, loopEnd)` でサンプル単位に瞬時接続（隙間ゼロ）。
  - `xfade`: ループ末尾と先頭を `crossfadeMs` でオーバーラップ加算（等電力カーブ）。
- インタラクティブ音楽: Segment/Marker を Track に付与可能（後述）。
- フェード: `fadeInMs` / `fadeOutMs`、指数/等電力カーブ。パラメータはサンプル補間でクリック回避。
 - パン: `pan∈[-1..+1]`、等電力パン法（-3dB パンロー）で左右係数を算出。
 - 状態: `idle → scheduled → playing → stopping(fade) → ended` の明確な遷移。`trackStarted/Ended/Looped` を通知。

### Bus
- ゲイン: `gainDb`（スムージング付き）。
- フィルタ: ローパス Biquad（12/24dB）`cutoffHz`, `Q`、係数は RBJ Cookbook に準拠。
- ダッキング: サイドチェイン入力（通常 Voice/SE バス）を鍵として、目標バス（BGM/Ambient）をコンプレッション。
  - パラメータ: `thresholdDb`, `ratio`, `attackMs`, `releaseMs`, `holdMs`, `maxAttenDb`, `makeupDb`。
  - 検波: RMS or peak（等価窓長 ~10–30ms）。
  - 減衰は等価的にゲインカーブへ合成（クリック回避のため連続関数）。
 - 複数キー: 複数バスをキーとして与えた場合は検波結果を合成（max もしくはエネルギー和のいずれか、既定は max）。

### Master
- ミックス: すべての Bus の出力を合成。
- ヘッドルーム: 既定で -6 dBFS の内部基準（各 Bus/Track のデフォルトゲインを -6dB）。
- リミッタ: 短いルックアヘッド（例 256 samples ≒ 5.3ms@48k）。`attack/release/knee` を持つ透明な ISP 近似リミッタ。
- Dither: 16bit出力は想定外（ブラウザは32bit float）なので不要。

---

## ループ仕様（詳細）

1. Seamless ループ
   - サンプル境界で `readIdx` を `loopStart` に巻き戻す。
   - ループ境界での補間は行わない（アセット自体のループ点がゼロクロス/位相整合であることが望ましい）。

2. Crossfade ループ（Ambient 向け）
   - `crossfadeMs` 指定。`loopEnd - crossfadeLen` からフェードアウトと、`loopStart` からフェードインを重ね合わせ。
   - カーブは等電力（`gA = sin^2(t)`, `gB = cos^2(t)`）を既定とする。
   - ループ長がクロスフェード長より短い場合はエラー。

3. インタラクティブ音楽（ギャップレス接続）
   - Segment（小節境界など）に `markerSamples[]` を持たせ、`transitionAt='now'|'nextMarker'|'barN'` で次セグメント/ステムへ遷移。
   - 遷移種別: `seamless`（境界瞬断）/`xfadeMs`（等電力クロスフェード）/`beatAlign`（BPM/拍子に同期）。
   - Stems: 複数 Track をグループ化（`MusicGroup`）して一斉切替/レベル操作可能。

---

## ダッキング仕様

- サイドチェイン: 任意の Bus を鍵（key）として、ターゲット Bus のゲインを減衰。
- しきい値判定は dB スケール、`ratio` に応じた減衰量を計算し、`attack/hold/release` のエンベロープで平滑化。
- 上限減衰 `maxAttenDb` を設置。BGM に過剰な“穴”が空かないよう保護。
- 既定: Voice を key に BGM/Ambient を 6–12dB 程度下げる。

---

## パラメータスムージング

- すべての可変パラメータ（ゲイン、カットオフ等）に対して、`set*` 時に目標値・所要時間を指定し、サンプル単位で補間。
- ゲインは等比（dB直線→線形振幅）または等電力、フィルタは 1 サンプルごとに係数再計算（滑らかなモジュレーション）。

---

## リサンプリング

- 入力アセットの `sampleRate` が異なる場合は Worklet受信時にオフラインで変換（高品質ウィンドウドシンク推奨）。
- 再生時のオンザフライ補間は `linear` を最小実装とし、将来 `sinc` へ切替可能。
- ループ境界の位相連続性を守るため、変換はアセット単位で事前実施を推奨。

### チャンネル/チャンネル数の扱い
- 入力は mono/stereo を想定（>2ch は将来拡張）。
- mono は L/R に同一コピーしパンで定位。stereo は LR をそのまま、パンはバランスとして扱う（将来等電力ステレオパン拡張）。

---

## メッセージ/API 仕様（UI ↔ Worklet）

WorkletNode の `port.postMessage()` で JSON と Transferable（Float32Array）をやり取りする。代表的な型を示す。

```ts
// 送信（UI → Worklet）
type MsgToEngine =
  | { type: 'init', options?: { masterHeadroomDb?: number, lookaheadSamples?: number } }
  | { type: 'loadBuffer', bufferId: string, sampleRate: number, channels: Float32Array[] }
  | { type: 'createBus', busId: string, options?: { kind?: 'bgm'|'ambient'|'sfx'|'voice'|'custom', gainDb?: number, lpf?: { enabled: boolean, cutoffHz: number, q: number, order?: 1|2 } } }
  | { type: 'createTrack', trackId: string, busId: string, assetId: string, options?: { gainDb?: number, pan?: number } }
  | { type: 'schedulePlay', trackId: string, whenSamples?: number, offsetSamples?: number, loop?: { mode: 'none'|'seamless'|'xfade', start: number, end: number, crossfadeMs?: number }, fades?: { inMs?: number, outMs?: number } }
  | { type: 'stop', trackId: string, whenSamples?: number, fadeOutMs?: number }
  | { type: 'setGain', scope: 'master'|'bus'|'track', id?: string, gainDb: number, rampMs?: number }
  | { type: 'setLPF', scope: 'bus'|'track', id: string, cutoffHz: number, q?: number, rampMs?: number, order?: 1|2 }
  | { type: 'setDucker', targetBusId: string, keyBusId: string, params: { thresholdDb: number, ratio: number, attackMs: number, releaseMs: number, holdMs?: number, maxAttenDb?: number, makeupDb?: number } }
  | { type: 'setRouting', trackId: string, busId: string }
  | { type: 'setMarkers', trackId: string, markersSamples: number[], bpm?: number, timeSig?: [number, number] }
  | { type: 'transition', groupId?: string, toTrackId: string, at: 'now'|'nextMarker'|{bar: number}, mode?: { kind: 'seamless'|'xfade', xfadeMs?: number } }
  | { type: 'setPolyphony', busId: string, maxVoices: number, policy?: 'dropOldest'|'dropNewest'|'queue' }
  | { type: 'unloadBuffer', bufferId: string }
  | { type: 'suspend' } | { type: 'resume' }
  | { type: 'query', nonce: number, what: 'time'|'playing'|'levels'|'buffers' };

// 受信（Worklet → UI）
type MsgFromEngine =
  | { type: 'ready', sampleRate: number, blockSize: number }
  | { type: 'bufferLoaded', bufferId: string }
  | { type: 'trackStarted', trackId: string, atSamples: number }
  | { type: 'trackEnded', trackId: string, atSamples: number }
  | { type: 'trackLooped', trackId: string, count: number, atSamples: number }
  | { type: 'levels', masterRms: number, buses: Record<string, { rms: number, gainDb: number }> }
  | { type: 'time', currentSample: number }
  | { type: 'polyphonyLimited', busId: string, droppedTrackId?: string }
  | { type: 'suspended' } | { type: 'resumed' };
```

エラーは `{ type: 'error', code, message }` で返す。リアルタイム中は例外を投げずエラー統計に加算。

---

## クリッピング防止とレベル設計

- 既定ヘッドルーム: 各 Track/BUS のデフォルトゲインは -6 dB。Master リミッタの `ceiling` は -1.0 dBFS 相当。
- リミッタ: ルックアヘッド付きピークリミッタ（ソフトニー）。パラメータは `attackMs≈1–5`, `releaseMs≈50–200`, `knee≈3dB` を推奨。
- クリップ検出: サンプル範囲超過を検知しカウンタ送出（デバッグHUD用）。
 - 目標レベル: 通常運用は Master RMS -18〜-12dBFS、瞬間ピーク -3〜-1dBFS を推奨。

---

## フィルタ（ローパス）

- 実装: RBJ Biquad係数。12dB（1段）/24dB（直列2段）を選択。
- スムージング: `cutoffHz`/`Q` のモジュレーションはサンプルごとに係数補間または再計算。

---

## 実装計画（Step-by-Step）

1) 最小エンジン（MVP）
- WorkletNode/Processor の骨格、メッセージ基盤、Asset登録、単一 Track→Master の再生（シームレスループあり）。

2) ミキサ/バス
- 複数 Track と複数 Bus、階層ゲイン、マスター合成。

3) パラメータスムージング/フェード
- ゲイン/パンのスムージング、フェードイン/アウト。

4) クリッピング防止
- ヘッドルーム導入、マスターリミッタ実装、クリップ検出通知。

5) ループ拡張
- クロスフェードループ（等電力）、エラー条件整備。

6) ダッキング
- サイドチェインコンプレッサ、Bus 間の鍵ルーティング、既定プロファイル（Voice→BGM/Ambient）。

7) ローパス
- Biquad LPF（12/24dB）を Bus に実装、パラメータランプ。

8) インタラクティブ音楽基盤
- Marker/Segment、`nextMarker` 遷移、ステム同報制御。

9) リサンプル
- オフライン高品質リサンプラ（Asset受信時）、再生時線形補間の撤廃。

10) テレメトリ/デバッグ
- レベルメータ、クリップカウンタ、ループイベント通知。

11) ライフサイクル/可搬性
- `suspend/resume`、`visibilitychange` 連動、Autoplay規制回避（ユーザー操作による初期解放）。
- AudioWorklet 非対応環境のフォールバック戦略（最低限は未サポート表示、将来 ScriptProcessorPolyfill を検討）。

---

## Rust/Wasm コア（参考設計）

モジュール例（`rust/audio_core` として独立可／現行 `sampo_core` に統合も可）

```rust
// 1ブロック処理のエントリ（AudioWorklet から呼び出し）
// in/out は 2ch、len=block_size。内部でトラック合成。
#[wasm_bindgen]
pub fn process_block(block_index: u64, out_l: &mut [f32], out_r: &mut [f32]);

// メッセージ適用（UIから JSON で届くコマンドを逐次反映）
#[wasm_bindgen]
pub fn apply_command(json: &str);

// アセット登録（チャンネル毎PCM）
#[wasm_bindgen]
pub fn register_asset(id: u32, channels: js_sys::Array, sample_rate: f32);
```

リアルタイム中は `process_block` でヒープ割当て禁止。リングバッファでコマンドを受け取り、ブロック内でサンプル境界に分割適用する。

---

## Nuxt/Vue 統合（概要）

1. 初期化
   - `AudioContext` を作成し `audio-engine.worklet.js` を登録。
   - `new AudioWorkletNode(context, 'audio-engine')` を生成。
   - Autoplay規制: 初回はユーザー操作イベントで `context.resume()` を呼び、`init` を送信。

2. アセット
   - `fetch`→`decodeAudioData`→チャネルごと `Float32Array` を Worklet へ転送（`loadBuffer`）。
   - 大容量の連続BGMは事前デコード・分割（チャンク）またはプリロールを推奨。メモリ上限に注意（端末により 50–200MB 程度）。

3. 再生
   - `createBus`（bgm/ambient/sfx/voice）→`createTrack`→`schedulePlay`。
   - ボイス再生時は `setDucker` で BGM/Ambient に鍵を設定。

4. コントロール
   - 音量/フィルタ/遷移/停止を随時メッセージで更新。定期的に `time`/`levels` を要求し HUD 表示。
   - `setPolyphony` で SE バスの同時発音上限を制御。過剰発音時のポリシー（既定: `dropOldest`）。

---

## 既知の制約と注意

- `SharedArrayBuffer` を使う場合は `crossOriginIsolated` が必要。未満環境では通常 `postMessage` コピーで代替（大容量は分割）。
- `decodeAudioData` は Worklet で使えないため、必ずメインスレッドで実施。
- ループの“無ギャップ”はアセット品質（ゼロクロス/周期整合）に依存。必要に応じて事前整形を推奨。
- 過度なエフェクトは当面非対応（LPF のみ）。将来的拡張余地としてエフェクトチェーンのフックを用意。
 - ハードウェアのサンプルレート変更（デバイス切替）では`AudioContext`再生成が必要になる場合がある。
 - メッセージ量が多い場合は結合（バッチ）送信を推奨。可能なら `SharedArrayBuffer` を用いたリングバッファ化。

---

## 完了定義（DoD）

- BGM/SE/ボイスの同時再生が可能で、発話時にBGMが自動でダッキングされる。
- BGM（seamless）と Ambient（crossfade）のループが 1 サンプルの隙間もなく繋がる。
- 0 dBFS 超過が発生せず（リミッタ稼働ログ/クリップカウンタ=0）、音量・LPF がランプでクリックレスに変化。
- API で定義した主要メッセージが往復し、エラーが UI に通知される。

---

## 付録: 代表的パラメータ既定値

- Master: `headroom=-6dB`, `limiter.ceiling=-1.0dBFS`, `lookahead=256smp`。
- Ducker: `threshold=-24dBFS`, `ratio=6:1`, `attack=10ms`, `release=200ms`, `maxAtten=12dB`。
- LPF: 既定 `disabled`、例 `cutoff=1200Hz`, `Q=0.707`。
- Crossfade loop: `crossfadeMs=150–300ms`（素材に応じ調整）。
