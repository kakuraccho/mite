# Mite MVP 実装仕様書

> DevCamp2026 / 実装基準 v1.3
> 最終更新: 2026-09-04
> 対象: 利用者側クライアント、家族側クライアント、Miteサーバー

## 0. 本書の扱い

本書はMiteのMVPを実装するための正本である。プロダクトの背景や将来案は[プロダクトシート](./PS.md)を参照し、実装時の判断は本書を優先する。

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
| JavaScriptパッケージ管理 | npm workspaces |
| DB | Supabase PostgreSQL |
| DB接続 | pgx/v5のpgxpool、Supavisor Session pooler |
| SQLコード生成 | sqlc |
| DB変更管理 | Supabase CLIのマイグレーション |
| 画像保存 | Supabase Storageの非公開バケット |
| 状態通知 | GoサーバーのWebSocket |
| 音声・画面共有・マーキング | LiveKit Cloud |
| ガイド生成 | GoサーバーからGemini APIを呼ぶ（APIキーはGoogle AI Studioで管理） |

SupabaseはPostgreSQLとStorageだけに使う。Supabase AuthとSupabase RealtimeはMVPでは使わない。両ElectronアプリはSupabaseへ直接接続せず、すべてMiteサーバーを経由する。

Google AI StudioはGemini APIのプロジェクトとAPIキーの管理に使い、アプリの実行基盤としては使わない。GoサーバーはGemini APIへ直接HTTPSで接続する。

TypeBoxとFastifyは採用しない。両者はTypeScriptサーバー向けであり、GoサーバーではOpenAPIをクライアントとサーバーの通信契約とする。

### 2.3 正本と自動生成

- APIの正本は `api/openapi.yaml` とする。
- PostgreSQLスキーマの正本は `supabase/migrations/*.sql` とする。
- sqlcへ渡すSQLの正本は `server/db/queries/*.sql` とする。
- `oapi-codegen`でGoの型とサーバーインターフェースを生成する。
- `openapi-typescript`でTypeScriptの型を生成し、`openapi-fetch`から利用する。
- `sqlc`でSQLに対応するGoコードを生成する。
- 自動生成ファイルは直接編集しない。正本を変更して再生成する。
- 自動生成ファイルはリポジトリへ含め、生成元と同じPull Requestで更新する。
- 自動生成ファイルは通常のコードレビュー対象外とし、正本と手書き実装をレビューする。
- ルートのnpm workspaceは `apps/*` と `packages/*` を対象とし、`mock/*` は含めない。
- `packages/api-client` は非公開workspace package `@mite/api-client` とし、npm registryへ公開しない。
- `packages/api-client` はOpenAPIから生成したTypeScript型と、API接続先およびBearerトークンを受け取る最小限のクライアント生成処理を公開する。画面状態、Electron固有処理、Idempotency-Keyの端末保存、再試行およびWebSocket接続は各Electronアプリが持つ。
- `oapi-codegen` は `server/go.mod` のtool dependency、`openapi-typescript` は `packages/api-client` のdevDependencyとしてバージョンを固定する。JavaScript依存関係はルートの `package-lock.json` で固定する。
- ルートの `npm run generate:api` で、同じ `api/openapi.yaml` からGoの型とサーバーインターフェース、およびTypeScript型を一括生成する。

API契約を変更する場合は、先に本書を更新してクライアント担当とサーバー担当で合意し、次に `api/openapi.yaml` を更新して再生成する。本書、OpenAPIおよび影響する生成物は同じPull Requestへ含める。CIではAPIコードを再生成し、コミット済み生成物との間に差分がないことを確認する。

### 2.4 リポジトリ構成

~~~text
package.json                npm workspaceと共通コマンド
package-lock.json           JavaScript依存関係の固定
apps/
├─ user-electron/          利用者側Electron
└─ family-electron/        家族側Electron
packages/
└─ api-client/             非公開workspace package @mite/api-client
   └─ src/
      ├─ generated/
      │  └─ schema.ts      OpenAPIから生成するTypeScript型
      ├─ client.ts         openapi-fetchのクライアント生成処理
      └─ index.ts          packageの公開入口
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

両Electronアプリは `@mite/api-client` をworkspace経由で参照する。生成されたTypeScript型やクライアントを相対パスで直接参照せず、packageの公開入口から利用する。

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
- Supabase Cloud、LiveKit Cloud、Gemini APIは開発・デモとも外部サービスを利用する。
- 画面全体ではなく、操作対象のウィンドウだけを共有・定期取得する。Mite自身の画面をガイド材料へ含めない。
- 2台のPCでそれぞれマイクとスピーカーを使い、音声、画面共有、マーキングを確認する。

## 3. 共通規約

### 3.1 API規約

- ベースパスは /v1 とする。
- JSONのキーはcamelCaseとする。
- レスポンスではデータモデルのfieldを省略せず、`string または null` などのnullable fieldは値がない場合にnullを返す。
- 日時はUTCのISO 8601文字列とする。
- IDは意味を持たない文字列とする。
- ステップ番号と表示順は1始まりとする。
- 文字数はUnicodeコードポイント数で数える。必須文字列は空文字と空白だけの文字列を許可しない。
- 操作者は認証情報から判定し、リクエスト本文のuserIdやfamilyIdを信用しない。
- 作成または状態変更を行うPOSTには `Idempotency-Key` ヘッダーを付ける。対象は `POST /v1/support-sessions/{id}/livekit-token` を除くすべてのPOSTとする。
- GuideDraftとGuideRunの更新、および既存状態を完了させるコマンドには expectedRevision を含める。対象は各リクエスト例で明示する。
- 新規エンティティのrevisionは1とする。同じトランザクション内で同じエンティティの複数項目を変更しても、revisionは1だけ増やす。
- Idempotency-Keyの再送、同一materialの再登録など、永続状態を変更しない成功ではrevisionを増やさない。
- expectedRevisionはトランザクション内で対象行をロックした後に比較する。現在値と一致しなければ、状態判定より先に409 REVISION_CONFLICTを返す。

Idempotency-Keyは次の規約に従う。

- 値は1〜128文字のASCII文字列とし、クライアントが操作ごとに生成する。同じ操作の応答が確定するまで端末へ保存し、タイムアウトや再起動後も同じ値を再利用する。
- サーバーは actorId、method、実際のpath、key の組を一意とし、完了から24時間、PostgreSQLへ永続化する。Goサーバー再起動で失ってはならない。
- requestHashは、JSONでは検証済みのリクエスト型を仕様上のfield順で再直列化したJSONから計算する。省略可能fieldは既定値またはnullへ補完し、元のキー順と空白に依存させない。multipartでは型検証・正規化したテキストfieldとファイル内容のSHA-256から計算し、HTTPのmultipart boundaryは比較対象にしない。
- 同じキーと同じrequestHashの完了済みリクエストには、現在状態の検証より先に、初回と同じHTTP statusとJSONレスポンスを返す。状態変更とrevision更新を繰り返さない。
- 同じキーでrequestHashが異なる場合は、現在状態に関係なく409 IDEMPOTENCY_KEY_REUSEDを返す。
- 同じキーの処理が進行中の場合は409 IDEMPOTENCY_REQUEST_IN_PROGRESSと `Retry-After: 1` を返す。クライアントは同じキーで再送する。
- 認証、形式、サイズの検証に失敗したリクエストと、再試行可能な5xx応答は完了済みとして保存しない。それ以外の業務結果はIdempotencyRecordへ保存する。
- DBだけを変更する処理では、業務変更と完了レスポンスのIdempotencyRecordを同一トランザクションで確定する。Storageを伴う処理は第12.1節の手順に従う。

再送で返る初回レスポンスは、その後の処理でrevisionが進んだエンティティについては古いスナップショットになり得る。クライアントは再送応答から作成済みIDを回収した後、関連するGETを行って現在状態へ合わせる。

サーバーは、認証とrole、本文の形式・サイズと必須Idempotency-Key、既存IdempotencyRecord、対象行のexpectedRevision、業務状態と関連IDの順に検証する。存在やIdempotency-Keyの情報を権限のないactorへ返してはならない。

### 3.2 認証

MVPでは次の固定トークンを使う。

~~~http
Authorization: Bearer <demo-token>
~~~

