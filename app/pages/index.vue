<template>
  <div class="container">
    <h1>Sanpo App（散歩アプリ）</h1>
    <p>HTML5 Canvas上でOpenStreetMapタイルとGeoJSONデータを表示し、プレイヤーの移動・向き・速度を操作できるデバッグ環境です。</p>
    
    <div class="actions">
      <NuxtLink to="/walk?id=level" class="btn btn-primary">
        サンプルルートを開く
      </NuxtLink>
    </div>

    <div class="features">
      <h2>主な機能</h2>
      <ul>
        <li>Canvas レンダリングによる高速マップ表示</li>
        <li>GeoJSON形式のルート表示（LineString・Polygon対応）</li>
        <li>OpenStreetMapタイルによる詳細地図</li>
        <li>プレイヤーマーカーのドラッグ操作</li>
        <li>WASD画面方向移動（マップ回転追従）</li>
        <li>QEキーによるマップ回転機能</li>
        <li>整数ズーム（1-18レベル）</li>
      </ul>
    </div>

    <div class="usage">
      <h2>使い方</h2>
      <ol>
        <li>上の「サンプルルートを開く」ボタンをクリック</li>
        <li>地図が表示されたら、赤い三角マーカーがプレイヤーです</li>
        <li>キーボード操作：
          <ul>
            <li><strong>WASD</strong>: 画面方向移動（マップ回転追従）</li>
            <li><strong>QE</strong>: マップ回転（15度ずつ）</li>
            <li><strong>R</strong>: プレイヤー位置リセット</li>
          </ul>
        </li>
        <li>マウス操作：
          <ul>
            <li><strong>ホイール/+−ボタン</strong>: ズーム調整</li>
            <li><strong>ドラッグ</strong>: プレイヤー位置を移動</li>
          </ul>
        </li>
        <li>青い線がLineString、薄緑色がPolygonとして表示されます</li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.container {
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
  line-height: 1.6;
}

h1 {
  color: #2d3748;
  margin-bottom: 1rem;
}

h2 {
  color: #4a5568;
  margin-top: 2rem;
  margin-bottom: 1rem;
}

.actions {
  margin: 2rem 0;
  text-align: center;
}

.btn {
  display: inline-block;
  padding: 12px 24px;
  text-decoration: none;
  border-radius: 6px;
  font-weight: 600;
  transition: all 0.3s ease;
}

.btn-primary {
  background-color: #3182ce;
  color: white;
}

.btn-primary:hover {
  background-color: #2c5aa0;
  transform: translateY(-2px);
}

.features ul, .usage ol, .usage ul {
  padding-left: 1.5rem;
}

.features li, .usage li {
  margin-bottom: 0.5rem;
}

.usage ul {
  margin-top: 0.5rem;
}
</style>
