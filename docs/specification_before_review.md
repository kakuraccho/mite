# Mite MVP 実装仕様書

> DevCamp2026 / 実装基準 v1.1  
> 最終更新: 2026-09-03  
> 対象: 利用者側クライアント、家族側クライアント、Miteサーバー

## 0. 本書の扱い

本書はMiteのMVPを実装するための正本である。プロダクトの背景や将来案は「Mite プロダクト仕様書」を参照し、実装時の判断は本書を優先する。

- 本書に記載した状態名、API、データ形式、責務分担は固定する。
- UIの色、余白、使用ライブラリなど、通信契約に影響しない内容は各担当者が決めてよい。
- API、状態、データ項目を変更する場合は、クライアント担当とサーバー担当の両者で合意する。
- 文章は常体で統一する。

## 1. MVPの完成条件

1人の利用者と1人の家族が、それぞれ別のWindows PCでElectronアプリを使い、次の流れを最後まで実行できることを完成条件とする。

1. 利用者がスクリーンショットと任意コメントを付けて支援を依頼する。
2. 家族が依頼を確認して発信する。
3. 利用者が応答し、音声通話、画面共有、マーキングを使って支援を受ける。
4. 支援中の画面を利用者側で5秒ごとに取得する。
5. 家族がガイド作成の有無を選ぶ。
6. 作成する場合は、取得画像からAIが下書きを生成する。
7. 家族が下書きを編集し、利用者が同じ内容を閲覧する。
8. 家族がガイドを保存する。
9. 利用者が保存済みガイドを選び、1ステップずつ操作する。
10. ガイドの途中で分からない場合は、ガイド版と現在ステップを引き継いで支援を依頼する。

### 1.1 MVPの制限

- 利用者と家族は固定の1対1とする。
- 同時に扱う未完了の支援は1件とする。
- 通知はアプリ内だけとする。
- 認証は固定のデモ用Bearerトークンとする。
- 利用者側と家族側は、それぞれ独立したWindows向けElectronアプリとする。
- 利用者側と家族側は別のWindows PCで利用する。
- 音声と画面共有にはLiveKit Cloudを使う。
- 操作は利用者本人が行い、家族による遠隔操作は行わない。

### 1.2 MVPに含めないもの

- カメラ映像
- 音声文字起こしと通話録音
- 遠隔操作
- 複数家族による同時対応
- 外部プッシュ通知
- 本格的なアカウント登録、復旧、家族招待
- 高度な切断復旧
- AIによるガイド検索
- バックアップと長期保存管理

## 2. 実行構成

~~~text
利用者PC                         家族PC
└─ 利用者側Electron              └─ 家族側Electron
   ├─ 画面取得                      ├─ 支援依頼確認
   ├─ 音声・画面配信                ├─ 音声・共有画面受信
   ├─ マーキング表示                ├─ マーキング送信
   └─ ガイド表示                    └─ ガイド編集
          │                                  │
          └──────── HTTPS / WSS ─────────────┘
                              │
                         Miteサーバー
                         ├─ REST API
                         ├─ WebSocket
                         ├─ LiveKitトークン発行
                         └─ AIガイド生成
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
Supabase PostgreSQL   Supabase Storage    LiveKit Cloud / AI API
~~~

### 2.1 通信の使い分け

| 用途 | 方式 | 正本 |
|---|---|---|
| 状態変更、保存、取得 | REST API | Miteサーバー |
| 状態変更の通知 | WebSocket | Miteサーバー |
| 音声、画面共有 | LiveKit Media | LiveKit接続 |
| マーキング | LiveKit Data Packet | 保存しない一時データ |
| 5秒ごとの画像 | 利用者端末に一時保存後、RESTで一括登録 | PostgreSQLのメタデータとSupabase Storage |

WebSocketから状態を変更してはならない。WebSocketはREST APIで確定した結果をクライアントへ知らせるためだけに使う。

### 2.2 採用技術

| 対象 | 採用技術 |
|---|---|
| 利用者側アプリ | Electron、React、TypeScript、Vite |
| 家族側アプリ | Electron、React、TypeScript、Vite |
| サーバー | Go 1.26系、Chi v5 |
| API定義 | OpenAPI 3.0.3 |
| Go APIコード生成 | oapi-codegen、chi-server、strict-server |
| TypeScript APIコード生成 | openapi-typescript、openapi-fetch |
| DB | Supabase PostgreSQL |
| DB接続 | pgx/v5のpgxpool、Supavisor Session pooler |
| SQLコード生成 | sqlc |
| DB変更管理 | Supabase CLIのマイグレーション |
| 画像保存 | Supabase Storageの非公開バケット |
| 状態通知 | GoサーバーのWebSocket |
| 音声・画面共有・マーキング | LiveKit Cloud |
| ガイド生成 | GoサーバーからOpenAI APIを呼ぶ |

SupabaseはPostgreSQLとStorageだけに使う。Supabase AuthとSupabase RealtimeはMVPでは使わない。両ElectronアプリはSupabaseへ直接接続せず、すべてMiteサーバーを経由する。

TypeBoxとFastifyは採用しない。両者はTypeScriptサーバー向けであり、GoサーバーではOpenAPIをクライアントとサーバーの通信契約とする。

### 2.3 正本と自動生成

- APIの正本は `api/openapi.yaml` とする。
- PostgreSQLスキーマの正本は `supabase/migrations/*.sql` とする。
- sqlcへ渡すSQLの正本は `server/db/queries/*.sql` とする。
- `oapi-codegen`でGoの型とサーバーインターフェースを生成する。
- `openapi-typescript`でTypeScriptの型を生成し、`openapi-fetch`から利用する。
- `sqlc`でSQLに対応するGoコードを生成する。
- 自動生成ファイルは直接編集しない。正本を変更して再生成する。
- 自動生成ファイルは通常のコードレビュー対象外とし、正本と手書き実装をレビューする。

### 2.4 リポジトリ構成

~~~text
apps/
├─ user-electron/          利用者側Electron
└─ family-electron/        家族側Electron
packages/
└─ api-client/             OpenAPIから生成するTypeScript型とクライアント
api/
└─ openapi.yaml            APIの正本
server/
├─ cmd/api/main.go
├─ internal/
│  ├─ handler/             HTTP入出力
│  ├─ service/             ユースケースと状態遷移
│  ├─ repository/          PostgreSQLとStorageへのアクセス
│  └─ domain/              状態、型、業務ルール
└─ db/queries/             sqlcへ渡すSQL
supabase/
└─ migrations/             PostgreSQLマイグレーション
~~~

両Electronアプリは同じリポジトリで管理するが、別々の実行ファイルとしてビルドする。利用者用と家族用で異なるデモトークンを設定し、実行中に役割を切り替えない。

Electronでは `contextIsolation` を有効、`nodeIntegration` を無効にする。画面取得と端末ファイル操作はメインプロセスで実行し、preloadから必要最小限のAPIだけをReactのレンダラープロセスへ公開する。パッケージ版のレンダラーは、利用者側で `mite-user://app`、家族側で `mite-family://app` をオリジンとして使う。

### 2.5 開発と2台デモの起動方法

