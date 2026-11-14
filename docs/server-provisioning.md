# VPSの新規構築・移行

[MiteのCI/CD](ci-cd.md)へ戻る。

新しいVPSへ、MiteのGo APIと家族向けPWAの公開環境を一から構築する手順である。既存VPSの更新は[MiteのCI/CD](ci-cd.md)の自動デプロイを使う。CDは「`mite-api.service`が稼働しているVPS」を前提とするため、新しいVPSでは本書の手順で最初の1回を手動で起動してからCDへ引き継ぐ。

## 構成

DB・画像はSupabase Cloud、音声・画面共有はLiveKit Cloud、ガイド生成はGemini APIを使う。いずれもVPSの外にあるため、VPSを作り直してもデータは失われない。VPSに置くのは次のファイルだけである。

| VPS上のパス | 内容 | 元になるファイル・作り方 |
| --- | --- | --- |
| `/etc/systemd/system/mite-api.service` | APIのsystemd unit | [`server/deploy/mite-api.service`](../server/deploy/mite-api.service) |
| `/etc/systemd/system/mite-api.service.d/50-mite-deploy.conf` | CDのリリース設定の読込指定 | [`server/deploy/50-mite-deploy.conf`](../server/deploy/50-mite-deploy.conf) |
| `/etc/mite/.env` | サーバー環境変数（秘密情報を含む） | [`server/.env.example`](../server/.env.example)を元に作成。Git管理外 |
| `/opt/mite/mite-api` | Goバイナリ | 初回は手動でbuild、以降はCD |
| `/opt/mite/mite-api.env` | プロンプト版 | CDが作成・更新 |
| `/usr/local/sbin/mite-deploy` | APIのデプロイスクリプト | [`server/deploy/mite-deploy.sh`](../server/deploy/mite-deploy.sh) |
| `/usr/local/bin/mite-pwa-deploy` | PWAのデプロイスクリプト | [`server/deploy/mite-pwa-deploy.sh`](../server/deploy/mite-pwa-deploy.sh) |
| `/etc/sudoers.d/mite-deploy` | CD用のsudo権限 | 本書の第6項 |
| `/etc/apache2/sites-available/mite-http.conf` | HTTP VirtualHost（証明書取得用） | [`server/deploy/apache-mite-http.conf.example`](../server/deploy/apache-mite-http.conf.example) |
| `/etc/apache2/sites-available/mite-https.conf` | HTTPS VirtualHost（APIのリバースプロキシ） | [`server/deploy/apache-mite-https.conf.example`](../server/deploy/apache-mite-https.conf.example) |
| `/etc/apache2/mite-family-pwa.conf` | PWAのAlias・ヘッダー | [`server/deploy/apache-family-pwa.conf.example`](../server/deploy/apache-family-pwa.conf.example) |
| `/etc/letsencrypt/live/priv.chi-llenge.com/` | TLS証明書 | certbot |
| `/var/www/mite-public` | DocumentRoot・certbotのwebroot | 空のdirectory |
| `/var/www/mite-family-pwa` | PWAのrelease | CD |

## 0. 移行前に旧VPSで控えるもの

旧VPSから移行する場合、**`/etc/mite/.env`はVPS上にしか存在しない**。旧VPSを削除する前に、内容をパスワードマネージャーなどの安全な場所へ控える。Gitやチャットへは貼らない。

```bash
sudo cat /etc/mite/.env
```

| 設定 | 失った場合の影響 |
| --- | --- |
| `WEB_PUSH_VAPID_PUBLIC_KEY`・`WEB_PUSH_VAPID_PRIVATE_KEY` | 作り直すと既存のPush購読が無効になり、家族がPWAで通知を再登録する必要がある |
| `DEMO_USER_TOKEN`・`DEMO_FAMILY_TOKEN` | 作り直すと配布済みElectronの`.env.local`とPWAに保存したトークンを更新する必要がある |
| `DATABASE_URL`・`SUPABASE_URL`・`SUPABASE_SECRET_KEY` | Supabase Dashboardから再取得・再発行できる |
| `LIVEKIT_*`・`GEMINI_API_KEY` | 各サービスのDashboardから再発行できる |

