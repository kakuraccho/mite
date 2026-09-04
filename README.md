# Mite（ミテ）

Miteは、PC操作の途中で次に何をすればよいか分からなくなった高齢者を、離れた家族が支援するためのサービスです。

家族が利用者の画面を見ながら操作する場所を伝え、利用者本人が操作して解決することを支援します。また、役立った支援内容をガイドとして残し、次回は利用者が一人でも操作できるようになる循環を目指します。

```text
家族に支援してもらう
        ↓
解決方法をガイドとして残す
        ↓
次回はガイドを使って一人で操作する
        ↓
難しければ、途中の状況を引き継いで再び家族に相談する
```

## 現在の開発状況

MVP実装仕様に基づき、利用者・家族向けElectronクライアント、API契約、共有APIクライアント、DBスキーマおよびGoサーバーのA/B/Cフローを実装しています。ローカル統合確認後、Windows実機と外部サービスを使った最終E2Eへ進みます。

## MVPの構成

- 利用者側と家族側で、それぞれ独立したWindows向けElectronアプリを提供する
- 利用者本人が操作し、家族は音声、画面共有、マーキングで支援する
- 支援中の画面からガイドの下書きを生成し、家族が確認・編集して保存する
- 保存したガイドを利用者が1ステップずつ実行し、途中から家族へ相談できる

### 採用技術

| 対象                       | 技術                                  |
| -------------------------- | ------------------------------------- |
| クライアント               | Electron、React、TypeScript、Vite     |
| サーバー                   | Go 1.26系、Chi v5                     |
| API契約                    | OpenAPI 3.0.3                         |
| データ・画像保存           | Supabase PostgreSQL、Supabase Storage |
| 音声・画面共有・マーキング | LiveKit Cloud                         |
| ガイド生成                 | Gemini API                            |

MVPでは固定の1対1とデモ用Bearerトークンを使用します。遠隔操作、カメラ映像、通話録音、本格的なアカウント機能、外部プッシュ通知は対象外です。

## ドキュメント

- [MVP実装仕様書](docs/specification.md): 実装の正本となるMVPの範囲、構成、API、状態、画面および受け入れ条件
- [プロダクトシート](docs/PS.md): 対象ユーザー、課題、提供価値および初期構想
- [サーバー・クライアント接続ガイド](docs/server-client-integration.md): ローカル起動、トークン、再送およびE2E確認手順
- [サーバー手動検証ガイド](server/MANUAL_TESTING.md): REST APIとWebSocketを`curl`で確認する手順

実装時の判断はMVP実装仕様書を優先してください。

## ディレクトリ構成

```text
.
├── api/        # OpenAPIによるAPI契約
├── client/     # 利用者・家族向けElectronクライアント
├── packages/   # 共有APIクライアント
├── docs/       # プロダクトに関する仕様・資料
├── mock/       # 画面・動作検証用のプロトタイプ
├── other/      # その他の参考資料
├── server/     # Go・ChiによるMiteサーバー
└── supabase/   # PostgreSQL migrationとseed
```

ルートと`client/`は別のnpm workspaceです。ルートはAPI生成と共有APIクライアント、`client/`は2つのElectronアプリとクライアント共通packageを管理します。

## 必要な環境

- Git
- Node.js 24 LTS
- npm 11
- Go 1.26系
- Docker（ローカルSupabaseを使う場合）
- Windows 11（Windows AppBarの実動作確認とWindows向け配布物の作成を行う場合）

Supabase CLIはルートのJavaScript依存関係に含まれるため、グローバルインストールは不要です。`oapi-codegen`と`sqlc`も`server/go.mod`のtool dependencyとして固定しています。

## セットアップ

### 1. リポジトリを取得する

```bash
git clone git@github.com:kakuraccho/mite.git
cd mite
```

GitHubへSSH接続するための設定が必要です。

### 2. 依存関係を取得する

ルートとクライアントで、それぞれ依存関係を取得します。

```bash
# リポジトリルート
npm install

cd client
npm install
cd ..
```

### 3. API型とDBアクセスコードを生成する

生成物はリポジトリに含まれていますが、生成元との一致を確認する場合は次を実行します。自動生成ファイルは直接編集しないでください。

```bash
# リポジトリルート
npm run generate:api

cd server
go tool sqlc generate
cd ..
```

## ローカルで起動する

以下は、ローカルSupabase、Goサーバー、利用者側Electron、家族側Electronを同じ開発環境で起動する手順です。ローカルSupabaseの代わりに共有環境を使う場合は、DBやStorageを初期化せず、その環境用のサーバー環境変数を設定してください。

### 1. ローカルSupabaseを起動する

Dockerを起動し、リポジトリルートで次を実行します。

```bash
npx supabase start
npx supabase db reset
```

`npx supabase db reset`は、このリポジトリのローカルDBを削除してmigrationとseedを再適用します。共有開発環境、デモ環境、本番環境には実行しないでください。

### 2. サーバー環境変数を設定する