- 利用者用と家族用で異なるトークンを用意する。
- トークンから role と actorId を確定する。
- LiveKit API SecretとAI API Keyはサーバーだけが保持する。
- トークンをURLのクエリ文字列へ含めない。
- REST APIのCORSとWebSocketのOriginはCLIENT_ORIGINSとの完全一致だけを許可する。cookie認証は使わず、ワイルドカードoriginを許可しない。CORS応答では `Retry-After` をクライアントへ公開する。

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
| 409 | IDEMPOTENCY_REQUEST_IN_PROGRESS | 同じ再送キーの処理が進行中 |
| 409 | DUPLICATE_ACTIVE_REQUEST | 進行中の支援処理がすでにある |
| 409 | MATERIAL_CONFLICT | 同じclientCaptureIdまたはsequenceに異なる画像情報が使われた |
| 413 | FILE_TOO_LARGE | 画像サイズ上限を超えた |
| 422 | INSUFFICIENT_MATERIALS | ガイド生成に使える画像がない |
| 500 | INTERNAL_ERROR | サーバー内部エラー |
| 503 | EXTERNAL_SERVICE_UNAVAILABLE | Storage、LiveKitなど同期処理中の外部サービスが利用できない |

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
            ├─ アップロード失敗またはAI生成失敗 → GENERATING_GUIDEのまま再試行
            ├─ AI生成成功 → REVIEWING_GUIDE
            │    └─ 家族が保存する → ENDED
            └─ 作成を中止する、または画像0件 → ENDED

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
FAILED ─ attempt<3で再試行 → QUEUED
FAILED ─ attempt=3 → 終端
RUNNING ─ サーバー再起動、attempt<3 → QUEUED
RUNNING ─ サーバー再起動、attempt=3 → FAILED
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

COMPLETEDとPAUSED_FOR_SUPPORTはMVPでは終端状態とする。PAUSED_FOR_SUPPORTになったGuideRunを再開するAPIは設けない。支援終了後にガイドをもう一度使う場合は、新しいGuideRunを作成する。

### 4.6 状態更新の原則

- 業務状態はMiteサーバーを正本とする。
- APIが失敗した場合、クライアントは表示上の状態を先へ進めない。
- クライアントはWebSocketだけでなくREST応答でも、同じentityIdについて自分が持つrevisionより小さいデータを無視する。同じrevisionは同じ永続状態として扱う。
- WebSocket再接続後はGET APIで現在状態を再取得する。
- LiveKitの接続状態とSupportSessionの状態は別に管理する。
- LiveKitが切れても、SupportSessionを自動でENDEDへ変更しない。
- SupportSessionがACTIVE以外へ遷移したら、利用者側は画面取得を止めて画面と音声をunpublishし、両クライアントはLiveKit Roomから退出する。REST応答とWebSocket通知のどちらで遷移を知った場合も同じ処理を行う。

### 4.7 revisionの基準系列

以下は競合がない正常系のrevisionである。実装とテストではこの系列を基準にする。

- SupportRequestは作成=1、callでsupportSessionId設定=2、acceptでIN_SUPPORT=3、resolveでRESOLVED=4となる。
- SupportSessionはcallで作成=1、acceptでACTIVE=2、resolveでSKIPならENDED=3となる。
- CREATEの場合、SupportSessionはresolveでGENERATING_GUIDE=3、バッチ作成=4、バッチ完了でguideGenerationJobId設定=5、AI成功でREVIEWING_GUIDEかつguideDraftId設定=6、保存でENDEDかつguideId設定=7となる。
- GuideMaterialBatchは作成=1、新しいGuideMaterialを1件確定するごとに1増え、N件登録後は1+N、complete後は2+Nとなる。同じmaterialの再送では増えない。
- GuideGenerationJobは作成時QUEUED・attempt=0・revision=1、ワーカー取得時RUNNING・attempt=1・revision=2、成功または失敗時revision=3となる。retry、次のRUNNING、次の結果でもそれぞれ1増える。
- GuideDraftとGuideRunは作成=1とし、PATCH、save、complete、support-requestによる状態変更ごとに1増える。
- Idempotency-Keyによる完了済み応答の再送では、上記のどのrevisionも増えない。

## 5. データモデル

すべてのID、日時、status、revisionはAPIレスポンスへ含める。削除フラグは使わず、MVPでは不要データを実削除する。

### 5.1 User

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| role | USER または FAMILY | 固定 |
| displayName | string | 1〜40文字 |

デモデータとして次をseed SQLから冪等に投入する。

| id | role | displayName |
|---|---|---|
| user_demo | USER | 利用者 |
| family_demo | FAMILY | 家族 |

固定ペアは user_demo と family_demo とする。

認証トークンはDBへ保存しない。GoサーバーはDEMO_USER_TOKENをuser_demo、DEMO_FAMILY_TOKENをfamily_demoへメモリ上で対応付ける。seed SQLはUserとUserPairだけを投入する。

UserPairは userId と familyId を持ち、この組を主キーとする。支援依頼のfamilyIdはUserPairからサーバーが決定する。画像、依頼、セッション、ガイドの認可もこの組に基づいて判定する。

### 5.2 Artifact

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| ownerUserId | string | 利用者ID |
| purpose | REQUEST_SCREENSHOT または GUIDE_MATERIAL または GUIDE_STEP | 必須 |
| mimeType | image/jpeg | 必須 |
| storageKey | string | Supabase Storageのオブジェクトパス。APIでは公開しない |
| sha256 | string | JPEG内容のSHA-256、小文字hex |
| byteSize | integer | 10MB以下 |
| width | integer | 1以上 |
| height | integer | 1以上 |
| capturedAt | datetime | 必須 |
| createdAt | datetime | 必須 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

APIのArtifactはstorageKeyを返さず、代わりに contentUrl=/v1/artifacts/{id}/content を返す。

### 5.3 SupportRequest

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| userId | string | 利用者ID |
| familyId | string | 家族ID |
| initialScreenshotArtifactId | string | 必須 |
| comment | string | 0〜500文字。省略時は空文字 |
| status | SupportRequestStatus | 必須 |
| supportSessionId | string または null | 発信後に設定 |
| guideContext | object または null | ガイドから依頼した場合だけ設定 |
| createdAt | datetime | 必須 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

guideContextは guideRunId、guideId、guideVersionNumber、stepNumber、guideTitle、stepInstruction、stepArtifactId を持つ。ガイド利用からの依頼では、サーバーがGuideRunと固定されたGuideVersionから表示用スナップショットとして生成する。これにより家族側は追加のGuide APIなしで、どの手順のどこで困ったかを表示できる。

guideContextは全項目が揃うか、object全体がnullのどちらかとする。

PENDINGではsupportSessionIdはnullまたはRINGINGのSupportSessionを指す。IN_SUPPORTではACTIVEのSupportSessionを必須とする。RESOLVEDではGENERATING_GUIDE、REVIEWING_GUIDE、ENDEDのいずれかのSupportSessionを必須とする。

### 5.4 SupportSession

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| supportRequestId | string | 一意 |
| userId | string | 利用者ID。未終了セッションの一意制約に使う |
| familyId | string | 家族ID |
| livekitRoomName | string | 一意 |
| status | SupportSessionStatus | 必須 |
| guideDecision | CREATE、SKIP、null | 解決時に設定 |
| guideMaterialBatchId | string または null | バッチ作成時に設定 |
| guideGenerationJobId | string または null | バッチ完了時に設定 |
| guideDraftId | string または null | AI成功時に設定 |
| guideId | string または null | 下書き保存時に設定 |
| consent | object または null | audio、screenShare、periodicCapture、textVersionを保持 |
| consentedAt | datetime または null | ACTIVE遷移時に設定 |
| startedAt | datetime または null | ACTIVE遷移時に設定 |
| endedAt | datetime または null | ENDED遷移時に設定 |
| endReason | GUIDE_SKIPPED、GUIDE_SAVED、GUIDE_CANCELLED、NO_MATERIALS、null | ENDED遷移時に設定 |
| createdAt | datetime | 必須 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