- 開発中のGoサーバーは `go run` で直接起動する。
- ローカル開発でDockerを必須としない。
- Dockerfileはクラウド配置先で必要になった場合だけ追加する。
- デモでは、利用者側Electronと家族側Electronを別のWindows PCで起動する。
- デモでは、HTTPSとWSSで公開した同一のGoサーバーへ両アプリから接続する。
- Goサーバーのクラウド配置先は実装開始時に選ぶ。配置先はHTTPS、WebSocket、環境変数、Goプロセスの常時実行に対応するものとする。
- MVPのGoサーバーは1インスタンスで実行する。複数インスタンスへの負荷分散は行わない。
- 開発時はローカルのGoサーバーへ接続できる。2台でローカル接続する場合は同一LAN上のサーバーPCのIPアドレスを使う。
- Supabase Cloud、LiveKit Cloud、OpenAI APIは開発・デモとも外部サービスを利用する。
- 画面全体ではなく、操作対象のウィンドウだけを共有・定期取得する。Mite自身の画面をガイド材料へ含めない。
- 2台のPCでそれぞれマイクとスピーカーを使い、音声、画面共有、マーキングを確認する。

## 3. 共通規約

### 3.1 API規約

- ベースパスは /v1 とする。
- JSONのキーはcamelCaseとする。
- 日時はUTCのISO 8601文字列とする。
- IDは意味を持たない文字列とする。
- ステップ番号と表示順は1始まりとする。
- 操作者は認証情報から判定し、リクエスト本文のuserIdやfamilyIdを信用しない。
- 作成または状態変更を行うPOSTには Idempotency-Key ヘッダーを付ける。
- GuideDraftとGuideRunの更新、および既存状態を完了させるコマンドには expectedRevision を含める。対象は各リクエスト例で明示する。
- 更新成功時にrevisionを1増やす。
- 古いrevisionによる更新は409を返す。

Idempotency-Keyは actorId、method、path、key の組で24時間保持する。同じキーと同じ本文の再送には初回と同じstatusとレスポンスを返す。同じキーで本文が異なる場合は409の IDEMPOTENCY_KEY_REUSED を返す。

### 3.2 認証

MVPでは次の固定トークンを使う。

~~~http
Authorization: Bearer <demo-token>
~~~

- 利用者用と家族用で異なるトークンを用意する。
- トークンから role と actorId を確定する。
- LiveKit API SecretとAI API Keyはサーバーだけが保持する。
- トークンをURLのクエリ文字列へ含めない。

### 3.3 成功レスポンス

~~~json
{
  "data": {}
}
~~~

### 3.4 エラーレスポンス

~~~json
{
  "error": {
    "code": "INVALID_STATE",
    "message": "現在の状態では実行できない",
    "requestId": "req_01"
  }
}
~~~

| HTTP | code | 用途 |
|---:|---|---|
| 400 | VALIDATION_ERROR | 入力形式が不正 |
| 401 | UNAUTHENTICATED | トークンがない、または不正 |
| 403 | FORBIDDEN | 役割または対象が不正 |
| 404 | NOT_FOUND | 対象が存在しない |
| 409 | INVALID_STATE | 現在状態では操作できない |
| 409 | REVISION_CONFLICT | expectedRevisionが古い |
| 409 | IDEMPOTENCY_KEY_REUSED | 同じ再送キーが異なる本文に使われた |
| 409 | DUPLICATE_ACTIVE_REQUEST | 未完了の依頼がすでにある |
| 413 | FILE_TOO_LARGE | 画像サイズ上限を超えた |
| 422 | INSUFFICIENT_MATERIALS | ガイド生成に使える画像がない |
| 500 | INTERNAL_ERROR | サーバー内部エラー |
| 503 | EXTERNAL_SERVICE_UNAVAILABLE | LiveKitまたはAIが利用できない |

## 4. 状態と状態遷移

### 4.1 支援依頼 SupportRequest

~~~text
PENDING
  └─ 利用者が応答する → IN_SUPPORT
       └─ 家族が解決済みにする → RESOLVED
~~~

| 状態 | 意味 |
|---|---|
| PENDING | 家族の対応を待っている |
| IN_SUPPORT | 支援セッションが進行している |
| RESOLVED | 支援が解決済みである |

### 4.2 支援セッション SupportSession

~~~text
RINGING
  └─ 利用者が応答する → ACTIVE
       ├─ ガイドを作らない → ENDED
       └─ ガイドを作る → GENERATING_GUIDE
            ├─ AI生成成功 → REVIEWING_GUIDE
            │    └─ 家族が保存する → ENDED
            └─ 作成を中止する → ENDED

REVIEWING_GUIDE
  └─ 作成を中止する → ENDED
~~~

| 状態 | 意味 |
|---|---|
| RINGING | 家族が発信し、利用者の応答を待っている |
| ACTIVE | 音声、画面共有、支援を行っている |
| GENERATING_GUIDE | 画像アップロードまたはAI生成中である |
| REVIEWING_GUIDE | 家族が下書きを編集し、利用者が閲覧している |
| ENDED | 支援処理が完了している |

### 4.3 ガイド生成ジョブ GuideGenerationJob

~~~text
QUEUED → RUNNING → SUCCEEDED
                  └→ FAILED
FAILED ─ 再試行 → QUEUED
~~~

### 4.4 ガイド下書き GuideDraft

~~~text
EDITING → SAVED
~~~

### 4.5 ガイド利用 GuideRun

~~~text
IN_PROGRESS
  ├─ 最終ステップで完了 → COMPLETED
  └─ 家族に聞く → PAUSED_FOR_SUPPORT
~~~

### 4.6 状態更新の原則

- 業務状態はMiteサーバーを正本とする。
- APIが失敗した場合、クライアントは表示上の状態を先へ進めない。
- クライアントは通知を受信しても、自分が持つrevision以下なら無視する。
- WebSocket再接続後はGET APIで現在状態を再取得する。
- LiveKitの接続状態とSupportSessionの状態は別に管理する。
- LiveKitが切れても、SupportSessionを自動でENDEDへ変更しない。
- SupportSessionがACTIVE以外へ遷移したら、利用者側は画面取得を止めて画面と音声をunpublishし、両クライアントはLiveKit Roomから退出する。REST応答とWebSocket通知のどちらで遷移を知った場合も同じ処理を行う。

## 5. データモデル

すべてのID、日時、status、revisionはAPIレスポンスへ含める。削除フラグは使わず、MVPでは不要データを実削除する。

### 5.1 User

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| role | USER または FAMILY | 固定 |
| displayName | string | 1〜40文字 |

デモデータとして次をseed SQLから冪等に投入する。

| id | role | displayName | 認証トークン |
|---|---|---|---|
| user_demo | USER | 利用者 | DEMO_USER_TOKENの値 |
| family_demo | FAMILY | 家族 | DEMO_FAMILY_TOKENの値 |

固定ペアは user_demo と family_demo とする。

UserPairは userId と familyId を持ち、この組を主キーとする。支援依頼のfamilyIdはUserPairからサーバーが決定する。画像、依頼、セッション、ガイドの認可もこの組に基づいて判定する。

