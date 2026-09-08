# サーバーのCI/CD

[開発ガイド](development.md)へ戻る。

## CI

GitHub Actionsの[Server CI/CD](../.github/workflows/server-ci.yml)で、すべてのPull Request、`dev`・`main`へのpush、手動実行時にサーバーと共有APIを検証する。

| チェック名 | 内容 |
| --- | --- |
| Generated code and shared API | OpenAPI・sqlcの再生成、コミット済み生成物との一致、新規生成ファイルの追跡漏れ、共有APIの型チェック・Lint・ビルド |
| Go tests and build | gofmt、race検査付きテスト、go vet、ビルド、VPSデプロイ・復元スクリプトのテスト |
| Supabase integration and HTTP WebSocket E2E | 一時的なSupabaseへのmigration適用、DB・Storage統合テスト、HTTP/WebSocket E2E |

Goは`server/go.mod`のバージョン、Node.jsは24を使う。npm依存関係はルートの`package-lock.json`、Goツールは`server/go.mod`・`server/go.sum`で固定する。ActionsもコミットSHAで固定する。

CI用のSupabaseはGitHub runner内に新規作成する。リポジトリのmigrationには固定デモユーザーと非公開Storageバケットの作成が含まれる。接続先はこの一時環境から取得し、未設定ならテスト開始前に失敗させる。実行後は一時環境を破棄する。共有・VPS側のDB接続情報をCIへ設定する必要はない。