RINGINGではconsent、consentedAt、startedAt、guideDecision、すべての子IDをnullとする。ACTIVEではconsent、consentedAt、startedAtを必須とし、guideDecisionとすべての子IDをnullとする。ACTIVE以降はconsent、consentedAt、startedAtを変更しない。GENERATING_GUIDEではguideDecision=CREATE、REVIEWING_GUIDEではguideDecision=CREATEかつguideDraftIdを必須とする。

statusがENDEDでない間はendedAt、endReason、guideIdをnullとする。ENDEDではendedAtとendReasonを必須とし、GUIDE_SKIPPEDはguideDecision=SKIPかつすべての子IDとguideIdがnull、GUIDE_SAVEDはguideDecision=CREATEかつguideIdとguideDraftIdが非null、GUIDE_CANCELLEDとNO_MATERIALSはguideDecision=CREATEかつすべての子IDとguideIdがnullとする。

### 5.5 GuideMaterialBatchとGuideMaterial

GuideMaterialBatchは1支援セッションにつき最大1件とする。

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| supportSessionId | string | 一意 |
| status | UPLOADING、COMPLETED | 必須 |
| captureIntervalSeconds | integer | MVPでは5 |
| expectedItemCount | integer | 1〜360 |
| receivedItemCount | integer | 0以上 |
| capturedFrom | datetime | 必須 |
| capturedTo | datetime | 必須 |
| completedAt | datetime または null | 完了時に設定 |
| createdAt | datetime | 必須 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

receivedItemCountは0〜expectedItemCountとし、capturedFromはcapturedTo以下とする。status=UPLOADINGではcompletedAt=null、COMPLETEDではcompletedAtを必須とする。

GuideMaterialは id、batchId、clientCaptureId、artifactId、sequence、capturedAt、createdAt を持つ。batchIdとclientCaptureIdの組、およびbatchIdとsequenceの組をそれぞれ一意にする。sequenceは1〜expectedItemCountであり、clientCaptureId、sequence、capturedAt、Artifact.sha256の組を同一materialの同一性判定に使う。

### 5.6 GuideGenerationJob

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| batchId | string | 一意 |
| status | QUEUED、RUNNING、SUCCEEDED、FAILED | 必須 |
| attempt | integer | 0〜3 |
| guideDraftId | string または null | 成功時に設定 |
| errorCode | string または null | 失敗時に設定 |
| createdAt | datetime | 必須 |
| startedAt | datetime または null | 任意 |
| finishedAt | datetime または null | 任意 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

QUEUEDではstartedAt、finishedAt、errorCode、guideDraftIdをnull、RUNNINGではstartedAtを必須かつfinishedAt、errorCode、guideDraftIdをnull、SUCCEEDEDではguideDraftIdとfinishedAtを必須かつerrorCodeをnull、FAILEDではfinishedAtとerrorCodeを必須かつguideDraftIdをnullとする。attempt=0は最初のQUEUEDだけとし、RUNNING、SUCCEEDED、FAILEDでは1〜3とする。

### 5.7 GuideDraft

| 項目 | 型 | 制約 |
|---|---|---|
| id | string | 主キー |
| supportSessionId | string | 一意 |
| title | string | 1〜40文字 |
| steps | GuideStep[] | 1〜8件 |
| status | EDITING、SAVED | 必須 |
| revision | integer | 1から開始 |
| createdAt | datetime | 必須 |
| updatedAt | datetime | 必須 |

GuideStepは position、artifactId、instruction を持つ。positionは1から連番、instructionは1〜120文字とする。GuideDraft.stepsはこの値をJSONB配列として保持し、保存済みガイドだけを第5.8節のGuideVersionStepへ正規化する。

EDITINGはREVIEWING_GUIDEのSupportSessionから参照され、SAVEDはendReason=GUIDE_SAVEDのSupportSessionから参照される。SAVEDへ遷移した後は変更しない。

### 5.8 Guide、GuideVersion、GuideVersionStep

- Guideは id、userId、title、currentVersionNumber、createdAt、updatedAt、revision を持つ。MVPではrevision=1で作成する。
- GuideVersionは guideId、versionNumber、title、createdBy、createdAt を持ち、guideIdとversionNumberを複合主キーとする。
- GuideVersionStepは guideId、versionNumber、position、artifactId、instruction を持ち、guideId、versionNumber、positionを複合主キーとする。positionは1から連番とする。
- GuideVersionStepのartifactIdは、同じGuide.userIdが所有するREQUEST_SCREENSHOTまたはGUIDE_STEPのArtifactだけを参照できる。
- ガイド保存時はGuide、GuideVersion、GuideVersionStepを同一トランザクションで作る。
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
| supportRequestId | string または null | PAUSED_FOR_SUPPORT遷移時に設定、一意 |
| startedAt | datetime | 必須 |
| completedAt | datetime または null | 任意 |
| pausedAt | datetime または null | PAUSED_FOR_SUPPORT遷移時に設定 |
| updatedAt | datetime | 必須 |
| revision | integer | 1から開始 |

currentStepNumberは固定したGuideVersionの1〜ステップ数とする。IN_PROGRESSではsupportRequestId、completedAt、pausedAtをnullとする。COMPLETEDではcompletedAtを必須としてsupportRequestIdとpausedAtをnullにし、PAUSED_FOR_SUPPORTではsupportRequestIdとpausedAtを必須としてcompletedAtをnullにする。

### 5.10 内部整合性データ

IdempotencyRecordは actorId、method、path、key、requestHash、status、resourceId、responseStatus、responseBody、leaseExpiresAt、createdAt、completedAt、expiresAt を持つ。actorId、method、path、keyを複合主キーとし、statusはIN_PROGRESSまたはCOMPLETEDとする。resourceIdはStorage登録を再開するときの同一Artifact IDとして使う。Storage処理中はleaseExpiresAtを更新し、期限内の同じ処理を並行実行しない。

ArtifactDeletionTaskは id、artifactId、storageKey、status、attempt、nextAttemptAt、createdAt を持つ。statusはPENDINGまたはRUNNINGとする。artifactIdはnullを許容し、Storage成功・DB失敗で生じた未確定オブジェクトも扱うため外部キーにしない。削除対象をDBトランザクションで予約し、Storage削除を再起動後も再試行するための内部データであり、APIには公開しない。

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
| 13 | POST | /v1/guide-material-batches/{id}/materials | 利用者 | 201 / 200 | 画像1件を登録する。重複は200 |
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
| 27 | POST | /v1/support-sessions/{id}/end-without-guide | 家族、画像0件時は利用者 | 200 | 生成またはレビューを中止して終了する |

状態を変更するAPIは次の条件を満たす場合だけ実行する。満たさない場合は409 INVALID_STATEを返す。

| API | 実行前条件 |
|---|---|
| call | SupportRequest=PENDINGかつsupportSessionId=null |
| accept | SupportSession=RINGINGかつ関連SupportRequest=PENDING |
| livekit-token | SupportSession=ACTIVE |
| resolve | SupportSession=ACTIVEかつ関連SupportRequest=IN_SUPPORT |
| guide-material-batches作成 | SupportSession=GENERATING_GUIDEかつguideDecision=CREATEかつguideMaterialBatchId=null |
| materials登録 | GuideMaterialBatch=UPLOADINGかつ関連SupportSession=GENERATING_GUIDEでguideMaterialBatchIdが対象IDと一致する |
| batch complete | GuideMaterialBatch=UPLOADINGかつ関連SupportSession=GENERATING_GUIDEでguideMaterialBatchIdが対象IDと一致し、receivedItemCount=expectedItemCountかつsequenceが1〜expectedItemCountまですべて存在する |
| job retry | GuideGenerationJob=FAILEDかつattempt<3で、関連SupportSession=GENERATING_GUIDEかつguideGenerationJobIdが対象IDと一致する |
| draft PATCH/save | SupportSession=REVIEWING_GUIDEかつSupportSession.guideDraftIdが対象IDと一致し、GuideDraft=EDITING |
| guide-run PATCH/complete/support-request | GuideRun=IN_PROGRESS |
| end-without-guide | 第6.3節の中止条件を満たす |

