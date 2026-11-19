# プロジェクトとワークフローのファイル

## プロジェクトの構成

ugoke のファイルは、プロジェクトのルートの `.ugoke` ディレクトリに置きます。

```text
my-project/                 プロジェクトのルート
├── .ugoke/
│   └── workflows/          ワークフローの定義
│       ├── deploy.yaml     ワークフロー deploy
│       └── release/
│           └── notes.yaml  ワークフロー release/notes
└── src/                    プロジェクトのほかのファイル
```

## プロジェクト

ugoke は、コマンドを実行したディレクトリから上へたどり、`.ugoke` ディレクトリのある最も近いディレクトリを、プロジェクトのルートにします。プロジェクトのサブディレクトリで実行しても、同じプロジェクトを使います。

途中のディレクトリにも `.ugoke` があるときは、より近い方をルートにします。どのディレクトリにも `.ugoke` がなければ、次のエラーになります。

```text
No .ugoke directory found in /private/tmp or its parents
```

## ワークフローの名前とファイル

ワークフローは、名前で指定します。名前が `deploy` のワークフローは、`.ugoke/workflows/deploy.yaml` か `.ugoke/workflows/deploy.yml` に定義します。`/` で区切った名前は、サブディレクトリの定義を指します。たとえば `release/notes` は、`.ugoke/workflows/release/notes.yaml` です。

名前の `/` で区切った各部分は、英字で始め、英字、数字、`_`、`-` だけで書きます。決まりに合わない名前は、プロジェクトを探す前にエラーになります。

```text
Invalid workflow name: ../deploy. Use letters, digits, _, and -, separated by /
```

同じ名前の `.yaml` と `.yml` の両方があるときと、どちらもないときは、エラーになります。

```text
Workflow deploy has both .yaml and .yml files
Workflow not found: deploy
```

## ワークフローを検証する

`ugoke validate` は、名前で指定したワークフローの定義を検証します。

```console
$ ugoke validate deploy
deploy: valid
```

定義に問題があるときは、ファイル、行と列、項目のパス、メッセージを表示します。定義の決まりは「[ワークフローの定義](workflow-definition.md)」で説明します。

```text
.ugoke/workflows/hello.yaml:7:11 steps.first.next: Unknown step: missing
```

終了ステータスは、定義が正しければ 0、エラーがあれば 1 です。

## 版を確かめる

`ugoke --version` は、ugoke の版を表示します。
