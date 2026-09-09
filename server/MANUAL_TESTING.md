# サーバー手動検証ガイド

この文書は、ローカルで起動したMiteサーバーを `curl` から操作し、主要なREST API、状態遷移、認証、再送制御を手動で確認するためのチェックリストである。

API契約の正本は [`api/openapi.yaml`](../api/openapi.yaml)、状態遷移と受け入れ条件の正本は [`docs/specification.md`](../docs/specification.md) である。本書と正本が異なる場合は正本を優先する。

## 1. 検証範囲

この手順では次を確認する。

- 固定デモトークンによる認証とrole別認可
- CORSと `X-Request-ID`
- ArtifactとSupportRequestの作成・取得
- SupportSessionの発信、応答、解決
- `Idempotency-Key` の再送と使い回し拒否
- `expectedRevision` の競合検出
- GuideMaterial、生成job、GuideDraft、Guideの一連の処理
- GuideRunの移動・完了と、ガイド途中からの支援依頼
- WebSocketの認証と更新イベント

次は別途、実クライアントを使って確認する。

- LiveKit Cloudへの接続、音声、画面共有、マーキング
- Electronによる10秒ごとの画面取得と端末上の復旧
- 切断、アプリ再起動、Goサーバー再起動からの復旧
- 2台のWindows PCを使う仕様書第17章の最終受け入れテスト

クライアントを含む確認は [`docs/server-client-integration.md`](../docs/server-client-integration.md) も参照する。

## 2. 安全上の注意

この手順はDBとStorageへデータを作成し、ガイド途中からの支援依頼を作成した時点で未完了のSupportRequestを残す。接続先にはテスト専用のローカルSupabaseだけを使う。共有開発環境、デモ環境、本番環境に対して実行してはならない。

`npx supabase db reset` はローカルDBの内容を削除してmigrationを再適用する。接続先がこのリポジトリのローカルSupabaseであることを確認してから実行する。

レスポンスに含まれるBearer token、LiveKit token、Supabase Secret key、Gemini API keyを記録資料やチャットへ貼り付けない。記録にはHTTP status、エラーコード、IDの末尾など、判定に必要な情報だけを残す。

## 3. 事前準備

### 3.1 必要なもの

- Go 1.26系
- Node.jsとnpm
- Docker
- Supabase CLI
- `curl`
- `cmp`
- 10MiB以下の有効なJPEG画像1枚

新しいpackageやCLIを追加する必要はない。

### 3.2 ローカルSupabaseの初期化

ターミナル1で、リポジトリルートから実行する。

```bash
npx supabase start
npx supabase db reset
```

migrationにより `user_demo`、`family_demo`、固定ペア、非公開bucket `mite-artifacts` が作成される。

### 3.3 サーバー環境変数

秘密値をコマンド履歴へ残したくない場合は、Gitに無視される `server/.env` を [`server/.env.example`](./.env.example) から作成し、値を設定する。`server/` を作業ディレクトリとして起動すると、サーバーが `.env` を自動で読み込む。既存の環境変数（空文字を含む）を優先して未設定項目だけを補い、ファイルがなければ環境変数だけを使う。

`.env` を使う場合も使わない場合も、利用者がローカルSupabaseの最新値を取得し、サーバー用の3変数へ設定する。ローカルSupabaseの再起動やresetでSecret keyが変わることがあり、古い値を使うとDB接続またはStorage操作が失敗するためである。次のコマンドはBashでCLI出力を評価し、秘密値を画面へ表示せず環境変数を上書きする。`.env` へ直接記入する場合も、既存の環境変数があればそちらを更新するか解除する。

```bash
eval "$(npx supabase status -o env 2>/dev/null)"
export DATABASE_URL="$DB_URL"
export SUPABASE_URL="$API_URL"
export SUPABASE_SECRET_KEY="$SECRET_KEY"
```

続けて共通のローカル設定を行う。

```bash
export PORT=3000
export SUPABASE_STORAGE_BUCKET=mite-artifacts
export DEMO_USER_TOKEN=manual-user-token
export DEMO_FAMILY_TOKEN=manual-family-token
export AI_PROVIDER=gemini
export AI_MODEL=gemini-3.8-flash
export AI_PROMPT_VERSION=v1
export CLIENT_ORIGINS=http://localhost:5173,http://localhost:5174
```

外部サービスへ接続しない短い確認では、ダミー値も設定する。

```bash
export LIVEKIT_URL=wss://livekit.invalid
export LIVEKIT_API_KEY=manual-livekit-key
export LIVEKIT_API_SECRET=manual-livekit-secret
export AI_BASE_URL=https://127.0.0.1:1
export GEMINI_API_KEY=manual-gemini-key
```

