# ワークフローの定義

ワークフローの定義のファイルの項目と決まりです。書き方を順に知るには、ガイドの「[ワークフローの定義](../guide/workflow-definition.md)」を読んでください。

## 最上位の項目

| 項目      | 必須 | 内容                                                      |
| --------- | ---- | --------------------------------------------------------- |
| `version` | はい | 定義の形式の版です。`v0.1` だけを受け付けます             |
| `start`   | はい | 最初に実行するステップの ID です                          |
| `steps`   | はい | ステップの一覧です。キーがステップの ID、値がステップです |
| `inputs`  | いいえ | ワークフローの入力の宣言です。[ワークフローの入力](#ワークフローの入力)を見てください |

## ステップの ID

- 英字で始め、英字、数字、`_` だけで書きます
- `start` と `end` は予約語のため、使えません

## ワークフローの入力

`inputs` には、ワークフローが始まるときに受け取る値を、名前と宣言の組で書きます。名前は英字で始め、英字、数字、`_` だけで書きます。値は、`ugoke run` の `--input` で渡します。

| 項目          | 必須   | 内容                                                                     |
| ------------- | ------ | ------------------------------------------------------------------------ |
| `type`        | はい   | `string`、`number`、`boolean`、`choice` のどれかです                     |
| `options`     | `choice` のとき | 選べる値の一覧です。1 つ以上書きます。空の文字列と、同じ値を重ねて書けません                    |
| `required`    | いいえ | 値を必ず渡すかどうかです。既定は `false` です                            |
| `default`     | いいえ | 値を渡さなかったときの値です。`type` に合う値を書きます                  |
| `description` | いいえ | 入力の説明です                                                           |

- `required: true` と `default` は、一緒に書けません
- 必須でない値を渡さなかったときは、`default` を使います。`default` もなければ `null` です
- 宣言にない名前の値、型の合わない値、`options` にない値を渡すと、実行せずに失敗します
- `number` の値は、`1.5` のように書きます。`1e3` のような指数の書き方は使えません
- 入力の値は、JSON で 512 KiB までです

## script ステップ

| 項目      | 必須   | 内容                                                      |
| --------- | ------ | --------------------------------------------------------- |
| `type`    | はい   | `script` です                                             |
| `run`     | はい   | 実行するコマンドです                                      |
| `next`    | はい   | 次に実行するステップの ID か、`end` です                  |
| `timeout` | いいえ | ステップの最大の実行時間です。既定は `30m` です           |
| `inputs`  | いいえ | ステップが受け取る値です。名前と[式](#式)の組で書きます |
| `outputs` | いいえ | ステップが出す値です。名前と[式](#式)の組で書きます     |

`timeout` は、正の整数に単位 `s`（秒）、`m`（分）、`h`（時間）を付けて書きます。たとえば `30s`、`5m`、`1h` です。

### 実行

- 作業ディレクトリは、プロジェクトのルートです
- 環境変数は、ステップを実行するプロセスのものを引き継ぎます。常駐プロセスで実行するときは、常駐プロセスを起動したときのものです
- 途中のコマンドが失敗すると、スクリプトが止まります。パイプラインの途中のコマンドと、`if`、`&&`、`||` の条件として書いたコマンドは除きます
- 0 以外の終了ステータスで終わるか、`timeout` を過ぎると、ステップは失敗します
- ステップが失敗すると、ワークフローはそれ以降のステップを実行せずに失敗します。失敗したステップは、やり直しません
- `timeout` を過ぎると、スクリプトと、スクリプトが起動したプロセスに終了を求め、5 秒たっても残っていれば強制的に止めます

## wait ステップ

人の答えを待つステップです。

| 項目      | 必須   | 内容                                                                    |
| --------- | ------ | ----------------------------------------------------------------------- |
| `type`    | はい   | `wait` です                                                             |
| `method`  | はい   | 待ち方です。`terminal` を使えます                                       |
| `with`    | 待ち方による | 待ち方のオプションです。文字列には[式](#式)を書けます             |
| `next`    | はい   | 次に実行するステップの ID か、`end` です                                |
| `inputs`  | いいえ | ステップが受け取る値です。名前と[式](#式)の組で書きます                 |
| `outputs` | いいえ | ステップが出す値です。答えを `result.<名前>` で参照できます             |

- 答えが来るまで待ちます。待つ時間の上限はありません
- 答えは、待ち方が宣言した値です。宣言に合わない答えは受け付けず、もう一度聞きます
- 必須でない値を答えなかったときは、`default` を使います。`default` もなければ `null` です

### terminal

`ugoke run` のターミナルで聞きます。

| 項目      | 必須   | 内容                                                                                                               |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| `message` | はい   | 聞く前に表示する文です                                                                                             |
| `schema`  | いいえ | 聞く値の宣言です。書き方は[ワークフローの入力](#ワークフローの入力)と同じです。書かなければ、Enter を押すまで待ちます |

答える前にターミナルの入力が終わると、ワークフローは失敗します。

## 式

`${{ <参照> }}` の形で、ほかの値を参照します。参照は、`steps.fetch.outputs.title` のように `.` で区切った名前です。

参照できる値と、それを使える場所は次のとおりです。

| 参照できる値                                                              | 使える場所                   |
| ------------------------------------------------------------------------- | ---------------------------- |
| 前に実行するステップの `outputs`（`steps.<ステップ>.outputs.<名前>`）     | `inputs`、`run`、`with`、`outputs`   |
| ワークフローの入力（`workflow.inputs.<名前>`）                            | `inputs`、`run`、`with`、`outputs`   |
| 自分の `inputs`（`inputs.<名前>`）                                        | `run`、`with`、`outputs`             |
| スクリプトの結果（`result.exitCode`、`result.stdout`、`result.stderr`）   | script ステップの `outputs`                    |
| 待機ステップの答え（`result.<名前>`）                                     | wait ステップの `outputs`                      |

- 宣言していない値は参照できません。参照した値の中の項目（`steps.fetch.outputs.title.text` など）も参照できません
- 式だけで書いた値は、参照した値の型のままです。ほかの文字と続けて書いた値は、文字列になります。そのとき、`null` は空の文字列に、オブジェクトと配列は JSON になります
- `result.stdout` と `result.stderr` は、最後の改行を 1 つ取り除いた値です
- ステップが受け取る値（`inputs` と、`run` と `outputs` が参照する値）と出す値は、それぞれ JSON で 512 KiB までです。受け取る値が超えるとスクリプトを実行せずに、出す値が超えると実行したあとに、ステップは失敗します

`ugoke validate` と `ugoke run` は、実行する前に式を確かめます。

## ステップのつながり

ワークフローは `start` のステップから始まり、各ステップの `next` をたどって進みます。`next` が `end` のステップで終わります。ステップのつながりは、次の 3 つを満たす必要があります。

- `start` と `next` が指すステップが、定義にある
- どのステップも、`start` から `next` をたどって行ける
- どのステップからも、`next` をたどって `end` に着ける

存在しないステップを指すステップは、`end` に着けないとは報告しません。`Unknown step` だけを報告します。

## YAML の書き方の制限

次の書き方は、エラーになります。

- 定義にない項目
- 同じマップの中で重複したキー
- 1 つのファイルに複数のドキュメント（`---` で区切ったもの）
- YAML のアンカー（`&name`）とエイリアス（`*name`）

## エラー

`ugoke validate` は、`ファイル:行:列 項目のパス: メッセージ` の形で表示します。YAML の構文のエラーと、アンカーとエイリアスのエラーには、項目のパスが付きません。

| メッセージ                                                                                                  | 原因                                                       |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Unknown field: <name>`                                                                                     | 定義にない項目がある                                       |
| `Map keys must be unique`                                                                                   | 同じマップの中で、キーが重複している                       |
| `Source contains multiple documents; please use YAML.parseAllDocuments()`                                   | 1 つのファイルに、複数のドキュメントがある                 |
| `YAML anchors are not supported`、`YAML aliases are not supported`                                         | アンカーかエイリアスがある                                 |
| `Must start with a letter, contain only letters, digits, or _, and not be a reserved word: end or start`    | ステップの ID が決まりに合わない                           |
| `Must be a positive duration such as 30s, 5m, or 1h`                                                        | `timeout` の書き方が決まりに合わない                       |
| `Unknown step: <step>`                                                                                      | `start` か `next` が、定義にないステップを指している       |
| `Step is not reachable from start`                                                                          | `start` からたどれないステップがある                       |
| `Step <step> cannot reach end, so the workflow could never finish`                                          | `end` に着けないステップがある                             |
| `Step <step> does not run before <step>`                                                                    | 前に実行しないステップの `outputs` を参照している          |
| `Step <step> does not declare the output <name>`、`Step <step> does not declare the input <name>`、`The workflow does not declare the input <name>` | 宣言していない値を参照している |
| `Can reference only <参照できるもの>`                                                                       | その場所では参照できない値を参照している                   |
| `Cannot reference a field of an output value`、`Cannot reference a field of an input value`、`Cannot reference a field of a workflow input value` | 値の中の項目を参照している |
| `A required input cannot have a default`                                                                    | `required: true` の入力に `default` を書いた               |
| `Duplicate option: <option>`                                                                                | `options` に同じ値を重ねて書いた                           |
| `Must be one of <options>` | `choice` の `default` が `options` にない |
| `Invalid input: expected <型>, received <型>` | `default` が `type` に合わない |
| `Must be a decimal number such as 1.5, without exponent notation` | `number` の `default` を、`1e3`、`0x10`、`.inf` のような、10 進数でない書き方で書いた |
| `Unknown wait method: <method>. Available methods: <methods>` | 使えない待ち方を書いた |
| `Step <step> does not declare the answer <name>` | 待ち方が宣言していない答えを参照している |
| `Invalid expression: <式>. <理由>`、`Unterminated expression: <式>`                                         | 式の書き方が正しくない                                     |

実行したときのエラー:

| メッセージ                            | 原因                                     |
| ------------------------------------- | ---------------------------------------- |
| `Script exited with code <code>`      | スクリプトが 0 以外の終了ステータスで終わった |
| `Script timed out after <ms> ms`      | スクリプトが `timeout` を過ぎた          |
| `The input ended before the answer was entered` | `terminal` で答える前に、ターミナルの入力が終わった |
| `... bytes, which exceeds the limit of 524288 bytes` | ステップが受け取る値か出す値が、512 KiB を超えた |
