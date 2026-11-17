# SDD のスキル

ugoke の開発で使う、仕様駆動開発（SDD）のスキルです。要件、設計、タスクの順に文書を書き、人間が段階ごとに
承認してから実装に進みます。

## 構成

| ファイル | 内容 |
| --- | --- |
| [conventions.md](conventions.md) | すべてのスキルが守る約束事 |
| [storage.md](storage.md) | 文書の置き場と読み書きのしかた |
| `../skills/sdd-requirements/` | 要件を書く |
| `../skills/sdd-validate-gap/` | 要件を検証し、既存のコードとのギャップを調べる |
| `../skills/sdd-design/` | 設計を書く |
| `../skills/sdd-validate-design/` | 設計を検証する |
| `../skills/sdd-tasks/` | Wave、PR、サブタスクに分ける |
| `../skills/sdd-validate-tasks/` | タスクを検証する |

スキルは、チャットから `/sdd-requirements <name>` のように呼べます。ugoke の `plan` ワークフロー
（`.ugoke/workflows/plan.yaml`）は、段階ごとに書くスキルと検証するスキルを呼び、人間の承認を待ちます。
実装は `develop` ワークフローが、タスクの文書の大タスクを 1 つずつ PR にします。

スキルの frontmatter には `allowed-tools` を書きません。ワークフローのステップが `allowedTools` で絞った
許可を、スキルが広げないようにするためです。
