# 開発・検証・配布

[README](../README.md)へ戻る。依存関係の取得と環境変数の設定は[セットアップガイド](setup.md)を参照してください。

## コード生成

生成物はリポジトリに含まれていますが、生成元との一致を確認する場合は次を実行します。自動生成ファイルは直接編集しないでください。

```bash
# リポジトリルート
npm run generate:api

cd server
go tool sqlc generate
cd ..
```

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
go test -race ./... -count=1
go vet ./...
go build ./...
```

主要APIをローカルSupabaseと`curl`で順番に確認する場合は、[サーバー手動検証ガイド](../server/MANUAL_TESTING.md)を参照してください。

HTTP/WebSocket E2Eは[接続ガイドの接続確認](server-client-integration.md#8-接続確認)、実機・外部サービスで残る確認は[READMEの既知の未確認事項](../README.md#既知の未確認事項)を参照してください。

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
