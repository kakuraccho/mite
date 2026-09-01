# 01. 状態モデル

## 1. 方針

支援依頼、支援セッション、ガイド作成、ガイド利用を別の状態として扱う。画面ごとのローカルなbooleanだけで全体の進行を表現しない。

## 2. 主要データ

### `SupportRequest`

```ts
interface SupportRequest {
  id: string;
  createdAt: string;
  screenshotId: string;
  comment: string;
  status: 'draft' | 'matching' | 'pending' | 'viewed' | 'closed';
}
```

### `SupportSession`

```ts
interface SupportSession {
  id: string;
  requestId: string;
  status:
    | 'idle'
    | 'ringing'
    | 'connecting'
    | 'supporting'
    | 'guideDecision'
    | 'guideGenerating'
    | 'guideReview'
    | 'ended';
  marker: Marker | null;
  mockCaptureCount: number;
}
```

### `Marker`

```ts
interface Marker {
  xRatio: number;
  yRatio: number;
  createdAt: string;
}
```

`xRatio` と `yRatio` は共有画面左上を `(0, 0)`、右下を `(1, 1)` とする相対座標とする。

### `Guide`

```ts
interface Guide {
  id: string;
  title: string;
  coverImageId: string;
  steps: GuideStep[];
  status: 'draft' | 'published';
  createdFromRequestId?: string;
}
```

### `GuideStep`

```ts
interface GuideStep {
  id: string;
  imageId: string;
  instruction: string;
}
```

### `GuideRun`

```ts
interface GuideRun {
  guideId: string | null;
  status: 'idle' | 'browsing' | 'running' | 'completed' | 'fallback';
  currentStepIndex: number;
  entry: 'guideList' | 'similarGuideMatch' | null;
}
```

型名や配置は既存コードに合わせて変更してよいが、意味と状態の分離は保つこと。

## 3. 主要イベント

```text
OPEN_EDGE_PANEL
START_SUPPORT_REQUEST
SET_REQUEST_COMMENT
SUBMIT_SUPPORT_REQUEST
START_GUIDE_MATCHING
GUIDE_MATCH_FOUND
GUIDE_MATCH_NOT_FOUND
VIEW_SUPPORT_REQUEST
SET_GRANDFATHER_ONLINE
START_CALL
ACCEPT_CALL
CONNECTION_ESTABLISHED
PLACE_MARKER
MOCK_CAPTURE_TICK
FINISH_PROBLEM_SOLVING
CHOOSE_CREATE_GUIDE
CHOOSE_SKIP_GUIDE
GUIDE_DRAFT_GENERATED
UPDATE_GUIDE_TITLE
UPDATE_GUIDE_STEP
GO_TO_GUIDE_REVIEW_STEP
SAVE_GUIDE
OPEN_GUIDE_LIST
SELECT_GUIDE
START_GUIDE
GO_TO_NEXT_GUIDE_STEP
GO_TO_PREVIOUS_GUIDE_STEP
COMPLETE_GUIDE
REQUEST_REMOTE_SUPPORT_FROM_GUIDE
END_SESSION
RESET_DEMO
```

## 4. 正常系の状態遷移

### 4.1 支援依頼

| 現在 | イベント | 次 |
|---|---|---|
| 依頼なし | `START_SUPPORT_REQUEST` | `draft` |
| `draft` | `SUBMIT_SUPPORT_REQUEST` | `matching` |
| `matching` | `GUIDE_MATCH_FOUND` | ガイド利用へ |
| `matching` | `GUIDE_MATCH_NOT_FOUND` | `pending` |
| `pending` | `VIEW_SUPPORT_REQUEST` | `viewed` |
| `viewed` | `START_CALL` | 支援セッション `ringing` |

### 4.2 支援セッション

| 現在 | イベント | 次 |
|---|---|---|
| `ringing` | `ACCEPT_CALL` | `connecting` |
| `connecting` | `CONNECTION_ESTABLISHED` | `supporting` |
| `supporting` | `PLACE_MARKER` | `supporting` |
| `supporting` | `MOCK_CAPTURE_TICK` | `supporting` |
| `supporting` | `FINISH_PROBLEM_SOLVING` | `guideDecision` |
| `guideDecision` | `CHOOSE_SKIP_GUIDE` | `ended` |
| `guideDecision` | `CHOOSE_CREATE_GUIDE` | `guideGenerating` |
| `guideGenerating` | `GUIDE_DRAFT_GENERATED` | `guideReview` |
| `guideReview` | `SAVE_GUIDE` | `ended` |

### 4.3 ガイド利用

| 現在 | イベント | 次 |
|---|---|---|
| `idle` | `OPEN_GUIDE_LIST` | `browsing` |
| `browsing` | `SELECT_GUIDE` | `running`, step 0 |
| `idle` | `GUIDE_MATCH_FOUND` | `running`, step 0 |
| `running` | `GO_TO_NEXT_GUIDE_STEP` | `running`, step +1 |
| `running` | `GO_TO_PREVIOUS_GUIDE_STEP` | `running`, step -1 |
| 最終stepの `running` | `COMPLETE_GUIDE` | `completed` |
| `running` | `REQUEST_REMOTE_SUPPORT_FROM_GUIDE` | `fallback` → 支援依頼へ |

## 5. 守るべき不変条件

- `supporting` 以外ではマーキング操作を有効にしない
- マーカーは常に0から1の相対座標内に収める
- ガイドレビュー中に祖父側から内容を編集できない
- `published` のガイドだけを祖父側一覧に表示する
- ガイドのページ番号は `0 <= currentStepIndex < steps.length` を満たす
- `guideGenerating` は実AI処理ではなく、固定時間後に決定的なドラフトを返す
- 支援を終了したら、画面共有、マーキング、疑似通話中表示を解除する
- `RESET_DEMO` 後は選択シナリオの初期状態へ戻る

## 6. 状態の共有

`/demo` では祖父側と家族側が同じストアを参照する。

個別ルートを別タブで開く場合は、同一ブラウザ内のモック同期でよい。ネットワークやサーバーは使用しない。

## 7. 異常系

今回、異常系は網羅しない。実装中に不足が見つかった場合は、正常系を通すために必要な最小限の表示だけを追加し、詳細は `90-open-questions.md` に残す。
