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

## 出典

考え方、ルール、雛形は [cc-sdd](https://github.com/gotalab/cc-sdd)（v3.1.0）を参考にし、ugoke の
ワークフローと置き場に合わせて書き直しています。cc-sdd は次の MIT License で配布されています。

```text
MIT License

Copyright (c) 2025 gotalab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