子エンティティのGETと更新は、SupportRequestまたはSupportSessionまで関連をたどり、認証actorがそのuserId・familyIdのペアに属することを確認する。GuideとGuideRunは所有するuserIdを確認する。URLのIDだけで認可してはならない。

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
| POST guide-material-batches | { batch: GuideMaterialBatch, supportSession: SupportSession } |
| GET guide-material-batches | { batch: GuideMaterialBatch, materials: GuideMaterial[] }。materialsはsequence昇順 |
| POST materials | { material: GuideMaterial, batch: GuideMaterialBatch } |
| POST batch complete | { batch: GuideMaterialBatch, job: GuideGenerationJob, supportSession: SupportSession } |
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

関連IDは第5章の親エンティティにも必ず含め、再読込時に親から子を取得できるようにする。GuideRunの画面は、GuideRun.guideIdで `GET /v1/guides/{id}` を取得して構成する。MVPではGuideの再編集がないため、取得したcurrentVersionNumberはGuideRun.guideVersionNumberと必ず一致する。

### 6.3 主要リクエスト

#### 画像登録

POST /v1/artifacts は multipart/form-data とし、次を送る。

| field | 値 |
|---|---|
| purpose | REQUEST_SCREENSHOT |
| capturedAt | ISO 8601 |
| file | JPEG、10MB以下 |

サーバーはJPEGをデコードしてmimeType、寸法、サイズ、SHA-256を検証する。content APIは `Content-Type: image/jpeg` と `Cache-Control: private, no-store` を返す。REQUEST_SCREENSHOTのうち24時間たってもSupportRequestから参照されないものは、第12.1節の削除処理で回収する。

#### 支援依頼作成

~~~json
{
  "initialScreenshotArtifactId": "art_01",
  "comment": "元の購入画面に戻れない"
}
~~~

サーバーは未完了依頼の有無、ENDEDでないSupportSessionの有無、画像所有者とpurpose=REQUEST_SCREENSHOTを確認する。いずれかの支援処理が残っている場合は新しい依頼を作らない。通常の依頼ではguideContext=nullとする。

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

textVersion=v1で利用者へ表示する同意文は次を正本とする。

~~~text
支援中は、家族との音声通話と、あなたが選んだ画面の共有を行います。共有中の画面は、あとで手順を作るため5秒ごとにこの端末へ一時保存します。家族が手順を作ることを選んだ場合だけ、保存した画像をMiteサーバーへ送り、GoogleのGemini AIで下書きを作ります。画面に個人情報が映る可能性があります。3つすべてに同意して支援を始めますか。
~~~

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
- SKIPならSupportRequestをRESOLVED、SupportSessionをENDEDへ変更し、endReason=GUIDE_SKIPPEDとendedAtを設定する。
- 両方の更新を同一トランザクションで行う。

#### 画像バッチ作成

~~~json
{
  "expectedSessionRevision": 3,
  "captureIntervalSeconds": 5,
  "capturedFrom": "2026-09-03T10:00:00Z",
  "capturedTo": "2026-09-03T10:03:00Z",
  "expectedItemCount": 37
}
~~~

expectedItemCountはCREATE確定時の端末manifestにある実ファイル数と一致させる。リクエストでは0〜360を許可し、1件以上ではcapturedFromとcapturedToをmanifest内の最小・最大capturedAtにする。1〜360件の場合だけバッチを作り、同一トランザクションでSupportSession.guideMaterialBatchIdへバッチIDを設定する。0件の場合に限りcapturedFromとcapturedToはnullを許可し、バッチを作らず422 INSUFFICIENT_MATERIALSを返す。利用者側は続けてend-without-guideをreason=NO_MATERIALSで呼び、両画面を終了状態へ同期する。

#### 画像1件の登録

POST /v1/guide-material-batches/{id}/materials はmultipart/form-dataとする。

| field | 値 |
|---|---|
| clientCaptureId | 端末側で生成した一意ID |
| sequence | 1始まりの連番 |
| capturedAt | ISO 8601 |
| file | JPEG、10MB以下 |

sequenceは1〜batch.expectedItemCount、capturedAtはbatch.capturedFrom〜capturedToの範囲内でなければならない。新規登録時はArtifactとGuideMaterialの作成、receivedItemCountとbatch.revisionの更新を一度だけ行い201を返す。同じIdempotency-Keyの再送は第3.1節に従って初回と同じ201と当時のレスポンスを返す。別のIdempotency-Keyで同じclientCaptureIdを再送した場合、sequence、capturedAt、ファイルのSHA-256も一致すれば重複保存せず、既存のGuideMaterialと現在のGuideMaterialBatchを200で返す。一つでも異なれば409 MATERIAL_CONFLICTを返す。同じsequenceに別のclientCaptureIdを登録した場合も409 MATERIAL_CONFLICTとする。

並列登録ではバッチ行をロックし、一意制約の確認とreceivedItemCount更新を直列化する。競合判定より先に別ArtifactをStorageへ置いたリクエストは、そのオブジェクトを削除予約した上で、同一materialなら200、異なるmaterialなら409を確定する。receivedItemCountは確定済みGuideMaterial件数と常に一致させる。クライアントは応答中で最も大きいbatch.revisionを保持する。

#### バッチ完了

~~~json
{
  "expectedBatchRevision": 38,
  "expectedItemCount": 37
}
~~~

本文のexpectedItemCountはバッチ作成時の値とも一致しなければならない。サーバー上の件数、clientCaptureIdの一意性、sequence=1〜expectedItemCountの連続性、最小・最大capturedAtとbatch.capturedFrom・capturedToの一致を確認した場合だけCOMPLETEDへ変更し、GuideGenerationJobを1件作り、SupportSession.guideGenerationJobIdへ設定する。不一致は409 INVALID_STATEとする。バッチ完了、ジョブ作成、参照ID更新は同一トランザクションで行う。同じIdempotency-Keyの二重実行は初回応答を返し、別のキーによる二重実行は409 INVALID_STATEとして、ジョブを増やさない。

#### AI生成の再試行

~~~json
{
  "expectedJobRevision": 3
}
~~~

FAILEDの場合だけ受け付ける。attemptが3以上なら409を返す。成功時はQUEUEDへ戻し、errorCode、startedAt、finishedAtをnullにして、202で更新後のGuideGenerationJobを返す。attemptはワーカーがQUEUEDからRUNNINGへ移す時に1増やす。最初の実行前は0、初回を含む実行上限は3回、retry APIを成功させられるのは最大2回とする。

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

artifactIdは、その支援依頼の初期スクリーンショット、または同じ支援セッションのGuideMaterialに含まれ、削除予約されていないものだけ指定できる。サーバーはstepsが1〜8件、positionが1からの連番、文字数が第5.7節どおりであることを全体置換ごとに検証する。

#### 下書き保存

~~~json
{
  "expectedRevision": 4
}
~~~

Guide、GuideVersion、GuideVersionStepを作成し、GuideDraftをSAVED、SupportSessionをENDEDへ変更する。SupportSession.guideId、endReason=GUIDE_SAVED、endedAtも設定する。採用したGUIDE_MATERIALのArtifactはpurpose=GUIDE_STEPへ変更してupdatedAtとrevisionを更新し、未採用のArtifactは削除予約する。支援依頼時のREQUEST_SCREENSHOTが採用された場合はpurposeを変更せず保持する。すべてのGuideMaterial、GuideMaterialBatch、GuideGenerationJobを中間データとして削除し、SupportSession.guideMaterialBatchIdとguideGenerationJobIdをnullに戻す。DB変更と削除予約は同一トランザクションで行い、Storageの実削除は第12.1節に従う。

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

サーバーは画像の所有者とpurpose=REQUEST_SCREENSHOTを検証する。GuideRunと固定されたGuideVersionから、第5.3節のguideContextを生成してSupportRequestへ保存する。クライアントがガイド情報を本文で指定してはならない。既存の未完了SupportRequestまたはENDEDでないSupportSessionがあればDUPLICATE_ACTIVE_REQUESTを返し、GuideRunを変更しない。成功時はGuideRunをPAUSED_FOR_SUPPORTへ変更し、supportRequestIdとpausedAtを設定する。GuideRunの変更とSupportRequest作成は同一トランザクションで行う。

#### ガイド利用完了

~~~json
{
  "expectedRevision": 4
}
~~~

GuideRunがIN_PROGRESSであり、currentStepNumberが最終ステップの場合だけCOMPLETEDへ変更し、completedAtを設定する。

#### ガイド作成を中止して終了

