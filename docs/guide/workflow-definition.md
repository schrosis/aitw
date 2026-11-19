# ワークフローの定義

ワークフローは、YAML のファイルに定義します。ファイルの置き場所は「[プロジェクトとワークフローのファイル](project.md)」で説明します。このページでは、定義の書き方を順に説明します。項目と決まりの一覧は、リファレンスの「[ワークフローの定義](../reference/workflow-definition.md)」にあります。

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

定義には、形式の版（`version`）、最初に実行するステップ（`start`）、ステップの一覧（`steps`）を書きます。この定義は、`hello` ステップで `echo hello` を実行し、終わります。

`type: script` のステップは、`run` に書いたコマンドを実行します。各ステップの `next` には、次に実行するステップを書きます。`next` に `end` を書くと、そのステップでワークフローが終わります。

## ステップをつなぐ

ステップを増やすときは、`next` で次のステップを指します。

```yaml
version: v0.1
start: build
steps:
  build:
    type: script
    run: make build
    next: test
  test:
    type: script
    run: make test
    timeout: 10m
    next: end
```

この定義は、`build`、`test` の順に実行して終わります。`timeout` は、ステップの最大の実行時間です。書かなければ `30m` です。

実行が必ず `end` で終わるように、`start` と `next` が指すステップは定義になければならず、どのステップも `start` からたどれて、`end` に着ける必要があります。このため、行き先を 1 つだけ書いた `next` では、輪を作れません。行き先を条件で分ける書き方は、このガイドではまだ説明していません。

## ステップ間で値を渡す

前のステップが `outputs` した値は、`${{ }}` で囲んだ式で、あとのステップから使えます。

```yaml
version: v0.1
start: fetch
steps:
  fetch:
    type: script
    run: echo hello
    outputs:
      title: ${{ result.stdout }}
    next: report
  report:
    type: script
    inputs:
      title: ${{ steps.fetch.outputs.title }}
    run: echo "title is ${{ inputs.title }}"
    next: end
```

- `fetch` の `outputs` で、スクリプトの標準出力を `title` という値にします。標準出力の最後の改行は、1 つ取り除きます
- `report` の `inputs` で `fetch` の `title` を受け取り、`run` の中で `${{ inputs.title }}` として使います

この定義を実行すると、`report` は `echo "title is hello"` を実行します。

式で参照できる値は、書く場所ごとに決まっています。`ugoke validate` は、参照できない値を参照していないかも確かめます。詳しくは、[リファレンスの式](../reference/workflow-definition.md#式)を見てください。

## 定義を確かめる

`ugoke validate` で、定義を実行する前に確かめられます。

```console
$ ugoke validate hello
hello: valid
```

問題があるときは、ファイル、行と列、項目のパスと一緒に表示します。たとえば、`first` の `next` が定義にない `missing` を指していると、次のようになります。

```text
.ugoke/workflows/hello.yaml:7:11 steps.first.next: Unknown step: missing
```

定義にない項目、重複したキー、YAML のアンカーとエイリアスなども、エラーになります。エラーの一覧は、リファレンスの「[エラー](../reference/workflow-definition.md#エラー)」にあります。コマンドの詳細は「[ugoke validate](../reference/commands/validate.md)」にあります。

## ステップが失敗したとき

スクリプトは、プロジェクトのルートで実行します。途中のコマンドが失敗するとスクリプトが止まり、0 以外の終了ステータスで終わるか、`timeout` を過ぎると、そのステップは失敗します。ステップが失敗すると、ワークフローはそれ以降のステップを実行せずに失敗します。失敗したステップは、やり直しません。

次は、`fail` ワークフローの `first` ステップが、終了ステータス 1 で終わったときの表示です。最後の行の先頭は、ワークフローの名前です。

```text
✗ first  Script exited with code 1 · 0.0s

fail: failed: Script exited with code 1
```

次は、`slow` ワークフローの `slow` ステップが、`timeout: 2s` を過ぎたときの表示です。

```text
✗ slow  Script timed out after 2000 ms · 2.0s

slow: failed: Script timed out after 2000 ms
```

止まらない場合や、`timeout` を過ぎたときの止め方は、リファレンスの「[実行](../reference/workflow-definition.md#実行)」にあります。

## 環境変数

script ステップは、ステップを実行するプロセスの環境変数を引き継ぎます。常駐プロセスで実行するときは、常駐プロセスを起動したときの環境変数です。
