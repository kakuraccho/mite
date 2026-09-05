# Miteクライアント作業規則

このファイルは `client/` 以下へ適用し、ルートの `AGENTS.md` を補足します。

## 構成と責務

- `apps/user-electron/`: 利用者側画面、画面取得、端末保存、共有送信、マーキング表示
- `apps/family-electron/`: 家族側画面、共有受信、マーキング送信、下書き編集
- `packages/client-api/`: rootの `@mite/api-client` から生成型を参照するREST・WebSocket adapter。API契約を独断で変更しない
- `packages/client-core/`: revision、再試行、復元、共通状態判断
- `packages/ui/`: 共通UI、アクセシビリティ、デザイントークン

アプリ固有コードから別アプリを直接importしないでください。共有が必要なコードは、責務に応じた `packages/` へ置いてください。

## Electronの安全性

- `contextIsolation` を有効、`nodeIntegration` を無効、sandboxを有効にする
- rendererからNode.js APIを直接使用しない
- mainとrendererの境界はpreloadの明示的なAPIだけにする
- IPCの送信元を検証し、任意のチャンネルを中継するAPIを公開しない
- トークン、画像、コメント本文をログへ出力しない
- パッケージ版は利用者側 `mite-user://app`、家族側 `mite-family://app` を使う

## 利用者側オーバーレイ

- 利用者側は通常のメインウィンドウを作らず、U-01からU-08を左端オーバーレイ内で完結させる
- Windowsではプライマリ画面の左端4pxだけをAppBarとして予約し、展開幅を予約領域へ含めない
- Windows AppBar APIの呼び出しはmainプロセスのプラットフォームアダプターへ閉じ込め、preloadには列挙済みの表示モード変更IPCだけを公開する
- Win32 FFIの `koffi` はmainプロセスだけで使用する。workspaceでhoistされた本体と対象OS用プリビルドを配布物へ入れる `forge.config.cjs` のcopy hook、および `.node` のasar展開設定を維持する
- LinuxではOSの作業領域を変更せず、同じ表示モードと境界計算を疑似動作させる
- AppBar変更後はWindows 11で最大化、タスクバー、DPI、表示設定変更、正常終了時の解除を確認し、未実施項目を完了報告へ記載する

## UI

- 利用者側本文は20px以上、主要ボタンは高さ48px以上にする
- 専門用語を利用者向け画面へ表示しない
- 色だけで状態を表現せず、キーボードフォーカスを常に視認可能にする
- ローディング、通信失敗、再試行、接続状態を明示する

## 状態と通信

- REST応答を業務状態の正本とし、WebSocketだけで状態を変更しない
- 同じエンティティの保持済みrevision以下を無視する
- WebSocket再接続後と5秒ごとのポーリングでGETし直す
- 状態変更POSTのIdempotency-Keyは応答確定まで保持し、結果不明時は同じキーで再送する
- API失敗時に表示状態を先へ進めない

## コマンド

変更後は対象に応じて次を実行してください。

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
```

Windows配布物の確認はWindows上で `npm run make:user` と `npm run make:family` を実行します。
