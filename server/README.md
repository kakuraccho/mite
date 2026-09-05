# Mite server

MiteのGo APIサーバーである。通信契約は`../api/openapi.yaml`、DBスキーマは`../supabase/migrations`を正本とする。現在は、機能別のAPI実装を開始できる共通基盤までを提供する。

## 必要なツール

- Go 1.26系
- Node.jsとnpm
- PostgreSQL migrationを適用するときはSupabase CLI

`oapi-codegen`と`sqlc`は`go.mod`のtool dependencyとして固定しているため、グローバルインストールは不要である。

## セットアップ

リポジトリルートでJavaScript依存関係を取得する。

```bash
npm install
```

API型を生成する。

```bash
npm run generate:api
```

DBアクセスコードを生成する。

```bash
cd server
go tool sqlc generate
```

## 環境変数

[`server/.env.example`](./.env.example)を参考に、Git管理外の`server/.env`または実行環境へ値を設定する。Goサーバーは起動時の作業ディレクトリにある`.env`を自動で読み込み、既存の環境変数（空文字を含む）を優先して未設定項目だけを補う。`.env`がなければ環境変数だけを使う。実際のトークン、DB接続文字列、APIキーをGitへ含めてはならない。

書式は`KEY=VALUE`で、キーは英字または`_`で始まる英数字・`_`とする。空行、`#`で始まるコメント行、値全体を囲む一重・二重引用符、WindowsのCRLFとUTF-8 BOMに対応する。引用符の外側の空白は除き、同じキーが複数あれば最後の値を使う。値は1行で記述し、変数展開、コマンド実行、エスケープ変換、行末コメントの解釈は行わない。読込不能、不正な書式、必須設定の不足では起動に失敗する。

Supabaseの設定値は利用者が最新化する。ローカルSupabaseの再起動やreset後は、[接続ガイド](../docs/server-client-integration.md)に従い、現在の接続先とSecret keyを`.env`または環境変数へ設定する。環境変数が残っている場合は`.env`の変更より優先される。

## 起動

migrationとseedを対象DBへ適用し、必要な設定を用意してから、リポジトリルートで実行する。

```bash
cd server
go run ./cmd/api
```

現段階では共通middlewareとDB接続を起動する。各REST API、WebSocket、Storage、LiveKit、AIワーカーの具体的な処理は後続の機能実装でgenerated server interfaceへ接続する。

後続実装は`internal/handler`の`ArtifactSupportAPI`、`SupportSessionAPI`、`GuideAPI`をレーンごとに実装し、`handler.API`へ合成する。これにより、3レーンが同じ巨大なhandler実装を編集せずに進められる。

## 検証

主要APIをローカルSupabaseと`curl`で順番に確認する場合は、[サーバー手動検証ガイド](./MANUAL_TESTING.md)を参照する。

```bash
go tool sqlc generate
go test ./...
go vet ./...
go build ./...
```

リポジトリルートでは、共有APIクライアントも確認する。

```bash
npm run generate:api
npm run typecheck
npm run lint
npm run build
```
