# セットアップ・ローカル起動

[README](../README.md)へ戻る。コード生成・検証・Windows配布は[開発ガイド](development.md)を参照してください。

## 必要な環境

- Git
- Node.js 24 LTS
- npm 11
- Go 1.26系
- Docker（ローカルSupabaseを使う場合）
- Windows 11（Windows画面の撮影・共有、Windows AppBarの実動作確認およびWindows向け配布物の作成を行う場合）

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

API型とDBアクセスコードの生成物はリポジトリに含まれています。再生成する場合は[コード生成](development.md#コード生成)を参照してください。

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

[`server/.env.example`](../server/.env.example)を参考にGit管理外の`server/.env`を作成し、デモ用トークンと外部サービスの設定を入力します。既に`.env`がある場合はコピーせず、必要な値を更新してください。`DEMO_USER_TOKEN`と`DEMO_FAMILY_TOKEN`には異なる値を設定してください。実際のトークン、DB接続文字列、APIキーをGitへ含めないでください。

```bash
cp server/.env.example server/.env
```

Goサーバーは起動時の作業ディレクトリにある`.env`を自動で読み込みます。`server/`で起動すると`server/.env`を使い、既存の環境変数（空文字を含む）を優先して未設定項目だけを補います。ファイルがなければ環境変数だけを使います。

Supabaseの設定値は、リポジトリルートで次のコマンドを実行して確認します。

```bash
npx supabase status -o env
```

`server/.env`をエディタで開き、表示された値を次の対応で転記してください。`$DB_URL`などの変数名ではなく、実際の値を記入します。

| コマンドの出力 | `server/.env`の設定項目 |
| -------------- | ---------------------- |
| `DB_URL`       | `DATABASE_URL`         |
| `API_URL`      | `SUPABASE_URL`         |
| `SECRET_KEY`   | `SUPABASE_SECRET_KEY`  |

ローカルでは`SUPABASE_STORAGE_BUCKET=mite-artifacts`を使います。Supabaseの再起動やreset後は、再度コマンドで現在の値を確認し、`server/.env`を更新してください。以前に`export`などで同じ環境変数を設定している場合は、`.env`より優先されるため解除してください。書式の詳細や環境変数へ直接設定する手順は[サーバー設定の補足](#サーバー設定の補足)を参照してください。

`server/.env.example`のLiveKitとGeminiのプレースホルダーでもサーバープロセス自体は起動できますが、音声・画面共有・マーキングと実AIガイド生成は利用できません。これらを確認するときは、LiveKit CloudとGemini APIの有効な認証情報をサーバーだけに設定してください。Geminiのキーなしで複数ガイドのレビューを試す場合は、後述の[開発用ガイド生成](#geminiのキーなしで複数ガイドを試す)を使います。

### 3. サーバーを起動する

リポジトリルートから次を実行します。サーバーが`server/.env`を自動で読み込むため、事前の`export`は不要です。

```bash
cd server
go run ./cmd/api
```

既定では`http://localhost:3000`で待ち受けます。専用のhealth endpointはないため、起動ログまたはAPIへのリクエストで確認してください。

### 4. クライアント環境変数を設定する

別のターミナルで、利用者側・家族側と家族向けPWAの`.env.local`を作成します。既にファイルがある場合はコピーせず、必要な値を更新してください。

```bash
# リポジトリルート
cp client/apps/user-electron/.env.example client/apps/user-electron/.env.local
cp client/apps/family-electron/.env.example client/apps/family-electron/.env.local
cp client/apps/family-pwa/.env.example client/apps/family-pwa/.env.local
```

Electronの各ファイルでは`MITE_DEMO_TOKEN`を、PWAでは初回画面で入力する家族用トークンを、次のようにサーバーと一致させます。

| クライアント | 対応するサーバー環境変数 |
| ------------ | ------------------------ |
| 利用者側     | `DEMO_USER_TOKEN`        |
| 家族側       | `DEMO_FAMILY_TOKEN`      |
| 家族向けPWA  | `DEMO_FAMILY_TOKEN`      |

Electronでは`MITE_API_BASE_URL=http://localhost:3000`、PWAでは`VITE_API_BASE_URL=http://localhost:3000`を使用します。PWAの家族用トークンは初回画面で端末へ保存でき、`VITE_DEMO_FAMILY_TOKEN`はローカル開発用の任意の初期値です。`.env.local`はGit管理されません。Supabase、LiveKit、GeminiおよびVAPID秘密鍵をクライアントへ設定しないでください。

### 5. クライアントとPWAを起動する

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

```bash
# ターミナル3
cd client
npm run dev:pwa
```

利用者側は`http://127.0.0.1:5173`、家族側は`http://127.0.0.1:5174`のVite開発サーバーをElectronで表示します。補助PWAは`http://localhost:5175`で開きます。Service WorkerとPushはlocalhost以外ではHTTPSが必要です。

公開環境ではPWAを `https://priv.chi-llenge.com/mite/family-pwa/`、APIを `https://priv.chi-llenge.com/mite` としてbuild・配信します。Apacheの初回設定と自動デプロイは[サーバーのCI/CD](ci-cd.md#2-家族向けpwaの初回vpsapache設定)を参照してください。公開buildへ`VITE_DEMO_FAMILY_TOKEN`を設定してはいけません。

### Web Pushを有効にする

`server/`で次を1回実行し、出力された2行を`server/.env`へ保存します。秘密鍵はサーバーだけに置き、Gitへ含めません。あわせて管理者の連絡先URIを設定してサーバーを再起動します。

```bash
cd server
go run ./cmd/vapid-keygen
```

```dotenv
WEB_PUSH_SUBJECT=mailto:admin@example.com
```

3項目をすべて未設定にするとPushだけが無効になり、状態確認と返答は利用できます。一部だけ設定した場合は設定漏れとしてサーバーが起動しません。

利用者側は通常のメインウィンドウを持ちません。Windowsではプライマリ画面の左端をAppBarとして使用します。LinuxではOSの作業領域を予約せず、画面位置とサイズ変更だけを疑似動作させます。

### Geminiのキーなしで複数ガイドを試す

第2項で作成した `server/.env` の次の2項目を変更します。既存ファイルをコピーし直す必要はありません。

```dotenv
MITE_ENV=development
AI_PROVIDER=mock
```

`AI_BASE_URL`、`GEMINI_API_KEY`、`AI_MODEL`、`AI_PROMPT_VERSION` は、このモードでは未設定・空欄でも起動できます。既存値が残っていても使いません。プロセスの環境変数が `.env` より優先されるため、以前に `AI_PROVIDER` や `MITE_ENV` を設定していた場合はそちらも更新してください。

Goサーバーを停止して、第3項の `go run ./cmd/api` で再起動します。起動ログに `using mock guide generator for development` が表示されます。DBには `20260910000100_cancel_guide_run.sql` までのmigrationを適用しておきます。

1. Windowsで両クライアントを起動し、相談・支援を開始します。
2. 画面全体を5秒以上共有し、定期取得画像を1枚以上残します。mockでも画像が0件の場合はガイドを作成しません。
3. 家族側で「支援を解決済みにする」から「ガイドを作る」を選びます。
4. `【動作確認用】画面を確認する`（2ステップ）と `【動作確認用】手順を見直す`（3ステップ）が表示されます。画像は今回の支援で登録した画像で、説明文は固定です。
5. 2件目を開いてタイトルや説明を編集し、保存完了後に「レビュー完了」を押します。全件が確定して通話と支援が終了し、利用者のガイド一覧へ2件とも表示されることを確認します。別の支援では2件目を開かずに確定できることも確認できます。

DBとSupabase Storageは通常どおり必要です。画面共有には有効なLiveKit設定が必要で、mockはLiveKitや画像取得を代替しません。LiveKitも未設定の場合は、[サーバー手動検証ガイド](../server/MANUAL_TESTING.md)の第3.3節でmockを設定し、第6章から第8章のREST操作で支援とJPEG材料を登録すると、第9章のレビュー・一括確定を確認できます。WSLでもこのAPI確認は可能です。

Geminiによる生成へ戻すときは `AI_PROVIDER=gemini` に変更し、4項目のAI設定に有効な値を入れてサーバーを再起動します。`MITE_ENV` はローカル開発では `development` のままで構いません。既存の動作確認用ガイドは自動では再生成されないため、新しい支援で試します。

### WSLでスクリーンショットが真っ黒になる場合

WSLで起動したLinux版Electronの `desktopCapturer` は、WSLg側の画面を取得します。Windowsのデスクトップ全体を取得する処理にはなりません。WSLgはLinuxの各ウィンドウをWindowsへ転送する構成です（[Microsoftの構成説明](https://devblogs.microsoft.com/commandline/wslg-architecture/)）。MiteではWSLからの撮影・共有を開始せず、Windows用アプリの起動を案内します。保存済みの相談画像もWSLでは復元しませんが、削除はしません。

Windowsの画面を撮影・共有するときは、利用者側をWindowsのPowerShellからWindows版Node.js 24で起動してください。GoサーバーはWSL側で実行したままにできます。

1. 今回の変更を含むソースをWindows側の作業フォルダー（例: `C:\dev\mite`）へ用意します。WSLの未コミット変更は通常のcloneでは引き継がれないため、変更したファイルも反映してください。WSLの `node_modules`、`dist`、`dist-electron`、`out` は持ち込まず、Windows上で依存関係を取得し直します。
2. Windows側の `client/apps/user-electron/.env.local` を第4項の手順で設定し、`MITE_API_BASE_URL` をWindowsから到達できるサーバーのURLにします。
3. WindowsのPowerShellで次を実行します。`node -p` の結果が `win32` であることを確認してください。`npm.cmd` を使うことでPowerShellのスクリプト実行ポリシーの変更は不要です。

```powershell
cd C:\dev\mite
node -p "process.platform"
node --version
npm.cmd install
cd client
npm.cmd install
npm.cmd run dev:user
```

家族側もWindowsで起動する場合は、家族用 `.env.local` を設定し、別のPowerShellから `client/` で `npm.cmd run dev:family` を実行します。

### 2台のPCで接続する場合

利用者側と家族側を別のPCで起動する場合は、両方の`MITE_API_BASE_URL`を`http://<サーバーPCのIPアドレス>:3000`へ変更します。`localhost`のままでは別PCのサーバーへ接続できません。公開デモではHTTPS/WSSで公開した同一のGoサーバーを指定します。

## サーバー設定の補足

### `.env`の書式

書式は`KEY=VALUE`で、キーは英字または`_`で始まる英数字・`_`です。空行、`#`で始まるコメント行、値全体を囲む一重・二重引用符、WindowsのCRLFとUTF-8 BOMに対応します。引用符の外側の空白は除き、同じキーが複数あれば最後の値を使います。値は1行で記述し、変数展開、コマンド実行、エスケープ変換、行末コメントの解釈は行いません。読込不能、不正な書式、必須設定の不足では起動に失敗します。

### 環境変数へ直接設定する場合

通常のローカル起動では`server/.env`へ記入します。環境変数へ設定する場合は、サーバーを起動する同じBashで次を実行します。CLIの秘密値は画面へ表示しません。

```bash
eval "$(npx supabase status -o env 2>/dev/null)"
export DATABASE_URL="$DB_URL"
export SUPABASE_URL="$API_URL"
export SUPABASE_SECRET_KEY="$SECRET_KEY"
```

このコマンドはリポジトリルートで実行してください。残りの必須値は`server/.env`または同じBashの環境変数へ設定し、`cd server`、`go run ./cmd/api`で起動します。
