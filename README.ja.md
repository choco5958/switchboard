<div align="center">

<img src="resources/icon.png" width="112" alt="Switchboard アイコン">

# Switchboard

**複数のコーディングエージェントをひとつの画面で指揮するデスクトップアプリ**

Claude Code、Codex、Gemini CLI のセッションが判断を尋ね、互いに仕事を任せ、席を外している間は Telegram で連絡します。

<a href="https://github.com/choco5958/switchboard/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/choco5958/switchboard?style=flat-square&color=6366f1"></a>
<a href="https://github.com/choco5958/switchboard/actions/workflows/test.yml"><img alt="tests" src="https://img.shields.io/github/actions/workflow/status/choco5958/switchboard/test.yml?branch=main&style=flat-square&label=tests"></a>
<img alt="macOS | Windows | Linux" src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-0f1424?style=flat-square&logo=electron&logoColor=9feaf9">
<a href="LICENSE"><img alt="MIT" src="https://img.shields.io/github/license/choco5958/switchboard?style=flat-square&color=22c55e"></a>

<p><b>ダウンロード</b> &nbsp; <a href="https://github.com/choco5958/switchboard/releases/latest">macOS</a> &nbsp;|&nbsp; <a href="https://github.com/choco5958/switchboard/releases/latest">Windows</a> &nbsp;|&nbsp; <a href="https://github.com/choco5958/switchboard/releases/latest">Linux</a></p>

[한국어](README.md) | [English](README.en.md) | **日本語** | [简体中文](README.zh-CN.md)

</div>

<br>

![ホーム画面: プロジェクト別のタスク、判断待ち、作業ログ](docs/screenshot-home.png)

セッションは人の判断が必要になると質問を判断待ちキューに載せ、答えを待たずにほかの作業を続けます。キーひとつで答えると、その答えがプロンプトとしてセッションに入ります。セッション同士で仕事をやり取りでき、席を外している間は判断の質問と権限の確認が自分の Telegram に届きます。

## ひと目でわかる

<table>
<tr>
<td width="50%" valign="top">
<h3>🗳️ 判断待ちキュー</h3>
<p>セッションは質問を載せたままほかの作業を続けます。キーひとつで答えると、そのセッションにプロンプトとして入ります。</p>
</td>
<td width="50%" valign="top">
<h3>🤝 セッション同士の連携</h3>
<p>ほかのセッションに尋ねて答えを受け取ります。複数のセッションの答えをまとめて入れ、任せた仕事は途中で取り消せます。</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>📱 席を外している間</h3>
<p>判断の質問と Claude Code の権限確認が自分の Telegram に届きます。予約プロンプトは決めた時刻に実行されます。</p>
</td>
<td width="50%" valign="top">
<h3>🔍 画面を見ながら直す</h3>
<p>内蔵ブラウザーで要素をクリックしてコメントを残すと、位置、スクリーンショット、コンソールのエラーが一緒に届きます。セッションはローカルのページを自分で操作して確かめます。</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h3>🧩 さまざまなコーディング CLI</h3>
<p>Codex、Gemini CLI、Qwen Code、Copilot CLI、OpenCode、Goose、Amp も同じ判断待ちと作業報告につながります。</p>
</td>
<td width="50%" valign="top">
<h3>🎨 選べる画面</h3>
<p>テーマ 13 種類と 4 つの言語に対応します。Claude の使用量とコンテキスト使用率を上部に表示します。</p>
</td>
</tr>
</table>

## クイックスタート

