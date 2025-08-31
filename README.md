# Sanpo App（散歩アプリ）- Canvas Map Version

このプロジェクトは「散歩アプリ」の基盤づくりを目的に、HTML5 Canvas上でOpenStreetMapタイルとGeoJSONデータを表示し、プレイヤー（あなた自身）の移動・向き・速度を操作／可視化できるデバッグ環境を提供します。

## 完成予定のアプリについて

**最終的には位置情報を利用した「散歩型アプリ／探索ゲーム」を目指しています。**

完成するアプリは、位置情報を利用した「散歩型アプリ／探索ゲーム」です。
プレイヤーは実際に歩きながら地図上を移動し、ルートをたどります。
移動に応じて音楽や環境音が変化し、場所や状況に合わせてボイスやイベントが発生します。
ルートから外れるとBGMが変化・消失し、方向感覚を音で表現します。
分岐点では「右に行くか、まっすぐ進むか」といった選択肢が提示されます。

本アプリは「**オーディオゲーム**」として設計されており、視覚よりも音の変化やボイスによる誘導が主な体験要素です。
天気や時間帯など現実の情報とも連動し、毎回違った体験が楽しめます。
ただの地図アプリではなく「**音で導かれる冒険**」として散歩を体験できます。
探索の途中にはポータルや秘密の場所があり、世界観の断片を感じられます。
最終的には「**散歩そのものが冒険だった**」と実感できるように設計されます。

### 現在の開発段階

**このリポジトリは上記アプリの技術基盤（地図表示・プレイヤー移動・GeoJSON描画）部分です。**

将来的に以下の機能が追加予定：
- 📍 GPS/位置情報連携
- 🎵 位置ベース音楽・環境音システム
- 🗣️ ボイス・イベント発火システム  
- 🎯 ルート逸脱検知・音響フィードバック
- 🌟 ポータル・秘密エリア・分岐システム
- 🌤️ 天気・時間帯連動
- 📱 PWA・オフライン対応

## 主な特徴

- **Canvas レンダリング**: HTML5 Canvasによる高速で安定したマップ表示
- **OpenStreetMap タイル**: タイル表示による詳細な地図情報
- **GeoJSON サポート**: LineString（線）とPolygon（面）の描画
- **直感的な操作**: WASD キーによる画面方向移動とマップ回転機能

補足（現行デバッグ実装）
- フルスクリーン表示（Canvas / MapLibre）と常時プレイヤー中央追従
- ズーム連動の移動幅（z=19で1m、縮小で×2、拡大で×0.5）
  - Shift=×5、Alt=×0.5 で微調整
- 回転は5°ステップ（Q/E）
- z>19はz=19タイルを拡大して表示（最大22まで表示）

## クイックスタート

### 1. 依存関係のインストール

```bash
# pnpm推奨
pnpm install

# または
npm install
```

### 2. 開発サーバーを起動

```bash
pnpm dev
# または
npm run dev
```

### 3. ブラウザでアクセス

- トップページ: http://localhost:3000/
- サンプルマップ: http://localhost:3000/walk?id=level

## 操作方法

### キーボード操作
- **W**: マップの画面上方向に移動（ズームに応じて距離自動調整）
- **A**: マップの画面左方向に移動
- **S**: マップの画面下方向に移動  
- **D**: マップの画面右方向に移動
- 補助キー: Shift=粗く（×5）, Alt=細かく（×0.5）
- **Q**: マップを左に5度回転
- **E**: マップを右に5度回転
- **R**: プレイヤー位置をリセット

### マウス操作
- **ホイール**: ズームイン/ズームアウト
- **+/-ボタン**: ズーム操作
- **ドラッグ（Canvas）**: マップを引っ張るようにパン（プレイヤーは常に中央）

### 特殊な動作
- WASD移動は**マップの回転に追従**します（マップが回転していても画面方向に移動）
- プレイヤーマーカーは常に北を向きます（赤い三角形）

## 地図表示機能

### サポートするGeoJSON形式

#### LineString（線路・道路）
```json
{
  "type": "LineString",
  "coordinates": [
    [経度, 緯度],
    [経度, 緯度]
  ]
}
```
- **表示**: 青い線（4px太さ）

