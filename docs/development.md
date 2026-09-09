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

Pull Requestと`dev`・`main`へのpushでは、GitHub Actionsがサーバーと共有APIを検証します。チェックの内容とVPSへのデプロイ設定は[サーバーのCI/CD](ci-cd.md)を参照してください。

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

Electronの `main` と各 `preload` は `client/scripts/build-electron.mjs` で型チェック後、既存のViteを使ってCommonJSへバンドルします。`npm run dev:user`、`npm run dev:family` と配布用の `build:electron` は同じ処理を使います。`dist-electron/main/main.js` と `dist-electron/preload/*.js` が実行用の生成物です。

`@mite/client-core` などのworkspaceはTypeScriptソースを公開しているため、Electronから直接読み込まず、必要なコードを実行用JavaScriptへ含めます。Electron・Node組み込みmodule・Koffiはバンドルの外に残し、既存のKoffi配布hookを維持します。sandbox付きpreloadはアプリ内moduleを `require` できないため、それぞれ単独のファイルにまとめます。根拠: [Vite library mode](https://vite.dev/guide/build.html#library-mode)、[Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)。

`client/scripts/build-electron.test.ts` は両アプリを実際にビルドし、生成したmainとpreloadをViteのTypeScript変換を介さず読み込みます。ElectronのAPIを疑似化したmodule読み込みの回帰テストであり、実ウィンドウや通話の確認は別途必要です。

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
4. 「同意して応答する」の1操作だけでプライマリ画面全体が家族側へ表示されることを確認します。Miteのパネル、ガイド表示、丸・カーソル・マウス・キーボードの案内が共有映像と端末の定期保存画像に写らないことを確認します。
5. 共有停止で映像と定期保存が止まり、再開ボタンだけで全画面共有が再開し、ACTIVEの場合だけ定期保存が再開することを確認します。LiveKitの切断・再接続後およびACTIVE中のアプリ再起動後も、対象の選択なしで再開できることを確認します。
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

配布版は`.env.local`を読みません。起動するWindowsユーザーの環境変数へ`MITE_API_BASE_URL`と`MITE_DEMO_TOKEN`を設定してください。利用者側では必要に応じて`CAPTURE_MAX_COUNT`も設定できます。定期撮影間隔は10秒に固定し、既存の`CAPTURE_INTERVAL_MS`が異なる値でも撮影間隔は変えません。状態ポーリングは5秒です。


## 実利用フィードバックの確認

今回の要件と自動検証、後日実機で確認する項目は[実利用フィードバック対応記録](family-support-improvements.md)にまとめています。Windowsのスピーカー音量処理はCore Audioの既定出力を使い、50%未満だけ50%へ上げます。通常のテストは音量の境界を疑似化し、WindowsではCOM定義のコンパイルだけを行います。実際の音量は変更しません。

ガイド作成中・保存後の音声と映像の継続、保存後にガイドを試してから手動終了できること、最大化状態の復元、外側クリックと直接復帰、キー同時押し・ドラッグ表示は2台のWindows実機で別途確認します。これらの手動確認は今回の実装・自動検証の完了条件には含めません。