この設定のLiveKit tokenは形式確認用であり、LiveKit Cloudへは接続できない。`guideDecision=SKIP` のフローではGemini APIを呼ばない。

実LiveKitまたはAI生成成功まで確認するときは、上のダミー値を設定せず、Git管理外の安全な環境または `server/.env` へ実際の認証情報を設定する。以前のダミー値が環境変数に残っている場合は更新するか解除する。Geminiの接続先は次を使う。

```bash
export AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
```

### 3.4 サーバー起動

引き続きターミナル1で実行する。

```bash
cd server
go run ./cmd/api
```

`server started` が出力され、終了していないことを確認する。専用のhealth endpointはないため、起動確認には第5.3節の一覧APIを使う。

### 3.5 操作用変数

ターミナル2で設定する。`MITE_TEST_JPEG` は実在するJPEGの絶対パスへ置き換える。

```bash
export MITE_API_BASE_URL=http://localhost:3000
export MITE_MANUAL_ORIGIN=http://localhost:5173
export MITE_MANUAL_USER_TOKEN=manual-user-token
export MITE_MANUAL_FAMILY_TOKEN=manual-family-token
export MITE_MANUAL_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export MITE_CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export MITE_TEST_JPEG=/absolute/path/to/test.jpg
export MITE_IDEMPOTENCY_COMPARE_DIR="$(mktemp -d)"
```

以降のコマンドを短くするため、同じshellで関数を定義する。

```bash
mite_user() {
  curl -i -sS \
    -H "Authorization: Bearer $MITE_MANUAL_USER_TOKEN" \
    -H "Origin: $MITE_MANUAL_ORIGIN" \
    "$@"
}

mite_family() {
  curl -i -sS \
    -H "Authorization: Bearer $MITE_MANUAL_FAMILY_TOKEN" \
    -H "Origin: $MITE_MANUAL_ORIGIN" \
    "$@"
}
```

各レスポンスの `data.id` や `revision` を目視し、案内された変数へ設定する。`<...>` はプレースホルダーなので、そのまま実行しない。

## 4. 共通の確認基準

正常なJSONレスポンスは `{ "data": ... }`、エラーは次の形で返る。

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "revisionが更新されている",
    "requestId": "req_..."
  }
}
```

各HTTPレスポンスで次を確認する。

- 想定したHTTP statusである。
- `X-Request-ID: req_...` がある。
- JSONのID、日時、status、revisionが省略されていない。
- nullable fieldは値がない場合に `null` である。
- エラー本文にSQL、Storage key、token、API keyなどの内部情報がない。

競合がない基本フローのrevisionは次のように進む。

| エンティティ | revision |
|---|---|
| SupportRequest | 作成1 → call 2 → accept 3 → resolve 4 |
| SupportSession（SKIP） | call 1 → accept 2 → resolve 3 |
| SupportSession（CREATE） | call 1 → accept 2 → resolve 3 → batch作成4 → batch完了5 → AI成功6 → 保存7 |
| GuideMaterialBatch（1件） | 作成1 → material登録2 → complete 3 |
| GuideGenerationJob | QUEUED 1 → RUNNING 2 → SUCCEEDEDまたはFAILED 3 |
| GuideDraft | 作成1 → PATCH 2 → save 3 |

### 4.1 冪等再送時のRaw Body

同じ `Idempotency-Key` と同一入力による完了済みリクエストの再送は、初回と同じHTTP statusかつ同一バイト列のJSON本文を返した場合だけPASSとする。JSONとして同値でも、空白、改行、オブジェクトのキー順が異なる場合はFAILである。

Raw Bodyは `curl -o` で初回と再送を別ファイルへ保存し、`cmp` で比較する。`cmp` が何も表示せず終了status 0を返せば同一バイト列である。`X-Request-ID` はリクエストごとに変わってよく、ヘッダー全体の一致は要求しない。

比較ファイルは `MITE_IDEMPOTENCY_COMPARE_DIR` が指す、この検証専用に作成した一時ディレクトリへ保存する。レスポンス本文にtokenなどの秘密情報を含む操作にはこの手順を流用しない。

## 5. 認証とCORS

### 5.1 Bearer tokenなし

```bash
curl -i -sS "$MITE_API_BASE_URL/v1/support-requests"
```

確認項目:

- [ ] HTTP 401である。
- [ ] `error.code` が `UNAUTHENTICATED` である。

### 5.2 許可されていないOrigin

```bash
curl -i -sS \
  -H "Authorization: Bearer $MITE_MANUAL_USER_TOKEN" \
  -H 'Origin: https://invalid.example' \
  "$MITE_API_BASE_URL/v1/support-requests"