### 5.2 Artifact

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| ownerUserId | string | 利用者ID |
| purpose | REQUEST_SCREENSHOT または GUIDE_MATERIAL または GUIDE_STEP | 必須 |
| mimeType | image/jpeg | 必須 |
| storageKey | string | Supabase Storageのオブジェクトパス。APIでは公開しない |
| byteSize | integer | 10MB以下 |
| width | integer | 1以上 |
| height | integer | 1以上 |
| capturedAt | datetime | 必須 |
| createdAt | datetime | 必須 |

APIのArtifactはstorageKeyを返さず、代わりに contentUrl=/v1/artifacts/{id}/content を返す。

### 5.3 SupportRequest

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| userId | string | 利用者ID |
| familyId | string | 家族ID |
| initialScreenshotArtifactId | string | 必須 |
| comment | string | 任意、0〜500文字 |
| status | SupportRequestStatus | 必須 |
| supportSessionId | string または null | 発信後に設定 |
| guideContext | object または null | ガイドから依頼した場合だけ設定 |
| createdAt | datetime | 必須 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

guideContextは guideId、guideVersionNumber、stepNumber を持つ。ガイド利用からの依頼ではサーバーがGuideRunから生成する。

### 5.4 SupportSession

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| supportRequestId | string | 一意 |
| livekitRoomName | string | 一意 |
| status | SupportSessionStatus | 必須 |
| guideDecision | CREATE、SKIP、null | 解決時に設定 |
| guideMaterialBatchId | string または null | バッチ作成時に設定 |
| guideGenerationJobId | string または null | バッチ完了時に設定 |
| guideDraftId | string または null | AI成功時に設定 |
| consent | object または null | audio、screenShare、periodicCapture、textVersionを保持 |
| consentedAt | datetime または null | ACTIVE遷移時に設定 |
| startedAt | datetime または null | ACTIVE遷移時に設定 |
| endedAt | datetime または null | ENDED遷移時に設定 |
| createdAt | datetime | 必須 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

### 5.5 GuideMaterialBatchとGuideMaterial

GuideMaterialBatchは1支援セッションにつき最大1件とする。

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| supportSessionId | string | 一意 |
| status | UPLOADING、COMPLETED | 必須 |
| expectedItemCount | integer | 1〜360 |
| receivedItemCount | integer | 0以上 |
| capturedFrom | datetime | 必須 |
| capturedTo | datetime | 必須 |
| completedAt | datetime または null | 完了時に設定 |
| revision | integer | 1から開始 |

GuideMaterialは id、batchId、clientCaptureId、artifactId、sequence、capturedAt を持つ。batchIdとclientCaptureIdの組を一意にする。

### 5.6 GuideGenerationJob

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| batchId | string | 必須 |
| status | QUEUED、RUNNING、SUCCEEDED、FAILED | 必須 |
| attempt | integer | 0〜3 |
| guideDraftId | string または null | 成功時に設定 |
| errorCode | string または null | 失敗時に設定 |
| createdAt | datetime | 必須 |
| startedAt | datetime または null | 任意 |
| finishedAt | datetime または null | 任意 |
| revision | integer | 1から開始 |

### 5.7 GuideDraft

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| supportSessionId | string | 一意 |
| title | string | 1〜40文字 |
| steps | GuideStep[] | 1〜8件 |
| status | EDITING、SAVED | 必須 |
| revision | integer | 1から開始 |

GuideStepは position、artifactId、instruction を持つ。positionは1から連番、instructionは1〜120文字とする。

### 5.8 GuideとGuideVersion

- Guideは id、userId、title、currentVersionNumber、createdAt、updatedAt、revision を持つ。MVPではrevision=1で作成する。
- GuideVersionは guideId、versionNumber、title、steps、createdBy、createdAt を持つ。
- ガイド保存時はGuideとGuideVersionを同一トランザクションで作る。
- MVPでは既存ガイドの再編集を行わない。最初の保存版はversionNumber=1とする。

### 5.9 GuideRun

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| guideId | string | 必須 |
| guideVersionNumber | integer | 開始時の版で固定 |
| userId | string | 必須 |
| status | IN_PROGRESS、COMPLETED、PAUSED_FOR_SUPPORT | 必須 |
| currentStepNumber | integer | 1始まり |
| startedAt | datetime | 必須 |
| completedAt | datetime または null | 任意 |
| revision | integer | 1から開始 |

## 6. REST API

### 6.1 エンドポイント一覧

| # | Method | Path | 実行者 | 成功 | 用途 |
|---:|---|---|---|---:|---|
| 1 | POST | /v1/artifacts | 利用者 | 201 | 支援依頼用画像を登録する |
| 2 | GET | /v1/artifacts/{id}/content | 両者 | 200 | 権限確認後に画像を返す |
| 3 | POST | /v1/support-requests | 利用者 | 201 | 支援依頼を作る |
| 4 | GET | /v1/support-requests?status={status} | 両者 | 200 | 自分のペアの依頼を新しい順に返す。statusは省略可 |
| 5 | GET | /v1/support-requests/{id} | 両者 | 200 | 依頼詳細を取得する |
| 6 | POST | /v1/support-requests/{id}/call | 家族 | 201 | RINGINGの支援セッションを作る |
| 7 | GET | /v1/support-sessions/{id} | 両者 | 200 | 支援状態を取得する |
| 8 | POST | /v1/support-sessions/{id}/accept | 利用者 | 200 | 応答と同意を確定する |
| 9 | POST | /v1/support-sessions/{id}/livekit-token | 両者 | 200 | 接続用トークンを得る |
| 10 | POST | /v1/support-sessions/{id}/resolve | 家族 | 200 | 解決済みとガイド作成有無を確定する |
| 11 | POST | /v1/support-sessions/{id}/guide-material-batches | 利用者 | 201 | 画像一括登録を開始する |
| 12 | GET | /v1/guide-material-batches/{id} | 両者 | 200 | 登録状況を取得する |
| 13 | POST | /v1/guide-material-batches/{id}/materials | 利用者 | 201 | 画像1件を登録する |
| 14 | POST | /v1/guide-material-batches/{id}/complete | 利用者 | 202 | 一括登録を閉じ、AI生成を予約する |
| 15 | GET | /v1/guide-generation-jobs/{id} | 両者 | 200 | AI生成状態を取得する |
| 16 | POST | /v1/guide-generation-jobs/{id}/retry | 家族 | 202 | 失敗した生成を再試行する |
| 17 | GET | /v1/guide-drafts/{id} | 両者 | 200 | 同じ下書きを取得する |
| 18 | PATCH | /v1/guide-drafts/{id} | 家族 | 200 | 下書き全体を更新する |
| 19 | POST | /v1/guide-drafts/{id}/save | 家族 | 201 | ガイドとして保存する |
| 20 | GET | /v1/guides | 利用者 | 200 | 利用可能なガイド一覧を返す |
| 21 | GET | /v1/guides/{id} | 利用者 | 200 | 現在版のガイドを返す |
| 22 | POST | /v1/guide-runs | 利用者 | 201 | ガイド利用を開始する |
| 23 | GET | /v1/guide-runs/{id} | 利用者 | 200 | ガイド利用状態を取得する |
| 24 | PATCH | /v1/guide-runs/{id} | 利用者 | 200 | 前または次のステップへ移る |
| 25 | POST | /v1/guide-runs/{id}/complete | 利用者 | 200 | ガイド利用を完了する |
| 26 | POST | /v1/guide-runs/{id}/support-request | 利用者 | 201 | 現在ステップを引き継いで依頼する |
| 27 | POST | /v1/support-sessions/{id}/end-without-guide | 家族 | 200 | 生成またはレビューを中止して終了する |

