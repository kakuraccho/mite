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

Pull Requestと`dev`・`main`へのpushでは、GitHub Actionsがサーバー・共有APIとclientの整形・Lint・型・テスト・buildを検証します。チェックの内容とVPSへのデプロイ設定は[MiteのCI/CD](ci-cd.md)を参照してください。

### API生成と共有APIクライアント

リポジトリルートで実行します。

```bash
npm run generate:api
npm run typecheck
npm run lint
npm run build
```

### Electronクライアントと家族向けPWA

`client/`で実行します。

テキストファイルの改行はリポジトリルートの `.gitattributes` でLFに統一し、clientのPrettierも `endOfLine: lf` を使います。Windowsの `core.autocrlf=true` でも、新しくチェックアウトするファイルはLFになります。既存の作業コピーにCRLFが残って整形チェックに失敗する場合は、`client/` で `npm run format` を実行し、差分を確認してから再チェックしてください。Gitのグローバル設定を変更する必要はありません。

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

Electronの `main` と各 `preload` は `client/scripts/build-electron.mjs` で型チェック後、既存のViteを使ってCommonJSへバンドルします。`npm run dev:user`、`npm run dev:family` と配布用の `build:electron` は同じ処理を使います。`dist-electron/main/main.js` と `dist-electron/preload/*.js` が実行用の生成物です。

`npm run build`は家族向けPWAも静的ファイルとして`client/apps/family-pwa/dist/`へ生成します。実端末のService WorkerとPush確認には、生成物とAPIをHTTPSで公開し、PWAのoriginをサーバーの`CLIENT_ORIGINS`へ追加してください。