~~~json
{
  "expectedSessionRevision": 6,
  "reason": "GUIDE_CANCELLED"
}
~~~

家族はreason=GUIDE_CANCELLEDを送り、SupportSessionがREVIEWING_GUIDEの場合、またはGENERATING_GUIDEかつジョブが未作成・FAILEDの場合だけ実行できる。QUEUEDまたはRUNNING中は409を返し、家族側の終了ボタンを無効にする。

利用者はreason=NO_MATERIALSだけを送信でき、SupportSessionがGENERATING_GUIDE、guideMaterialBatchId=null、guideGenerationJobId=nullの場合だけ実行できる。これはバッチ作成が422 INSUFFICIENT_MATERIALSになった直後の終了処理として使う。

成功時は未保存の下書き、ジョブ、GuideMaterial、バッチを削除し、各Artifactを削除予約する。SupportSessionの子IDをnullに戻し、status=ENDED、指定されたendReason、endedAtを設定する。これらのDB変更と削除予約を同一トランザクションで行う。保存済みGuideと支援依頼時のREQUEST_SCREENSHOTは削除しない。

## 7. WebSocket

### 7.1 接続

- 接続先は /v1/events とする。
- サーバーはHTTPのOriginをCLIENT_ORIGINSと完全一致で検証し、許可していないWebページからの接続を拒否する。
- 接続後5秒以内に認証メッセージを送る。

~~~json
{
  "type": "authenticate",
  "token": "demo-token"
}
~~~

- 成功時、サーバーは `{ "type": "authenticated" }` を返す。このメッセージを受信するまで業務イベントを処理しない。
- 認証失敗または5秒以内に認証されなかった接続は閉じる。認証メッセージとトークンをログへ出力しない。
- 切断時は1秒、2秒、5秒、以降10秒間隔で再接続する。
- 再接続後は画面で扱っているエンティティをGETし直す。

WebSocketは到達保証とイベント再送を行わない通知経路であり、REST APIが常に正本である。PENDING、RINGING、ACTIVE、GENERATING_GUIDE、REVIEWING_GUIDEの画面では、接続中でも5秒ごとに該当GETを行う。家族の依頼一覧も5秒ごとに再取得する。これにより、接続が切れないままイベントを取り逃した場合も復元する。

両クライアントは最後に扱ったSupportRequest IDを端末へ保存する。起動・再読込時は、保存IDのGETと支援依頼一覧のGETを必ず行う。PENDINGかつsupportSessionId=nullの依頼、またはsupportSessionIdの示すセッションがENDEDでない依頼が一覧にあれば、保存IDより新しい依頼を含め、その最新項目を優先して保存IDを更新する。CREATE選択後はSupportRequestがRESOLVEDでもSupportSessionは未終了になり得るため、request statusだけで除外してはならない。

復元対象がPENDINGかつsupportSessionId=nullなら支援待ちへ移る。supportSessionIdがあればセッションを取得し、guideMaterialBatchId、guideGenerationJobId、guideDraftId、guideIdの順に、nullでない必要な子を取得する。未終了セッションなら対応する画面へ、未終了の依頼がなく保存対象のセッションがENDEDならendReasonに対応する完了画面へ移る。

利用者側はIN_PROGRESSのGuideRun IDも端末へ保存する。起動時にGuideRunとGuideをGETし、IN_PROGRESSならcurrentStepNumberからU-07を復元する。PAUSED_FOR_SUPPORTならsupportRequestIdを使って支援フローへ移る。COMPLETEDなら保存IDを消す。GENERATING_GUIDEでの端末画像復旧は第9.4節に従う。

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

同じeventIdまたは同じentityId・revisionのイベントは重複して届くことがある。クライアントはeventIdを接続中の重複排除に使い、最終判断はentityIdごとのrevisionで行う。保持済みrevision以下を無視し、より大きいrevisionは中間イベントを飛ばして受け入れる。同じDBトランザクションから複数イベントが生じる場合、その到着順には依存せず、関連IDが必要ならGETする。

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
- roomNameとparticipantIdentityには表示名、メールアドレスなどの個人情報を含めず、第3.1節の意味を持たないIDだけを使う。
- ACTIVEのセッションにだけ、30分有効の参加トークンを発行する。
- 利用者と家族以外の参加を許可しない。
- LiveKit API KeyとSecretをクライアントへ渡さない。
- 業務状態はLiveKitのルーム状態から自動変更しない。
- 両者にroomJoin=trueとcanSubscribe=trueを付与する。
- 利用者はcanPublish=true、canPublishData=false、canPublishSourcesはmicrophoneとscreen_shareだけとする。cameraとscreen_share_audioは許可しない。
- 家族はcanPublish=true、canPublishData=true、canPublishSourcesはmicrophoneだけとする。cameraとscreen_shareは許可しない。
- 両者のData Packet受信を許可するが、Miteの実装上、マーキング送信UIは家族側だけに置く。
- トークンは接続または再接続の直前に取得する。期限切れで再接続できない場合は、SupportSessionをGETしてACTIVEであることを確認し、新しいトークンを取得する。

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

LiveKit Roomだけが切断した場合、SupportSessionはACTIVEのままにする。利用者側は定期取得を停止し、両クライアントは接続再試行を表示する。再接続後、利用者が同じ対象を再選択してscreen share trackのpublishに成功した時点で、次のsequenceから定期取得を再開する。SupportSessionがACTIVE以外になっていた場合は再接続せず、第4.6節の終了処理を行う。

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
- 取得に失敗した回は欠番を作らず、次に成功した画像へ連続するsequenceを割り当てる。360枚に達したら取得を停止し、利用者側へ上限到達を表示する。
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

manifest.jsonは次の形式とする。Idempotency-Keyは初回送信前に生成して書き込み、確定応答を受けるまで変更しない。

~~~json
{
  "schemaVersion": 1,
  "supportSessionId": "session_01",
  "guideMaterialBatchId": null,
  "batchCreateIdempotencyKey": "idem_batch_create_01",
  "batchCompleteIdempotencyKey": "idem_batch_complete_01",
  "noMaterialsEndIdempotencyKey": null,
  "captures": [
    {
      "clientCaptureId": "cap_01",
      "sequence": 1,
      "capturedAt": "2026-09-03T10:00:00Z",
      "filename": "000001.jpg",
      "sha256": "lowercase-hex",
      "uploadIdempotencyKey": "idem_material_01"
    }
  ]
}
~~~

manifestは画像ファイルを完全に書き終えた後に一時ファイルとrenameを使って原子的に更新する。noMaterialsEndIdempotencyKeyは画像0件で終了APIを初めて送る直前に生成して保存する。アプリ再起動時に途中の一時ファイルは削除し、manifestにないJPEGは採用しない。送信前にJPEGのSHA-256を再計算し、manifestと異なる場合は破損として自動送信を止める。

### 9.4 アップロード

- 同時アップロード数は3とする。
- 失敗時は1秒、2秒、4秒後に最大3回再試行する。
- 全件成功後にバッチ完了APIを呼ぶ。
- バッチ完了成功後に端末上の対象ディレクトリを削除する。
- 自動再試行後も失敗した画像は端末へ残し、利用者の再試行操作またはアプリ再起動で同じclientCaptureIdとIdempotency-Keyを使って再送する。
- SupportSessionがENDEDになった場合は、SKIP、保存、中止のいずれでも対象ディレクトリを削除する。
- アプリ起動時、24時間を超えたディレクトリは、対応するSupportSessionがENDEDであるか、サーバーに存在しないことをRESTで確認できた場合だけ削除する。サーバーへ接続できない場合や、セッションがACTIVEまたはGENERATING_GUIDEの場合は削除しない。
- サーバーはガイド保存まで全材料を保持し、保存後は定期取得材料のうち採用されたGuideVersionStepの画像だけを残す。支援依頼時のREQUEST_SCREENSHOTはSupportRequestの参照として保持する。

Electron起動・再読込時は、各captureディレクトリとサーバー状態を照合する。