状態を変更するAPIは次の条件を満たす場合だけ実行する。満たさない場合は409 INVALID_STATEを返す。

| API | 実行前条件 |
|---|---|
| call | SupportRequest=PENDINGかつsupportSessionId=null |
| accept | SupportSession=RINGING |
| livekit-token | SupportSession=ACTIVE |
| resolve | SupportSession=ACTIVE |
| guide-material-batches作成 | SupportSession=GENERATING_GUIDEかつguideMaterialBatchId=null |
| materials登録 | GuideMaterialBatch=UPLOADING |
| batch complete | GuideMaterialBatch=UPLOADINGかつreceivedItemCount=expectedItemCount |
| job retry | GuideGenerationJob=FAILEDかつattempt<3 |
| draft PATCH/save | SupportSession=REVIEWING_GUIDEかつGuideDraft=EDITING |
| guide-run PATCH/complete/support-request | GuideRun=IN_PROGRESS |
| end-without-guide | 第6.3節の中止条件を満たす |

### 6.2 成功レスポンスのdata型

GET /v1/artifacts/{id}/content だけは画像バイナリを返す。それ以外は第3.3節のJSON形式で返す。

| API | data |
|---|---|
| POST artifacts | Artifact |
| POST/GET support-requests、GET support-requests/{id} | SupportRequest。一覧だけ { items: SupportRequest[] }。新しい順で最大20件、ページングなし |
| POST call | { supportRequest: SupportRequest, supportSession: SupportSession } |
| GET support-sessions/{id} | SupportSession |
| POST accept、POST resolve | { supportRequest: SupportRequest, supportSession: SupportSession } |
| POST livekit-token | { serverUrl, roomName, participantIdentity, token, expiresAt } |
| POST/GET guide-material-batches | GuideMaterialBatch。GETでは materials: GuideMaterial[] も含む |
| POST materials | { material: GuideMaterial, batch: GuideMaterialBatch } |
| POST batch complete | { batch: GuideMaterialBatch, job: GuideGenerationJob } |
| GET job、POST retry | GuideGenerationJob |
| GET/PATCH draft | GuideDraft |
| POST draft save | { guide: GuideDetail, supportSession: SupportSession } |
| GET guides | { items: GuideSummary[] } |
| GET guides/{id} | GuideDetail |
| POST/GET/PATCH guide-runs、POST complete | GuideRun |
| POST guide-run support-request | { guideRun: GuideRun, supportRequest: SupportRequest } |
| POST end-without-guide | SupportSession |

GuideSummaryは id、title、currentVersionNumber、representativeArtifactId、updatedAt を持つ。representativeArtifactIdは現在版の先頭ステップのartifactIdとする。GuideDetailは次の形とし、stepsはcurrentVersionの内側だけに置く。

~~~json
{
  "id": "guide_01",
  "userId": "user_demo",
  "title": "認証コードを確認して元の画面に戻る",
  "currentVersionNumber": 1,
  "revision": 1,
  "createdAt": "2026-09-03T10:10:00Z",
  "updatedAt": "2026-09-03T10:10:00Z",
  "representativeArtifactId": "art_11",
  "currentVersion": {
    "versionNumber": 1,
    "title": "認証コードを確認して元の画面に戻る",
    "createdBy": "family_demo",
    "createdAt": "2026-09-03T10:10:00Z",
    "steps": [
      {
        "position": 1,
        "artifactId": "art_11",
        "instruction": "メール画面を開き、認証コードを確認する"
      }
    ]
  }
}
~~~

関連IDは第5章の親エンティティにも必ず含め、再読込時に親から子を取得できるようにする。

### 6.3 主要リクエスト

#### 画像登録

POST /v1/artifacts は multipart/form-data とし、次を送る。

| field | 値 |
|---|---|
| purpose | REQUEST_SCREENSHOT |
| capturedAt | ISO 8601 |
| file | JPEG、10MB以下 |

#### 支援依頼作成

~~~json
{
  "initialScreenshotArtifactId": "art_01",
  "comment": "元の購入画面に戻れない"
}
~~~

サーバーは未完了依頼の有無、ENDEDでないSupportSessionの有無、画像所有者を確認する。いずれかの支援処理が残っている場合は新しい依頼を作らない。

#### 発信

SupportRequestの現在revisionを送る。

~~~json
{
  "expectedRequestRevision": 1
}
~~~

成功時にSupportRequest.supportSessionIdへ作成したセッションIDを設定する。

#### 応答

~~~json
{
  "expectedSessionRevision": 1,
  "consent": {
    "audio": true,
    "screenShare": true,
    "periodicCapture": true,
    "textVersion": "v1"
  }
}
~~~

3項目すべてがtrueの場合だけACTIVEへ遷移させる。SupportRequestのIN_SUPPORT遷移も同一トランザクションで行う。

#### LiveKitトークン取得

本文は空オブジェクトとする。SupportSessionがACTIVEであり、操作者が当該ペアの一員である場合だけ発行する。

~~~json
{
  "data": {
    "serverUrl": "wss://example.livekit.cloud",
    "roomName": "mite-session_01",
    "participantIdentity": "user:user_01",
    "token": "jwt",
    "expiresAt": "2026-09-03T10:30:00Z"
  }
}
~~~

家族の場合のidentityは family:family_01 とする。

#### 支援解決

~~~json
{
  "expectedSessionRevision": 2,
  "guideDecision": "CREATE"
}
~~~

- CREATEならSupportRequestをRESOLVED、SupportSessionをGENERATING_GUIDEへ変更する。
- SKIPならSupportRequestをRESOLVED、SupportSessionをENDEDへ変更する。
- 両方の更新を同一トランザクションで行う。

#### 画像バッチ作成

~~~json
{
  "captureIntervalSeconds": 5,
  "capturedFrom": "2026-09-03T10:00:00Z",
  "capturedTo": "2026-09-03T10:03:00Z",
  "expectedItemCount": 37
}
~~~

成功時にSupportSession.guideMaterialBatchIdへ作成したバッチIDを設定する。

#### 画像1件の登録

POST /v1/guide-material-batches/{id}/materials はmultipart/form-dataとする。

| field | 値 |
|---|---|
| clientCaptureId | 端末側で生成した一意ID |
| sequence | 1始まりの連番 |
| capturedAt | ISO 8601 |
| file | JPEG、10MB以下 |

同じclientCaptureIdの再送は重複保存せず、既存のGuideMaterialと現在のGuideMaterialBatchを200で返す。新規登録時は両者を201で返す。並列アップロード時、クライアントは応答中で最も大きいbatch.revisionを保持する。

#### バッチ完了