PWAの開発サーバーは、Viteが挿入するスクリプトとスタイルにリクエストごとのnonceを付け、ローカルのHMR WebSocket接続をCSPで許可します。ビルドしたPWAでは`script-src 'self'`と`style-src 'self'`を維持します。`frame-ancestors`はmetaタグでは無効なため、開発・previewではHTTPヘッダーで返します。公開時もPWAのHTMLを配信するサーバーに`Content-Security-Policy: frame-ancestors 'none'`を設定してください。根拠: [ViteのCSP対応](https://vite.dev/guide/features.html#content-security-policy-csp)、[frame-ancestorsの制約](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)。

`@mite/client-core` などのworkspaceはTypeScriptソースを公開しているため、Electronから直接読み込まず、必要なコードを実行用JavaScriptへ含めます。Electron・Node組み込みmodule・Koffiはバンドルの外に残し、既存のKoffi配布hookを維持します。sandbox付きpreloadはアプリ内moduleを `require` できないため、それぞれ単独のファイルにまとめます。根拠: [Vite library mode](https://vite.dev/guide/build.html#library-mode)、[Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)。

`client/scripts/build-electron.test.ts` は両アプリを実際にビルドし、生成したmainとpreloadをViteのTypeScript変換を介さず読み込みます。ElectronのAPIを疑似化したmodule読み込みの回帰テストであり、実ウィンドウや通話の確認は別途必要です。

### 家族向けPWAをサブパスで公開する

`https://example.com/mite/pwa/`へ置く場合は、API接続先を設定したうえで`client/`から次を実行します。公開するビルドに家族用トークンを埋め込まず、初回画面で入力してください。

```bash
VITE_API_BASE_URL=https://example.com/mite VITE_PWA_BASE_PATH=/mite/pwa/ VITE_DEMO_FAMILY_TOKEN= npm run build -w @mite/family-pwa
```

WindowsのPowerShellでは、同じ設定を次のように渡します。

```powershell
$env:VITE_API_BASE_URL = 'https://example.com/mite'
$env:VITE_PWA_BASE_PATH = '/mite/pwa/'
$env:VITE_DEMO_FAMILY_TOKEN = ''
npm run build -w @mite/family-pwa
```

`apps/family-pwa/dist/`の中身を公開先へ配置します。Apacheの`DocumentRoot`が`/var/www/mite-public`なら配置先は`/var/www/mite-public/mite/pwa/`です。既存の`/mite/v1/`へのProxyPassは引き続きAPIへ転送できます。Viteの`base`がHTML・アセットとService Workerの登録先に反映され、manifestと通知のリンクもPWAのパスを使います。開発時の既定URLは`http://localhost:5175/`です。[Viteの公開パス設定](https://vite.dev/guide/build.html#public-base-path)

これは手動配置の例です。`priv.chi-llenge.com`の自動デプロイでは、同じ`/mite/pwa/`をApacheのAliasで`/var/www/mite-family-pwa/current/`へ割り当てます。[CI/CDの初回設定と手動配置からの移行](ci-cd.md#2-家族向けpwaの初回vpsapache設定)を行ってください。手動配置だけでは自動デプロイの事前確認は通りません。

PWA用のApache設定例は次のとおりです。`headers`モジュールを有効にして読み込ませ、`apache2ctl configtest`の成功後にApacheをreloadします。`index.html`、Service Worker、manifestは更新時に再検証させます。[ApacheのHeader設定](https://httpd.apache.org/docs/2.4/mod/mod_headers.html)

```apache
<Directory /var/www/mite-public/mite/pwa>
    DirectoryIndex index.html
    Header always set Content-Security-Policy "frame-ancestors 'none'"
    <FilesMatch "^(index\.html|sw\.js|manifest\.webmanifest)$">
        Header always set Cache-Control "no-cache"
    </FilesMatch>
</Directory>
```

API側の`CLIENT_ORIGINS`へ追加する値は`https://example.com`です。`/mite/pwa/`はOriginに含めません。同じドメインでもOriginを送る状態変更APIのために必要です。Service WorkerがキャッシュするのはPWAの公開ファイルだけで、API応答や認証付きリクエストを保存しません。通知タップは同じPWAのパスを開きます。

公開後は末尾に`/`があるPWA URLで、画面表示、家族用トークンの初回入力、接続状況の取得と返答を確認します。Web Pushは別途サーバーのVAPID設定が必要です。iPhoneのホーム画面追加、通知購読と受信は実端末で確認してください。

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

1. 相談画面で画像と入力欄が横に並び、通常の表示サイズで送信ボタンまでスクロールせず操作できること、画像を押すと拡大して確認できることを確認します。複数のアプリを表示した状態で「家族に相談する」を開き、選択画面なしでプライマリ画面全体の画像が表示されることを確認します。タスクバーを含む範囲を確認し、Miteのパネルが写らないことを確認します。
2. コメントを入力し、Miteを「しまう」で閉じて別のアプリを操作します。左端から相談へ戻り、「画面を撮り直す」で画像が更新され、コメントが残ることを確認します。撮影中は再撮影と送信ができず、送信後は家族側に最後の画像が表示されることを確認します。
3. ガイド途中の「家族に聞く」でも自動撮影と撮り直しを行い、最新画像とガイドの文脈が家族側へ送られることを確認します。
4. 「同意して応答する」の1操作だけでプライマリ画面全体が家族側へ表示されることを確認します。Miteのパネル、ガイド表示、丸・カーソル・マウス・キーボードの案内が共有映像と端末の定期保存画像に写らないことを確認します。
5. 共有停止で映像と定期保存が止まり、再開ボタンだけで全画面共有が再開し、ACTIVEの場合だけ定期保存が再開することを確認します。LiveKitの切断・再接続後およびACTIVE中のアプリ再起動後も、対象の選択なしで再開できることを確認します。
6. 複数モニター、異なるDPIおよび縦向きの画面で、プライマリ画面1枚だけが取得され、静止画が縦横比を維持して1920×1080以内になることを確認します。プライマリ画面の変更時は共有を停止して再開します。取得対象を特定できない場合に他のモニターへ切り替わらないことも確認します。
7. カーソルとマウスのモードを選ぶと中央にカーソルが出ること、クリックやドラッグの解放後、共有画面の外への移動後、家族側の別ウィンドウ操作中も最後のカーソル位置が消えずに残ることを確認します。マウス図は押下中だけカーソル横に表示し、解放・フォーカス喪失では消えます。キーボード全体図は押下中だけ画面幅の約80%で表示し、解放・フォーカス喪失で消えることを確認します。「案内を消す」・モード変更・共有停止・切断ではカーソルも消えること、連続更新で点滅しないこと、画面右端・下端でもカーソルが見えることを確認します。
8. CREATE後の画像アップロード・AI生成・下書き編集では映像を停止し、音声は続くことを確認します。作成中の再接続も音声だけを接続します。保存後は作成前に共有していた場合だけ映像を再開し、手動で止めていた場合には再開しないことを確認します。
9. 利用者側のガイド一覧・実行・下書き閲覧で、画像を押すと拡大し、「閉じる」またはEscで元の手順へ戻ることを確認します。拡大だけでは手順移動・完了・通信操作が実行されず、次の手順ではその手順の画像が表示されることを確認します。

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