1. SupportSessionがACTIVEなら、利用者へ共有対象の再選択を求める。publish成功後、manifestの最大sequenceの次から取得を再開する。
2. GENERATING_GUIDEかつguideMaterialBatchId=nullで画像が1件以上なら、保存済みbatchCreateIdempotencyKeyでバッチを作成する。画像が0件なら第6.3節のNO_MATERIALS終了を行う。
3. guideMaterialBatchIdがありバッチがUPLOADINGなら、GETで返るclientCaptureIdとmanifestを比較し、不足分だけ保存済みuploadIdempotencyKeyで送る。expectedItemCountとローカル件数が異なる場合は自動でcompleteせず、破損として表示する。
4. 全件登録後は、応答中の最大batch.revisionをGETで再確認し、保存済みbatchCompleteIdempotencyKeyでcompleteを呼ぶ。
5. バッチがCOMPLETED、またはSupportSessionがENDEDなら端末ディレクトリを削除する。

## 10. AIガイド生成

### 10.1 実行方式

- MVPの既定実装はGemini Interactions APIの `POST /v1beta/interactions` とする。
- モデルは `gemini-3.8-flash` とし、画像入力とStructured Outputsを使う。
- Google AI Studioで発行したGemini API用のAuth APIキーを `x-goog-api-key` ヘッダーで送る。キーをURL、リクエスト本文、ログへ含めてはならない。
- リクエストでは `store=false`、`background=false`、`stream=false`、`generation_config.thinking_level=low`、`generation_config.max_output_tokens=2048` とし、HTTPタイムアウトは50秒とする。
- AI生成はサーバーの非同期ジョブとして実行する。
- ジョブ実行には外部キューを使わず、サーバープロセス内のワーカー1個がQUEUEDを順番に処理する。
- 各attemptは入力準備を含め55秒以内に必ずSUCCEEDEDまたはFAILEDへ確定し、Gemini APIへのHTTP要求はその内側で最大50秒とする。
- ワーカーは1秒以内の間隔でQUEUEDを検索し、`FOR UPDATE SKIP LOCKED`で1件だけ取得して、RUNNINGへの変更、attemptの加算、startedAtの設定、errorCodeとfinishedAtの消去を同一トランザクションで行う。このとき確定したrevisionを実行権の識別に使う。
- サーバー起動時に残っているRUNNINGは、attemptが3未満ならQUEUEDへ戻してstartedAtをnullにし、attemptが3ならFAILEDへ変更してerrorCode=WORKER_RESTARTED、finishedAtを設定する。どちらもrevisionを1増やしてからワーカーを開始する。
- バッチ完了時にQUEUEDで作成し、ワーカーがRUNNINGへ変更する。外部API応答後の成功・失敗更新は、jobがまだRUNNINGでrevisionが実行開始時の値と一致する場合だけ確定する。古い実行の遅延応答は破棄する。
- 成功時は下書きを作り、ジョブをSUCCEEDED、SupportSessionをREVIEWING_GUIDEへ変更し、SupportSession.guideDraftIdへ設定する。
- 失敗時はジョブをFAILEDへ変更し、errorCodeとfinishedAtを設定する。初回を含め最大3回実行し、家族がretryできるのは最大2回とする。
- AIの直接出力を保存済みGuideにしてはならない。必ずGuideDraftとして家族の確認を通す。

errorCodeはAI_TIMEOUT、AI_UNAVAILABLE、AI_REFUSAL、AI_INCOMPLETE_RESPONSE、AI_INVALID_OUTPUT、AI_INPUT_UNAVAILABLE、WORKER_RESTARTEDのいずれかとする。外部APIの詳細や画像内容をerrorCodeまたはログへ含めない。

### 10.2 入力

次だけをAIへ渡す。

- 支援依頼のコメント
- 支援依頼時のスクリーンショット
- 定期取得した画像のうち最大30枚
- 各画像のkind、artifactId、capturedAt、sequence

定期取得画像が30枚を超える場合は最初と最後を必ず残し、間を時間順に等間隔で選ぶ。支援依頼時の画像はkind=REQUEST_SCREENSHOT、sequence=0とし、定期取得画像はkind=GUIDE_MATERIALと元のsequenceを使う。したがってAI入力は支援依頼時の画像1枚と定期取得画像最大30枚の計最大31枚である。音声、マーキング、ユーザー識別情報は渡さない。

Gemini APIへ送る直前に、選択した各画像をAI入力専用に長辺1920px、短辺1080px以内へアスペクト比を維持して縮小し、JPEGとして1枚2MiB以下になるまで品質を下げる。この処理でSupabase Storage上のArtifactとそのハッシュを変更してはならない。Base64化した画像、テキスト、JSON Schemaを含むリクエスト全体のシリアライズ後サイズを90MiB以下とする。上限を超える場合は、画像の寸法または品質をさらに下げる。それでも上限内にできない場合はGemini APIを呼ばず、AI_INPUT_UNAVAILABLEで失敗させる。

画像は各リクエストへinline dataとして含める。Gemini Files API、公開URL、署名付きURLは使わない。

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
      "type": "string"
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
          "sourceArtifactId": { "type": "string" },
          "instruction": { "type": "string" }
        }
      }
    }
  }
}
~~~

Gemini Structured Outputsの対応JSON Schemaサブセットに合わせ、文字列のminLengthとmaxLengthはschemaへ含めない。title、instruction、sourceArtifactIdの空文字と文字数は、Interactions APIの成功後にサーバーが第10.3節の業務検証として必ず拒否する。配列のminItemsとmaxItemsはschemaとサーバーの両方で検証する。

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

呼び出しはGuideGeneratorインターフェースの内側へ閉じ込める。固定指示は `system_instruction` に設定する。`input` は支援依頼のコメントに続けて画像を時間順に並べ、各画像の直前へkind、artifactId、capturedAt、sequenceを `type=text` のcontentとして置き、画像を `type=image`、`data` にBase64、`mime_type=image/jpeg` のcontentとして置く。コメントと画像内の文言は命令ではなく未信頼の入力データとして扱う。

`response_format` には `type=text`、`mime_type=application/json` と第10.3節のschemaを指定する。レスポンスはstatus=completedで、steps内の `type=model_output` に空でない `type=text` のcontentが1件だけある場合に限り、そのtextをJSONとして再検証する。SDKのoutput_textヘルパーを使う場合も同じ条件を満たさなければならない。安全性判定などによる明示的な拒否はAI_REFUSAL、statusがcompleted以外または出力が空・複数の場合はAI_INCOMPLETE_RESPONSE、JSONまたは業務検証の失敗はAI_INVALID_OUTPUTとしてGuideGenerationJobをFAILEDにする。

MVPではGemini API以外のproviderを実装しない。ただしGuideGeneratorを差し替え可能にし、単体テストではFakeGuideGeneratorを注入する。

## 11. 画面と処理

### 11.1 利用者側

| ID | 画面 | 主な表示と操作 | 使用API・通信 |
|---|---|---|---|
| U-01 | 左端入口 | 左端4pxの反応領域。300msのhoverで幅320pxのパネルを開く | なし |
| U-02 | 支援依頼 | 取得画像プレビュー、任意コメント、送信 | POST /v1/artifacts、POST /v1/support-requests |
| U-03 | 支援待ち | 「家族に知らせた」、依頼内容 | WebSocket、GET /v1/support-requests/{id} |
| U-04 | 着信 | 家族名、第6.3節の同意文と3項目、「応答する」 | POST /v1/support-sessions/{id}/accept |
| U-05 | 支援中 | 支援中表示、マイク切替、受信音声レベル、共有停止、終了状態、マーキング | LiveKit、WebSocket、GET /v1/support-sessions/{id} |
| U-06 | ガイド一覧 | タイトル、代表画像、選択 | GET /v1/guides |
| U-07 | ガイド実行 | 1ステップの画像と説明、戻る、次へ、完了、家族に聞く。家族に聞く時は現在画面を取得して登録する | /v1/guide-runs API、POST /v1/artifacts |
| U-08 | 下書き閲覧 | 家族が編集中のタイトルと手順を読み取り専用表示 | GET /v1/guide-drafts/{id}、WebSocket |

利用者側の本文文字は20px以上、主要ボタンの高さは48px以上とする。専門用語を画面へ表示しない。

U-07ではGuideRun IDを端末へ保存し、状態変更のたびに更新する。「家族に聞く」の成功後は返されたsupportRequestIdを保存してU-03へ移る。CREATE後に画像が0件だった場合は、422を受けてNO_MATERIALS終了を実行し、「画像を保存できなかったため手順を作れなかった」と表示する。