#### Polygon（エリア・建物）
```json
{
  "type": "Polygon", 
  "coordinates": [[
    [経度, 緯度],
    [経度, 緯度],
    [経度, 緯度],
    [経度, 緯度]  // 最初と最後は同じ座標で閉じる
  ]]
}
```
- **表示**: 薄い緑色の塗りつぶし + 緑の輪郭線

### マップタイル
- **ソース**: OpenStreetMap (tile.openstreetmap.org)
- **ズームレベル**: 1–22（z>19はz=19タイルを拡大表示）
- **タイルサイズ**: 256px
- **投影法**: Web Mercator (EPSG:3857)

## ルートデータ（GeoJSON）

- 配置場所: `public/routes/<id>.geojson`
- 取得先（API）: `/api/routes/:id`（サーバー: `server/api/routes/[id].get.ts`）
- 座標順序: `[経度, 緯度]`（WGS84 / EPSG:4326）

### Feature ID 仕様（重要）
- 各 Feature の `properties.id` は参照用の一意なID（文字列）として扱います。
  - 道（LineString）: 例）`"root1"`, `"root2"`, `"root3"`
  - エリア（Polygon）: 例）`"start"`, `"goal"`（将来: `"battle"`, `"notify"` など）
- 複数形状（`MultiLineString`/`MultiPolygon`）は、それぞれ `id:part-index` で分割登録されます（例: `root:0`, `root:1`）。
- `properties.id` が無い場合はフォールバックとして `properties.name`、それも無ければ `feature-<index>` を自動採番（Rustコア取り込み仕様）。

サンプル `public/routes/level.geojson` では、以下のIDが付与されています。
- Polygon（エリア）: `start`, `goal`
- LineString（道）: `root1`, `root2`, `root3`

これらのIDは Wasm コアの戻り値として使用されます。
- `nearest_road_id(lat,lng)` → 最も近い道の `id`（例: `root2`）
- `current_area_id(lat,lng)` → 現在位置が含まれるエリアの `id`（例: `start`/`goal`）

## ファイル構成

```
sampo-app/
├── components/
│   ├── CanvasMapView.vue      # Canvas版マップコンポーネント
│   └── MapView.vue            # MapLibre版（代替表示）
├── composables/
│   └── usePlayer.ts           # プレイヤー状態管理（ズーム連動の移動幅）
├── app/pages/
│   ├── index.vue              # ホームページ
│   └── walk.vue               # マップページ
├── public/routes/
│   ├── level.geojson          # サンプルGeoJSONデータ
│   └── README.md              # GeoJSONデータの作成方法
└── server/api/routes/
    └── [id].get.ts            # GeoJSONファイル読み込みAPI
```

## 技術仕様

### フロントエンド
- **フレームワーク**: Nuxt 4 + Vue 3
- **レンダリング**: HTML5 Canvas 2D Context（MapLibre 代替あり）
- **地理計算**: Turf.js 7.2.0
- **TypeScript**: 完全対応

### マップエンジン
- **タイル配信**: OpenStreetMap
- **座標系**: WGS84 (EPSG:4326) → Web Mercator (EPSG:3857)
- **描画**: Canvas 2D API
- **キャッシュ**: Map<string, HTMLImageElement> によるタイル管理

## カスタムGeoJSONルートの追加

### 1. GeoJSONファイルを作成
`public/routes/my-route.geojson` を作成：

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {},
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [139.8145, 35.7713],
          [139.8151, 35.7712]
        ]
      }
    }
  ]
}
```

### 2. ブラウザでアクセス
http://localhost:3000/walk?id=my-route

詳細は `public/routes/README.md` を参照してください。

## 開発・カスタマイズ

### プレイヤー初期位置の変更
`composables/usePlayer.ts` の以下の行を編集：

```typescript
const position = reactive<Position>({ lat: 35.77134, lng: 139.81465 })
```

### 移動距離（歩幅）の調整
`usePlayer.ts` のキーハンドラーでズーム連動の歩幅を変更できます：

```typescript
// baseStep は z=19 で 1m、拡大で 0.5m、縮小で 2m の指数スケール
const z = getZoom ? getZoom() : 19
const baseStep = Math.pow(2, 19 - z)
// 修飾キー倍率（例）
let stepMeters = baseStep
if (event.shiftKey) stepMeters *= 5
if (event.altKey) stepMeters *= 0.5
```

### マップスタイルの変更（Canvas）
`components/CanvasMapView.vue` の描画設定：

```typescript
// LineString の色・太さ
ctx.strokeStyle = '#0066ff'
ctx.lineWidth = 4