1. [Releases](https://github.com/choco5958/switchboard/releases/latest) から OS に合ったインストーラーを入手して開きます。詳しくは[インストール](#インストール)にあります。
2. 下のドックの `+ Claude` でセッションを開き、いつもどおり仕事を任せます。
3. 判断の質問が来たらキーで答えます。あとはセッションが続けます。

## 主な機能

### 判断とタスク

- **判断待ちキュー**: セッションが `ask_decision` で選択肢、おすすめ、その理由を載せます。`a`、`b` などのキーで選び、`Enter` で送ります。保留にしたり、メモを付けて答えたりもできます。同じ質問が二重に載ることはありません。
- **タスクと進行グラフ**: タスクの段階 (要求、設計、作業、完了) とノード (確認、実装、テスト、レビュー) が画面に描かれ、ノードごとに担当のサブエージェントが実行中か終わったかが分かります。
- **あなた待ち**: 判断待ちがある、ターンが 5 分以上止まっている、使用量の上限に達した、セッションが切れた、といったタスクがサイドバーの一番上に集まります。止まったセッションと上限が解除されたセッションは macOS の通知でも知らせます。
- **プロジェクト別の表示**: 左の一覧でフォルダーを選ぶと、画面全体がそのプロジェクトのセッションとタスクだけを表示します。

### セッション同士の連携

- **質問と回答**: セッションが `list_sessions` でほかのセッションを探し、`send_to_session` で依頼を送ります。受け取ったセッションが返事をせずにターンを終えると、最後の回答が結果として戻ります。
- **複数のセッションに聞く**: 複数のセッションに送った質問は、返事を集めてひとつのターンに入れます。その間に人がアプリやターミナルで話しかけると、それまでに届いた返事を一緒に入れます。15 分たつと、先に届いた返事から渡します。
- **返事が来ないとき**: 受け取ったセッションの接続が切れたりターンが中断されたりすると、送ったセッションに返事が来ないことを知らせます。送ったセッションは待たずに作業を続けます。
- **任せた仕事の取り消しと委任の上限**: セッションは `cancel_request` で自分が任せた依頼を取り消します。まだ届いていなければ入らず、受け取ったセッションのターンがその依頼だけを処理していればターンを止めます。ひとつの依頼から始まってセッション同士で任せる依頼は、合わせて 8 回までです。
- **判断の転送**: 判断の質問をほかのセッションに渡し、代わりに答えてもらえます。
- **使用量の上限**: 上限に達したセッションへの答えとメッセージは、リセットされるまで預かってから届けます。

### 席を外している間

- **Telegram で答える**: アプリが閉じている、画面がロックされている、5 分以上入力がない、のいずれかのとき、判断の質問を自分の Telegram ボットに送ります。ボタンか返信で答えます。
- **権限の確認の中継**: 同じ状況では Claude Code の権限の確認もアプリと Telegram に届きます。Telegram で許可するには、もう一度確認のボタンを押します。席にいるときは、これまでどおりターミナルが確認します。
- **予約プロンプト**: 毎日、平日、間隔、1 回から選び、プロジェクトのセッションにプロンプトを送ります。接続中のセッションがなければアプリが `+ Claude` ターミナルを開きます。知らせることのない実行は通知しません。

### 画面を見ながら直す (ライブデバッグ)

- 開発サーバーを登録して起動し、内蔵ブラウザーで開きます。
- 画面の要素をクリックしてコメントを残すと、位置、CSS、スクリーンショット、その時点のページのコンソールエラーと失敗したリクエストが一緒にセッションへ届きます。
- セッションは `browser_*` ツールでローカルのページを読み、クリックし、入力して、直した結果を自分で確かめます。扱えるのはこのコンピューターかプライベートネットワークのアドレスだけです。
- アプリのターミナルで CLI が開くローカルアドレスは内蔵ブラウザーで開きます。

### ターミナルとシェル

- **内蔵ターミナル**: 下のドックの `+ Claude` は mod が接続された Claude Code を、`+ シェル` は通常のシェルを開きます。
- **ほかのコーディング CLI**: Codex、Gemini CLI、Qwen Code、GitHub Copilot CLI、OpenCode、Goose、Amp も判断待ちとタスク報告につながります。アプリが MCP サーバーを起動オプションで付けるので、各 CLI の設定ファイルには手を加えません。Cursor CLI、Grok、Kimi、Crush はターミナルとしてだけ開き、それ以外の CLI は設定でコマンドを登録します。ドックにはインストール済みの CLI だけが並びます。
- **`switchboard` コマンド**: シェルやスクリプトからセッションに仕事を任せ、結果を受け取ります。結果は終了コードでも区別できます。
- **セッション側のパネル**: Claude Code で `/switchboard` と入力すると、このセッションの作業の流れと判断待ちを横のパネルで見られます。

### 表示

- 上部に Claude の 5 時間と週間の使用量、コンテキストの使用率が表示されます。
- 한국어、English、日本語、简体中文に対応しています。最初は OS の言語に従い、設定で切り替えます。
- テーマ 13 種: ベーシック紺、冒険日誌、蛍光ターミナル、ドット絵、地下鉄路線図、回路基板、モダンターミナル、青い DOS 画面、Dracula、Nord、Solarized ダークとライト、GitHub ライト。
- Orca がインストールされていれば、ノードごとにワークツリーを作り、Linear の課題からタスクを始められます。



## 画面

<table>
<tr>
<td width="50%"><img src="docs/screenshot-decision.png" alt="判断待ち: 青い DOS 画面テーマ"><p align="center"><sub>判断待ち: 青い DOS 画面テーマ</sub></p></td>
<td width="50%"><img src="docs/screenshot-task.png" alt="タスク画面: 段階と進行グラフ"><p align="center"><sub>タスク画面: 段階と進行グラフ</sub></p></td>
</tr>
</table>

## 構成

```mermaid
flowchart LR
  cc["Claude Code セッション"] -- "mod: ide-bridge" --> bridge
  cli["Codex、Gemini など"] -- "MCP: mcp/server.ts" --> bridge
  cmd["switchboard コマンド"] --> bridge
  tg["Telegram ボット"] <-->|"long polling"| bridge
  bridge[("ブリッジ<br/>ローカルソケット + SQLite")] <--> app["Switchboard アプリ<br/>Electron"]
```

| フォルダー | 役割 |
| --- | --- |
| `bridge/` | ローカルの中継サーバー。`~/.claude-ide/bridge.sock` ソケットと `~/.claude-ide/ide.db` SQLite を使います。ネットワークのポートは開きません。予約の実行と Telegram との接続もここで動きます。 |
| `mod/` | Claude Code の mod `ide-bridge`。ツールを登録し、アプリからの答えをセッションに入れ、`/switchboard` パネルを描きます。 |
| `mcp/` | ほかのコーディング CLI 向けの MCP サーバー (stdio)。mod と同じツールに `check_answers` を加えて提供します。 |
| `scripts/` | セットアップスクリプトと `switchboard` コマンド。 |
| `src/` | Electron アプリ (React)。 |

## 必要なもの

- macOS、Windows、Linux。macOS (Apple Silicon) で確認済みです。Windows と Linux は自動テストを通過しましたが、実機ではまだ確認していません。
- Claude Code 2.1.309 以上 (mod 機能を使います)
- 任意: Codex、Gemini CLI などのほかのコーディング CLI、Orca (ワークツリー、Linear)、Telegram アカウント
- ソースから動かすときだけ: Node.js 24 以上、pnpm

## インストール

### インストーラー

[Releases](https://github.com/choco5958/switchboard/releases/latest) から自分の OS に合うファイルを取得します。アプリに Node が入っているので、ほかにインストールするものはありません。

| OS | ファイル |
| --- | --- |
| macOS | Apple Silicon は `Switchboard-<バージョン>-mac-arm64.dmg`、Intel は `-mac-x64.dmg` |
| Windows | `Switchboard-<バージョン>-win-x64.exe` (ARM 機は `-win-arm64.exe`) |
| Linux | `.AppImage` (実行権限を付けてそのまま実行) または `.deb` |

まだコード署名をしていないため、初めて開くときに警告が出ます。

- macOS: アプリをアプリケーションフォルダーに移してから右クリック > 開くを選び、表示された画面でもう一度開くを押します。
- Windows: 「Windows によって PC が保護されました」の画面で詳細情報 > 実行を押します。

アプリは起動するたびに、ブリッジの起動ファイルと `switchboard` コマンドを `~/.claude-ide` にアプリの場所に合わせて書き直します。`switchboard` コマンドは macOS と Linux では `~/.local/bin`、Windows では `%USERPROFILE%\.claude-ide\bin` にできるので、そのフォルダーを PATH に加えます。

新しいバージョンはアプリが自分で確認します。Windows と Linux (AppImage) は新しいバージョンをダウンロードしておき、アプリを閉じるときにインストールします。macOS は署名がないと自動インストールできないため、通知を押すとダウンロードページが開きます。

### ソースから動かす

```sh
git clone https://github.com/choco5958/switchboard.git
cd switchboard
pnpm install
pnpm run setup  # ~/.claude-ide/start-bridge.json と ~/.local/bin/switchboard を作ります
pnpm dev        # アプリを起動
```

リポジトリのフォルダーを移動したら `pnpm run setup` をもう一度実行します。インストーラーは `pnpm dist` で作ります。

### ほかのターミナルの Claude Code をつなぐ

アプリの `+ Claude` ターミナルは mod を自動で読み込みます。ほかのターミナルで開いた Claude Code のセッションもつなぐには、Claude Code の入力欄で mod をインストールします。

```
/plugin install ide-bridge --marketplace choco5958/switchboard
```

`Add marketplace?` には `y` を押し、範囲は一番上の user を選びます。シェルからは `claude plugin install ide-bridge --marketplace choco5958/switchboard` でインストールします。

インストール後に開いたセッションからブリッジにつながります。ブリッジが止まっていれば mod かアプリが先に起動します。mod はアプリか `pnpm run setup` が作った `~/.claude-ide/start-bridge.json` でブリッジを起動するので、先にアプリを一度起動するか setup を実行しておいてください。

## 使い方

1. アプリを起動し、下のドックで `+ Claude` を押します。初めてなら左上の `+ フォルダー` で作業するプロジェクトのフォルダーを選びます。
2. いつもどおり Claude Code に仕事を任せます。ツールの説明にいつ使うかが書いてあるので、セッションが自分でタスクを載せ、判断が必要になれば質問を載せます。
3. 左の疑問符アイコンに数字が出たら、判断待ちの質問が届いています。質問を開いてキーで答えます。

### キー

| キー | 動作 |
| --- | --- |
| `a`、`b`、`1`、`2` | 選択肢を選ぶ |
| `Enter` | 送る |
| `H` | 保留 |
| `M` | メモを入力 (`Cmd+Enter` で送る、`Esc` で抜ける) |
| `Cmd+K` | 検索 (タスクを開く、進捗報告を受け取る、などの操作) |

### Telegram の接続

1. Telegram で `@BotFather` に `/newbot` を送り、ボットの名前と ID を決めます。
2. Switchboard の 設定 > Telegram で答える に、BotFather がくれたトークン (`123456:ABC...` の形) を貼り付けて「ボットを接続」を押します。
3. 「接続コードを受け取る」を押し、10 分以内にスマートフォンでリンクを開いて開始を押します。接続されるのはそのチャットだけで、ほかの人からの答えは受け付けません。

ブリッジが Telegram のサーバーに新しいメッセージを自分で問い合わせる方式なので、開けておくポートはありません。

### 予約プロンプト

設定 > 予約プロンプト で名前、プロジェクト、プロンプト、スケジュールを決めます。間隔は 5 分以上です。前回の実行が終わっていなければ今回の実行は飛ばします。アプリやブリッジが止まっていた間に逃した実行を、起動時に 1 回だけ実行するかどうかを選べます。

### シェルコマンド

| コマンド | 内容 |
| --- | --- |
| `switchboard sessions` | セッション一覧 (● 接続中) |
| `switchboard send <セッションかプロジェクト> <仕事 または -> [--wait] [--timeout 30m] [--info] [--json]` | セッションに仕事を任せ、`m7` のような番号を出力します。`--wait` を付けると結果まで待って出力し、`--info` は返事を求めないお知らせとして送ります。`-` は標準入力を読みます。 |
| `switchboard status m7` | 任せた仕事の状態と結果 |
| `switchboard decisions`、`switchboard answer Q12 a [メモ]` | 判断待ちを見て答えます。 |
| `switchboard waits`、`switchboard fire w3 [内容]` | セッションが開いた待機を見て、起こします。 |

終了コード: 0 完了、1 失敗、2 コマンドラインの誤り、3 セッションが判断を待っている、4 時間切れ (セッションは作業を続けます)、5 ブリッジが止まっているかセッションがない。

```sh
# テストが終わったら、その結果を待っていたセッションを起こします
pnpm test; switchboard fire w3 "テスト終了: 終了コード $?"
```

## セッションが使うツール

| ツール | 内容 |
| --- | --- |
| `ask_decision` | 判断待ちキューに質問を載せます。待たずにすぐ戻ります。 |
| `set_task` | タスクを作るか、段階、いまの作業、テスト結果を更新します。 |
| `plan_nodes`、`update_node` | タスクをノードに分けて進行グラフに載せ、状態 (待機、実行中、完了、失敗) を変えます。 |
| `node_worktree` | ノードに Orca のワークツリーを作ります。Orca が必要です。 |
| `open_in_ide` | ライブデバッグのタブでページや開発サーバーを開きます。 |
| `list_sessions`、`send_to_session` | ほかのセッションを見て、依頼や情報を送ります。返事は次のターンに届きます。 |
| `cancel_request` | 自分が任せた依頼を取り消します。受け取ったセッションがその依頼だけを処理していればターンを止めます。 |
| `await_event`、`close_wait` | ビルドやデプロイのような外の作業を待つ待機を開閉します。 |
| `routine_no_update`、`routine_report_failure` | 予約の実行で知らせることがなかった、または失敗したことを記録します。 |
| `browser_snapshot`、`browser_click`、`browser_type`、`browser_navigate`、`browser_console`、`browser_screenshot` | 内蔵ブラウザーのローカルページを読み、操作します。古い ref でクリックしようとすると拒否します。 |
| `check_answers` | ほかのコーディング CLI 向け。アプリの外で動くセッションが、まだ受け取っていない答えを取りに行きます。 |

## データとセキュリティ

- すべてのデータはこのコンピューターの `~/.claude-ide/` の下にだけ保存されます。フォルダーは本人だけが読めて (0700)、ソケットと DB も本人専用です (0600)。
- Telegram を接続すると、判断の質問と権限の確認の内容が Telegram のサーバーを通ります。トークンらしい値は送る前に伏せます。ボットのトークンは画面の状態に載せず、DB にだけ置きます。
- 画面のコメントに付くコンソールとリクエストの記録も、収集する時点でトークンらしい値を伏せます。
- セッションのブラウザーツールが開くのは、このコンピューターとプライベートネットワークのアドレスだけです。
- ブラウザーツールと画面コメントのスクリプトは、ページとは分かれた領域で実行します。ページのスクリプトがクリック位置や読み取る内容を偽ったり、代わりにコメントを保存したりはできません。
- ほかの CLI のターミナルにメッセージを入力する前に画面を確認します。CLI が「このコマンドを実行しますか？」のような確認メニューを出しているあいだは、入力がその選択肢を選ばないよう待ちます。
- 権限の確認への回答、不在の表示、Telegram の設定、予約プロンプト、設定の変更、セッションの操作はアプリだけができます。アプリは OS のキーチェーンで暗号化しておいた鍵を標準入力でブリッジに渡し、これらの経路はその鍵があるときだけ答えます。そのため、シェル権限を持つセッションがブリッジに直接リクエストしても、自分の権限の確認を許可することはできません。mod が先に起動したブリッジは鍵を持たないため、アプリが起動するときに一度起動し直します。
- 判断待ちへの回答、セッションへのメッセージ、待機の解除は `switchboard` コマンドが使う経路なので、同じユーザーのプログラムなら実行できます。エージェントにシェル権限を与えるときは、Claude Code のサンドボックスで `~/.claude-ide` へのアクセスを塞いでおくことをおすすめします。
- セッションが `open_in_ide` で指定した開発サーバーのコマンドは、初めて実行するとき (と変わるたび) に、アプリがコマンドとフォルダーを表示して確認を取ります。
- 遠隔での承認はコマンドを先頭に表示します。全部を表示できない依頼 (切れている、隠れた文字がある、複数か所の編集) はターミナルでだけ確認し、値を伏せた依頼は Telegram からは許可できません。
- Windows ではブリッジは 127.0.0.1 にだけポートを開き、起動のたびに作るトークンを持つリクエストにだけ答えます。Web ページからのリクエストは拒否します。
- 作業ログは 7 日たつと消します。アカウントのメールアドレスは伏せて表示し、どこにも送りません。

## 開発

```sh
pnpm test        # ブリッジ、mod、スクリプト (node:test) と画面ロジック (vitest)
pnpm typecheck
pnpm build && pnpm start
claude plugin test mod
```

テストは実際のアカウントの環境変数を消し、一時的なホームフォルダーで動きます (`scripts/test-env.ts`)。

画面の確認は、実際のデータと切り離したブリッジで行います。macOS はソケットのパスを約 104 バイトに制限するので、短くしておきます。

```sh
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_DB=/tmp/sb/ide.db node bridge/server.ts &
CLAUDE_IDE_SOCKET=/tmp/sb/b.sock CLAUDE_IDE_CAPTURE=/tmp/sb/shot.png pnpm exec electron .
```

`CLAUDE_IDE_CAPTURE` を指定すると、ウィンドウを出さずに画面を PNG に保存して終了します。テーマの追加方法は [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) にあります。アプリのアイコンは `node scripts/icon.mjs` で描き直します。

## ライセンス

[MIT](LICENSE)