Git管理外の`server/.env`を作成し、デモ用トークンと外部サービスの設定を入力します。`DEMO_USER_TOKEN`と`DEMO_FAMILY_TOKEN`には異なる値を設定してください。実際のトークン、DB接続文字列、APIキーをGitへ含めないでください。

```bash
cp server/.env.example server/.env
```

Goサーバーは`.env`を自動で読み込みません。サーバーを起動するターミナルで読み込んだ後、ローカルSupabaseの現在値でDB、API、Storage用の3変数を上書きします。Supabaseの再起動やreset後に古いSecret keyを使わないため、この順序で実行してください。

```bash
# リポジトリルート
set -a
source server/.env
set +a

eval "$(npx supabase status -o env 2>/dev/null)"
export DATABASE_URL="$DB_URL"
export SUPABASE_URL="$API_URL"
export SUPABASE_SECRET_KEY="$SECRET_KEY"
```

`server/.env.example`のLiveKitとGeminiのプレースホルダーでもサーバープロセス自体は起動できますが、音声・画面共有・マーキングとAIガイド生成は利用できません。これらを確認するときは、LiveKit CloudとGemini APIの有効な認証情報をサーバーだけに設定してください。

### 3. サーバーを起動する

環境変数を設定した同じターミナルで実行します。

```bash
cd server
go run ./cmd/api
```

既定では`http://localhost:3000`で待ち受けます。専用のhealth endpointはないため、起動ログまたはAPIへのリクエストで確認してください。

### 4. クライアント環境変数を設定する

別のターミナルで、利用者側と家族側それぞれの`.env.local`を作成します。

```bash
# リポジトリルート
cp client/apps/user-electron/.env.example client/apps/user-electron/.env.local
cp client/apps/family-electron/.env.example client/apps/family-electron/.env.local
```

各ファイルの`MITE_DEMO_TOKEN`を次のようにサーバーと一致させます。

| クライアント | 対応するサーバー環境変数 |
| ------------ | ------------------------ |
| 利用者側     | `DEMO_USER_TOKEN`        |
| 家族側       | `DEMO_FAMILY_TOKEN`      |

ローカルでは`MITE_API_BASE_URL=http://localhost:3000`を使用します。`.env.local`はGit管理されず、次の開発コマンドだけが読み込みます。Supabase、LiveKit、Geminiの秘密情報をクライアントへ設定しないでください。

### 5. 両クライアントを起動する

利用者側と家族側を別々のターミナルで起動します。

```bash
# ターミナル1
cd client
npm run dev:user
```

```bash
# ターミナル2
cd client
npm run dev:family
```

利用者側は`http://127.0.0.1:5173`、家族側は`http://127.0.0.1:5174`のVite開発サーバーをElectronで表示します。

利用者側は通常のメインウィンドウを持ちません。Windowsではプライマリ画面の左端をAppBarとして使用します。LinuxではOSの作業領域を予約せず、画面位置とサイズ変更だけを疑似動作させます。

### 2台のPCで接続する場合

利用者側と家族側を別のPCで起動する場合は、両方の`MITE_API_BASE_URL`を`http://<サーバーPCのIPアドレス>:3000`へ変更します。`localhost`のままでは別PCのサーバーへ接続できません。公開デモではHTTPS/WSSで公開した同一のGoサーバーを指定します。

## Windows向け配布物

Windows上で、クライアントの依存関係を取得してから実行します。

```bash
cd client
npm run make:user
npm run make:family
```

生成物は各アプリの`out/`に出力されます。インストーラーを作る前のパッケージ確認には`npm run package:user`と`npm run package:family`を使用できます。

Windows向けの`npm install`、package、makeはWindows上で実行してください。WSL2上で生成したLinux配布物ではWindows AppBarの動作を確認できません。コード署名はMVPの配布方法を確定した後に設定します。

配布版は`.env.local`を読みません。起動するWindowsユーザーの環境変数へ`MITE_API_BASE_URL`と`MITE_DEMO_TOKEN`を設定してください。利用者側では必要に応じて`CAPTURE_INTERVAL_MS`と`CAPTURE_MAX_COUNT`も設定できます。

## 検証

### API生成と共有APIクライアント

リポジトリルートで実行します。

```bash
npm run generate:api
npm run typecheck
npm run lint
npm run build
```

### Electronクライアント

`client/`で実行します。

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

### Goサーバー

`server/`で実行します。

```bash
go tool sqlc generate
go test ./...
go vet ./...
go build ./...
```

主要APIをローカルSupabaseと`curl`で順番に確認する場合は、[サーバー手動検証ガイド](server/MANUAL_TESTING.md)を参照してください。

## 既知の未確認事項

- Windows AppBarの登録、他アプリの最大化との共存、DPI・表示設定変更、タスクバーとの競合および終了時の予約解除は、Windows 11実機での確認が必要です。
- 実LiveKit Cloudによる音声・画面共有・マーキングと、実Gemini APIによるガイド生成は、有効な認証情報を用意した環境でのsmoke testが必要です。
- 2台のWindows PCと公開Goサーバーを使う最終E2Eは未実施です。