```

確認項目:

- [ ] HTTP 403である。
- [ ] `error.code` が `FORBIDDEN` である。

### 5.3 許可されたOrigin

```bash
mite_user "$MITE_API_BASE_URL/v1/support-requests"
```

確認項目:

- [ ] HTTP 200である。
- [ ] `Access-Control-Allow-Origin` が `http://localhost:5173` である。
- [ ] `Access-Control-Expose-Headers` が `Retry-After` である。
- [ ] 初期状態では `data.items` が空配列である。

## 6. 支援開始までの基本フロー

### 6.1 初期スクリーンショット登録

```bash
MITE_ARTIFACT_HTTP_STATUS_FIRST="$(
  curl -sS \
    -D "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-first.headers" \
    -o "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-first.json" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $MITE_MANUAL_USER_TOKEN" \
    -H "Origin: $MITE_MANUAL_ORIGIN" \
    -X POST \
    -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-artifact-initial" \
    -F purpose=REQUEST_SCREENSHOT \
    -F "capturedAt=$MITE_CAPTURED_AT" \
    -F "file=@$MITE_TEST_JPEG;type=image/jpeg" \
    "$MITE_API_BASE_URL/v1/artifacts"
)"
sed -n '1,20p' "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-first.headers"
sed -n '1p' "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-first.json"
```

確認項目:

- [ ] HTTP 201である。
- [ ] `data.purpose` が `REQUEST_SCREENSHOT`、`data.revision` が1である。
- [ ] `data.contentUrl` が `/v1/artifacts/{id}/content` である。
- [ ] `storageKey` がレスポンスに含まれない。

レスポンスのArtifact IDを設定する。

```bash
export MITE_INITIAL_ARTIFACT_ID='<data.id>'
```

同じJPEG、日時、Idempotency-Keyで再送し、初回と再送のstatusとRaw Bodyを比較する。

```bash
MITE_ARTIFACT_HTTP_STATUS_RETRY="$(
  curl -sS \
    -D "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-retry.headers" \
    -o "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-retry.json" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $MITE_MANUAL_USER_TOKEN" \
    -H "Origin: $MITE_MANUAL_ORIGIN" \
    -X POST \
    -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-artifact-initial" \
    -F purpose=REQUEST_SCREENSHOT \
    -F "capturedAt=$MITE_CAPTURED_AT" \
    -F "file=@$MITE_TEST_JPEG;type=image/jpeg" \
    "$MITE_API_BASE_URL/v1/artifacts"
)"
test "$MITE_ARTIFACT_HTTP_STATUS_FIRST" = 201
test "$MITE_ARTIFACT_HTTP_STATUS_RETRY" = "$MITE_ARTIFACT_HTTP_STATUS_FIRST"
cmp "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-first.json" \
  "$MITE_IDEMPOTENCY_COMPARE_DIR/artifact-retry.json"
```

- [ ] 両方ともHTTP 201である。
- [ ] `cmp` が終了status 0となり、Raw Bodyが同一バイト列である。
- [ ] 別のArtifactが増えておらず、revisionも増えていない。
- [ ] `X-Request-ID` が異なっていても結果へ影響しない。

### 6.2 画像取得

```bash
mite_family \
  -D - \
  -o /dev/null \
  "$MITE_API_BASE_URL/v1/artifacts/$MITE_INITIAL_ARTIFACT_ID/content"
```

確認項目:

- [ ] HTTP 200である。
- [ ] `Content-Type` が `image/jpeg` である。
- [ ] `Cache-Control` が `private, no-store` である。

内容の一致は、元画像と取得結果のSHA-256を比較して確認できる。

```bash
sha256sum "$MITE_TEST_JPEG"
curl -sS \
  -H "Authorization: Bearer $MITE_MANUAL_FAMILY_TOKEN" \
  -H "Origin: $MITE_MANUAL_ORIGIN" \
  "$MITE_API_BASE_URL/v1/artifacts/$MITE_INITIAL_ARTIFACT_ID/content" \
  | sha256sum
```

- [ ] 2つのSHA-256が一致する。

### 6.3 支援依頼作成

```bash
MITE_SUPPORT_REQUEST_HTTP_STATUS_FIRST="$(
  curl -sS \
    -D "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-first.headers" \
    -o "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-first.json" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $MITE_MANUAL_USER_TOKEN" \
    -H "Origin: $MITE_MANUAL_ORIGIN" \
    -X POST \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-request" \
    --data "{\"initialScreenshotArtifactId\":\"$MITE_INITIAL_ARTIFACT_ID\",\"comment\":\"設定方法が分からない\"}" \
    "$MITE_API_BASE_URL/v1/support-requests"
)"
sed -n '1,20p' "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-first.headers"
sed -n '1p' "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-first.json"
```