// Polygon の塗りつぶし・輪郭
ctx.fillStyle = 'rgba(0, 255, 0, 0.3)'
ctx.strokeStyle = '#00aa00'
```

## パフォーマンス

### 最適化済み機能
- **タイル キャッシュ**: 一度読み込んだタイルを再利用
- **非同期待ちを排除**: 描画フレーム内ではキャッシュ済みのみ描画、未ロードは非同期で取得
- **オーバーズーム**: z>19 は z=19 を拡大して安定表示

### パフォーマンス指標
- **フレームレート**: 60fps (requestAnimationFrame)
- **タイル読み込み**: 非同期・並列処理

## トラブルシューティング

### よくある問題

#### GeoJSONが表示されない
1. ファイル形式がGeoJSON標準に準拠しているか確認
2. 座標が [経度, 緯度] の順番になっているか確認
3. ブラウザの開発者ツールでネットワークエラーがないか確認

#### 移動が期待通りに動かない
1. キーボードフォーカスがマップ上にあるか確認
2. ブラウザのConsoleにエラーメッセージがないか確認

#### タイルが読み込まれない
1. インターネット接続を確認
2. OpenStreetMapのサーバー状況を確認

## ライセンス

このプロジェクトはオープンソースです。

### 使用している外部リソース
- **地図タイル**: OpenStreetMap contributors (ODbL License)
- **地理計算**: Turf.js (MIT License)
- **フレームワーク**: Nuxt/Vue.js (MIT License)

---

## 今後の拡張予定

### フェーズ1: 位置情報連携
- [ ] GPS/位置情報API連携
- [ ] リアルタイム位置トラッキング
- [ ] 実世界座標とGeoJSONルートの照合

### フェーズ2: オーディオシステム基盤
- [ ] 位置ベース音楽・環境音再生
- [ ] ボイス・効果音システム
- [ ] 音響距離感・方向感の実装

### フェーズ3: ゲーム要素
- [ ] ルート逸脱検知とBGM変化
- [ ] 分岐点での選択肢システム
- [ ] ポータル・秘密エリア発見
- [ ] 世界観・ストーリー要素

### フェーズ4: 環境連動・最適化
- [ ] 天気API連動（音響変化）
- [ ] 時間帯連動システム
- [ ] PWA化・オフライン対応
- [ ] パフォーマンス最適化

### 最終目標
「**散歩そのものが冒険だった**」と実感できる、音で導かれる位置情報ベース探索ゲームの完成

## モバイル展開とアーキテクチャ方針（重要）

- 最終ターゲット: iOS / Android へのリリース。その前段として PWA を想定。
- コア実装の方針: ゲームのコア（地理ロジック/状態遷移）とオーディオのコア（ミキシング/ループ/遷移）は Rust で実装し、Web では Wasm、ネイティブでは静的ライブラリとして再利用します。
- JS/TS の役割: できる限り薄いホスト・UI層とし、基本は「オーディオフレームの入出力（AudioWorklet）」「入力/描画」「Wasmブリッジ」に限定。ドメインロジックやDSPは Rust 側に寄せます。
- 本リポジトリの Nuxt ページは「デバッグ/レベルデザイン/デモ」用途です。製品UIではなく、開発補助のための HUD と操作系を備えます。

メモ（忘備録）
- ループ（seamless/xfade）・インタラクティブ遷移（loopEnd/nextMarker）・ダッキング等のオーディオ挙動は Rust 側に集約し、TS 側はフラグやコマンドを渡すのみとする。
- PWA 化: 音声アセットのキャッシュ戦略、Wasm 生成物の precache、オフライン起動の検討。
- ネイティブ移植: iOS/Android 向けに Rust コアを静的リンク（AudioWorklet 相当は各OSの低レイテンシAPIにブリッジ）。

詳しいリファクタリング計画は `docs/refactoring-plan.md` を参照してください。

## Rust→Wasm コア（ゲーム基盤）

本プロジェクトには、ゲームコアの試作として Rust 製の Wasm モジュールを同梱しています。

- ソース: `rust/sampo_core/`
- ビルド成果物の配置先: `public/wasm/`
- 参照方法（例）: フロント側で `import("/wasm/sampo_core.js")` し、`init_geojson`, `nearest_road_id`, `current_area_id` を呼び出し

### 提供API（暫定）
- `init_geojson(json: string)`: GeoJSONを読み込み、道路（LineString）・エリア（Polygon）をインデックス化
- `nearest_road_id(lat: number, lng: number): string | undefined`: 現在地点に最も近い道路IDを返却
- `nearest_road_distance_m(lat: number, lng: number): number`: 最も近い道路までの最短距離（m）。該当なしは `NaN`
- `current_area_id(lat: number, lng: number): string | undefined`: 現在地点が含まれるエリアIDを返却
- `summarize(): string`: 取り込んだ要素数の要約
- `current_area_ids(lat: number, lng: number): string`（JSON配列）: 現在地点が含まれる全エリアIDを返却
- `query_point(lat: number, lng: number): string`（JSON）: `{ roadId: string|null, areaIds: string[], distanceMeters: number|null }`

GeoJSON の `properties.id`（または `name`）を参照用IDとして使用します。未指定の場合は `feature-<index>` を採番します。

TypeScript ラッパ（composables/useSampoCore.ts）
```ts
import { useSampoCore } from '~/composables/useSampoCore'

