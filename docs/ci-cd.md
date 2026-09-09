# サーバーのCI/CD

[開発ガイド](development.md)へ戻る。

## CI

GitHub Actionsの[Server CI/CD](../.github/workflows/server-ci.yml)で、すべてのPull Request、`dev`・`main`へのpush、手動実行時にサーバー・共有APIとclientの整形を検証する。

| チェック名 | 内容 |
| --- | --- |
| Client formatting | `client/` の `npm run format:check`。LF改行を含むPrettierの整形規則を検証 |
| Generated code and shared API | OpenAPI・sqlcの再生成、コミット済み生成物との一致、新規生成ファイルの追跡漏れ、共有APIの型チェック・Lint・ビルド |
| Go tests and build | gofmt、race検査付きテスト、go vet、ビルド、DB適用とVPS更新の順序・失敗時の停止、VPSデプロイ・復元スクリプトのテスト |
| Supabase integration and HTTP WebSocket E2E | 一時的なSupabaseへのmigration適用、DB・Storage統合テスト、HTTP/WebSocket E2E |

Goは`server/go.mod`のバージョン、Node.jsは24を使う。npm依存関係はルートの`package-lock.json`と`client/package-lock.json`、Goツールは`server/go.mod`・`server/go.sum`で固定する。ActionsもコミットSHAで固定する。