確認項目:

- [ ] HTTP 201である。
- [ ] `status=PENDING`、`revision=1`、`supportSessionId=null` である。
- [ ] `userId=user_demo`、`familyId=family_demo` である。
- [ ] 通常依頼なので `guideContext=null` である。

レスポンスのSupportRequest IDを設定する。

```bash
export MITE_SUPPORT_REQUEST_ID='<data.id>'
```

同じbodyとIdempotency-Keyで再送し、初回と再送を比較する。

```bash
MITE_SUPPORT_REQUEST_HTTP_STATUS_RETRY="$(
  curl -sS \
    -D "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-retry.headers" \
    -o "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-retry.json" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $MITE_MANUAL_USER_TOKEN" \
    -H "Origin: $MITE_MANUAL_ORIGIN" \
    -X POST \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-request" \
    --data "{\"initialScreenshotArtifactId\":\"$MITE_INITIAL_ARTIFACT_ID\",\"comment\":\"設定方法が分からない\"}" \
    "$MITE_API_BASE_URL/v1/support-requests"
)"
test "$MITE_SUPPORT_REQUEST_HTTP_STATUS_FIRST" = 201
test "$MITE_SUPPORT_REQUEST_HTTP_STATUS_RETRY" = \
  "$MITE_SUPPORT_REQUEST_HTTP_STATUS_FIRST"
cmp "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-first.json" \
  "$MITE_IDEMPOTENCY_COMPARE_DIR/support-request-retry.json"
```

- [ ] 両方ともHTTP 201である。
- [ ] `cmp` が終了status 0となり、Raw Bodyが同一バイト列である。
- [ ] SupportRequestが増えず、revisionも増えない。