~~~json
{
  "expectedBatchRevision": 38,
  "expectedItemCount": 37
}
~~~

サーバー上の件数と一致した場合だけCOMPLETEDへ変更し、GuideGenerationJobを1件作り、SupportSession.guideGenerationJobIdへ設定する。バッチ完了、ジョブ作成、参照ID更新は同一トランザクションで行う。

#### AI生成の再試行

~~~json
{
  "expectedJobRevision": 3
}
~~~

FAILEDの場合だけ受け付ける。attemptが3以上なら409を返す。成功時はQUEUEDへ戻し、202で更新後のGuideGenerationJobを返す。attemptはワーカーがQUEUEDからRUNNINGへ移す時に1増やす。最初の実行前は0、実行上限は3とする。

#### 下書き更新

PATCHは差分ではなく、タイトルと全ステップを送る。

~~~json
{
  "expectedRevision": 3,
  "title": "認証コードを確認して元の画面に戻る",
  "steps": [
    {
      "position": 1,
      "artifactId": "art_11",
      "instruction": "メール画面を開き、認証コードを確認する"
    },
    {
      "position": 2,
      "artifactId": "art_17",
      "instruction": "画面下のブラウザのマークを押す"
    }
  ]
}
~~~

artifactIdは、その支援依頼の初期スクリーンショット、または同じ支援セッションのGuideMaterialに含まれるものだけ指定できる。

#### 下書き保存

~~~json
{
  "expectedRevision": 4
}
~~~

Guide、GuideVersion、GuideStepを作成し、GuideDraftをSAVED、SupportSessionをENDEDへ変更する。すべてを同一トランザクションで行う。

#### ガイド利用開始

~~~json
{
  "guideId": "guide_01"
}
~~~

サーバーはその時点のcurrentVersionNumberをGuideRunへ固定し、currentStepNumber=1で作成する。

#### ステップ移動

~~~json
{
  "expectedRevision": 2,
  "action": "NEXT"
}
~~~

actionはNEXTまたはPREVIOUSとする。範囲外への移動は400を返す。

#### ガイドから支援依頼

~~~json
{
  "expectedRevision": 3,
  "initialScreenshotArtifactId": "art_90",
  "comment": "このボタンが見つからない"
}
~~~

サーバーはGuideRunからguideId、guideVersionNumber、currentStepNumberを取得してSupportRequest.guideContextへ保存する。クライアントがガイド情報を本文で指定してはならない。GuideRunのPAUSED_FOR_SUPPORT遷移とSupportRequest作成は同一トランザクションで行う。

#### ガイド利用完了

~~~json
{
  "expectedRevision": 4
}
~~~

GuideRunがIN_PROGRESSであり、currentStepNumberが最終ステップの場合だけCOMPLETEDへ変更する。

#### ガイド作成を中止して終了

~~~json
{
  "expectedSessionRevision": 8
}
~~~

SupportSessionがREVIEWING_GUIDEの場合、またはGENERATING_GUIDEかつジョブが未作成・FAILEDの場合だけ受け付ける。QUEUEDまたはRUNNING中は409を返し、家族側の終了ボタンを無効にする。未保存の下書き、ジョブ、ガイド材料を削除し、SupportSessionをENDEDへ変更する。保存済みGuideは削除しない。

## 7. WebSocket

### 7.1 接続

- 接続先は /v1/events とする。
- 接続後5秒以内に認証メッセージを送る。

~~~json
{
  "type": "authenticate",
  "token": "demo-token"
}
~~~

- 成功時、サーバーは authenticated を返す。
- 切断時は1秒、2秒、5秒、以降10秒間隔で再接続する。
- 再接続後は画面で扱っているエンティティをGETし直す。

両クライアントは最後に扱ったSupportRequest IDを端末へ保存する。起動・再読込時はそのIDをGETし、supportSessionId、guideMaterialBatchId、guideGenerationJobId、guideDraftIdの順に必要な子を取得する。IDが端末にない場合は支援依頼一覧を新しい順に確認し、supportSessionIdを持つ最新項目からセッションを取得する。セッションがENDEDでなければ対応画面を復元する。

### 7.2 イベント形式

~~~json
{
  "eventId": "evt_01",
  "type": "supportSession.updated",
  "occurredAt": "2026-09-03T10:00:00Z",
  "entityId": "session_01",
  "revision": 3,
  "data": {}
}
~~~

dataには差分ではなく更新後のエンティティ全体を入れる。

### 7.3 イベント一覧

- supportRequest.created
- supportRequest.updated
- supportSession.created
- supportSession.updated
- guideMaterialBatch.created
- guideMaterialBatch.updated
- guideGenerationJob.created
- guideGenerationJob.updated
- guideDraft.created
- guideDraft.updated
- guide.created
- guideRun.created
- guideRun.updated

イベントは当該利用者と家族の接続だけへ送る。

## 8. LiveKit

### 8.1 Miteサーバーの処理

- SupportSessionごとに roomName = mite-<supportSessionId> を使う。
- ACTIVEのセッションにだけ、30分有効の参加トークンを発行する。
- 利用者と家族以外の参加を許可しない。
- LiveKit API KeyとSecretをクライアントへ渡さない。
- 業務状態はLiveKitのルーム状態から自動変更しない。
- 両者にroomJoin=trueとcanSubscribe=trueを付与する。
- 利用者はcanPublish=true、canPublishData=false、publishSourcesはmicrophoneとscreen_shareだけとする。cameraとscreen_share_audioは許可しない。
- 家族はcanPublish=true、canPublishData=true、publishSourcesはmicrophoneだけとする。cameraとscreen_shareは許可しない。
- 両者のData Packet受信を許可するが、Miteの実装上、マーキング送信UIは家族側だけに置く。

### 8.2 利用者側

- マイク音声をpublishする。
- 支援対象の画面またはウィンドウをscreen share trackとしてpublishする。
- 家族の音声をsubscribeして再生する。
- topicが mite.marking.v1 のData Packetを受け取り、画面上へ表示する。
- カメラはpublishしない。

### 8.3 家族側

- マイク音声をpublishする。
- 利用者の音声とscreen share trackをsubscribeする。
- 表示中の共有画面をクリックしたとき、マーキングをData Packetで送る。
- カメラと画面はpublishしない。

### 8.4 マーキング形式

送信topicは mite.marking.v1、配信方式はreliableとする。

~~~json
{
  "type": "mark.set",
  "markId": "mark_01",
  "trackSid": "TR_xxx",
  "x": 0.42,
  "y": 0.31,
  "shape": "CIRCLE",
  "ttlMs": 2000,
  "sentAt": "2026-09-03T10:00:00Z"
}
~~~

- xとyは映像の左上を0、右下を1とした正規化座標とする。
- 共有映像の余白を除いた実映像領域から座標を計算する。
- 受信側はtrackSidが現在表示中の画面共有と一致する場合だけ描画する。
- 同じmarkIdは上書きする。
- ttlMs後に自動で消す。
- マーキングはDB、ログ、ガイド材料へ保存しない。
- screen share trackがunpublishされた場合は、そのtrackSidのマークをすべて消す。

全消去は次を送る。

