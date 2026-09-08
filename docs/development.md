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

## 全画面撮影と共有の確認

Windows 11で利用者側を起動し、次を確認します。家族側の画像・共有映像の確認には、別PCの家族側アプリと接続可能なMiteサーバー、LiveKit Cloudを使います。この実機確認は未実施です。

1. 複数のアプリを表示した状態で「家族に相談する」を開き、選択画面なしでプライマリ画面全体の画像が表示されることを確認します。タスクバーを含む範囲を確認し、Miteのパネルが写らないことを確認します。
2. コメントを入力し、Miteを「しまう」で閉じて別のアプリを操作します。左端から相談へ戻り、「画面を撮り直す」で画像が更新され、コメントが残ることを確認します。撮影中は再撮影と送信ができず、送信後は家族側に最後の画像が表示されることを確認します。
3. ガイド途中の「家族に聞く」でも自動撮影と撮り直しを行い、最新画像とガイドの文脈が家族側へ送られることを確認します。
4. 着信への応答後、「画面全体を共有する」でプライマリ画面全体が家族側へ表示されることを確認します。Miteのパネル、ガイド表示およびマーキングが共有映像と端末の定期保存画像に写らないことを確認します。
5. 共有停止で映像と定期保存が止まり、再開ボタンだけで全画面共有と定期保存が再開することを確認します。LiveKitの切断・再接続後およびACTIVE中のアプリ再起動後も、対象の選択なしで再開できることを確認します。
6. 複数モニター、異なるDPIおよび縦向きの画面で、プライマリ画面1枚だけが取得され、静止画が縦横比を維持して1920×1080以内になることを確認します。プライマリ画面の変更時は共有を停止して再開します。取得対象を特定できない場合に他のモニターへ切り替わらないことも確認します。

WSLではWindowsのデスクトップを取得できないため、撮影・共有の開始前にエラーを表示します。[Windows側での起動手順](setup.md#wslでスクリーンショットが真っ黒になる場合)を参照してください。

WSL以外のLinux開発では静止画取得中だけMiteのウィンドウを一時的に隠し、取得に失敗しても再表示します。Linuxの共有映像からMiteを除外する処理はありません。画面の識別情報を取得できない環境では、別画面への誤共有を防ぐため撮影・共有を開始しません。Windows固有の除外動作の検証にはWindows 11を使ってください。

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
