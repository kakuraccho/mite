# サーバー・クライアント接続ガイド

この文書は、クライアント担当がMiteサーバーへ接続してA/B/Cフローを確認するための入口です。API契約の正本は [`api/openapi.yaml`](../api/openapi.yaml)、状態遷移と復旧条件の正本は [`docs/specification.md`](./specification.md) です。

## 1. 起動

初回の依存関係取得、`server/.env`とクライアントの`.env.local`の設定、起動手順は[セットアップガイド](setup.md)を参照してください。サーバーだけを起動する場合は「ローカルで起動する」の手順1〜3まで進めます。

クライアントは通常 `MITE_API_BASE_URL=http://localhost:3000` を使います。別PCから接続する場合はサーバーPCのIPアドレスへ変え、そのOriginを `CLIENT_ORIGINS` に完全一致で追加してください。

## 2. トークンと実装状況

| クライアント | Bearer token |
|---|---|
| 利用者側 | サーバーの `DEMO_USER_TOKEN` と同じ値 |
| 家族側 | サーバーの `DEMO_FAMILY_TOKEN` と同じ値 |

トークンはURLへ含めません。RESTでは `Authorization: Bearer <token>`、WebSocketでは接続後の最初のmessageで送ります。

- A: Artifact登録・取得、SupportRequest作成・一覧・取得、Supabase Storage、削除workerを実装済み
- B: SupportSessionのcall・取得・accept・LiveKit token・resolve・end、WebSocketを実装済み
- C: GuideMaterial、生成job、draft、Guide、GuideRunの16 operationと生成workerを実装済み
- OpenAPIの27 operationはすべて実handlerへ配線済みで、`/v1/events` も利用できます。

## 3. 基本の操作順

```text
REQUEST_SCREENSHOT登録
  → SupportRequest作成(PENDING)
  → 家族がcall(RINGING)
  → 利用者がaccept(ACTIVE)
  → 両者がLiveKit token取得・接続
  → 家族がresolve
      ├─ SKIP   → ENDED
      └─ CREATE → GENERATING_GUIDE
                   → batch作成・material upload・complete
                   → job SUCCEEDED / FAILED
                   → draft確認・編集・save
                   → Guide保存・session ENDED
```

保存後は利用者がGuideRunを作成し、`NEXT` / `PREVIOUS`、最終stepでcompleteを行います。途中で家族へ聞く場合は、現在画面を新しい `REQUEST_SCREENSHOT` Artifactとして登録してから `POST /v1/guide-runs/{id}/support-request` を呼びます。

## 4. 再送と復旧

状態変更POSTとmultipart POSTでは、操作前に `Idempotency-Key` を生成して端末へ保存します。応答が確定するまで、同じbody・同じfile bytes・同じkeyで再送してください。異なるbodyへ同じkeyを使うと `IDEMPOTENCY_KEY_REUSED` です。

同一操作の完了済み応答を再送した場合、サーバーは初回と同じHTTP statusと、初回と同一バイト列のJSON本文を返します。空白、改行、オブジェクトのキー順も変わりません。`X-Request-ID` などのレスポンスヘッダーはリクエストごとに変わることがあり、この一致要件には含みません。

`IDEMPOTENCY_REQUEST_IN_PROGRESS` の409では、`Retry-After` 秒後に同じrequestを再送します。CORSで `Retry-After` を公開済みなので、rendererから `response.headers.get("Retry-After")` で参照できます。

PATCHまたは `expectedRevision` 付きPOSTが `REVISION_CONFLICT` になった場合は、対象をGETし直して画面を最新状態へ合わせます。ユーザーが改めて操作する場合は、最新revisionと新しい `Idempotency-Key` を使います。

WebSocketは通知経路で、RESTが正本です。切断・再接続、古いrevision、イベント欠落の後は必ず関連エンティティをGETしてください。

## 5. multipart upload

初期スクリーンショットは `POST /v1/artifacts` へ次を送ります。

- `purpose=REQUEST_SCREENSHOT`
- `capturedAt`: RFC 3339日時
- `file`: 実デコード可能なJPEG、最大10MiB