clientの整形ジョブは`client/`で`npm ci --ignore-scripts`を実行する。整形にはElectron本体やネイティブmoduleのインストール処理は不要なため、これらのスクリプトを省略する。clientのLint・型チェック・テスト・ビルドはこのジョブの対象に含まれず、[開発ガイド](development.md#electronクライアント)に従って別途実行する。整形ジョブもデプロイの成功条件に含める。

CI用のSupabaseはGitHub runner内に新規作成する。リポジトリのmigrationには固定デモユーザーと非公開Storageバケットの作成が含まれる。接続先はこの一時環境から取得し、未設定ならテスト開始前に失敗させる。実行後は一時環境を破棄する。共有・VPS側のDB接続情報をCIへ設定する必要はない。

統合テストはパッケージごとに順番に実行し、HTTP/WebSocket E2Eのworkerとほかのテストの生成ジョブが干渉することを避ける。Geminiの生成処理はfakeを使う。実LiveKit・実Gemini、WindowsのElectron実機動作は[既知の未確認事項](../README.md#既知の未確認事項)に従って別途検証する。

Supabase起動時の出力にはローカルAPIキーが含まれるため、起動出力はrunner内の一時ファイルへ保存し、ログや成果物として公開しない。起動に失敗した場合はコンテナの稼働状態だけを表示する。Dockerが使えるローカル環境で`npm ci`、`npx --no-install supabase start`を実行して原因を確認する。

GitHubでマージ前にCI成功を必須にする場合は、`dev`・`main`のbranch rulesetに上記4つをrequired status checksとして登録する。既存の3つを登録済みの場合も`Client formatting`の追加が必要になる。ワークフローを追加するだけではマージ制限は有効にならない。

## CD

配置先は現在Goサーバーを実行しているVPSとし、次の既存構成を使う。

| 項目 | 設定 |
| --- | --- |
| OS・CPU | Ubuntu 24.04 LTS、amd64（x86_64） |
| systemdサービス | `mite-api.service` |
| 実行ファイル | `/opt/mite/mite-api` |
| ローカルAPI | `http://127.0.0.1:3000` |

対象ブランチのCIがすべて成功すると、`Migrate Supabase and deploy to VPS`ジョブで次を順に実行する。対象ブランチはGitHubのRepository variableで指定し、未設定の場合はデプロイしない。PRからのデプロイは実行しない。

1. GitHub runnerでLinux amd64向けのGoバイナリをビルドする。
2. SSH接続、VPSのデプロイスクリプト、リリース設定の読込指定、稼働中サービス、デプロイ用sudo権限を確認する。
3. Supabase Cloudへ`supabase db push --dry-run`で接続し、マイグレーション履歴の整合性と適用予定を確認する。
4. `supabase db push --yes`で未適用のマイグレーションを適用する。接続先は`SUPABASE_DB_URL`で指定する。
5. 成功した場合だけGoバイナリと対応するプロンプト版をSSHでVPSへ送り、既存サービスを更新する。

[CI用デプロイスクリプト](../server/deploy/deploy-from-ci.sh)がこの順序を制御する。Supabase CLIは既存の`package-lock.json`に固定したバージョンを使い、VPSにはNode.jsやSupabase CLIを追加しない。両方の`db push`に`--skip-vault`を指定し、Vaultの同期は行わない。`--include-seed`、`--include-roles`、`--include-all`は指定しない。初期マイグレーション内の固定デモユーザーとStorageバケット作成は適用対象に含まれる。

DB適用からVPS更新までを同じジョブのconcurrencyで直列化する。開始時、DB適用直前、VPS転送直前には対象ブランチの最新コミットとCIで検証したコミットが一致することを確認する。古いCIが後から完了した場合は残りの処理をスキップする。DB適用中に新しいコミットが追加された場合、DB変更は残り、古いバイナリの転送はスキップする。VPSでもファイルロックを取得し、同時更新を拒否する。

プロンプト版はバイナリと同じコミットの[リリース設定](../server/deploy/mite-api.env)から取得する。`AI_PROMPT_VERSION`を変更する際は、このファイルも同じPRで更新する。Goテストで`GeminiPromptVersion`との一致を必須にする。サーバー側の版の厳密な検証は維持する。

VPSの[デプロイスクリプト](../server/deploy/mite-deploy.sh)は転送されたバイナリのSHA-256を検証し、直前の実行ファイルとリリース設定を退避してから置き換える。プロンプト版だけを`/opt/mite/mite-api.env`へ書き、systemdの`EnvironmentFile`から読み込ませる。この環境変数はGoが読む既存の`.env`より優先される。既存の`.env`、APIキー、トークンは変更・転送しない。`mite-api.service`を再起動し、以下が3回連続で成立した場合に成功とする。

- systemdがactiveを返す。
- MainPIDが新しく配置したバイナリを実行している。
- 認証情報を付けない`GET /v1/support-requests`が401を返す。

起動確認は最大30回まで行う。失敗や中断時には退避した実行ファイルとリリース設定を戻し、再起動と起動確認を行う。初回更新前にリリース設定ファイルがなければ、復元時には新しく作ったファイルを削除し、元の`.env`の設定へ戻す。復元に成功してもGitHubのデプロイ結果は失敗とする。正常に更新できた場合、直前の実行ファイルは`/opt/mite/mite-api.previous`へ1世代だけ残す。手動復元時は、そのバイナリに対応するプロンプト版を指定する。

この確認はプロセスとHTTPの起動確認であり、実LiveKit・実Gemini・外部HTTPS/WSS経由のE2Eを保証しない。OS停止や強制終了で復元処理自体を実行できなかった場合は、VPSで手動確認が必要になる。

### 1. VPSへデプロイスクリプトを設置する

初回だけ、レビューした`server/deploy/mite-deploy.sh`と`server/deploy/50-mite-deploy.conf`をそれぞれVPSの`/tmp/mite-deploy.sh`、`/tmp/50-mite-deploy.conf`などへ転送し、VPS上で次を実行する。スクリプトや読込指定を更新した場合も再設置する。

```bash
sudo install -o root -g root -m 0755 /tmp/mite-deploy.sh /usr/local/sbin/mite-deploy
sudo install -d -o root -g root -m 0755 /etc/systemd/system/mite-api.service.d
sudo install -o root -g root -m 0644 /tmp/50-mite-deploy.conf /etc/systemd/system/mite-api.service.d/50-mite-deploy.conf
sudo systemctl daemon-reload
sudo -n /usr/local/sbin/mite-deploy --check
```

**バイナリだけを転送していた旧CDから移行する場合も、マージしてデプロイする前に上記の設置が必要になる。** `50-mite-deploy.conf`は`EnvironmentFile=-/opt/mite/mite-api.env`を追加する。ファイルがない間は既存の`.env`を使い続けるため、この設置ではサービスの再起動やプロンプト版の変更を行わない。リリース設定を手動でv2に書き換えると稼働中の旧バイナリの再起動を妨げるので、最初の設定ファイルの作成もCDに任せる。

`--check`は読込指定と稼働中サービスだけを確認し、DB・バイナリ・設定を更新しない。旧スクリプトが残っている場合や読込指定がない場合は、CIの事前確認でDB適用より前に停止する。別の`EnvironmentFile`がある場合、このリリース設定を最後に読み込むことを確認する。

`/opt/mite`と`/usr/local/sbin/mite-deploy`はrootが管理し、SSHユーザーから書き換えられない状態にする。現在の`/opt/mite/mite-api`はシンボリックリンクではない通常の実行ファイルで、`mite-api.service`が正常稼働している必要がある。VPSにはBash、curl、flock、sha256sum、sudoを使用する。

GitHub Actionsには、使用するSSHユーザーの`authorized_keys`へ公開鍵を登録した、パスフレーズなしのSSH鍵を使う。条件を満たす既存鍵も利用できる。秘密鍵はGitHubのEnvironment secretへ登録し、リポジトリのファイルへ置かない。

SSHユーザーがroot以外の場合は、`sudo visudo -f /etc/sudoers.d/mite-deploy`で次の1コマンドだけをパスワードなしで許可する。`<SSHユーザー>`は実際のユーザー名へ置き換える。

```sudoers
<SSHユーザー> ALL=(root) NOPASSWD: /usr/local/sbin/mite-deploy *
```

`sudo visudo -cf /etc/sudoers.d/mite-deploy`で書式を確認する。このスクリプトはSHA-256と`v2`などのプロンプト版、または読取専用の`--check`だけを受け付ける。更新時は標準入力からバイナリを受け取り、固定の配置先・リリース設定・サービスだけを操作する。任意の環境変数、配置パス、シェルコマンドは受け付けない。既存の上記sudoers規則はそのまま使える。

### 2. GitHubのEnvironmentと変数を設定する

リポジトリのSettings → Environmentsで`vps-mirai-server`を開き、Deployment branches and tagsを対象ブランチに制限する。次のEnvironment secretsを登録する。

| Secret | 内容 |
| --- | --- |
| `VPS_HOST` | VPSのホスト名またはIPアドレス |
| `VPS_USER` | 上記SSH鍵で接続するユーザー名 |
| `VPS_SSH_KEY` | VPSへ公開鍵を登録済みの、パスフレーズなしのSSH秘密鍵全文 |
| `VPS_KNOWN_HOSTS` | 別経路で確認したVPSのホスト公開鍵を含むknown_hosts形式の行 |
| `SUPABASE_DB_URL` | VPSのGoサーバーと同じSupabase Cloudを指す、マイグレーション権限のあるPostgreSQL接続文字列 |

`SUPABASE_DB_URL`はSupabase DashboardのConnectからSession poolerの接続文字列を取得し、5432番と`sslmode=require`を使う。パスワードに特殊文字がある場合はURLエンコードする。形式は`postgresql://postgres.<project-ref>:<encoded-password>@<pooler-host>:5432/postgres?sslmode=require`である。ローカルSupabaseの54322番やTransaction poolerの6543番を指定しない。DBパスワードを変更した場合は、VPSの接続設定とこのSecretを両方更新する。

この方式は`--db-url`でDBへ接続するため、SupabaseのアクセストークンやStorage用Secret keyをGitHubへ追加する必要はない。接続文字列はGitHubのEnvironment secretへ保存し、リポジトリやログには出力しない。

ホスト公開鍵はVPSのコンソールなどで`/etc/ssh/ssh_host_ed25519_key.pub`を確認する。known_hostsは通常`<VPS_HOST> ssh-ed25519 <公開鍵>`の形式、SSHが22番以外なら`[<VPS_HOST>]:<PORT> ssh-ed25519 <公開鍵>`の形式にする。ワークフローは登録済みの鍵との一致を必須とし、実行時に取得した未確認の鍵を自動で信用しない。

Environment variablesには必要に応じて次を登録する。

| Variable | 内容 |
| --- | --- |
| `VPS_SSH_PORT` | SSHポート。省略時は`22` |

Settings → Secrets and variables → Actions → Variablesには、次の**Repository variables**を登録する。ジョブ開始前の判定に使うため、Environment variablesへは置かない。

| Variable | 内容 |
| --- | --- |
| `VPS_DEPLOY_BRANCH` | DB適用とVPS更新の対象にする`dev`または`main`。未設定ならデプロイは無効 |
| `VPS_AUTO_DEPLOY` | `true`にすると対象ブランチへのpush後、CI成功時にDB適用とVPS更新を自動実行する。未設定または`false`なら手動実行だけ |

既存のsystemd unitに上記のリリース設定の読込指定を追加する。`/etc/mite/`などに置いた既存の環境変数ファイルとHTTPS/WSSのリバースプロキシ設定はそのまま使う。LiveKit・Geminiの秘密情報とデモトークンをGitHubへ追加する必要はない。

### 3. 初回デプロイと通常運用

ワークフローをGitHubへ反映した後、Actions → Server CI/CD → Run workflowから、`VPS_DEPLOY_BRANCH`と同じブランチを選び、`deploy`を有効にして実行する。手動実行ボタンの表示には、ワークフローがリポジトリのデフォルトブランチに存在する必要がある。

初回のCI・デプロイが通ったら、継続的に配置する場合は`VPS_AUTO_DEPLOY=true`にする。`deploy`を有効にしない手動実行はCIのみを行う。

デフォルトブランチへワークフローをまだ反映していない場合は、pushによる実行も使える。必要なSecretsとVPS設定を整え、このCDの変更を対象ブランチへ反映した後、`VPS_AUTO_DEPLOY=true`にする。以降の対象ブランチへのpushで、CI成功後にDB適用とVPS更新が実行される。

初回実行前に、適用済みマイグレーションの履歴とリポジトリのSQLが一致することを確認する。履歴不一致やSQLエラーでdry-runまたは適用に失敗した場合、VPSは更新しない。CI上で`migration repair`やDBのresetを自動実行して解消しない。

マイグレーションは稼働中および復元対象の旧バイナリとも互換性を保つ。DB適用後にVPS更新が失敗しても、バイナリの自動復元ではDBスキーマは戻らない。マイグレーション途中で失敗した場合も、それ以前に適用済みの変更は残るため、適用履歴を確認してから再実行する。データを削除・不可逆に変更するマイグレーションは実行前に確認し、自動デプロイを有効にしたまま未確認の変更を対象ブランチへ入れない。

デプロイ後はGoプロセスの再起動によってWebSocket接続が一度切れるため、デモの実施時間と重ならないようにする。クライアントは既存の再接続・GETによる状態復元を使う。

### 手動で直前のバイナリへ戻す

サービスが正常稼働している状態で直前の版へ戻す場合は、VPSで次を実行する。`mite-api.previous`はデプロイ成功時に作られる。

`MITE_PREVIOUS_PROMPT_VERSION`には、戻すバイナリのコミットの`server/internal/service/gemini.go`にある`GeminiPromptVersion`を指定する。以下は複数ガイド対応前のv1へ戻す例であり、v2のバイナリへ戻す場合はv2にする。現在の設定をそのまま流用しない。

```bash
MITE_PREVIOUS_SHA="$(sudo sha256sum /opt/mite/mite-api.previous)"
MITE_PREVIOUS_SHA="${MITE_PREVIOUS_SHA%% *}"
MITE_PREVIOUS_PROMPT_VERSION=v1
sudo cat /opt/mite/mite-api.previous | sudo -n /usr/local/sbin/mite-deploy "$MITE_PREVIOUS_SHA" "$MITE_PREVIOUS_PROMPT_VERSION"
```

サービス自体が停止している場合は、スクリプトの事前確認で停止する。VPSの管理者が`systemctl status mite-api --no-pager`とログで原因を確認し、退避ファイルからの復元または設定修正を行う。

## ローカル確認

コード生成、テスト、静的解析、ビルドのコマンドは[開発ガイド](development.md#検証)を参照する。DB・StorageとHTTP/WebSocketの確認にはローカルSupabaseと[接続ガイド](server-client-integration.md#8-接続確認)を使う。

デプロイスクリプトのテストはリポジトリルートで`bash server/deploy/test-mite-deploy.sh`を実行する。一時ディレクトリと模擬的なサービス応答を使い、チェックサム不一致、事前の起動確認、更新後の起動失敗、再起動失敗、中断、排他制御、旧バイナリの復元を確認する。実際のVPSやsystemdは変更しない。

旧バイナリはv1、新バイナリはv2の設定がなければ起動できない条件で検証する。リリース設定の初回作成・更新、設定配置の失敗、設定ファイルがなかった状態への復元、systemdの読込指定不足も確認する。

`bash server/deploy/test-deploy-from-ci.sh`でCDの制御も確認する。GitHub・Supabase・SSHを模擬し、設定不足、古いコミット、SSH事前確認の失敗、dry-run失敗、マイグレーション失敗、VPS更新失敗を再現する。DB適用より前にVPSを更新しないこと、失敗後の処理を止めること、一時SSH鍵を削除することを検証する。

## 参考

- [GitHub Actionsのワークフロー構文](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub ActionsのEnvironment secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets#creating-secrets-for-an-environment)
- [SupabaseのGitHub Actionsによる自動テスト](https://supabase.com/docs/guides/deployment/ci/testing)
- [Supabase CLIのdb push](https://supabase.com/docs/reference/cli/supabase-db-push)
- [Ubuntu 24.04のsystemctl](https://manpages.ubuntu.com/manpages/noble/man1/systemctl.1.html)
- [systemdのEnvironmentFile](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=)
- [Ubuntu 24.04のsudoers](https://manpages.ubuntu.com/manpages/noble/man5/sudoers.5.html)