~~~json
{
  "type": "mark.clear",
  "trackSid": "TR_xxx",
  "sentAt": "2026-09-03T10:00:01Z"
}
~~~

## 9. 5秒ごとの画面取得

### 9.1 開始と停止

- SupportSessionがACTIVEになり、画面共有trackのpublishが成功した時点で開始する。
- 開始直後に1枚取得し、その後5秒ごとに取得する。
- 画面共有が一時停止した間は取得しない。
- 1セッションの上限は360枚とする。
- CREATE選択時にアップロードへ進む。
- SKIP選択時は全画像を直ちに削除する。

### 9.2 画像形式

- 画面共有と同じ対象を取得する。
- JPEG、品質80とする。
- 最大1920×1080へ縦横比を保って縮小する。
- ファイルごとにclientCaptureId、sequence、capturedAtを記録する。
- Mite自身のガイド表示やマーキングをガイド画像へ含めない。デモでは対象ウィンドウだけを共有・取得する。

### 9.3 端末保存

保存先は次とする。

~~~text
%LOCALAPPDATA%\Mite\captures\<supportSessionId>\
├─ manifest.json
├─ 000001.jpg
├─ 000002.jpg
└─ ...
~~~

manifest.jsonの1件は次の形式とする。

~~~json
{
  "clientCaptureId": "cap_01",
  "sequence": 1,
  "capturedAt": "2026-09-03T10:00:00Z",
  "filename": "000001.jpg"
}
~~~

### 9.4 アップロード

- 同時アップロード数は3とする。
- 失敗時は1秒、2秒、4秒後に最大3回再試行する。
- 全件成功後にバッチ完了APIを呼ぶ。
- バッチ完了成功後に端末上の対象ディレクトリを削除する。
- アプリ起動時に24時間を超えた未処理ディレクトリを削除する。
- サーバーはガイド保存まで全材料を保持し、保存後は採用されたGuideStepの画像だけを残す。

## 10. AIガイド生成

### 10.1 実行方式

- MVPの既定実装はOpenAI Responses APIの POST /v1/responses とする。
- モデルは gpt-5.4-mini とし、画像入力とStructured Outputsを使う。
- リクエストでは store=false とし、HTTPタイムアウトは60秒とする。
- AI生成はサーバーの非同期ジョブとして実行する。
- ジョブ実行には外部キューを使わず、サーバープロセス内のワーカー1個がQUEUEDを順番に処理する。
- サーバー起動時に残っているRUNNINGは、attemptが3未満ならQUEUED、3ならFAILEDへ戻す。
- バッチ完了時にQUEUEDで作成し、ワーカーがRUNNINGへ変更する。
- 成功時は下書きを作り、ジョブをSUCCEEDED、SupportSessionをREVIEWING_GUIDEへ変更し、SupportSession.guideDraftIdへ設定する。
- 失敗時はジョブをFAILEDへ変更する。家族は最大3回まで再試行できる。
- AIの直接出力を保存済みGuideにしてはならない。必ずGuideDraftとして家族の確認を通す。

### 10.2 入力

次だけをAIへ渡す。

- 支援依頼のコメント
- 支援依頼時のスクリーンショット
- 定期取得した画像のうち最大30枚
- 各画像のartifactId、capturedAt、sequence

30枚を超える場合は最初と最後を必ず残し、間を時間順に等間隔で選ぶ。音声、マーキング、ユーザー識別情報は渡さない。

### 10.3 出力

AIにはJSONだけを返させる。

~~~json
{
  "title": "認証コードを確認して元の画面に戻る",
  "steps": [
    {
      "sourceArtifactId": "art_11",
      "instruction": "メール画面を開き、認証コードを確認する"
    }
  ]
}
~~~

サーバーは次を検証する。

- titleは1〜40文字である。
- stepsは1〜8件である。
- instructionは1〜120文字である。
- sourceArtifactIdは入力画像のいずれかである。
- すべての項目が揃い、余分な項目がない。

検証に失敗した場合はジョブをFAILEDとする。

Structured Outputsへ渡すJSON Schemaは次を正本とする。

~~~json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "steps"],
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40
    },
    "steps": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["sourceArtifactId", "instruction"],
        "properties": {
          "sourceArtifactId": { "type": "string", "minLength": 1 },
          "instruction": { "type": "string", "minLength": 1, "maxLength": 120 }
        }
      }
    }
  }
}
~~~

### 10.4 プロンプト要件

サーバー側で次の指示を固定し、AI_PROMPT_VERSIONで版管理する。

~~~text
PC操作支援の連続画像から、高齢の利用者が後日一人で実行できる短いガイドを作る。
画像から確認できない操作を推測しない。
1ステップには1操作だけを書く。
「ここ」「これ」ではなく、画面上で見つけられる名称・色・位置を書く。
与えられたartifactIdだけを使う。
指定されたJSON形式以外を出力しない。
~~~

呼び出しはGuideGeneratorインターフェースの内側へ閉じ込める。実装は画像を data:image/jpeg;base64,... 形式の input_image として時間順に並べ、画像直前の input_text にartifactId、capturedAt、sequenceを記載する。text.formatには strict=true のjson_schemaを指定し、第10.3節のスキーマを渡す。返却されたoutput_textをJSONとして再検証してからGuideDraftを作る。

MVPではOpenAI以外のproviderを実装しない。ただしGuideGeneratorを差し替え可能にし、単体テストではFakeGuideGeneratorを注入する。

## 11. 画面と処理

### 11.1 利用者側

| ID | 画面 | 主な表示と操作 | 使用API・通信 |
|---|---|---|---|
| U-01 | 左端入口 | 左端4pxの反応領域。300msのhoverで幅320pxのパネルを開く | なし |
| U-02 | 支援依頼 | 取得画像プレビュー、任意コメント、送信 | POST artifacts、POST support-requests |
| U-03 | 支援待ち | 「家族に知らせた」、依頼内容 | WebSocket、GET support-request |
| U-04 | 着信 | 家族名、「応答する」 | POST accept |
| U-05 | 支援中 | 支援中表示、マイク切替、受信音声レベル、共有停止、終了状態、マーキング | LiveKit、WebSocket |
| U-06 | ガイド一覧 | タイトル、代表画像、選択 | GET guides |
| U-07 | ガイド実行 | 1ステップの画像と説明、戻る、次へ、完了、家族に聞く。家族に聞く時は現在画面を取得して登録する | GuideRun API、POST artifacts |
| U-08 | 下書き閲覧 | 家族が編集中のタイトルと手順を読み取り専用表示 | GET draft、WebSocket |

利用者側の本文文字は20px以上、主要ボタンの高さは48px以上とする。専門用語を画面へ表示しない。

### 11.2 家族側

| ID | 画面 | 主な表示と操作 | 使用API・通信 |
|---|---|---|---|
| F-01 | 依頼一覧・詳細 | 利用者名、画像、コメント、ガイド文脈、発信 | GET requests、POST call |
| F-02 | 呼び出し中 | 応答待ち | WebSocket |
| F-03 | 支援中 | 共有画面、マイク切替、受信音声レベル、クリックでマーキング、解決 | LiveKit、POST resolve |
| F-04 | ガイド生成中 | アップロード件数、生成状態、失敗時の再試行、作成せず終了 | Batch/Job API、end-without-guide、WebSocket |
| F-05 | 下書き編集 | タイトル、画像、説明、順番、削除、保存、作成せず終了 | Draft API、end-without-guide、WebSocket |