初回POST前にJPEG、`capturedAt`、Artifact用Idempotency-Keyを端末へ永続化してください。通信結果が不明なときに同じrequestを再現できないと、二相Storage処理を安全に復旧できません。Artifact成功後、そのIDを `POST /v1/support-requests` の `initialScreenshotArtifactId` に使います。

ガイド材料は `POST /v1/guide-material-batches/{id}/materials` へ次を送ります。

- `clientCaptureId`
- `sequence`: 1始まりの連番
- `capturedAt`: RFC 3339日時
- `file`: JPEG

同時uploadは3件までとし、全件成功後にbatch completeを呼びます。

## 6. WebSocketとLiveKit

`ws://localhost:3000/v1/events` へ接続後、5秒以内に次を送ります。

```json
{"type":"authenticate","token":"<role-specific-demo-token>"}
```

成功時は `{"type":"authenticated"}` が届きます。その後のeventは更新後エンティティ全体を `data` に持ちます。接続中は `eventId`、永続状態では `entityId` と `revision` で重複・順不同を処理してください。

LiveKit tokenはSupportSessionが `ACTIVE` の間だけ取得できます。接続または再接続の直前に `POST /v1/support-sessions/{id}/livekit-token` を呼び、返された `serverUrl`、`token`、`roomName`、`participantIdentity` をSDKへ渡します。API keyとsecretをクライアントへ置かないでください。

## 7. Guide素材manifestの復旧

端末のcapture directoryには、JPEGとともに次を保持します。

- SupportSession IDと、確定後のbatch ID
- batch create / material upload / batch completeごとのIdempotency-Key
- 各画像の `clientCaptureId`、`sequence`、`capturedAt`、filename、SHA-256

再起動時はSupportSessionとbatchをGETし、manifestとサーバーのmaterial一覧を比較して不足分だけ同じkeyで再送します。`expectedItemCount` とローカル件数が異なる場合は自動completeしません。batchが `COMPLETED`、またはsessionが `ENDED` になった後だけ端末画像を削除します。

## 8. 接続確認

コード生成・テスト・静的解析・ビルドは[開発ガイドのGoサーバー検証](development.md#goサーバー)を参照してください。

ローカルSupabaseとfake GuideGeneratorを使うHTTP/WebSocket E2Eは、秘密値を表示せず次のように実行できます。

```bash
# リポジトリルートで実行
eval "$(npx supabase status -o env 2>/dev/null)"
cd server
MITE_E2E_DATABASE_URL="$DB_URL" \
MITE_E2E_SUPABASE_URL="$API_URL" \
MITE_E2E_SUPABASE_SECRET_KEY="$SECRET_KEY" \
go test ./cmd/api -run '^TestServerRuntimeE2E$' -count=1 -v
```

実LiveKit Cloudと実Gemini APIは、有効な認証情報を明示的に用意した環境で別途smoke testが必要です。通常のローカルE2Eは外部へ接続しません。

## 9. クライアント統合状況

- rootの `packages/api-client` を生成型と最小clientの正本とし、`client/packages/client-api` の `HttpMiteApi` adapterはその公開型からrequestとresponseを派生する
- multipart uploadとimage/jpeg取得は `HttpMiteApi` のwrapperへ隔離する
- 通常の支援依頼とGuideRunからの支援依頼は、最初のArtifact POST前に同じJPEGとcapturedAtを端末へ保存する
- Idempotency-Key、最後のSupportRequest / GuideRun IDおよびcapture manifestを端末へ保存する
- RESTの5秒pollingとWebSocket再接続後GETによる復旧を実装済み
- LiveKit SDKの音声・画面共有・marking Data Packetを実装済み
- ローカルSupabase、Goサーバーおよびfake Geminiを使い、実 `HttpMiteApi` でA/B/Cフローを確認するintegration testを用意している

残る最終確認は、2台のWindows PCと公開サーバーで実LiveKit・実Geminiを含むE2Eを行うことである。Windows AppBar固有の確認項目は [READMEの既知の未確認事項](../README.md#既知の未確認事項) を参照する。
