# リファクタリング計画（Rustコア集中・PWA/モバイル対応）

目的
- iOS/Android リリースを見据え、PWA を含む複数ターゲットで同一の「ゲームコア／オーディオコア」を再利用できる構成にする。
- JS/TS の責務を極小化し、Rust 側へドメイン/オーディオのロジックを集約。Web は主に UI/入力/描画/ブリッジに限定。

方針
- コアの境界を明確化: Rust＝ゲーム状態・イベント・オーディオDSP、JS＝Wasm呼び出し・UI。
- Web（AudioWorklet）は「オーディオフレームの入出力」と「コマンド転送」のみ。
- デバッグ/レベルデザインは Web HUD（Nuxt）で継続。製品版 UI は別途。

ステップ計画
1) オーディオコア（Rust→Wasm）
- [完了/進行中] ループ（seamless/xfade）、線形補間、パン/ゲイン、トラック合成、`audio_process_into(outL,outR)` 実装。
- [次] トランジション（`loopEnd`/`nextMarker`/`now`）を Rust 側に集約。
  - API: `audio_set_markers(track, &[u32])`, `audio_transition(track, at, to_asset, loop_cfg)`
- [次] ダッキング/LPF/リミッタ等の DSP を Rust 側へ移管。Worklet 側は単に `process_into` を呼ぶ。
- [将来] クリップ検出/テレメトリ（RMS/GR/clipCount）を Rust から返却、HUD表示。

2) ゲームコア（Rust）
- 位置/ルート/エリアの状態判定（既存）に加え、ゲームイベント（分岐/到達/逸脱）と遷移表を Rust 側に保有。
- オーディオ挙動（どの曲/ボイス/SEをどう遷移するか）を Rust のステートマシンで決定。TS は入力（位置/操作）を渡すだけ。
- API案:
  - `load_route(json)`, `game_tick(input: { lat,lng,dt,... }) -> Output { audio_cmds: [...], hud: {...} }`
  - データ駆動で振る舞いを変更できる `profile.json` の導入。

3) JS/Worklet 側の薄型化
- Orchestrator は Rust の出力コマンドをそのまま Worklet に転送するだけの層に縮小。
- AudioWorklet は wasm の `audio_*` API を呼ぶ最小実装へ。JS のフォールバックDSPは最終的に削除（開発中のみ残存可）。

4) PWA 化（デモ/デバッグ前提）
- Service Worker 導入: wasm/JS/主要音源の precache、runtime cache による補完。
- 大容量オーディオのキャッシュ戦略（チャンク化/圧縮/メタデータ事前取得）。
- オフライン起動（デバッグHUD機能は最小限で動作可能に）。

5) モバイル移植（iOS/Android）
- Rust コアを staticlib としてビルド。
- ネイティブ側で低レイテンシオーディオ（AAudio/AudioTrack、AVAudioEngine 等）に `process_into` 相当をブリッジ。
- 共通のコマンド/イベントスキーマを定義し、Web/ネイティブ間の整合を維持。

6) ビルド/リリースパイプライン
- wasm-pack（Web）と cargo-ndk / Xcode（ネイティブ）をCIで併用。
- アセット変換（BPM/markers抽出、ループ点埋め込み）用のスクリプトを Rust/CLI で用意。

7) テスト戦略
- Rust: コアロジックの単体テスト（ループ/遷移/境界条件）とゴールデン音声比較（小ブロック）。
- Web: E2E でコマンド→Wasm→出力までの経路を検証。HUDのテレメトリ値をスナップショット。

8) 段階的移行の管理
- 各段階で JS 実装をフォールバックとして維持しつつ、Wasm 側が安定次第に削除。
- README に「Web はデバッグ/デモ用、コアは Rust 実装」という方針を明記（済）。

インターフェース（Wasm APIの暫定案）
- Audio
  - `audio_init(sr)`
  - `audio_register_asset(id, sr, channels: Float32Array[])`
  - `audio_create_track(id, asset, pan, gain_db)`
  - `audio_schedule_play(id, offset_samples, mode, start, end, xfade_ms)`
  - `audio_set_loop(id, mode, start, end, xfade_ms)`
  - `audio_set_markers(id, markers: &[u32])`
  - `audio_transition(id, at, to_asset, loop_cfg)`
  - `audio_process_into(out_l, out_r)`
- Game（設計中）
  - `load_route(json)`, `game_tick(input) -> output`（audio_cmds/hudなど）

リスクと対策
- Worklet 内での Wasm 読み込み: dynamic import + wasm-bindgen の互換性（Safari/CORS/COEP）に注意。
- メモリ/コピー: `audio_process_into` の引数コピーを減らす最適化は次段。SharedArrayBuffer は COOP/COEP 必須。
- 大容量アセット: PWA キャッシュ容量/端末差に注意。長尺BGMはループ/セグメント化でメモリ削減。

マイルストン
- M1: ループ（seamless/xfade）を Rust に移管（完了）
- M2: transition/markers を Rust へ（次）
- M3: ダッキング/LPF/リミッタを Rust へ
- M4: JSフォールバック削減・Worklet最小化
- M5: PWA化/オフライン
- M6: iOS/Android ブリッジ PoC

備考
- 本Web実装はデバッグ/レベルデザイン/デモ用であり、製品版UIではありません。コアは Rust に寄せる前提で設計し、JSは薄いホストに留めます。