同じIdempotency-Keyでcommentだけを変える。

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-request" \
  --data "{\"initialScreenshotArtifactId\":\"$MITE_INITIAL_ARTIFACT_ID\",\"comment\":\"別の内容\"}" \
  "$MITE_API_BASE_URL/v1/support-requests"
```

- [ ] HTTP 409、`IDEMPOTENCY_KEY_REUSED` である。

### 6.4 支援依頼一覧・詳細

```bash
mite_family \
  "$MITE_API_BASE_URL/v1/support-requests?status=PENDING"

mite_family \
  "$MITE_API_BASE_URL/v1/support-requests/$MITE_SUPPORT_REQUEST_ID"
```

確認項目:

- [ ] 両方ともHTTP 200である。
- [ ] 一覧と詳細に同じSupportRequestが含まれる。
- [ ] 一覧は `data.items` 配列である。

### 6.5 家族から発信

```bash
mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-call" \
  --data '{"expectedRequestRevision":1}' \
  "$MITE_API_BASE_URL/v1/support-requests/$MITE_SUPPORT_REQUEST_ID/call"
```

確認項目:

- [ ] HTTP 201である。
- [ ] `data.supportRequest.revision=2` で、`supportSessionId` が設定される。
- [ ] `data.supportSession.status=RINGING`、`revision=1` である。
- [ ] `livekitRoomName` が `mite-<session ID>` で、個人情報を含まない。

レスポンスのSupportSession IDを設定する。

```bash
export MITE_SUPPORT_SESSION_ID='<data.supportSession.id>'
```

新しいIdempotency-Keyで古いSupportRequest revisionを指定する。

```bash
mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-call-stale" \
  --data '{"expectedRequestRevision":1}' \
  "$MITE_API_BASE_URL/v1/support-requests/$MITE_SUPPORT_REQUEST_ID/call"
```

- [ ] HTTP 409、`REVISION_CONFLICT` である。
- [ ] 2件目のSupportSessionが作られていない。

### 6.6 利用者が応答

まず家族tokenで実行する。

```bash
mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-accept-family" \
  --data '{"expectedSessionRevision":1,"consent":{"audio":true,"screenShare":true,"periodicCapture":true,"textVersion":"v3"}}' \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/accept"
```

- [ ] HTTP 403、`FORBIDDEN` である。

利用者tokenで応答する。

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-accept" \
  --data '{"expectedSessionRevision":1,"consent":{"audio":true,"screenShare":true,"periodicCapture":true,"textVersion":"v3"}}' \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/accept"
```

確認項目:

- [ ] HTTP 200である。
- [ ] SupportRequestが `IN_SUPPORT`・revision 3である。
- [ ] SupportSessionが `ACTIVE`・revision 2である。
- [ ] consent、`consentedAt`、`startedAt` が設定される。

GETでも同じ状態を確認する。

```bash
mite_family \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID"
```

### 6.7 LiveKit token発行

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{}' \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/livekit-token"

mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  --data '{}' \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/livekit-token"
```

確認項目:

- [ ] 両方ともHTTP 200である。
- [ ] `participantIdentity` が利用者は `user:user_demo`、家族は `family:family_demo` である。
- [ ] `roomName` は同一で、tokenと `expiresAt` が設定される。
- [ ] API keyとSecretがレスポンスに含まれない。

このPOSTだけは `Idempotency-Key` が不要である。ローカル用ダミー設定では発行tokenを使ってLiveKit Cloudへ接続しない。

## 7. 支援解決の分岐

`SKIP` と `CREATE` は同じSupportSessionでは両方実行できない。短いsmoke testでは7.1、ガイド保存まで確認する場合は7.2を選ぶ。

### 7.1 ガイドを作らず終了する

```bash
mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-resolve-skip" \
  --data '{"expectedSessionRevision":2,"guideDecision":"SKIP"}' \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/resolve"
```

確認項目:

- [ ] HTTP 200である。
- [ ] SupportRequestが `RESOLVED`・revision 4である。
- [ ] SupportSessionが `ENDED`・revision 3である。
- [ ] `guideDecision=SKIP`、`endReason=GUIDE_SKIPPED` である。
- [ ] ガイド関連IDがすべて `null` である。

この分岐を実行した後にCREATEフローを確認する場合は、サーバーを停止し、ローカルDBをresetして第3章からやり直す。

### 7.2 ガイドを作成する

```bash
mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-resolve-create" \
  --data '{"expectedSessionRevision":2,"guideDecision":"CREATE"}' \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/resolve"
```

確認項目:

- [ ] HTTP 200である。
- [ ] SupportRequestが `RESOLVED`・revision 4である。
- [ ] SupportSessionが `GENERATING_GUIDE`・revision 3である。
- [ ] `guideDecision=CREATE` である。

## 8. ガイド材料と生成job

この章は7.2を選んだ場合だけ実行する。

### 8.1 材料バッチ作成

```bash
export MITE_MATERIAL_CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-batch" \
  --data "{\"expectedSessionRevision\":3,\"captureIntervalSeconds\":10,\"capturedFrom\":\"$MITE_MATERIAL_CAPTURED_AT\",\"capturedTo\":\"$MITE_MATERIAL_CAPTURED_AT\",\"expectedItemCount\":1}" \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/guide-material-batches"
```

確認項目:

- [ ] HTTP 201である。
- [ ] batchが `UPLOADING`・revision 1・`receivedItemCount=0` である。
- [ ] SupportSessionがrevision 4となり、`guideMaterialBatchId` が設定される。

batch IDを設定する。

```bash
export MITE_GUIDE_BATCH_ID='<data.batch.id>'
```

### 8.2 材料画像登録

```bash
mite_user \
  -X POST \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-material-1" \
  -F "clientCaptureId=manual-$MITE_MANUAL_RUN_ID-capture-1" \
  -F sequence=1 \
  -F "capturedAt=$MITE_MATERIAL_CAPTURED_AT" \
  -F "file=@$MITE_TEST_JPEG;type=image/jpeg" \
  "$MITE_API_BASE_URL/v1/guide-material-batches/$MITE_GUIDE_BATCH_ID/materials"
```

確認項目:

- [ ] HTTP 201である。
- [ ] materialの `sequence=1` である。
- [ ] batchがrevision 2・`receivedItemCount=1` である。

materialのArtifact IDを設定する。

```bash
export MITE_MATERIAL_ARTIFACT_ID='<data.material.artifactId>'
```

別のIdempotency-Keyで、同じclientCaptureId、sequence、capturedAt、JPEGを送る。

```bash
mite_user \
  -X POST \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-material-1-duplicate" \
  -F "clientCaptureId=manual-$MITE_MANUAL_RUN_ID-capture-1" \
  -F sequence=1 \
  -F "capturedAt=$MITE_MATERIAL_CAPTURED_AT" \
  -F "file=@$MITE_TEST_JPEG;type=image/jpeg" \
  "$MITE_API_BASE_URL/v1/guide-material-batches/$MITE_GUIDE_BATCH_ID/materials"
```

確認項目:

- [ ] 同一materialとしてHTTP 200である。
- [ ] material IDは同じで、`receivedItemCount=1`・batch revision 2のままである。

### 8.3 バッチ取得・完了

```bash
mite_family \
  "$MITE_API_BASE_URL/v1/guide-material-batches/$MITE_GUIDE_BATCH_ID"
```

- [ ] HTTP 200で、`materials` がsequence昇順に1件返る。

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-batch-complete" \
  --data '{"expectedBatchRevision":2,"expectedItemCount":1}' \
  "$MITE_API_BASE_URL/v1/guide-material-batches/$MITE_GUIDE_BATCH_ID/complete"
```

確認項目:

- [ ] HTTP 202である。
- [ ] batchが `COMPLETED`・revision 3である。
- [ ] jobが `QUEUED`・attempt 0・revision 1である。
- [ ] SupportSessionがrevision 5となり、`guideGenerationJobId` が設定される。

job IDを設定する。

```bash
export MITE_GUIDE_JOB_ID='<data.job.id>'
```

### 8.4 job完了待ち

数秒ごとに取得し、最大60秒を目安に `SUCCEEDED` または `FAILED` になるまで確認する。

```bash
mite_family \
  "$MITE_API_BASE_URL/v1/guide-generation-jobs/$MITE_GUIDE_JOB_ID"
```

確認項目:

- [ ] `QUEUED → RUNNING → SUCCEEDED` または `FAILED` の範囲で遷移する。
- [ ] 完了時にattemptが1、revisionが3となる。
- [ ] `RUNNING` を観測できた場合はattemptが1、revisionが2である。処理が短い場合は `RUNNING` を観測できなくてもよい。
- [ ] 失敗時の `errorCode` が仕様で定めた値のいずれかで、外部APIの詳細を含まない。

第3.3節のローカル用ダミーAI設定では `FAILED` が期待結果である。実Geminiを設定した完全確認では `SUCCEEDED` と `guideDraftId` の設定を確認し、第9章へ進む。

### 8.5 FAILED時の再試行または中止

jobの現在revisionを設定する。

```bash
export MITE_GUIDE_JOB_REVISION='<data.revision>'
```

attemptが3未満なら再試行できる。

```bash
mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-job-retry" \
  --data "{\"expectedJobRevision\":$MITE_GUIDE_JOB_REVISION}" \
  "$MITE_API_BASE_URL/v1/guide-generation-jobs/$MITE_GUIDE_JOB_ID/retry"
```

- [ ] HTTP 202で `QUEUED` に戻り、revisionが1増える。
- [ ] attemptはworkerが次に `RUNNING` へ移す時点で増える。

中止する場合はSupportSessionをGETし、現在revisionを設定する。jobが `QUEUED` または `RUNNING` の間は中止できない。

```bash
export MITE_SUPPORT_SESSION_REVISION='<current session revision>'

mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-end-cancelled" \
  --data "{\"expectedSessionRevision\":$MITE_SUPPORT_SESSION_REVISION,\"reason\":\"GUIDE_CANCELLED\"}" \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/end-without-guide"
```

- [ ] HTTP 200で `ENDED`・`endReason=GUIDE_CANCELLED` となる。
- [ ] batch、job、draftへの参照IDが `null` になる。

中止した場合は第9章以降へ進まず、このシナリオを終了する。

## 9. 下書き編集とガイド保存

この章はjobが `SUCCEEDED` になった場合だけ実行する。

jobレスポンスのdraft IDを設定する。

```bash
export MITE_GUIDE_DRAFT_ID='<data.guideDraftId>'
```

### 9.1 下書き取得

```bash
mite_user \
  "$MITE_API_BASE_URL/v1/guide-drafts/$MITE_GUIDE_DRAFT_ID"

mite_family \
  "$MITE_API_BASE_URL/v1/guide-drafts/$MITE_GUIDE_DRAFT_ID"
```

確認項目:

- [ ] 両方ともHTTP 200で、同じ下書きが返る。
- [ ] `status=EDITING`、revision 1、stepsが1〜8件である。
- [ ] SupportSessionをGETすると `REVIEWING_GUIDE`・revision 6である。

### 9.2 家族による下書き更新

初期スクリーンショットと材料画像を使い、2ステップへ全体置換する。

```bash
mite_family \
  -X PATCH \
  -H 'Content-Type: application/json' \
  --data "{\"expectedRevision\":1,\"title\":\"設定を確認する\",\"steps\":[{\"position\":1,\"artifactId\":\"$MITE_INITIAL_ARTIFACT_ID\",\"instruction\":\"設定画面を確認する\"},{\"position\":2,\"artifactId\":\"$MITE_MATERIAL_ARTIFACT_ID\",\"instruction\":\"保存ボタンを押す\"}]}" \
  "$MITE_API_BASE_URL/v1/guide-drafts/$MITE_GUIDE_DRAFT_ID"
```

確認項目:

- [ ] HTTP 200でrevision 2となる。
- [ ] titleとstepsが送信内容へ置き換わる。

同じPATCHを `expectedRevision=1` のまま再送する。

- [ ] HTTP 409、`REVISION_CONFLICT` である。

### 9.3 ガイド保存

```bash
mite_family \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-draft-save" \
  --data '{"expectedRevision":2}' \
  "$MITE_API_BASE_URL/v1/guide-drafts/$MITE_GUIDE_DRAFT_ID/save"
```

確認項目:

- [ ] HTTP 201である。
- [ ] Guideの `currentVersionNumber=1`、revision 1、stepsが2件である。
- [ ] SupportSessionが `GUIDE_SAVED`・revision 7、`endedAt`と`endReason`がnullで、LiveKit tokenの取得ができる。
- [ ] GuideDraftが `SAVED`・revision 3である。
- [ ] batchとjobへの参照が `null` になる。

Guide IDを設定する。

```bash
export MITE_GUIDE_ID='<data.guide.id>'
```

同じsaveを同じIdempotency-Keyとbodyで再送する。

- [ ] HTTP 201と、初回と同一バイト列のJSON本文が返る。
- [ ] Guide、GuideVersion、GuideVersionStepが増えない。

### 9.4 ガイド一覧・詳細

```bash
mite_user "$MITE_API_BASE_URL/v1/guides"
mite_user "$MITE_API_BASE_URL/v1/guides/$MITE_GUIDE_ID"
```

確認項目:

- [ ] 両方ともHTTP 200である。
- [ ] 一覧に保存したガイドが含まれる。
- [ ] 詳細の `currentVersion.steps` はposition昇順で2件である。
- [ ] `representativeArtifactId` が1ステップ目のArtifact IDである。

家族tokenでも詳細を取得する。

```bash
mite_family "$MITE_API_BASE_URL/v1/guides/$MITE_GUIDE_ID"
```

- [ ] HTTP 403、`FORBIDDEN` である。

## 10. GuideRun

### 10.1 開始と取得

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-guide-run" \
  --data "{\"guideId\":\"$MITE_GUIDE_ID\"}" \
  "$MITE_API_BASE_URL/v1/guide-runs"
```

確認項目:

- [ ] HTTP 201である。
- [ ] `status=IN_PROGRESS`、`currentStepNumber=1`、revision 1である。
- [ ] `guideVersionNumber=1` で固定される。

GuideRun IDを設定する。

```bash
export MITE_GUIDE_RUN_ID='<data.id>'
```

```bash
mite_user "$MITE_API_BASE_URL/v1/guide-runs/$MITE_GUIDE_RUN_ID"
```

- [ ] HTTP 200で作成時と同じ状態が返る。

### 10.2 ステップ移動と完了

```bash
mite_user \
  -X PATCH \
  -H 'Content-Type: application/json' \
  --data '{"expectedRevision":1,"action":"NEXT"}' \
  "$MITE_API_BASE_URL/v1/guide-runs/$MITE_GUIDE_RUN_ID"
```

- [ ] HTTP 200で `currentStepNumber=2`、revision 2となる。

古いrevision 1で `PREVIOUS` を送る。

```bash
mite_user \
  -X PATCH \
  -H 'Content-Type: application/json' \
  --data '{"expectedRevision":1,"action":"PREVIOUS"}' \
  "$MITE_API_BASE_URL/v1/guide-runs/$MITE_GUIDE_RUN_ID"
```

- [ ] HTTP 409、`REVISION_CONFLICT` で、stepは2のままである。

最終ステップで完了する。

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-guide-run-complete" \
  --data '{"expectedRevision":2}' \
  "$MITE_API_BASE_URL/v1/guide-runs/$MITE_GUIDE_RUN_ID/complete"
```

確認項目:

- [ ] HTTP 200で `COMPLETED`・revision 3となる。
- [ ] `completedAt` が設定される。

### 10.3 保存後の通話終了

ガイドの保存では通話・共有を終了しません。利用者がガイドを試し終えた後、家族が次を実行します。「閉じる」だけではこのAPIを呼びません。

```bash
mite_family -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-end-saved-guide" \
  --data '{"expectedSessionRevision":7}' \
  "$MITE_API_BASE_URL/v1/support-sessions/$MITE_SUPPORT_SESSION_ID/end"
```

- [ ] `ENDED`・revision 8・`endReason=GUIDE_SAVED`になり、Guideと画像は保持される。
- [ ] 同じキーと本文の再送は、同一バイトの成功応答を返す。
- [ ] 利用者による実行は403、終了後のLiveKit token発行は409になる。

### 10.4 ガイド途中から支援依頼

新しいGuideRunを作る。

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-guide-run-help" \
  --data "{\"guideId\":\"$MITE_GUIDE_ID\"}" \
  "$MITE_API_BASE_URL/v1/guide-runs"
```

```bash
export MITE_HELP_GUIDE_RUN_ID='<data.id>'
export MITE_HELP_CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

現在画面を支援依頼用Artifactとして登録する。

```bash
mite_user \
  -X POST \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-help-artifact" \
  -F purpose=REQUEST_SCREENSHOT \
  -F "capturedAt=$MITE_HELP_CAPTURED_AT" \
  -F "file=@$MITE_TEST_JPEG;type=image/jpeg" \
  "$MITE_API_BASE_URL/v1/artifacts"
```

```bash
export MITE_HELP_ARTIFACT_ID='<data.id>'
```

GuideRunの現在ステップを引き継いで支援依頼を作る。

```bash
mite_user \
  -X POST \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: manual-$MITE_MANUAL_RUN_ID-guide-run-help-request" \
  --data "{\"expectedRevision\":1,\"initialScreenshotArtifactId\":\"$MITE_HELP_ARTIFACT_ID\",\"comment\":\"この手順が分からない\"}" \
  "$MITE_API_BASE_URL/v1/guide-runs/$MITE_HELP_GUIDE_RUN_ID/support-request"
```

確認項目:

- [ ] HTTP 201である。
- [ ] GuideRunが `PAUSED_FOR_SUPPORT`・revision 2となる。
- [ ] GuideRunとSupportRequestの関連IDが相互に設定される。
- [ ] SupportRequestが `PENDING`・revision 1である。
- [ ] `guideContext` にguide ID、version、step、title、instruction、Artifact IDがすべて含まれる。

この操作は未完了のSupportRequestを残す。再度手順全体を実行する前に、第12章に従ってローカルDBをresetする。

## 11. WebSocket

WebSocketはRESTによる状態変更を通知する経路であり、状態の正本ではない。第6章以降を実行する前に、許可されたOriginで動く利用者側または家族側ElectronのDevToolsから接続する。

家族側の例を示す。`manual-family-token` はローカル検証用の値である。

```javascript
const manualSocket = new WebSocket("ws://localhost:3000/v1/events");

manualSocket.addEventListener("message", (event) => {
  console.log(JSON.parse(event.data));
});

manualSocket.addEventListener("open", () => {
  manualSocket.send(JSON.stringify({
    type: "authenticate",
    token: "manual-family-token",
  }));
});
```

確認項目:

- [ ] 接続から5秒以内に認証メッセージを送り、`{ "type": "authenticated" }` を受信する。
- [ ] REST操作後に対応する `*.created` または `*.updated` を受信する。
- [ ] eventに `eventId`、`occurredAt`、`entityId`、`revision`、更新後エンティティ全体の `data` がある。
- [ ] tokenやStorage keyがeventに含まれない。
- [ ] 許可されていないOrigin、空token、不正tokenでは接続が閉じられる。

確認後は接続を閉じる。

```javascript
manualSocket.close();
```

## 12. 終了と再実行

サーバーはターミナル1で `Ctrl+C` を押して停止する。再度最初から検証する場合は、接続先がローカルSupabaseであることを確認し、リポジトリルートで実行する。

```bash
npx supabase db reset
```

リセット後は第3.3節に従い、`eval "$(npx supabase status -o env 2>/dev/null)"` と `DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_SECRET_KEY` への上書きを再実行する。`.env` へ直接記入した場合はそちらを最新化し、サーバーを再起動する。ガイド途中からの支援依頼を作成した場合、resetせずに再実行すると `DUPLICATE_ACTIVE_REQUEST` になる。

## 13. 結果記録

手動検証結果には次を残す。token、Secret key、API key、画像内容、コメント本文は残さない。

```text
実施日時:
実施者:
branch / commit:
OS:
Go version:
Supabase CLI version:
検証範囲: SKIP / CREATE / GuideRun / WebSocket / 実LiveKit / 実Gemini
結果: PASS / FAIL
失敗した節:
HTTP status / error.code / requestId:
Idempotency再送: HTTP status SAME / DIFFERENT、Raw JSON Body SAME / DIFFERENT
補足:
```

完了判定:

- [ ] 実施した各節のHTTP status、状態、revisionが期待値と一致した。
- [ ] 再送でデータとrevisionが増えなかった。
- [ ] ArtifactとSupportRequestの再送で、HTTP statusとRaw JSON Bodyが初回と一致した。
- [ ] 不正role、古いrevision、不正なIdempotency-Key再利用が拒否された。
- [ ] レスポンス、event、ログに秘密情報やStorage keyが出ていない。
- [ ] 実行しなかった分岐と外部サービス確認を結果記録へ明記した。
