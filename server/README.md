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

`.env.example`を参考に、実行環境へ値を設定する。`.env`はGoサーバーが自動読込しないため、シェルまたは配置先の環境変数機能から設定する。実際のトークン、DB接続文字列、APIキーをGitへ含めてはならない。

## 起動

migrationとseedを対象DBへ適用し、必要な環境変数を設定してから実行する。

```bash
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