### 11.2 家族側

| ID | 画面 | 主な表示と操作 | 使用API・通信 |
|---|---|---|---|
| F-01 | 依頼一覧・詳細 | 利用者名、画像、コメント、ガイド文脈、発信 | GET /v1/support-requests、POST /v1/support-requests/{id}/call |
| F-02 | 呼び出し中 | 応答待ち | WebSocket、GET /v1/support-sessions/{id} |
| F-03 | 支援中 | 共有画面、マイク切替、受信音声レベル、クリックでマーキング、解決 | LiveKit、POST /v1/support-sessions/{id}/resolve |
| F-04 | ガイド生成中 | アップロード件数、生成状態、失敗時の再試行、作成せず終了 | Batch/Job API、POST /v1/support-sessions/{id}/end-without-guide、WebSocket |
| F-05 | 下書き編集 | タイトル、画像、説明、順番、削除、保存、作成せず終了 | Draft API、POST /v1/support-sessions/{id}/end-without-guide、WebSocket |

下書き編集は最後の入力から500ms後にPATCHする。PATCHは同時に1件だけ実行し、送信中に追加編集があれば、成功応答のrevisionを使って最新の全体を続けて送る。保存ボタンは未完了のPATCH成功後にだけ有効にする。409時は最新下書きを再取得し、「内容が更新されたため読み直した」と表示する。

F-01のガイド文脈はSupportRequest.guideContextのguideTitle、stepNumber、stepInstruction、stepArtifactIdから表示する。F-04は5秒ごとのGETでも件数とジョブ状態を更新する。FAILEDかつattempt<3の場合だけ再試行ボタンを有効にし、attempt=3では実行上限に達したことを表示する。endReason=NO_MATERIALSでENDEDになった場合は「画面を保存できなかったため手順を作れなかった」と表示する。

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

Artifact登録はStorageとDBを単一トランザクションにできないため、次の順序で再開可能にする。

1. 画像全体を一時領域へ受信して検証し、requestHashとSHA-256を確定する。
2. 短いDBトランザクションでIN_PROGRESSのIdempotencyRecord、同じ再送で使うArtifact ID、2分間のleaseを確保する。期限内の同一処理にはIDEMPOTENCY_REQUEST_IN_PROGRESSを返し、期限切れなら同じresourceIdで処理を引き継ぐ。
3. `<ownerUserId>/<artifactId>.jpg` へアップロードする。再開時の上書きは、同じIdempotencyRecordとrequestHashから復元した同じオブジェクトにだけ許可する。
4. DBトランザクションでArtifactを作る。GuideMaterial登録ではGuideMaterial作成とバッチ更新も行い、最後にIdempotencyRecordをCOMPLETEDとレスポンスへ更新する。
5. Storage失敗時はArtifactを作らない。呼び出し元へ失敗を返せる既知の失敗ではleaseを直ちに解放し、プロセス異常終了など結果不明の場合はlease期限後に、同じキーで再開できるようにする。Storage成功後のDB失敗でも同じキー、resourceId、storageKeyで再開する。最終的に業務条件を満たせないオブジェクトはArtifactDeletionTaskへ登録する。

削除対象は、参照を外すDB変更と同じトランザクションでArtifactDeletionTaskへ登録する。登録済みArtifactはその時点からcontent APIで404とし、Storage上に残っていても利用しない。削除ワーカーはStorageオブジェクトを削除し、存在しない場合も成功扱いにして、その後ArtifactとタスクをDBから削除する。失敗時は間隔を延ばして再試行する。Goサーバー起動時にRUNNINGの削除タスクをPENDINGへ戻し、未完了タスクを再開する。REQUEST_SCREENSHOTの未参照Artifactも作成から24時間後に同じ仕組みで削除する。24時間を超えてIN_PROGRESSのままのIdempotencyRecordも、resourceIdに対応する未確定オブジェクトを削除予約してから削除する。

DBスキーマはSupabase CLIのマイグレーションだけで変更する。共有SupabaseプロジェクトのDashboardから本番スキーマを直接変更してはならない。開発・デモでは同じSupabaseプロジェクトを使用する。

### 12.2 必須の一意制約

- Artifact.storageKey
- SupportSession.supportRequestId
- SupportSession.livekitRoomName
- SupportRequest.supportSessionId。ただしnullは除く
- SupportRequest.userIdの部分一意制約。ただしstatusがPENDINGまたはIN_SUPPORTの行だけを対象とする
- SupportSession.userIdの部分一意制約。ただしstatusがENDEDでない行だけを対象とする
- GuideMaterialBatch.supportSessionId
- GuideMaterial(batchId, clientCaptureId)
- GuideMaterial(batchId, sequence)
- GuideMaterial.artifactId
- GuideGenerationJob.batchId
- GuideDraft.supportSessionId
- GuideVersion(guideId, versionNumber)
- GuideVersionStep(guideId, versionNumber, position)
- GuideRun.supportRequestId。ただしnullは除く
- IdempotencyRecord(actorId, method, path, key)
- ArtifactDeletionTask.storageKey

外部キーは原則として削除をRESTRICTし、参照元を明示的に整理してから削除する。同じ行だけで検証できるstatus、件数、文字数、attempt、revisionには第4章と第5章に対応するCHECK制約を置く。連番、receivedItemCountと実件数、版とステップ範囲など複数行・複数テーブルにまたがる規則は、行ロックを取ったserviceのトランザクションで検証する。SupportRequest作成系ではUser行を `FOR UPDATE` でロックした上で、未完了SupportRequestと未終了SupportSessionの両方を確認する。これにより、通常依頼とGuideRunからの依頼が並行しても1件だけを作成する。

### 12.3 同一トランザクションで行う処理

1. callでのSupportSession作成とSupportRequest.supportSessionId更新
2. 利用者の応答、SupportRequestのIN_SUPPORT化、SupportSessionのACTIVE化
3. 支援解決、SupportRequestのRESOLVED化、SupportSessionの次状態への変更
4. バッチ作成とSupportSession.guideMaterialBatchId更新
5. GuideMaterialとArtifactのDB登録、receivedItemCountとバッチrevision更新、IdempotencyRecord完了
6. バッチ完了、生成ジョブ作成、SupportSession.guideGenerationJobId更新
7. ジョブのRUNNING取得、またはFAILEDからQUEUEDへのretry
8. AI成功、GuideDraft作成、ジョブのSUCCEEDED化、SupportSessionのREVIEWING_GUIDE化
9. AI失敗とジョブのFAILED化
10. 下書き更新
11. 下書き保存、Guide、GuideVersion、GuideVersionStep作成、下書きとセッションの完了、中間データ削除、不要画像の削除予約
12. ガイド利用のステップ移動または完了
13. ガイド途中の支援依頼作成、GuideRunのPAUSED_FOR_SUPPORT化と関連ID設定
14. ガイド作成中止、子データの参照解除、セッション完了、画像の削除予約

状態変更処理は、User、SupportRequest、SupportSession、GuideMaterialBatch、GuideGenerationJob、GuideDraft、GuideRunの順で必要な行をロックする。同じ処理内では順序を逆転させない。WebSocketイベントはDB commit後にだけ送信し、rollback時は送らない。送信失敗でDBをrollbackせず、第7.1節のGETによる収束を正本とする。

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
- npm workspaceと `@mite/api-client` の公開範囲
- 利用者側と家族側ElectronのAPI接続先

共有契約を変更した場合は本書を先に更新して両担当で合意し、OpenAPI、生成物、両実装の順に変更する。生成物だけを直接変更してはならない。

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
AI_PROVIDER=gemini
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_API_KEY=change-me
AI_MODEL=gemini-3.8-flash
AI_PROMPT_VERSION=v1
CLIENT_ORIGINS=http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174,mite-user://app,mite-family://app
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

GEMINI_API_KEYにはGoogle AI Studioで新規発行したGemini API用のAuth APIキーを設定し、Gemini APIだけに制限する。Standard APIキーは使わない。

Supabase、LiveKit、Google AI StudioのGemini APIキーをクライアントの配布物やGitへ含めてはならない。Electronアプリには役割ごとのデモトークンだけを設定する。

## 15. 最低限のエラー動作