const core = useSampoCore()
await core.init(routeGeoJSON)

const { roadId, areaIds, distanceMeters } = await core.query(35.77134, 139.81465)
console.log(roadId, areaIds, distanceMeters) // 例: 'root2', [], 12.3

// 距離だけを個別に取りたい場合
const d = core ? (await (async () => mod.nearest_road_distance_m(35.77134, 139.81465))()) : null
```

### ビルド前提
1. Rust ツールチェーン（stable）
2. wasm-pack（https://rustwasm.github.io/wasm-pack/）

### ビルド手順
```bash
# Wasm をビルドして public/wasm に出力
npm run wasm:build

# Nuxt を起動（事前に wasm:build が走ります）
npm run dev
```

将来的には、イベント／音声再生（BGMレイヤ、効果音、ボイス）、状態遷移、分岐などのメインロジックを Rust 側に追加予定です。

現在進行中の変更点
- ループ（seamless/xfade）や再生制御を Rust→Wasm に段階移行中。TS 側はフラグ/コマンドを渡すだけの設計に寄せています。
- Web はデバッグ用のホストであり、製品版では Rust コアをモバイルへ再利用する方針です。

### 初期化と読み込み（Nuxt側）
- Wasm生成物は `public/wasm/` に配置（`npm run wasm:build`）
- Nuxtの`head`で `public/wasm/init.auto.js` を `type="module"` で読み込み、自動初期化します
  - 参照: `nuxt.config.ts` に `app.head.script: [ { src: '/wasm/init.auto.js', type: 'module' } ]`
- SSR中はスタブが返るため、実処理はクライアントで動作します（コンソールに `summary: server` が表示されるのは想定どおり）

### デバッグHUD（Canvas）
- HUDに以下を表示（`components/CanvasMapView.vue`）
  - 現在座標／向き／ズーム／地図ベアリング
  - Nearest road: 近い道IDと線までの最短距離（m）
  - Area IDs: 現在位置が含まれる全エリアID
- プレイヤー移動時に約120ms間隔で再計算してWasmに問い合わせます
- ルートデータ変更時は再初期化→再計算します

### テスト（Rust）
- `cargo test --manifest-path rust/sampo_core/Cargo.toml`
  - `public/routes/level.geojson` を読み込み、
    - startエリア内で areaIds に `start` を含むこと
    - 初期座標で areaIds が空かつ最近道路が取得できること
  を検証
