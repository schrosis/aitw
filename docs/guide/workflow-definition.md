# ワークフローの定義

ワークフローは、YAML のファイルに定義します。定義には、最初に実行するステップと、ステップの一覧を書きます。各ステップには、次に進むステップを書きます。

## 最小の定義

```yaml
version: v0.1
start: hello
steps:
  hello:
    type: script
    run: echo hello
    next: end
```

この定義は、`hello` ステップで `echo hello` を実行し、終わります。

## 最上位の項目

| 項目      | 必須 | 内容                                                       |
| --------- | ---- | ---------------------------------------------------------- |
| `version` | はい | 定義の形式の版です。`v0.1` だけを受け付けます              |
| `start`   | はい | 最初に実行するステップの ID です                           |
| `steps`   | はい | ステップの一覧です。キーがステップの ID、値がステップです  |

ほかの項目は、それぞれを説明する節で扱います。

## ステップの ID

ステップの ID は、英字で始め、英字、数字、`_` だけで書きます。`start` と `end` は予約語のため、ステップの ID には使えません。

`next` に `end` を書くと、そのステップでワークフローが終わります。

## script ステップ

`type: script` のステップは、`run` に書いたコマンドを実行します。

| 項目      | 必須   | 内容                                                                 |
| --------- | ------ | -------------------------------------------------------------------- |
| `type`    | はい   | `script` です                                                        |
| `run`     | はい   | 実行するコマンドです                                                 |
| `next`    | はい   | 次に実行するステップの ID か、`end` です                             |
| `timeout` | いいえ | ステップの最大の実行時間です。既定は `30m` です                      |

`timeout` は、正の整数に単位を付けて書きます。単位は `s`（秒）、`m`（分）、`h`（時間）です。たとえば `30s`、`5m`、`1h` と書きます。

### script ステップの実行

途中のコマンドが失敗すると、そこでスクリプトが止まります。作業ディレクトリは、どのディレクトリでコマンドを実行しても、プロジェクトのルート（`.ugoke` のあるディレクトリ）です。環境変数は、「環境変数」の節で説明します。

スクリプトが 0 以外の終了ステータスで終わるか、`timeout` を過ぎると、そのステップは失敗します。ステップが失敗すると、ワークフローはそれ以降のステップを実行せずに失敗します。失敗したステップは、やり直しません。

```text
✗ first  Script exited with code 1 · 0.0s

fail: failed: Script exited with code 1
```

`timeout` を過ぎたときは、スクリプトと、スクリプトが起動したプロセスに終了を求め、5 秒たっても残っていれば強制的に止めます。

```text
✗ slow  Script timed out after 2000 ms · 2.0s

slow: failed: Script timed out after 2000 ms
```

## 環境変数

script ステップは、ステップを実行するプロセスの環境変数を引き継ぎます。常駐プロセスで実行するときは、常駐プロセスを起動したときの環境変数です。

## ステップのつながり

ワークフローは `start` のステップから始まり、各ステップの `next` をたどって進みます。実行が必ず `end` で終わるように、ステップのつながりは次の 3 つを満たす必要があります。

- `start` と `next` が指すステップが、定義にある
- どのステップも、`start` から `next` をたどって行ける
- どのステップからも、`next` をたどって `end` に着ける

このため、行き先を 1 つだけ書いた `next` では、輪を作れません。たとえば、`first` の `next` が `second`、`second` の `next` が `first` の定義では、どちらのステップからも `end` に着けません。行き先を条件で分ける書き方は、このガイドではまだ説明していません。

満たさない定義は、`ugoke validate` でエラーになります。次は、それぞれ別の定義のエラーの例です。

`first` の `next` が、定義にない `missing` を指す定義:

```text
.ugoke/workflows/hello.yaml:7:11 steps.first.next: Unknown step: missing
```

`start` からたどれない `lonely` がある定義:

```text
.ugoke/workflows/hello.yaml:8:3 steps.lonely: Step is not reachable from start
```

`first` と `second` が互いを `next` に書いた定義:

```text
.ugoke/workflows/hello.yaml:7:11 steps.first.next: Step first cannot reach end, so the workflow could never finish
.ugoke/workflows/hello.yaml:11:11 steps.second.next: Step second cannot reach end, so the workflow could never finish
```

存在しないステップを指すステップは、`end` に着けないとは報告しません。`Unknown step` だけを報告します。

## YAML の書き方の制限

定義の意味がひと目でわかるように、次の書き方はエラーになります。

- 定義にない項目。たとえば、script ステップの `foo`
- 同じマップの中で重複したキー
- 1 つのファイルに複数のドキュメント（`---` で区切ったもの）
- YAML のアンカー（`&name`）とエイリアス（`*name`）

エラーには、ファイル、行と列、エラーのある項目のパスが付きます。`ugoke validate` は、次のように表示します。

```text
.ugoke/workflows/hello.yaml:7:5 steps.hello.foo: Unknown field: foo
```

YAML の構文のエラーと、アンカーとエイリアスのエラーには、項目のパスが付きません。

```text
.ugoke/workflows/hello.yaml:6:13 YAML anchors are not supported
```