| 事象 | クライアント動作 |
|---|---|
| REST通信失敗 | 現在状態を維持し、「通信できない。もう一度試す」を表示する |
| 401 | デモ設定不備として停止し、再読み込みだけを表示する |
| 409 INVALID_STATE | 対象をGETし直し、サーバー状態へ合わせる。新しい操作が必要なら新しいIdempotency-Keyを使う |
| 409 REVISION_CONFLICT | 最新データを取得し直す。POSTを新しいexpectedRevisionでやり直す場合は新しいIdempotency-Keyを使う |
| 409 IDEMPOTENCY_KEY_REUSED | クライアント実装エラーとして同じキーを再利用せず、対象をGETして状態を確認する |
| 409 IDEMPOTENCY_REQUEST_IN_PROGRESS | Retry-After後に同じbodyとIdempotency-Keyで再送する |
| 409 MATERIAL_CONFLICT | 自動送信を止め、manifestの重複または破損として表示する |
| LiveKit接続失敗 | 業務状態は変えず、接続の再試行を表示する |
| 画面共有停止 | 音声は継続し、共有停止を両画面へ表示する |
| 画面取得失敗 | 支援は継続し、利用者側へガイド材料不足を表示する。CREATE後に画像が0件ならバッチ作成の422後にNO_MATERIALSで終了し、家族側にも作成不能を表示する |
| 画像アップロード失敗 | 端末画像を残し、失敗分だけ再送する |
| AI生成失敗 | 家族側へ再試行ボタンを表示する |
| WebSocket切断 | 再接続し、成功後にGETで状態を復元する |

状態変更POSTの応答が不明な場合は、新しいIdempotency-Keyを発行せず、保存済みの同じキーで再送する。PATCHの応答が不明な場合は対象をGETし、revisionと内容を確認してから次の更新を行う。高度な自動復旧は行わない。少なくともデータを失わず、再試行またはGETによる照合ができる状態に止める。

## 16. 実装順

1. `api/openapi.yaml`へ本書のAPIを記述する。
2. ルートのnpm workspace、`packages/api-client`およびAPIコード生成設定を作り、OpenAPIからGo・TypeScriptコードを生成する。
3. `supabase/migrations`へPostgreSQLスキーマとデモデータを記述する。
4. `server/db/queries`へSQLを記述してsqlcコードを生成し、Go、Chi、handler、service、repository、domainの基本構成を作る。
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
6. 新しいSupportRequestのguideContextだけで、家族側にガイド名、該当手順の説明と画像が表示される。
7. 同時にGuideRunがPAUSED_FOR_SUPPORTになり、相互の関連IDが設定される。
8. そのSupportRequestから発信、応答、解決まで通常支援フローを実行できる。元のGuideRunはPAUSED_FOR_SUPPORTのまま残る。

### 17.4 契約と安全性

- 同じIdempotency-Keyによる再送でデータが増えない。
- 同じIdempotency-Keyと異なるbodyで409 IDEMPOTENCY_KEY_REUSEDになる。
- 古いexpectedRevisionで更新すると409になる。
- 家族は別ペアの画像を取得できない。
- クライアントからLiveKit API SecretとAI API Keyを確認できない。
- 共有停止操作から1秒以内に映像publishと定期取得が止まる。
- 2台のWindows PCで利用者側Electronと家族側Electronを起動し、公開Goサーバーへ接続して全正常系を実演できる。

### 17.5 二重送信と並行実行

1. support-request、call、resolve、batch complete、draft saveを同じIdempotency-Keyで2回送り、HTTP statusとbodyが初回と同じで、エンティティとrevisionが増えない。
2. 上記を別のIdempotency-Keyで状態遷移後に再実行し、409になり、SupportSession、GuideGenerationJob、Guideが重複しない。
3. 同じexpectedRevisionの競合更新を同時に送り、片方だけが成功し、もう片方が409 REVISION_CONFLICTになる。
4. 3並列で1〜360件のGuideMaterialを順不同に登録し、各clientCaptureIdとsequenceが一意、receivedItemCountが実件数、最終revisionが1+件数になる。
5. 同じclientCaptureIdと同じ内容を別キーで再送すると200になり、異なる内容またはsequence重複では409 MATERIAL_CONFLICTになる。
6. 不足画像がある間のbatch completeは409 INVALID_STATEになり、全件登録後のcompleteだけが成功してジョブを1件作る。
7. 通常の支援依頼作成とGuideRunからの支援依頼作成を同時に実行し、一方だけが成功する。

### 17.6 切断、再起動、境界値

1. REST成功後に応答を受け取る前に切断し、同じIdempotency-Keyで再送して初回結果を回収できる。
2. WebSocket切断中の状態更新、重複イベント、古いrevisionのイベントを発生させ、再接続とGET後にサーバー状態へ一致する。
3. LiveKitだけを切断してもSupportSessionはACTIVEを保ち、定期取得は止まり、再接続・再publish後に連続するsequenceで再開する。
4. ACTIVE中にElectronを再起動し、共有対象の再選択後に支援と画面取得を再開できる。
5. CREATE直後、アップロード途中、batch complete成功直後の各時点で利用者側Electronを終了し、再起動後に不足分だけを送り、重複なしでCOMPLETEDへ到達して端末画像を削除できる。
6. 保存直前に切断した場合はGET後に保存を実行でき、保存成功直後に切断した場合は同じIdempotency-KeyまたはGETでGuideとENDED状態を回収できる。
7. RUNNING中にGoサーバーを再起動し、attempt<3ならQUEUEDから再実行し、attempt=3ならFAILEDになる。attempt<3のFAILEDからはretryしてQUEUED、RUNNING、SUCCEEDEDへ遷移でき、attempt=3のFAILEDに対するretryは409になる。
8. Storage削除中にGoサーバーを再起動し、ArtifactDeletionTaskが再開してDBとStorageの両方から削除される。
9. 画像0件では422後にNO_MATERIALSでENDEDになり、画像360件では361件目を作らずバッチを完了できる。
10. AI出力と家族編集の両方で1ステップと8ステップを保存・実行でき、0ステップと9ステップを拒否する。
11. 端末ディレクトリが24時間を超えてもACTIVEまたはGENERATING_GUIDEなら削除せず、ENDED確認後だけ削除する。

## 18. 完了の定義

MVP実装完了は次をすべて満たした時点とする。

- 第17章のテストがすべて通る。
- 状態名とAPIが本書と一致する。
- OpenAPI、DB制約、revision、Idempotency-Key、WebSocketの復元契約が本書と一致する。
- `npm run generate:api`でGoとTypeScriptのAPIコードを再生成でき、コミット済み生成物との差分がない。
- デモ用の起動手順と環境変数例がリポジトリにある。
- DBを空にした状態から固定データを投入できる。
- 画像、DB、LiveKit Cloud、AI APIを使った正常系がモックなしで通る。
- 既知の未対応事項がREADMEに記録されている。

## 19. 参考資料

- [Mite プロダクトシート](./PS.md)
- Chi: https://github.com/go-chi/chi
- npm workspaces: https://docs.npmjs.com/cli/using-npm/workspaces/
- oapi-codegen: https://github.com/oapi-codegen/oapi-codegen
- openapi-typescript: https://openapi-ts.dev/cli
- Go tool dependencies: https://go.dev/doc/modules/managing-dependencies#tool-dependencies
- sqlc: https://docs.sqlc.dev/
- Supabase PostgreSQL connection: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase database migrations: https://supabase.com/docs/guides/deployment/database-migrations
- Supabase Storage: https://supabase.com/docs/guides/storage/buckets/fundamentals
- LiveKit Screen sharing: https://docs.livekit.io/transport/media/screenshare/
- LiveKit Data packets: https://docs.livekit.io/transport/data/packets/
- LiveKit Tokens and grants: https://docs.livekit.io/frontends/reference/tokens-grants/
- Google AI Studio: https://ai.google.dev/aistudio
- Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key
- Gemini Interactions API: https://ai.google.dev/gemini-api/docs/interactions-overview
- Gemini 3.8 Flash: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- Gemini image input: https://ai.google.dev/gemini-api/docs/file-input-methods
- Gemini Structured Outputs: https://ai.google.dev/gemini-api/docs/structured-output
