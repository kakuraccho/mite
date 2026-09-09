# 実利用フィードバック対応記録

## 作業条件

- 開始地点: `dev` / `0e3f6786b51df2e854ece6ceccbd281a19628eaa`
- 作業ブランチ: `update/system/improve-family-support`
- Windows 11 Home、メモリ約16GB。開始時空き約0.5GBのため重い検証は直列で行う。
- Node 24.14.0、npm 11.9.0、Go 1.26.0、Git、rgを利用可能。
- Dockerは開始時に接続できなかったが、その後ローカルSupabaseを利用可能と確認した。既存の開発DBを変更せず、別DBと非公開bucketを新規作成して統合テストに使用した。
- 既存変更 `client/package-lock.json` を保護し、今回のコミットに含めない。開始時SHA-256: `D98E0DC532BBE43776BD6203514927548915DA8C69F72F4022F407E0A180FB9A`。
- 新規依存・サービスは追加しない。共有環境のmigration適用、push、PR、merge、deployは行わない。

## 要件と検証の対応

実装・検証結果と対応する根拠を記録する。未チェックは未完了である。

| 完了 | 要件 | 実装・検証結果 |
|---|---|---|
| [x] | 仕様・OpenAPI・生成物を先に更新し、状態と同意を整合させる | spec v1.5、OpenAPI 28 operation、OpenAPI/SQL生成。ルートの生成・型・Lint・build成功。 |
| [x] | ガイド作成・upload・生成・編集・保存後も通話と共有を継続する | 両rendererの通話状態判断と固定video接続。UserClientの非表示中ACTIVE→生成→編集→保存テスト、FamilyClientの保存後disconnect未実行テスト。 |
| [x] | 保存と終了を分離し、手動終了・SKIP・中止・失敗・再送を扱う | GUIDE_SAVEDとend API。service/handler/DB、FamilyClientでSKIP・中止・保存失敗・手動終了の同一キー再送を検証。 |
| [x] | 保存後もGET、再起動、LiveKit token・再接続から状態を復元する | 全4通話状態の両ロールtokenテスト、保存後GET・FamilyClient再起動・UserClient再接続テスト。 |
| [x] | 認可、revision、Idempotency-Key、トランザクション、画像の保持・削除を維持する | end serviceで認可・revision優先・rollback・同一応答再送。DB/Storage/HTTP E2Eで画像保持、不要画像削除、tokenと手動終了。 |
| [x] | 直後1枚＋10秒撮影、共有停止・ガイド作成後は撮影停止、再接続でも段階を尊重する | CAPTURE_INTERVAL_MS=10000、ACTIVE+sharingのみ。5秒pollingを維持。UserClientで10秒、停止・再開・生成以降・in-flight・上限を検証。 |
| [x] | 応答へ同意を統合し、音声・共有を自動開始する | 同意v2の1ボタンと自動通話/共有・自動collapseをUIテスト。履歴v1と5秒バッチはDBに保持。 |
| [x] | 経過時間を維持し、双方に自分のマイクのメーターを表示する | startedAt由来のCallElapsed、双方のlocal microphone analyser。時刻、mute、再接続、cleanupを疑似LiveKitテスト。 |
| [x] | Windowsスピーカー音量を50%未満の場合だけ50%へ上げる | OS付属PowerShellからCore Audio COM。0/49.99/50/75/100%と失敗分岐、WindowsでC#コンパイル成功（実音量は変更していない）。 |
| [x] | 外側クリックでしまい、直前画面と入力を保持し最新状態へ復帰する | Electron blur→COLLAPSED通知。controllerとUIで直接復帰・入力保持・非表示中の最新状態復帰。 |
| [x] | 通話開始でしまい、閉じたまま通話・共有・案内を継続する | 応答後collapse、別オーバーレイで案内継続。UserClientで非表示中の通話/共有/capture/案内を検証。 |
| [x] | 家族トップだけに未解決依頼を表示し、通話・編集内容を大きくする | 表示一覧だけRESOLVEDを除外し、復元では未終了セッションを回収。通話・編集時の非表示と終了後の一覧をUI検証。 |
| [x] | 家族ウィンドウの最大化状態を保持する | ローカルJSONへmaximize/unmaximize/closeを記録。再起動と壊れた設定のfallbackを検証。 |
| [x] | 画面ID除去、スクロール抑制、ポップアップ、可視の主要操作とフォーカスを整える | 管理ID表示を除去。同意・作成選択・中止・完了・画像選択・ガイド中相談をModal化。手順を1件ずつ表示。Tab循環・Escape・focus復元をテスト。 |
| [x] | 丸・カーソルとマウス・キーボード案内を実装し、ドラッグと同時キーを表現する | mite.guidance.v1、実pointer buttonsと物理キーの同時表示、500ms heartbeat。送受信と操作UIをテスト。遠隔入力処理は追加していない。 |
| [x] | モード切替・共有停止・切断で案内を消去し、映像とDPI座標を対応させる | モード/blur/共有停止/切断/表示変更でclear。native側2秒期限で停止表示を防止。letterbox除外とDIP画面への正規化座標をテスト。 |
| [x] | Mite・全案内表示を撮影と共有から除外するWindows機能を維持する | main・独立した透過案内windowのsetContentProtection(true)を維持。native設定テスト成功。実画像への除外は後日の実機確認。 |
| [x] | 全撮影済み画像からポップアップで1画像1手順を追加し、編集・並べ替え・8件上限を守る | バッチ全材料+初期画像picker。6件ずつ表示し全画像へ移動できる。AI未採用画像の追加、説明、順序変更、8件上限、取得失敗、最後のページをUIテスト。 |
| [x] | 材料の所有者・同一支援・削除予約を検証する | SQLの同一支援・purpose・所有者・削除予約条件。DB統合で別所有者、当該支援外、削除予約、別家族、利用者、9件を拒否。 |
| [x] | 全指定の生成・自動検証を行い、成功・失敗・skip・未実行を分けて記録する | 下記検証記録。変更に起因する失敗は解消済み。既存改行とCGO環境の制約は再実行方法を記録。 |
| [x] | 関連する仕様・実装・テストを機能単位でローカルコミットする | `af9d6118f9ff589408f8a5c18f2d5bc3ee889c73` に仕様・契約・生成物・両クライアント・サーバー・自動検証をまとめた。 |

