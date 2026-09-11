# dev取り込み・動作確認・保守記録

確認日: 2026-09-11。基準は `origin/dev` の `ea94b915049d6c11d813966e091df60243ed75e8`。作業ブランチは `update/system/audit-and-refactor-support-flows` とする。

## ブランチの取り込み確認

リモートをfetchし、全ブランチの先端からdevに未収録のコミットを調べ、PRの取り込み先も照合した。機能・修正ブランチ8本はすべてdevの祖先であり、取りこぼした製品変更はなかった。未処理のPRもなかった。

`main` にだけある3コミットは、PR #28のマージ、これを取り消すrevert、PR #29のマージである。revert後のツリーが #28のマージ直前と一致することを確認した。同じ機能変更はPR #30でdevに取り込み済みであり、main用の取り消しをdevへ適用する必要はない。`main` と `dev` は保持する。

次の9本を削除した。削除時に先端SHAが変わっていないことを条件に、全件をまとめて削除し、リモートにmainとdevだけが残ったことを確認した。SHAはいずれも取り込み先の履歴から復元できる。

| リモートブランチ | 削除前のSHA | 取り込み先 |
| --- | --- | --- |
| `chore/system/test-merge-multiple-guides` | `4ded90828512d3152b8b6dda56e06474f5dcb455` | dev / PR #30 |
| `feat/system/add-family-pwa-companion` | `17231962f08386e784b855b32af39fabbf8d68ae` | dev / PR #32 |
| `feat/system/deploy-family-pwa` | `aa491b18ecc22cab28cdd2aaa98422de2ac714ac` | dev / PR #34 |
| `feat/system/review-multiple-guides` | `28fc15c96f5ceac87c4098a3394e1ee79a36ef90` | dev / PR #30の履歴に含まれる |
| `fix/client/family-pwa-publishing` | `6ff842800e14901937c92ca7741538eaab4d6550` | dev / PR #36 |
| `fix/server/deploy-matching-prompt-version` | `c4cc9df41c72c7e9102c70928045ac2f61f289b4` | dev / PR #31 |
| `fix/system/reproducible-pwa-deployment` | `05971c64ec1b3be054a571f511b878e22cf8abe9` | dev / PR #38 |
| `revert-28-chore/system/test-merge-multiple-guides` | `d2164e219b90cb3ea438897f3b09474db9736e72` | main / PR #29 |
| `update/client/refine-mite-visual-design` | `3b88e49e008f7db670c297df9279875052c6fc2b` | dev / PR #37 |

復元が必要な場合は、表のSHAとブランチ名を指定して `git push origin <SHA>:refs/heads/<ブランチ名>` を実行する。ローカルブランチは削除対象に含めない。

## 修正とリファクタリング

- PWAの状態取得を `useCompanionData` に分ける。遅いGET、同じ依頼の古いrevision、一覧から消えた依頼への遅いPATCH応答による表示の巻き戻りを防ぐ。
- トークン設定とダッシュボードの寿命を分け、トークン再設定時に依頼・返答・通知設定の表示を初期化する。
- 初回取得中と取得失敗を表示し、取得前に「依頼なし」と表示しない。返答失敗と再取得失敗を別々に保持し、自動更新の成功で送信エラーを消さない。
- JSON・画像・204応答で認証とAPIエラー処理を共通化し、画像取得・Push購読解除でも `Retry-After` を呼び出し元へ渡す。RESTの契約とDBスキーマは変更しない。
- CIで既存の `TestClientAdapterE2E` を有効化する。GoのHTTP/WebSocket E2Eとは別のジョブ・Supabase環境を使い、テストデータを分離する。
- AI生成の受け入れ条件を、合意済みの最大300秒/試行と整合させる。取得待ち・確定を含む受け入れ条件は305秒とする。

## 検証結果

LinuxでNode.js 24.21.0、npm 11.19.0、Go 1.26.8を使い、以下を確認した。外部サービスの呼び出しと実機確認は、下記の範囲に含めない。

| 対象 | 結果 |
| --- | --- |
| API・SQL生成 | `npm run generate:api` と `go tool sqlc generate` が成功。生成物の差分なし |
| 共有API | ルートの `npm run typecheck`、`npm run lint`、`npm run build` が成功 |
| client | `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run build` が成功。両Electronと本番サブパスのPWAをビルド |
| clientの自動テスト | `npm run test -- --maxWorkers=2` で203件成功・2件skip。フック終了処理の整理後もPWAの9件が成功 |
| Go | `go test -race ./... -count=1 -timeout=5m`、`go vet ./...`、`go build ./...` が成功 |
| デプロイ | `server/deploy/test-*.sh` の4スイートが成功。配置・再実行・checksum・排他・失敗時の復元を確認 |
| DB・Storage・HTTP/WebSocket | 新規の専用Supabaseに全9 migrationを適用。`go test -race -p 1 ./... -run 'Postgres\|Integration\|^TestServerRuntimeE2E$' -count=1 -timeout=5m -v` が成功。既存の開発DBは使用せず、専用環境は確認後に破棄 |
| 実TypeScript adapter | CIの専用Supabaseで `TestClientAdapterE2E` が成功。支援から複数ガイドの一括保存・利用・再相談、heartbeat・確認返答・取消・Push未設定時の503と購読解除の204を確認 |
| 実ブラウザー | Headless Chromiumでビルド済みPWAを `/mite/pwa/` から起動。テスト用HTTP応答を使い、トークン入力、返答、競合エラーの保持と再試行、通信復帰、依頼非表示、トークン初期化を確認。幅390px・844pxで横方向のはみ出しなし、未処理のJavaScript例外なし |
| 現行公開環境 | 現行devの公開PWAとService WorkerがHTTP 200、認証なしのAPIが401になることを確認。今回のPR内容の公開確認はマージ後に行う |

通常のclientテストのskipは、Windows専用のCore Audio COMコンパイル確認と、接続情報を別途必要とするTypeScript adapter E2Eである。後者は独立したCIジョブで実行した。CIの6ジョブと最終コミットの結果は[PR #39のChecks](https://github.com/kakuraccho/mite/pull/39/checks)を参照する。

Windowsでの `npm run make:user` / `npm run make:family`、Windows固有の画面取得・AppBar・音量動作、2台間の実LiveKit/Gemini、iPhoneの実Web Pushは、このLinux環境では未実施である。第17章のすべてに合格したことやMVPの実機検証完了を示すものではない。

## マージ後に行うこと

1. PRの変更内容とCI結果を確認してdevへマージする。
2. `VPS_DEPLOY_BRANCH=dev` と `VPS_AUTO_DEPLOY=true` が設定されているため、マージ後は[CI/CDガイド](ci-cd.md)に従い、API・PWAの自動デプロイ成功を確認する。今回の変更に新しいmigration、秘密情報、外部サービスの追加は不要である。
3. Windows上で `client/` の `npm run make:user` と `npm run make:family` を実行し、2台のWindows PCで[仕様第17章](specification.md#17-受け入れテスト)の正常系を確認する。画面取得・AppBar、実LiveKitの音声・共有・マーキング、実Geminiのガイド生成は実機確認に含める。
4. iPhoneのホーム画面へ公開PWAを追加し、通知購読、ロック画面受信、通知タップ後の最新取得、600秒以上切断後の再接続通知を確認する。返答の表示、取消後の依頼非表示、通信復帰も確認する。

Windowsとスマートフォンの実機・外部サービスの確認手順は[開発ガイド](development.md)、[接続ガイド](server-client-integration.md)、[READMEの既知の未確認事項](../README.md#既知の未確認事項)を参照する。
