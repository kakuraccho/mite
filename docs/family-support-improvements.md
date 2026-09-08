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