## 実装上の決定

- 保存済みで通話中の状態を `GUIDE_SAVED` とし、`POST /v1/support-sessions/{id}/end` で家族が明示的に終了する。保存では `endedAt` と `endReason` を設定しない。`startedAt` は応答以降変更しない。
- 通話可能状態は `ACTIVE`、`GENERATING_GUIDE`、`REVIEWING_GUIDE`、`GUIDE_SAVED`。定期撮影は共有中の `ACTIVE` だけで行う。
- 画像選択は既存のバッチGETと初期相談画像を使い、既存PATCHの全体置換・1〜8件・権限検証を利用する。
- 新規応答は10秒撮影を説明する同意 `v2`。過去に保存した `v1` 同意と5秒間隔のバッチ記録をmigrationで書き換えない。
- 未決定の業務仕様を新たに確定した箇所、新規依存・外部サービスの追加はない。

## 検証記録

| 対象 | コマンドと結果 |
|---|---|
| ルート | `npm run generate:api`、`npm run typecheck`、`npm run lint`、`npm run build` はすべて成功。 |
| client | `npm run lint`、`npm run typecheck`、`npm run build` 成功。両Electronアプリと共有packageを確認。Viteの既存サイズ基準による500kB超のchunk警告は残る。 |
| clientテスト | `npm run test -- --maxWorkers=1` は137成功・2skip、37ファイル中36成功・1skip。最大化テストのcleanupを最終Lint指摘に合わせて修正し、当該テスト1件とLint・整形を再実行して成功。 |
| Go | `go tool sqlc generate`、`go test ./... -count=1 -v`、`go vet ./...`、`go build ./...` 成功。生成の再実行で生成物に追加差分なし。`CGO_ENABLED=0`、`GOMAXPROCS=2`、`GOFLAGS=-p=1` で実行。 |
| DB・Storage・HTTP/WebSocket | 専用DB・Storageを有効にしたGo全体で115のトップレベルテスト成功。internalはskipなし。runtime E2Eも成功。 |
| TypeScript→Goの実HTTP | `TestClientAdapterE2E` を別の新規DBで実行して成功（内側のHttpMiteApiテスト1件成功）。実router・DB・Storage・workerで保存後のガイド試行、通話終了、同一応答再送まで確認。 |
| Windows音量 | 閾値・失敗分岐を自動テストし、Windows PowerShellでCore Audio宣言のC#コンパイル成功。実音量は変更していない。 |

