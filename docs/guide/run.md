# ワークフローを実行する

このページでは、ワークフローを実行して、結果を確かめるまでを順に説明します。コマンドの詳細は、リファレンスの「[ugoke run](../reference/commands/run.md)」にあります。

## 準備

ワークフローは、Temporal Server の上で実行します。ふだんは、常駐プロセスを 1 度起動しておきます。常駐プロセスが、Temporal Server を起動し、ワークフローのステップを実行します。仕組みは「[アーキテクチャ](../explanation/architecture.md)」で説明します。

```console
$ ugoke daemon start
```

常駐プロセスを使わずに試すときは、`ugoke run` に `--dev` を付けます。その実行のあいだだけ、一時的な Temporal Server を起動します。

## 実行する

`ugoke run` に、ワークフローの名前を指定します。

```console
$ ugoke run ok
first
│ > echo first
│ first
✓ first  0.0s

second
│ > echo second
│ second
✓ second  0.0s

ok: completed (first, second)
```

ステップごとに、ステップの ID、実行するコマンド（`│ >` の行）、コマンドの出力（`│` の行）、結果（`✓` の行）を表示します。最後の行は、ワークフローの名前、結果、実行したステップの順番です。

実行する前に、`ugoke validate` と同じように定義を確かめます。定義に問題があるときは、エラーを表示し、何も実行しません。

## 失敗したとき

ステップが失敗すると、`✗` の行に理由を表示し、ワークフローはそれ以降のステップを実行せずに失敗します。終了ステータスは 1 です。

```text
first
│ > false
│ > echo not reached
✗ first  Script exited with code 1 · 0.0s

fail: failed: Script exited with code 1
```

どんなときにステップが失敗するかは、「[ワークフローの定義](workflow-definition.md#ステップが失敗したとき)」で説明します。

## 途中で止める

実行の途中で Ctrl+C を押したときの動きは、どこでステップを実行しているかで変わります。

常駐プロセスで実行しているときは、`ugoke run` はすぐにワークフローから切り離れます。ワークフローは止まらずに、常駐プロセスで続きます。

```text
wait: detached. Run "ugoke attach" to continue
```

`--dev` の一時的な Temporal Server は、実行の記録を残しません。このため、Ctrl+C を押すと、ワークフローを取り消します。

```text
wait: cancelled. A development server without --dev-db keeps no runs to attach to later
```

`ugoke run` が自分でステップを実行していて、Temporal Server が実行の記録を残すとき（`--dev --dev-db` など）は、実行中のステップが終わるのを待ってから切り離れます。待っているあいだにもう 1 度 Ctrl+C を押すと、すぐに終了します。このとき、実行中のステップは失敗し、そのワークフローは続けられなくなります。

```text
Waiting for the running step to finish, so that you can attach to the run later.
Press Ctrl+C again to exit now. The running step will fail, and the run cannot be continued.
```