移行作業中はRepository variableの`VPS_AUTO_DEPLOY`を`false`にし、旧VPSへの自動デプロイを止める。DNSを切り替える場合は、事前にTTLを短くしておく。

## 1. 前提

- Ubuntu 24.04 LTS以降、amd64（x86_64）。Ubuntu 24.04と26.04で稼働実績がある。
- `priv.chi-llenge.com`のAレコードが新しいVPSのIPアドレスを指していること。certbotのHTTP-01認証に必要。
- sudoできる管理ユーザーで、SSH鍵によりログインできること。
- 以降のコマンドは、デプロイ対象ブランチをcloneしたリポジトリルートで実行する。VPS上でcloneしない場合は、使用するファイルを`/tmp`などへ転送してパスを読み替える。

別ドメインで構築する場合は、先に[別ドメインで構築する場合](#別ドメインで構築する場合)の箇所を変更したcommitを用意する。

## 2. パッケージとファイアウォール

```bash
sudo apt update
sudo apt install -y apache2 certbot curl
```

Bash、flock、sha256sum、sudoはUbuntuの標準パッケージに含まれる。VPSにNode.js、Supabase CLI、Dockerは不要。

Goサーバーは全インターフェースの3000番で待ち受ける。Apacheを経由しない直接アクセスを防ぐため、ufwでSSH・HTTP・HTTPSだけを許可する。SSH接続が切れないよう、`OpenSSH`を許可してから有効にする。

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Apache Full'
sudo ufw enable
sudo ufw status verbose
```

`3000`が許可一覧に含まれていないことを確認する。VPS事業者のファイアウォール（セキュリティグループ）がある場合も、22・80・443番だけを開ける。

## 3. 実行ユーザーと環境変数

APIはログインできないシステムユーザー`mite`で実行する。

```bash
id -u mite >/dev/null 2>&1 || sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin mite
sudo install -d -o root -g mite -m 0750 /etc/mite
sudo install -o root -g mite -m 0640 server/.env.example /etc/mite/.env
sudoedit /etc/mite/.env
```

旧VPSから控えた内容がある場合は、`server/.env.example`の代わりにそれを書き込む。新規に作る場合は次の値を本番用に設定する。書式は[サーバー設定の補足](setup.md#envの書式)に従う。

| 設定 | 本番の値 |
| --- | --- |
| `MITE_ENV` | `production` |
| `DATABASE_URL` | Supabase DashboardのConnectで取得したPostgreSQL接続文字列 |
| `SUPABASE_URL`・`SUPABASE_SECRET_KEY` | Supabase DashboardのProject URLとSecret key |
| `SUPABASE_STORAGE_BUCKET` | `mite-artifacts` |
| `DEMO_USER_TOKEN`・`DEMO_FAMILY_TOKEN` | 互いに異なる推測困難な値 |
| `LIVEKIT_URL`・`LIVEKIT_API_KEY`・`LIVEKIT_API_SECRET` | LiveKit Cloudの値 |
| `AI_PROVIDER`・`GEMINI_API_KEY`・`AI_MODEL` | `gemini`と有効なキー・モデル |
| `AI_PROMPT_VERSION` | [`server/deploy/mite-api.env`](../server/deploy/mite-api.env)と同じ版。CD後は`/opt/mite/mite-api.env`の値が優先される |
| `CLIENT_ORIGINS` | 既存値へ`https://priv.chi-llenge.com`を追加する |
| `WEB_PUSH_*` | 3項目すべて。新規なら`cd server && go run ./cmd/vapid-keygen`で生成する |

systemd unitの`WorkingDirectory=/etc/mite`により、Goサーバーは`/etc/mite/.env`を読み込む。`mite`ユーザーは読み取りだけでき、書き込みはできない。

## 4. 初回バイナリとsystemd

CDの事前確認は稼働中の`mite-api.service`を必要とするため、初回だけGo 1.26系でバイナリをbuildして配置する。CIと同じ設定で、デプロイ対象ブランチの最新commitからbuildする。

```bash
cd server
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/mite-api ./cmd/api
cd ..
```

別のPCでbuildした場合は、`/tmp/mite-api`をVPSへ転送する。

```bash
sudo install -d -o root -g root -m 0755 /opt/mite
sudo install -o root -g root -m 0755 /tmp/mite-api /opt/mite/mite-api
sudo install -o root -g root -m 0644 server/deploy/mite-api.service /etc/systemd/system/mite-api.service
sudo install -d -o root -g root -m 0755 /etc/systemd/system/mite-api.service.d
sudo install -o root -g root -m 0644 server/deploy/50-mite-deploy.conf /etc/systemd/system/mite-api.service.d/50-mite-deploy.conf
sudo systemd-analyze verify /etc/systemd/system/mite-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now mite-api.service
```

**新しいSupabaseプロジェクトを使う場合は、サービスを起動する前にマイグレーションを適用する。** Goサーバーは起動直後にバックグラウンド処理でテーブルを参照するため、テーブルがないと`STARTUP_FAILED`で停止する。CDは稼働中のサービスを確認してからマイグレーションを適用するため、この初回適用はCDでは行えない。既存のSupabaseプロジェクトを引き継ぐ移行では不要。

Node.js 24がある作業PCのリポジトリルートで、CDと同じオプションを使って適用する。`SUPABASE_DB_URL`には[CI/CDの第3項](ci-cd.md#3-githubのenvironmentと変数を設定する)と同じSession poolerの接続文字列を使う。

```bash
npm ci
read -r -s -p 'SUPABASE_DB_URL: ' SUPABASE_DB_URL; echo
export SUPABASE_DB_URL
npx --no-install supabase db push --db-url "$SUPABASE_DB_URL" --skip-vault --dry-run
npx --no-install supabase db push --db-url "$SUPABASE_DB_URL" --skip-vault --yes
unset SUPABASE_DB_URL
```

起動時にはDBへの接続も確認するため、`DATABASE_URL`へ接続できない場合も起動に失敗する。次の確認で`401`が返れば起動している。

```bash
systemctl is-active mite-api.service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/v1/support-requests
sudo journalctl -u mite-api -n 50 --no-pager
```

`STARTUP_FAILED`で停止した場合は、ログのほか、Supabase DashboardのPostgresログで`relation ... does not exist`が出ていないかを確認する。出ている場合は、上記のマイグレーション適用が済んでいない。

## 5. Apacheと証明書

必要なモジュールを有効にし、HTTPのVirtualHostで証明書を取得する。

```bash
sudo a2enmod ssl proxy proxy_http headers alias
sudo install -d -o root -g root -m 0755 /var/www/mite-public
sudo install -o root -g root -m 0644 server/deploy/apache-mite-http.conf.example /etc/apache2/sites-available/mite-http.conf
sudo a2ensite mite-http
sudo apache2ctl configtest
sudo systemctl reload apache2
```

```bash
sudo certbot certonly --webroot -w /var/www/mite-public \
  -d priv.chi-llenge.com --cert-name priv.chi-llenge.com \
  --deploy-hook 'systemctl reload apache2'
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

証明書の取得後に、PWAとAPIを含むHTTPSのVirtualHostを有効にする。HTTPS側は`/etc/apache2/mite-family-pwa.conf`を読み込むため、先にPWA設定を配置する。

```bash
sudo install -o root -g root -m 0644 server/deploy/apache-family-pwa.conf.example /etc/apache2/mite-family-pwa.conf
sudo install -o root -g root -m 0644 server/deploy/apache-mite-https.conf.example /etc/apache2/sites-available/mite-https.conf
sudo a2ensite mite-https
sudo apache2ctl configtest
sudo systemctl reload apache2
curl -s -o /dev/null -w '%{http_code}\n' https://priv.chi-llenge.com/mite/v1/support-requests
```

`401`が返れば、HTTPS経由でAPIへ到達している。PWAの`/mite/pwa/`は初回デプロイまで404になる。

## 6. CD用のSSHユーザーとデプロイスクリプト

GitHub ActionsがSSHで接続するユーザー（GitHubの`VPS_USER`）を決める。管理ユーザーと兼ねてもよい。

1. パスフレーズなしのSSH鍵を作り、公開鍵をそのユーザーの`~/.ssh/authorized_keys`へ登録する。秘密鍵はGitHubのEnvironment secret `VPS_SSH_KEY`だけに保存し、VPSやリポジトリに残さない。
2. [CI/CDの第1項](ci-cd.md#1-vpsへデプロイスクリプトを設置する)の手順で`/usr/local/sbin/mite-deploy`を設置し、`/etc/sudoers.d/mite-deploy`でそのユーザーに`mite-deploy`だけを許可する。`sudo -n /usr/local/sbin/mite-deploy --check`が成功することを確認する。
3. [CI/CDの第2項](ci-cd.md#2-家族向けpwaの初回vpsapache設定)の手順で`/usr/local/bin/mite-pwa-deploy`と`/var/www/mite-family-pwa/releases`を作成する。新しいVPSでは「既存の手動配置を引き継ぐ場合」は不要。Apache設定は第5項で配置済みのため、同項の`--check`による事前確認だけを行う。

## 7. GitHubの設定更新と初回デプロイ

Settings → Environments → `vps-mirai-server`のEnvironment secretsを新しいVPSの値へ更新する。

| Secret | 更新内容 |
| --- | --- |
| `VPS_HOST` | 新しいVPSのホスト名またはIPアドレス |
| `VPS_KNOWN_HOSTS` | 新しいVPSの`/etc/ssh/ssh_host_ed25519_key.pub`から作った行 |
| `VPS_USER`・`VPS_SSH_KEY` | 第6項で決めたユーザーと秘密鍵 |
| `SUPABASE_DB_URL` | Supabaseプロジェクトを変えた場合だけ更新する |

形式は[CI/CDの第3項](ci-cd.md#3-githubのenvironmentと変数を設定する)を参照する。SSHポートを変えた場合は`VPS_SSH_PORT`も更新する。

Actions → Mite CI/CD → Run workflowから、`VPS_DEPLOY_BRANCH`と同じブランチで`deploy`を有効にして実行する。成功後に次を確認する。

- `https://priv.chi-llenge.com/mite/pwa/`でPWAが表示され、家族用トークンで接続状況を取得できる。
- 利用者側・家族側のElectronが`https://priv.chi-llenge.com/mite`へ接続し、WebSocketの再接続後も状態が復元される。
- `sudo cat /opt/mite/mite-api.env`がリポジトリの`server/deploy/mite-api.env`と一致する。

確認後、継続的に配置する場合は`VPS_AUTO_DEPLOY=true`に戻す。

## 8. 旧VPSを停止する

新しいVPSで第7項の確認が済み、DNSの切り替えが反映された後に、旧VPSのMiteを停止する。DNSが旧VPSを指したままの間は停止しない。

```bash
sudo systemctl disable --now mite-api.service
sudo a2dissite mite-https mite-http
sudo systemctl reload apache2
sudo certbot delete --cert-name priv.chi-llenge.com
```

DNSの切り替え後は、旧VPSでの証明書更新が失敗し続けるため、証明書も削除する。データはSupabase Cloudにあるため、旧VPSのファイルを削除してもDBとStorageは変わらない。`/etc/mite/.env`を控えたことを確認してから、[構成](#構成)の表にあるファイル、`mite`ユーザーと、デプロイ用の`authorized_keys`の公開鍵を削除する。

## 別ドメインで構築する場合

公開URLは現在`https://priv.chi-llenge.com/mite`に固定している。別ドメインで構築する場合は、次の箇所を同じcommitで変更してからCIを通す。

| ファイル | 変更箇所 |
| --- | --- |
| `.github/workflows/server-ci.yml` | 2か所の`VITE_API_BASE_URL` |
| `server/deploy/mite-pwa-deploy.sh` | `mite_pwa_public_url`、`mite_pwa_api_probe`、`mite_pwa_origin` |
| `client/scripts/build-family-pwa.test.ts` | `apiBaseUrl` |
| `server/deploy/apache-mite-http.conf.example`・`apache-mite-https.conf.example` | `ServerName`と証明書のパス |
| `/etc/mite/.env`（VPS） | `CLIENT_ORIGINS`へ追加するOrigin |

`mite-pwa-deploy.sh`を変更した場合は、VPSのスクリプトも再設置する。certbotの`-d`と`--cert-name`も新しいドメインにする。