成功扱いに含めない項目と再実行方法:

- `client/` の `npm run format:check` は未変更のCRLFファイル77件で失敗。失敗一覧に今回の変更ファイルはない。`core.autocrlf=true` による改行差であり、`npm run format:check -- --end-of-line auto` は全体成功。通常チェックの再実行はLFのcheckoutで `npm run format:check`。無関係な一括整形は行っていない。
- WindowsではLinuxの静止画撮影時の隠蔽テスト1件をプラットフォーム条件でskip。Linuxで `cd client`、`npm run test -- --maxWorkers=1` を実行する。
- 通常のclientテストでは環境変数がないHttpMiteApi統合テスト1件をskipし、Go全体では `MITE_E2E_CLIENT_ADAPTER` 未指定の同名harnessをskipした。いずれも専用DBを使う別実行で成功しており、未確認ではない。再実行は[接続ガイド](server-client-integration.md#8-接続確認)に従う。
- 既定のCGO設定によるsqlc生成と追加の `go test -race ./... -count=1` は、`runtime/cgo: cgo.exe: exit status 2` でビルド段階に失敗した。sqlc生成・通常テスト・vet・buildは上記CGO無効設定で成功。race検査は実行できていない。対応するWindows Cコンパイラ環境を整え、`$env:CGO_ENABLED='1'` とテスト専用DB/Storageを設定して `go test -race ./... -count=1` を再実行する。OSやコンパイラ設定は変更していない。
- LiveKitと生成AI、Electronウィンドウ操作は自動テストで疑似化した。実LiveKit Cloud・Geminiへの接続、実音声・実画面の確認は未実施。後日の実機確認と[接続ガイド](server-client-integration.md#8-接続確認)を参照する。

検証用に作成したローカルDB `mite_feedback_test`、`mite_feedback_clienttest`、`mite_feedback_runtime` と非公開Storage bucket `mite-feedback-e2e` は、検証終了後に削除した。既存 `postgres` DB、他のbucketと起動済みSupabase環境は保持している。

最終監査では、更新文書7件のローカルリンク34件、手動検証の見出しと操作順、生成元と生成物の対応、画面ID表示の除去、ステージ差分を確認した。`git diff --check` は成功し、追加行の認証情報パターン検査で該当はなかった。実装コミット後の未コミット変更は保護対象 `client/package-lock.json` だけで、SHA-256は開始時と一致する。push・PR・merge・deploy・共有環境へのmigration適用は実施していない。

## 実装資料

- Windowsの既定出力取得: [IMMDeviceEnumerator](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdeviceenumerator-getdefaultaudioendpoint)
- Windows音量の読み書き: [IAudioEndpointVolume](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudioendpointvolume)
- 自分のマイク解析: [LiveKit createAudioAnalyser](https://docs.livekit.io/reference/client-sdk-js/functions/createAudioAnalyser.html)
- Windows表示制御・撮影除外: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)

## 後日の実機確認（今回の完了条件外）

- 2台のWindows PCで、通話・共有が生成・編集・保存後まで継続すること。
- スピーカー音量とマイク入力、AppBar、外側クリック、案内のドラッグ・キー同時押し、DPIと表示設定変更。
- メニュー・ガイド・全案内が共有映像と撮影画像に写らないこと。
- Windows配布物の実行と、祖父による操作・見やすさの確認。

## 判断待ち・承認待ち

現時点でなし。

## 起動エラーの追加修正（2026-09-09）

- 実利用で `npm run dev:user` が `ERR_MODULE_NOT_FOUND`（`client-core/src/idempotency`）で停止した。前回追加したmainの定数・案内検証が、TypeScriptソースを公開する共有packageを実行時に読み込んだことが原因。従来のtsc出力は外部importを残し、Vite経由の既存テストではこの問題を検出できなかった。
- `client/scripts/build-electron.mjs` を追加し、既存Viteでmain・各preloadを個別のCommonJSファイルへまとめる。両アプリの開発起動・配布buildで共通化し、共有コードを含め、Electron・Node組み込み・Koffiは外部参照を維持する。追加依存・API変更はない。
- 両アプリの生成したmainとsandbox付きpreloadを、ViteのTypeScript変換を介さず読み込む回帰テスト2件が成功。client全体は139成功・2skip。skipはHTTP統合環境変数の未指定とLinux限定テストで、今回サーバー契約は変更していない。
- Lint・型チェック・両アプリのElectron/rendererビルド成功。通常の整形チェックは未変更のCRLFファイル74件で失敗し、`npm run format:check -- --end-of-line auto` は成功。保護対象のlockfileは変更していない。
- 実Electronを起動する追加検証コマンドは、自動承認レビューで `blocked by policy` として拒否された。詳細理由は返されていない。実ウィンドウ起動の確認は未実施であり、生成物読み込みの自動テストと区別する。開発ターミナルの既存プロセスをCtrl+Cで終了し、`client/` で `npm run dev:user` を再実行して確認する。


## 表示とガイド作成中の共有停止の追加調整（2026-09-09）

この節は上記のv1.5時点の「生成・編集中も共有する」動作を更新する。現行仕様は [specification.md](specification.md) v1.6を参照する。

- 支援依頼画面は画像とコメントを横に配置し、通常の詳細表示サイズでは送信ボタンまで一画面に収める。画像はポップアップで拡大でき、入力・撮り直し・再送状態を保持する。小さい画面や長いエラーでは文字を小さくせずスクロールを許す。
- 点滅は、案内受信ごとの `setGuidance(null)` とネイティブ窓の `showInactive()` の繰り返しが原因だった。丸の消去と案内全消去を分け、表示中は窓を開き直さず内容を更新する。TTL・共有停止・接続切断時の消去は維持する。
- マウス図はボタン押下中だけカーソル横に表示し、画面端では範囲内へ収める。キーボードは [参考の全体図](https://dynabook.com/assistpc/tab/faq/pcdata/720212.htm) のようなコードで描く図を画面幅の約80%で表示し、押しているキーと同時押しを示す。全キー解放で消える。
- CREATE後のアップロード・AI生成・編集は音声だけを継続する。画面配信と撮影・案内は停止する。接続開始と状態変更の競合でも映像の開始を抑止し、publish中の停止は処理順を保ってunpublishする。家族側も作成中は映像枠を外す。
- 保存後は作成前に共有していた場合だけ映像を自動再開する。手動停止やアプリ再起動後は再開ボタンを使う。定期撮影は保存後に再開しない。
- 同意文をv3へ更新し、API生成物とサーバーの新規応答検証を合わせた。追加migration `20260909000200_update_support_consent_v3.sql` は履歴v1・v2を保持する。反映時はDB migration、サーバー、両クライアントの版を揃える。共有環境へは未適用。

検証結果:

| 対象 | 結果 |
|---|---|
| API・共有package | ルートの `npm run generate:api`、`npm run typecheck`、`npm run lint`、`npm run build` 成功。 |
| client | 型チェック・Lint・両Electronアプリのbuild成功。最後の停止完了通知の競合修正後も利用者側の型チェック・Lint・renderer buildを再実行。既存の500kB超chunk警告は残る。 |
| clientテスト | `npm run test -- --maxWorkers=1` は145成功・2skip。連続案内の無消去更新、ネイティブ窓の表示維持、マウス解放、キーボード図の押下表示、画像拡大時の入力保持、共有の停止と条件付き再開、作成中の音声だけの再接続、接続中に作成開始する競合を確認。最終確認で共有停止通知が保存後まで遅れる場合を追加し、利用者Appの22件を再実行して成功。 |
| Go | `CGO_ENABLED=0`、`GOMAXPROCS=2`、`GOFLAGS=-p=1` で `go tool sqlc generate`、`go test ./...`、`go vet ./...`、`go build ./...` 成功。v1・v2・不正な同意の新規受付拒否を確認。 |
| 整形 | 通常の `npm run format:check` は未変更のCRLFファイル74件で失敗。変更ファイルはすべて成功。`npm run format:check -- --end-of-line auto` は全体成功。 |
| 差分・文書 | `git diff --check` 成功。更新した開発・接続・仕様書のローカルリンクの参照先を確認。 |

今回実施できなかった確認:

- clientの2skipはLinux限定の撮影テストとHTTP統合環境変数が必要なテスト。GoのDB・Storage・runtime統合テストも環境変数未設定でskip。この時点ではローカルDocker Engineが停止していたため実DB検証を保留した。後続のDocker追加検証で、新migrationを含むDB・Storage・runtime・クライアント接続テストは成功した（次節参照）。
- 実LiveKitでの音声と映像、Windowsの点滅・DPI・画面内への収まりは未確認。ブラウザ操作ツールはカーネル資産パスのエラーで初期化できず、その後のChromeによる表示確認用起動は自動承認レビューに `blocked by policy` として拒否された。詳細理由は返されていない。模擬DOMとネイティブAPIの自動テストは実画面検証として扱わない。
- Windows配布物の `npm run make:user`・`npm run make:family`、実LiveKit Cloud・Gemini接続は未実施。依存関係・配布設定は今回変更していない。実機で [開発ガイドの確認手順](development.md) を実行する。


## Dockerでの追加検証（2026-09-09）

起動済みのローカルSupabaseを使い、専用DBと非公開の専用Storage bucketで検証した。API生成・sqlc生成も再実行し、生成物に追加変更がないことを確認した。Docker関連のテストで追加修正を要する不具合は検出されなかった。

| 検証 | 結果 |
|---|---|
| DB・Storageを有効にした `go test ./internal/... -count=1 -v` | 114件成功、skipなし。repository/serviceのPostgreSQL統合と実Storageの保存・取得・削除を含む。 |
| `TestServerRuntimeE2E` | 成功。実HTTP・WebSocket・DB・Storage・workerを使い、同意v3での応答、ガイド保存、保存後の試行と手動終了まで確認。生成器とLiveKit認証情報はテスト用。 |
| `TestClientAdapterE2E` | 成功。実 `HttpMiteApi` とGoサーバーを接続し、内側のTypeScript統合テスト1件も成功。 |
| 既存同意のmigration | v1・v2の同意を入れた旧スキーマに `20260909000200_update_support_consent_v3.sql` を適用して成功。両方の同意とrevisionが変更されないことを確認。 |

GoはWindows上で `CGO_ENABLED=0`、`GOMAXPROCS=2`、`GOFLAGS=-p=1` とし、DBとStorageはDocker上のSupabaseを利用した。手順と環境変数は [接続確認](server-client-integration.md#8-接続確認) に従う。端末上のGo race検査は未実施で、PRのLinux CIで実行する。Chromeによる表示確認はユーザーの指示により今回の対象外とする。

検証に作成した `mite_overlay_pr_internal`、`mite_overlay_pr_runtime`、`mite_overlay_pr_client`、`mite_overlay_pr_migration` の4DBと非公開bucket `mite-overlay-pr-tests` は削除した。既存のDB、bucket、Supabaseコンテナと他プロジェクトのコンテナは保持した。
