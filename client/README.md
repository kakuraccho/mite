# Miteクライアント

利用者側と家族側のWindows向けElectronアプリを管理するnpm workspaceです。

- 利用者側: Windows左端に常駐するオーバーレイでの支援依頼、着信同意、音声・画面共有、定期画面保存、ガイド閲覧・実行
- 家族側: 依頼確認、音声・共有画面の閲覧、マーキング、ガイド生成状況、下書き編集

業務状態はREST APIを正本とし、WebSocketは更新通知、LiveKitは音声・画面共有・一時マーキングにだけ使用します。遠隔操作、カメラ、録音・録画は行いません。

支援依頼時のスクリーンショットは最初のArtifact送信前にmainプロセスから端末へ保存します。通信結果が分からない場合は、保存済みの同じ画像とIdempotency-Keyで再送します。

## 必要な環境

- Node.js 24 LTS
- npm 11

## 構成

```text
apps/
├── user-electron/       利用者側アプリ
└── family-electron/     家族側アプリ
packages/
├── client-api/          OpenAPI生成型を使うREST・WebSocket adapter
├── client-core/         revision・再試行・復元などの共通処理
└── ui/                  共通UIとデザイントークン
```

## セットアップ

```bash
npm install
```

環境変数は各アプリの `.env.example` を `.env.local` へコピーし、役割ごとのデモ用トークンを設定してください。`.env.local` はGit管理されず、後述の開発コマンドだけが読み込みます。

クライアント単体にデモサーバーは含まれません。実際の2台接続にはMiteサーバー、LiveKit Cloudと役割ごとの有効なデモトークンが必要です。テストでは通信実装を注入して外部サービスなしで画面と状態遷移を検証します。

## 開発

```bash
npm run dev:user
npm run dev:family
```

利用者側は `http://127.0.0.1:5173`、家族側は `http://127.0.0.1:5174` のVite開発サーバーをElectronで表示します。

利用者側は通常のメインウィンドウを持ちません。Windowsではプライマリ画面の左端4pxをAppBarとして予約し、300msのhoverで入口を320pxへ、各操作を行うと内容に応じた幅へオーバーレイ展開します。Linuxでは画面位置とサイズ変更だけを疑似動作させ、OSの作業領域は予約しません。

2台のPCで試す場合、両方の `MITE_API_BASE_URL` にサーバーを起動したPCの到達可能なIPアドレスを指定します。`localhost` のままでは別のPCのサーバーへ接続できません。

## 検証

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

配布アプリへ含まれる依存関係だけを監査する場合は、次を実行します。

```bash
npm audit --omit=dev
```

Electron Forgeの開発時依存に対する警告を消すために `npm audit fix --force` を実行しないでください。安定版のForgeを古いメジャー版へ強制変更し、警告を解消できない場合があります。

APIの実サーバー、LiveKitとWindows固有の画面選択を含む2台間の確認は、単体テストとは別にWindows実機で行ってください。

Windows AppBarについては、左端4pxの予約、他アプリの最大化、タスクバーとの競合、DPI・表示設定変更および終了時の予約解除をWindows 11で確認します。現在のWSL2上のLinux確認ではこれらを実行できないため、Windows固有の実動作確認は未実施です。

## Windows向け配布物

Windows上で次を実行します。

```bash
npm run make:user
npm run make:family
```

生成物は各アプリの `out/` に出力されます。コード署名はMVPの配布方法を確定した後に設定します。

利用者側のAppBar連携は対象OS用のKoffiプリビルドを同梱します。Windows向けの `npm install`、`package:user` および `make:user` はWindows上で実行してください。WSL2上で生成したLinux配布物をWindows固有動作の確認には使用できません。

配布版は `.env.local` を読みません。起動するWindowsユーザーの環境変数へ `MITE_API_BASE_URL` と `MITE_DEMO_TOKEN` を設定してからアプリを起動してください。利用者側では必要に応じて `CAPTURE_INTERVAL_MS` と `CAPTURE_MAX_COUNT` も設定できます（既定値は5000ms、最大360枚です）。デモトークン以外の秘密情報をクライアントへ設定しないでください。

インストーラーを作る前のパッケージ確認は、対象OS上で次を実行できます。

```bash
npm run package:user
npm run package:family
```

## API型の生成

APIの正本は `../api/openapi.yaml` です。次のコマンドはリポジトリルートの `@mite/api-client` を再生成します。

```bash
npm run generate:api
```

`../packages/api-client/src/generated/schema.ts` は生成物です。直接編集しないでください。`packages/client-api` の `HttpMiteApi` はこの生成型からrequestとresponseの型を派生し、multipart uploadとWebSocketを画面から分離します。

ローカルSupabaseとGoサーバーを起動した状態で、adapterのA/B/Cフローだけを再確認する場合は、役割別デモトークンを環境変数で渡して次を実行します。値をログやソースへ記録しないでください。

```bash
MITE_E2E_API_BASE_URL=http://127.0.0.1:3000 \
MITE_E2E_USER_TOKEN=<user-token> \
MITE_E2E_FAMILY_TOKEN=<family-token> \
npx vitest run packages/client-api/src/http-client.integration.test.ts
```