下書き編集は最後の入力から500ms後にPATCHする。保存ボタンは未完了のPATCH成功後にだけ有効にする。409時は最新下書きを再取得し、「内容が更新されたため読み直した」と表示する。

### 11.3 支援中の共有停止

- 利用者が「画面共有を止める」を押したら1秒以内にscreen share trackをunpublishする。
- 定期取得も同時に停止する。
- マイクは別の操作として継続してよい。
- 再開ボタンで同じ対象を再選択し、publish成功後に定期取得を再開する。

## 12. 保存とトランザクション

### 12.1 保存先

- 構造化データはSupabase PostgreSQLへ保存する。
- 画像はSupabase Storageの非公開バケット `mite-artifacts` へ保存する。
- DBにはStorageのオブジェクトパスであるstorageKeyだけを持つ。
- オブジェクトパスは `<ownerUserId>/<artifactId>.jpg` とする。
- ElectronアプリからPostgreSQLとStorageへ直接接続しない。
- 画像は公開URLで配信しない。MiteサーバーがArtifact APIで権限を確認し、Storageから取得して返す。
- Supabase AuthとSupabase RealtimeはMVPでは使わない。
- SupabaseのSecret keyとDB接続文字列はMiteサーバーだけが保持する。

Artifact登録では、Miteサーバーが画像を検証してStorageへアップロードした後、DBへメタデータを登録する。DB登録に失敗した場合はアップロード済みオブジェクトを削除する。Storageへのアップロードに失敗した場合はDBへArtifactを作らない。

DBスキーマはSupabase CLIのマイグレーションだけで変更する。共有SupabaseプロジェクトのDashboardから本番スキーマを直接変更してはならない。開発・デモでは同じSupabaseプロジェクトを使用する。

### 12.2 必須の一意制約

- SupportSession.supportRequestId
- GuideMaterialBatch.supportSessionId
- GuideMaterial(batchId, clientCaptureId)
- GuideGenerationJobは完了バッチにつき、同時にQUEUEDまたはRUNNINGのものを1件だけ許可する。
- 未完了のSupportRequestは利用者につき1件だけ許可する。
- ENDEDでないSupportSessionは利用者につき1件だけ許可する。支援依頼作成時にもこの条件を検証する。

### 12.3 同一トランザクションで行う処理

1. 利用者の応答、SupportRequestのIN_SUPPORT化、SupportSessionのACTIVE化
2. 支援解決、SupportRequestのRESOLVED化、SupportSessionの次状態への変更
3. バッチ完了、生成ジョブ作成
4. AI成功、GuideDraft作成、SupportSessionのREVIEWING_GUIDE化
5. 下書き保存、GuideとGuideVersion作成、下書きとセッションの完了
6. ガイド途中の支援依頼作成、GuideRunのPAUSED_FOR_SUPPORT化

### 12.4 保存しない情報

- 通話音声
- LiveKitの映像トラック
- マーキング
- マイク入力
- LiveKitトークン
- AI API Key

ログにはコメント本文、画像内容、トークン、APIキーを出力しない。ID、状態、処理時間、エラーコードだけを記録する。

## 13. 担当範囲

### 13.1 クライアント担当

- 利用者側Windowsアプリの全画面
- 家族側Windowsアプリの全画面
- 2つのElectronアプリのビルドと起動設定
- 左端入口と支援依頼UI
- スクリーンショット取得、5秒ごとの保存、アップロード、端末削除
- Electronのmain、preload、renderer間のIPC
- LiveKit SDKによるマイク、画面共有、受信、切断
- マーキングの座標計算、送信、表示、消去
- ガイド一覧、下書き閲覧・編集、ガイド実行
- REST APIとWebSocketへの接続
- revision、再試行、ローディング、エラー表示
- サーバー未完成時のFake API

### 13.2 サーバー担当

- 本書のREST API
- OpenAPI 3.0.3とGo APIコード生成の管理
- WebSocket認証とイベント配信
- 業務状態とrevisionの管理
- 固定ユーザー認証と1対1の権限確認
- Supabase PostgreSQLのスキーマ、マイグレーション、SQL
- pgx/v5とsqlcによるDBアクセス
- Supabase Storageの画像登録、読取、削除
- LiveKit参加トークンの発行
- AI入力の選別、生成ジョブ、出力検証
- ガイド、版、利用状態の保存
- Idempotency-Key、重複送信、トランザクション
- エラーコードとサーバーログ

### 13.3 2人で合わせるもの

次は片方だけで変更してはならない。

- APIのパス、method、JSON、HTTP status、エラーコード
- 状態名と遷移条件
- WebSocketのイベント名とdata形式
- LiveKitのroomName、identity、publish権限、Data Packet形式
- x、y座標の基準と映像余白の扱い
- 日時、ID、step番号、revisionの規約
- 画像形式、上限、5秒間隔、削除条件
- AI出力JSONと文字数・件数制約
- デモ用トークンと接続先
- 正常系E2Eの開始条件と期待結果
- OpenAPI、マイグレーション、生成コマンドの変更
- 利用者側と家族側ElectronのAPI接続先

共有契約を変更した場合は本書を先に更新し、その後に両実装を変更する。

### 13.4 サーバーのコード構成とレビュー規則

- handlerはHTTPの入力をserviceへ渡し、serviceの結果をHTTPレスポンスへ変換する。業務ルールとSQLを書かない。
- serviceはユースケース、権限確認、状態遷移、トランザクション境界を担当する。
- repositoryはPostgreSQLとStorageへのアクセスを担当し、HTTPの型を受け取らない。
- domainは状態、データ型、状態遷移のルールを持ち、Chi、pgx、Supabase SDKへ依存しない。
- `main.go`で依存関係を明示的に組み立てる。不要な依存性注入フレームワークは使わない。
- 外部サービス境界以外に、目的のないinterfaceを作らない。
- 状態遷移とserviceはテーブル駆動テストで正常系を確認する。
- 1つのレビューで扱うユースケースを小さく保つ。
- レビューではOpenAPI、手書きSQL、状態遷移、権限、トランザクション、エラー処理を確認する。
- `oapi-codegen`、`openapi-typescript`、`sqlc`の生成物はレビュー対象外とする。生成元と生成結果の差分が一致することだけを確認する。

## 14. 環境変数

### 14.1 サーバー

~~~dotenv
PORT=3000
DATABASE_URL=postgresql://postgres:password@example.supabase.co:5432/postgres
SUPABASE_URL=https://example.supabase.co
SUPABASE_SECRET_KEY=change-me
SUPABASE_STORAGE_BUCKET=mite-artifacts
DEMO_USER_TOKEN=change-me
DEMO_FAMILY_TOKEN=change-me
LIVEKIT_URL=wss://example.livekit.cloud
LIVEKIT_API_KEY=change-me
LIVEKIT_API_SECRET=change-me
AI_PROVIDER=openai
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=change-me
AI_MODEL=gpt-5.4-mini
AI_PROMPT_VERSION=v1
CLIENT_ORIGINS=http://localhost:5173,http://localhost:5174,mite-user://app,mite-family://app
~~~

