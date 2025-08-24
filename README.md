# Sanpo App（散歩アプリ）基盤

このプロジェクトは「散歩アプリ」の基盤づくりを目的に、Web GUI 上で GeoJSON マップを表示し、プレイヤー（あなた自身）の移動・向き・速度を操作／可視化できるデバッグ環境を提供します。将来的には「音やイベントの発火」「ルート探索」などを拡張予定ですが、まずは技術的な基盤（地図表示＋プレイヤー動作）を最優先しています。

## 直近の目標（ゴール）

- Web GUI 上で GeoJSON マップを表示できること
- プレイヤー操作（移動・回頭・速度）の可視化とデバッグができること
- ゲーム演出ではなく、まずはインタラクティブに動作確認できる環境を整備すること

## クイックスタート / 使い方

1) 依存のインストール（任意のパッケージマネージャー）

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

2) 開発サーバを起動

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

3) ブラウザで以下を開くと、マップとHUD（操作UI）が表示されます

- http://localhost:3000/walk?id=level

4) 独自のルートを試すには、`public/routes/<id>.geojson` を追加し、`/walk?id=<id>` にアクセスします。
   詳細な手順は [`public/routes/README.md`](public/routes/README.md) を参照してください。

## 基本機能

- GeoJSON 表示: `public/routes/<id>.geojson` を青いラインで描画（LineString）
- プレイヤー操作: Move/Pause、左右回頭、速度スライダー、ドラッグで位置調整、WASD/矢印キー操作
- カメラ追従: プレイヤー位置へ `easeTo()` でセンタリング
- HUD: 画面左下に操作パネルと現在座標を表示

## Controls & Map Navigation

- **Move/Pause**: start or stop automatic movement along the current heading.
- **⟲ / ⟳**: rotate the player heading by 5° increments.
- **Speed slider**: set movement speed in meters per second.
- **Drag marker**: reposition the player on the map.
- **Keyboard**: arrow keys or WASD adjust speed and heading; space toggles movement.
- **Map navigation**: drag to pan, scroll to zoom, and use standard MapLibre gestures for rotation and pitch.

## 技術スタック（抜粋）

- Nuxt 4（TypeScript）
- MapLibre GL（地図表示）
- @turf/turf（移動計算: destination）

## 主要ファイル

- `pages/walk.vue`: クエリの `id` から GeoJSON ルートを読み込み、`MapView` に渡すページエントリ
- `components/MapView.vue`: ルートとプレイヤーマーカーを描画し、HUD 操作やカメラ追従を担当する地図コンポーネント
- `composables/usePlayer.ts`: プレイヤー位置・向き・速度を管理し、移動ロジックを提供するコンポーザブル
- `public/routes/level.geojson`: サンプルルート
- `docs/` 内に仕様ドキュメント（Sanpo GeoMap 仕様 v1）

## 今後の拡張（構想）

- 音やイベントの発火
- ルート探索・スナップ移動
- 初期 `fitBounds`、視野表現、PWA/オフライン

---

下記は Nuxt 公式のセットアップガイドです（プロジェクト運用の参考）。

# Nuxt Minimal Starter

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