統合テストはパッケージごとに順番に実行し、HTTP/WebSocket E2Eのworkerとほかのテストの生成ジョブが干渉することを避ける。Geminiの生成処理はfakeを使う。実LiveKit・実Gemini、WindowsのElectron実機動作は[既知の未確認事項](../README.md#既知の未確認事項)に従って別途検証する。

Supabase起動時の出力にはローカルAPIキーが含まれるため、起動出力はrunner内の一時ファイルへ保存し、ログや成果物として公開しない。起動に失敗した場合はコンテナの稼働状態だけを表示する。Dockerが使えるローカル環境で`npm ci`、`npx --no-install supabase start`を実行して原因を確認する。

GitHubでマージ前にCI成功を必須にする場合は、`dev`・`main`のbranch rulesetに上記3つをrequired status checksとして登録する。ワークフローを追加するだけではマージ制限は有効にならない。

## CD

配置先は現在Goサーバーを実行しているVPSとし、次の既存構成を使う。

| 項目 | 設定 |
| --- | --- |
| OS・CPU | Ubuntu 24.04 LTS、amd64（x86_64） |
| systemdサービス | `mite-api.service` |
| 実行ファイル | `/opt/mite/mite-api` |
| ローカルAPI | `http://127.0.0.1:3000` |

対象ブランチのCIがすべて成功すると、GitHub runnerでLinux amd64向けのGoバイナリをビルドし、SSHでVPSへ送る。VPSでのGoビルドは不要である。対象ブランチはGitHubのRepository variableで指定し、未設定の場合はデプロイしない。PRからのデプロイは実行しない。

デプロイを直列化し、転送前には対象ブランチの最新コミットとCIで検証したコミットが一致することを確認する。古いCIが後から完了しても、古いコミットへ戻さない。VPSでもファイルロックを取得し、同時更新を拒否する。

VPSの[デプロイスクリプト](../server/deploy/mite-deploy.sh)は転送されたバイナリのSHA-256を検証し、直前の実行ファイルを退避してから同じファイルシステム内で置き換える。`mite-api.service`を再起動し、以下が3回連続で成立した場合に成功とする。

- systemdがactiveを返す。
- MainPIDが新しく配置したバイナリを実行している。
- 認証情報を付けない`GET /v1/support-requests`が401を返す。

起動確認は最大30回まで行う。失敗や中断時には退避した実行ファイルを戻し、再起動と起動確認を行う。復元に成功してもGitHubのデプロイ結果は失敗とする。正常に更新できた場合、直前の実行ファイルは`/opt/mite/mite-api.previous`へ1世代だけ残す。

この確認はプロセスとHTTPの起動確認であり、実LiveKit・実Gemini・外部HTTPS/WSS経由のE2Eを保証しない。OS停止や強制終了で復元処理自体を実行できなかった場合は、VPSで手動確認が必要になる。

### 1. VPSへデプロイスクリプトを設置する

初回だけ、レビューした`server/deploy/mite-deploy.sh`をVPSの`/tmp/mite-deploy.sh`などへ転送し、VPS上で次を実行する。スクリプトを更新した場合も再設置する。

```bash
sudo install -o root -g root -m 0755 /tmp/mite-deploy.sh /usr/local/sbin/mite-deploy
```

`/opt/mite`と`/usr/local/sbin/mite-deploy`はrootが管理し、SSHユーザーから書き換えられない状態にする。現在の`/opt/mite/mite-api`はシンボリックリンクではない通常の実行ファイルで、`mite-api.service`が正常稼働している必要がある。VPSにはBash、curl、flock、sha256sum、sudoを使用する。

GitHub Actionsには、使用するSSHユーザーの`authorized_keys`へ公開鍵を登録した、パスフレーズなしのSSH鍵を使う。条件を満たす既存鍵も利用できる。秘密鍵はGitHubのEnvironment secretへ登録し、リポジトリのファイルへ置かない。

SSHユーザーがroot以外の場合は、`sudo visudo -f /etc/sudoers.d/mite-deploy`で次の1コマンドだけをパスワードなしで許可する。`<SSHユーザー>`は実際のユーザー名へ置き換える。

```sudoers
<SSHユーザー> ALL=(root) NOPASSWD: /usr/local/sbin/mite-deploy *
```

`sudo visudo -cf /etc/sudoers.d/mite-deploy`で書式を確認する。このスクリプトは引数を1個のSHA-256に限定し、標準入力からバイナリを受け取り、固定の配置先とサービスだけを操作する。任意の配置パスやシェルコマンドは受け付けない。

### 2. GitHubのEnvironmentと変数を設定する

リポジトリのSettings → Environmentsで`vps-mirai-server`を開き、Deployment branches and tagsを対象ブランチに制限する。次のEnvironment secretsを登録する。

| Secret | 内容 |
| --- | --- |
| `VPS_HOST` | VPSのホスト名またはIPアドレス |
| `VPS_USER` | 上記SSH鍵で接続するユーザー名 |
| `VPS_SSH_KEY` | VPSへ公開鍵を登録済みの、パスフレーズなしのSSH秘密鍵全文 |
| `VPS_KNOWN_HOSTS` | 別経路で確認したVPSのホスト公開鍵を含むknown_hosts形式の行 |

ホスト公開鍵はVPSのコンソールなどで`/etc/ssh/ssh_host_ed25519_key.pub`を確認する。known_hostsは通常`<VPS_HOST> ssh-ed25519 <公開鍵>`の形式、SSHが22番以外なら`[<VPS_HOST>]:<PORT> ssh-ed25519 <公開鍵>`の形式にする。ワークフローは登録済みの鍵との一致を必須とし、実行時に取得した未確認の鍵を自動で信用しない。

Environment variablesには必要に応じて次を登録する。

| Variable | 内容 |
| --- | --- |
| `VPS_SSH_PORT` | SSHポート。省略時は`22` |

Settings → Secrets and variables → Actions → Variablesには、次の**Repository variables**を登録する。ジョブ開始前の判定に使うため、Environment variablesへは置かない。

| Variable | 内容 |
| --- | --- |
| `VPS_DEPLOY_BRANCH` | デプロイ対象の`dev`または`main`。未設定ならデプロイは無効 |
| `VPS_AUTO_DEPLOY` | `true`にすると対象ブランチへのpush後、CI成功時に自動デプロイする。未設定または`false`なら手動実行だけ |

既存のsystemd unit、`/etc/mite/`などに置いた環境変数ファイル、HTTPS/WSSのリバースプロキシ設定はそのまま使う。Supabase・LiveKit・Geminiの秘密情報とデモトークンをGitHubへ追加する必要はない。

### 3. 初回デプロイと通常運用

ワークフローをGitHubへ反映した後、Actions → Server CI/CD → Run workflowから、`VPS_DEPLOY_BRANCH`と同じブランチを選び、`deploy`を有効にして実行する。手動実行ボタンの表示には、ワークフローがリポジトリのデフォルトブランチに存在する必要がある。

初回のCI・デプロイが通ったら、継続的に配置する場合は`VPS_AUTO_DEPLOY=true`にする。`deploy`を有効にしない手動実行はCIのみを行う。

DB migrationはこのCDでは自動適用しない。migrationを含む変更では、既存バイナリとの互換性と実行内容を確認し、対象DBに必要なmigrationを適用してからデプロイする。バイナリの自動復元ではDBスキーマは戻らない。データを削除・不可逆に変更するmigrationは実行前に確認する。

デプロイ後はGoプロセスの再起動によってWebSocket接続が一度切れるため、デモの実施時間と重ならないようにする。クライアントは既存の再接続・GETによる状態復元を使う。

### 手動で直前のバイナリへ戻す

サービスが正常稼働している状態で直前の版へ戻す場合は、VPSで次を実行する。`mite-api.previous`はデプロイ成功時に作られる。

```bash
MITE_PREVIOUS_SHA="$(sudo sha256sum /opt/mite/mite-api.previous)"
MITE_PREVIOUS_SHA="${MITE_PREVIOUS_SHA%% *}"
sudo cat /opt/mite/mite-api.previous | sudo -n /usr/local/sbin/mite-deploy "$MITE_PREVIOUS_SHA"
```

サービス自体が停止している場合は、スクリプトの事前確認で停止する。VPSの管理者が`systemctl status mite-api --no-pager`とログで原因を確認し、退避ファイルからの復元または設定修正を行う。

## ローカル確認

コード生成、テスト、静的解析、ビルドのコマンドは[開発ガイド](development.md#検証)を参照する。DB・StorageとHTTP/WebSocketの確認にはローカルSupabaseと[接続ガイド](server-client-integration.md#8-接続確認)を使う。

デプロイスクリプトのテストはリポジトリルートで`bash server/deploy/test-mite-deploy.sh`を実行する。一時ディレクトリと模擬的なサービス応答を使い、チェックサム不一致、事前の起動確認、更新後の起動失敗、再起動失敗、中断、排他制御、旧バイナリの復元を確認する。実際のVPSやsystemdは変更しない。

## 参考

- [GitHub Actionsのワークフロー構文](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub ActionsのEnvironment secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-an-environment)
- [SupabaseのGitHub Actionsによる自動テスト](https://supabase.com/docs/guides/deployment/ci/testing)
- [Ubuntu 24.04のsystemctl](https://manpages.ubuntu.com/manpages/noble/man1/systemctl.1.html)
- [Ubuntu 24.04のsudoers](https://manpages.ubuntu.com/manpages/noble/man5/sudoers.5.html)