### 14.2 利用者側

~~~dotenv
MITE_API_BASE_URL=https://api.example.com
MITE_DEMO_TOKEN=change-me
CAPTURE_INTERVAL_MS=5000
CAPTURE_MAX_COUNT=360
~~~

### 14.3 家族側

~~~dotenv
MITE_API_BASE_URL=https://api.example.com
MITE_DEMO_TOKEN=change-me
~~~

ローカル開発ではMITE_API_BASE_URLを `http://localhost:3000` に変更する。2台を同一LANで接続する場合はlocalhostではなくGoサーバーを起動したPCのIPアドレスを使う。

Supabase、LiveKit、OpenAIのSecretをクライアントの配布物やGitへ含めてはならない。Electronアプリには役割ごとのデモトークンだけを設定する。

## 15. 最低限のエラー動作

| 事象 | クライアント動作 |
|---|---|
| REST通信失敗 | 現在状態を維持し、「通信できない。もう一度試す」を表示する |
| 401 | デモ設定不備として停止し、再読み込みだけを表示する |
| 409 INVALID_STATE | 対象をGETし直し、サーバー状態へ合わせる |
| 409 REVISION_CONFLICT | 最新データを取得し直す |
| LiveKit接続失敗 | 業務状態は変えず、接続の再試行を表示する |
| 画面共有停止 | 音声は継続し、共有停止を両画面へ表示する |
| 画面取得失敗 | 支援は継続し、利用者側へガイド材料不足を表示する。CREATE後に画像が0件ならサーバーが422を返し、家族側にも作成不能を表示する |
| 画像アップロード失敗 | 端末画像を残し、失敗分だけ再送する |
| AI生成失敗 | 家族側へ再試行ボタンを表示する |
| WebSocket切断 | 再接続し、成功後にGETで状態を復元する |

高度な自動復旧は行わない。少なくともデータを失わず、再試行できる状態に止める。

## 16. 実装順

1. `api/openapi.yaml`へ本書のAPIを記述する。
2. `supabase/migrations`へPostgreSQLスキーマとデモデータを記述する。
3. `server/db/queries`へSQLを記述し、OpenAPIとSQLからGo・TypeScriptコードを生成する。
4. Go、Chi、handler、service、repository、domainの基本構成を作る。
5. 固定ユーザー認証、支援依頼API、Supabase Storageへの画像登録を作る。
6. 利用者の支援依頼画面と家族の依頼画面を接続する。
7. SupportSession APIとWebSocketを接続する。
8. LiveKitの音声・画面共有を接続する。
9. マーキングを接続する。
10. 5秒取得、端末保存、バッチアップロードを作る。
11. AI生成ジョブと下書きAPIを作る。
12. 家族の下書き編集と利用者の閲覧を接続する。
13. ガイド保存、一覧、実行を作る。
14. ガイド途中からの支援依頼を接続する。
15. 2台のWindows PCと公開Goサーバーで正常系E2Eを通す。

各段階ではサーバー未完成ならFake API、クライアント未完成ならAPIテストクライアントを使い、担当者同士が待たないようにする。

## 17. 受け入れテスト

### 17.1 支援からガイド保存

1. 利用者が画像とコメント付きの依頼を送る。
2. 家族側に同じ依頼が表示される。
3. 家族が発信し、利用者が応答すると両画面がACTIVEになる。
4. 利用者側マイクだけを有効にすると家族側の受信レベルが動き、家族側マイクだけを有効にすると利用者側の受信レベルが動く。家族側には利用者の共有画面が表示される。
5. 家族が共有画面をクリックすると、2秒以内に利用者側へ2秒間マークが出る。表示中心の誤差は、同じ映像座標へ換算したとき20px以内とする。
6. 共有開始から15秒後までに、開始直後を含め4枚以上の画像が端末へ保存される。
7. CREATEを選ぶと全画像がアップロードされ、AIジョブが実行される。バッチ完了から60秒以内にSUCCEEDEDまたはFAILEDへ到達する。
8. 成功した下書きが1〜8ステップで、JSON Schema検証を通り、入力に存在するartifactIdだけを参照している。
9. 両画面に同じ下書きが表示される。
10. 家族の編集がPATCH成功から2秒以内に利用者側へ反映される。
11. 家族が保存するとセッションがENDEDになり、ガイド一覧へ表示される。
12. 再読み込みとサーバー再起動後も保存済みガイドが残る。

### 17.2 ガイドを作らない場合

1. ACTIVEの支援でSKIPを選ぶ。
2. SupportRequestがRESOLVED、SupportSessionがENDEDになる。
3. 端末の定期取得画像が削除される。
4. Guide、GuideDraft、GuideGenerationJobが作られない。

### 17.3 ガイド利用

1. 利用者が一覧からガイドを選ぶ。
2. GuideRunがIN_PROGRESS、step=1で作られる。
3. 次へ、戻るでサーバーと画面のstepが一致する。
4. 最終ステップで完了するとCOMPLETEDになる。
5. 家族に聞くを選ぶと、新しいSupportRequestにガイドID、版、現在ステップが入る。
6. 同時にGuideRunがPAUSED_FOR_SUPPORTになる。

### 17.4 契約と安全性

- 同じIdempotency-Keyによる再送でデータが増えない。
- 古いexpectedRevisionで更新すると409になる。
- 家族は別ペアの画像を取得できない。
- クライアントからLiveKit API SecretとAI API Keyを確認できない。
- 共有停止操作から1秒以内に映像publishと定期取得が止まる。
- 2台のWindows PCで利用者側Electronと家族側Electronを起動し、公開Goサーバーへ接続して全正常系を実演できる。

## 18. 完了の定義

MVP実装完了は次をすべて満たした時点とする。

- 第17章のテストがすべて通る。
- 状態名とAPIが本書と一致する。
- デモ用の起動手順と環境変数例がリポジトリにある。
- DBを空にした状態から固定データを投入できる。
- 画像、DB、LiveKit Cloud、AI APIを使った正常系がモックなしで通る。
- 既知の未対応事項がREADMEに記録されている。

## 19. 参考資料

- Mite プロダクト仕様書
- Chi: https://github.com/go-chi/chi
- oapi-codegen: https://github.com/oapi-codegen/oapi-codegen
- sqlc: https://docs.sqlc.dev/
- Supabase PostgreSQL connection: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase database migrations: https://supabase.com/docs/guides/deployment/database-migrations
- Supabase Storage: https://supabase.com/docs/guides/storage/buckets/fundamentals
- LiveKit Screen sharing: https://docs.livekit.io/transport/media/screenshare/
- LiveKit Data packets: https://docs.livekit.io/transport/data/packets/
- LiveKit Tokens and grants: https://docs.livekit.io/frontends/reference/tokens-grants/
- OpenAI Responses API: https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- OpenAI GPT-5.4 Mini: https://developers.openai.com/api/docs/models/gpt-5.4-mini
