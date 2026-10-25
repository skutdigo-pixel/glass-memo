# Glass Memo

開いた瞬間にメモが書ける、フリック操作のタスク管理 Web アプリ。モバイルファースト、白ベースの Liquid Glass UI。

## 機能
- **時間に合わせて出るタスク(今日)**: 開いた時刻に応じて「いま」「30分以内」「遅れ」「今日中」「このあと」「完了」に自動で振り分け。1日のスケジュール(7:30〜17:00)の各時間帯のやることが、その時間に開くと一番上に並ぶ。20秒ごとに更新。日曜は休業日として表示なし
- **今週 / 今月**: 週初めの確認、月初・中旬・月末の業務(締切日つき。過ぎた未完了は赤枠)
- **マニュアル**: 入社マニュアル21件の全文を閲覧でき、各タスクをタップすると該当する手順が開く。チェックリスト系は「今日に追加」で一括タスク化
- **音声入力**: マイクで録音、または音声ファイルを添付 → Cloudflare Workers AI (Whisper) で文字起こし → AI がタスクに分割して追加
- 起動直後に入力欄へフォーカス。Enter で即保存、フォーカスは維持(連続入力可)
- タスクカードを右フリックで ToDo → Doing → Done、左フリックで一つ戻す(ToDo で左フリックは削除)
- 全画面スケルトンローディング
- Google 認証のみ
- AI ボタン: 入力した文章を Cloudflare Workers AI が複数のタスクへ分割して一括追加

## 技術選定と理由

| 領域 | 採用 | 理由 |
|---|---|---|
| ランタイム | Node.js 24 | 組み込みの `node:sqlite` が使え、ネイティブビルド依存がない。Docker イメージが単純で Fly.io で安定して動く |
| バックエンド FW | Hono | 小さく速い。Web 標準の Request/Response ベースで、将来 Workers 等へ移植もしやすい。依存を 2 パッケージ(hono, @hono/node-server)に抑えられる |
| DB | SQLite (`node:sqlite`) + Fly Volume | 個人用タスクデータは単一ノードで十分。外部 DB 不要で運用コスト・レイテンシが最小。`/data` ボリュームに永続化 |
| フロント | ビルドなしの素の HTML/CSS/ES Modules | 「開いた瞬間」を最優先するため JS を最小化(フレームワーク/バンドル無し)。初回描画とフォーカスまでが最短 |
| 認証 | Google OAuth 2.0 / OIDC を自前実装(認可コード + PKCE + state) | 「Google のみ」の要件に対し、必要な処理は小さい(リダイレクト、トークン交換、id_token の claims 検証)。認証ライブラリを入れず攻撃面と依存を減らす。id_token は TLS 経由で Google のトークンエンドポイントから直接受け取るため、OIDC Core 3.1.3.7 に従い署名検証を省略し iss/aud を検証 |
| セッション | ランダムトークンを SHA-256 ハッシュで SQLite 保存、HttpOnly + SameSite=Lax + Secure Cookie | JWT より失効(ログアウト)が確実。サーバー側ストアが元々あるため追加コストなし。変更系 API は JSON の Content-Type 必須で簡易 CSRF 対策 |
| AI 呼び出し | バックエンドから Cloudflare Workers AI の REST API(`/ai/run/@cf/meta/llama-3.1-8b-instruct`) | API トークンをブラウザへ出さない。Fly.io 側から直接呼べ、Workers のデプロイが不要。JSON モードで出力を構造化し、タスク分割用途に十分な軽量モデルで低遅延・低コスト。モデルは `CF_AI_MODEL` で差し替え可 |
| アニメーション | CSS(transition/keyframes/spring 風 cubic-bezier)+ Web Animations API | ライブラリ不要で 60fps(transform/opacity のみ)。スワイプ追従は Pointer Events(マウス/タッチ共通)、`touch-action: pan-y` で縦スクロールと両立。`prefers-reduced-motion` を尊重 |
| Liquid Glass | `backdrop-filter: blur() saturate()` + 半透明グラデーション + 内側ハイライトの多層 box-shadow、背景はゆっくり漂うぼかし円 | 全ブラウザで動く範囲で Liquid Glass の質感(屈折風の光沢・透過)を再現。SVG 屈折フィルタは Safari 非対応のため不採用 |
| スケルトン | 初期 HTML に同梱 | JS 読込前から表示でき、API 完了後にフェードアウト(最低 800ms 表示して点滅を防止) |
| 音声入力 | MediaRecorder で録音 → バックエンド経由で Workers AI の Whisper (`@cf/openai/whisper-large-v3-turbo`) | ブラウザ内蔵の音声認識(Web Speech API)は iOS Safari などで挙動が不安定。録音+サーバー側認識なら端末差が小さく、日本語精度が高く、音声ファイルの取り込みも同じ経路で扱える。API トークンはサーバー内に留まる |
| 時間ごとの表示 | クライアント時刻で分類(いま=開始≤現在<終了、30分以内=開始まで30分以内、遅れ=終了済みで未完了) | サーバーは日・週・月ごとにタスクを自動生成するだけにして、「今何をすべきか」は端末の時計で即時に判定(通信不要)。`?t=09:00&d=YYYY-MM-DD` で時刻を指定して確認可能 |
| マニュアルデータ | `private/manual.json`(git 管理外) | 社内マニュアルの内容は公開リポジトリに入れない。Docker イメージにのみ同梱し、ログインしたユーザーだけが API / 画像を取得できる。生成スクリプトも非公開 |
| ホスティング | Fly.io (Docker) | 要件。`auto_stop_machines` で無通信時は停止し低コスト、Volume で SQLite を永続化 |

## ローカル開発
```bash
npm install
npm run dev   # DEV_AUTH=1 AI_MOCK=1: Google/Workers AI を使わず動作(本番では無効)
```
`http://localhost:3000` を開き、`dev` ボタンで開発用ログインできます。

## 必要な秘密情報(リポジトリには含めません)
`.env.example` を参照。

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google Cloud Console の OAuth クライアント(Web)。承認済みリダイレクト URI に `https://<app>.fly.dev/auth/google/callback`
- `BASE_URL`: 公開 URL
- `CF_ACCOUNT_ID` / `CF_API_TOKEN`: Workers AI 権限のトークン

## Fly.io へのデプロイ
```bash
fly launch --no-deploy --copy-config
fly volumes create memo_data --size 1 --region nrt
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... BASE_URL=https://<app>.fly.dev CF_ACCOUNT_ID=... CF_API_TOKEN=...
fly deploy
```
SQLite のためマシンは 1 台で運用してください。

## ワンコマンドデプロイ
`.env` に値を入れ(git 管理外)、`fly auth login` 後に `scripts/deploy.sh <app名>` を実行すると、アプリ作成、Volume 作成、secrets 登録、デプロイまで行います。

## マニュアルデータについて
`private/manual.json` と `private/media/` は公開リポジトリに含まれません。無い場合は空のタスク管理アプリとして動作します(Docker ビルドには `private/` ディレクトリが必要)。
