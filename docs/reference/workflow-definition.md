# ワークフローの定義

ワークフローの定義のファイルの項目と決まりです。書き方を順に知るには、ガイドの「[ワークフローの定義](../guide/workflow-definition.md)」を読んでください。

## 最上位の項目

| 項目      | 必須 | 内容                                                      |
| --------- | ---- | --------------------------------------------------------- |
| `version` | はい | 定義の形式のバージョンです。`v0.1` だけを受け付けます             |
| `start`   | はい | 最初に実行するステップの ID です                          |
| `steps`   | はい | ステップの一覧です。キーがステップの ID、値がステップです |
| `inputs`  | いいえ | ワークフローの入力の宣言です。[ワークフローの入力](#ワークフローの入力)を見てください |
| `env`     | いいえ | すべての script ステップと ai ステップの環境変数です。名前と値の組で書きます。値の[式](#式)は、`workflow.inputs` だけを参照できます |
| `dotenv`  | いいえ | script ステップと ai ステップが読む dotenv のファイルです。プロジェクトのルートからの相対パスで書きます |

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
| `env`     | いいえ | このステップの環境変数です。名前と値の組で書きます。値には[式](#式)を書けます |

`timeout` は、正の整数に単位 `s`（秒）、`m`（分）、`h`（時間）を付けて書きます。たとえば `30s`、`5m`、`1h` です。

### 実行

- 作業ディレクトリは、プロジェクトのルートです
- 環境変数は、ステップを実行するプロセスのものを引き継ぎます。常駐プロセスで実行するときは、常駐プロセスを起動したときのものです
- `dotenv` のファイルは、スクリプトを実行するたびに読みます。その値は、実行の記録に残りません。`env` の値は、実行の記録に残ります
- 同じ名前の環境変数は、`dotenv` のファイル、引き継いだ環境変数、ワークフローの `env`、ステップの `env` の順に、あとのものが使われます
- 環境変数の名前は、英字か `_` で始め、英字、数字、`_` だけで書きます。値は、文字列、数、真偽値で書き、数や真偽値は文字列にします
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

## ai ステップ

AI に指示を実行させるステップです。AI は、プロバイダーが動かします。使えるプロバイダーは、[リファレンス](README.md#ai-のプロバイダー)にあります。

| 項目       | 必須   | 内容                                                                                       |
| ---------- | ------ | ------------------------------------------------------------------------------------------ |
| `type`     | はい   | `ai` です                                                                                  |
| `provider` | はい   | AI を動かすプロバイダーの名前です                                                          |
| `prompt`   | はい   | AI への指示です。[式](#式)を書けます                                                       |
| `model`    | いいえ | 使うモデルです。プロバイダーにそのまま渡します。書かなければ、プロバイダーが選びます       |
| `schema`   | いいえ | 結果の JSON Schema です。`type: object` で書きます。書かなければ、結果はテキストです       |
| `session`  | いいえ | `reuse` か `new` です。既定は `reuse` です                                                 |
| `with`     | プロバイダーによる | プロバイダーのオプションです。文字列には[式](#式)を書けます                  |
| `next`     | はい   | 次に実行するステップの ID か、`end` です                                                   |
| `timeout`  | いいえ | ステップの最大の実行時間です。既定は `30m` です。書き方は script ステップと同じです        |
| `inputs`   | いいえ | ステップが受け取る値です。名前と[式](#式)の組で書きます                                    |
| `outputs`  | いいえ | ステップが出す値です。AI の結果を `result.data` で参照できます                             |
| `env`      | いいえ | このステップの環境変数です。名前と値の組で書きます。値には[式](#式)を書けます              |

- 作業ディレクトリは、プロジェクトのルートです
- 環境変数は、script ステップと同じです。ステップを実行するプロセスの環境変数を引き継ぎ、ワークフローの `env`、ステップの `env`、`dotenv` のファイルを渡します。同じ名前の順も同じです
- AI が言ったことやしたことを、ステップの出力として表示します
- `schema` を書くと、結果は `schema` に合う値です。`outputs` では、`result.data.<名前>` のように中の項目も参照できます
- 同じ実行の中でステップがもう一度動くとき、`session` が `reuse` なら前のセッションを続け、`new` なら新しく始めます
- `timeout` を過ぎると、ステップは失敗します。失敗した ai ステップは、やり直しません。ファイルを変えたあとに失敗したかもしれないためです
- `outputs` が参照した `result.data` の項目が AI の結果になければ、AI を動かしたあとにステップは失敗します
- 知らないプロバイダーと、プロバイダーの決まりに合わない `with` は、定義のエラーです。`with` の式を評価した値が決まりに合わないときは、AI を動かさずにステップが失敗します

`result.data` の中の項目は、`schema` の `properties` に書いた名前だけを参照できます。ただし、次の `schema` では、ほかの名前も参照できます。

- `additionalProperties` を `false` 以外で書いた
- `$ref`、`allOf`、`anyOf`、`oneOf`、`if`、`patternProperties`、`dependentSchemas`、`unevaluatedProperties` のどれかを書いた
- `properties` を書いていない

## 式

`${{ <参照> }}` の形で、ほかの値を参照します。参照は、`steps.fetch.outputs.title` のように `.` で区切った名前です。

参照できる値と、それを使える場所は次のとおりです。

| 参照できる値                                                              | 使える場所                   |
| ------------------------------------------------------------------------- | ---------------------------- |
| 前に実行するステップの `outputs`（`steps.<ステップ>.outputs.<名前>`）     | `inputs`、`run`、`prompt`、`with`、ステップの `env`、`outputs`   |
| ワークフローの入力（`workflow.inputs.<名前>`）                            | `inputs`、`run`、`prompt`、`with`、ステップの `env`、`outputs`、ワークフローの `env`   |
| 自分の `inputs`（`inputs.<名前>`）                                        | `run`、`prompt`、`with`、ステップの `env`、`outputs`             |
| スクリプトの結果（`result.exitCode`、`result.stdout`、`result.stderr`）   | script ステップの `outputs`                    |
| 待機ステップの答え（`result.<名前>`）                                     | wait ステップの `outputs`                      |
| AI の結果（`result.data`）                                                | ai ステップの `outputs`                        |

- 宣言していない値は参照できません。参照した値の中の項目（`steps.fetch.outputs.title.text` など）も参照できません。`result.data` の中の項目は、[ai ステップ](#ai-ステップ)の `schema` で決まります
- 式だけで書いた値は、参照した値の型のままです。ほかの文字と続けて書いた値は、文字列になります。そのとき、`null` は空の文字列に、オブジェクトと配列は JSON になります
- `run`、`prompt`、`env` の値は、式だけで書いても、いつも文字列です。`null` とオブジェクトと配列は、ほかの文字と続けて書いたときと同じように文字列にします
- `result.stdout` と `result.stderr` は、最後の改行を 1 つ取り除いた値です
- ステップが受け取る値（`inputs`、`run`、`prompt`、`env`、`outputs` が参照する値と、ワークフローの `env`、ai ステップの `with`）と出す値は、それぞれ JSON で 512 KiB までです。受け取る値が超えるとスクリプトや AI を動かさずに、出す値が超えると動かしたあとに、ステップは失敗します

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
| `Unknown wait method: <method>. <案内>` | 使えない待ち方を書いた。案内は、使える待ち方の一覧などです |
| `Step <step> does not declare the answer <name>` | 待ち方が宣言していない答えを参照している |
| `Unknown AI provider: <provider>. <案内>` | 使えないプロバイダーを書いた。案内は、使えるプロバイダーの一覧などです |
| `Step <step> has no schema, so result.data is text` | `schema` のない ai ステップで、`result.data` の中の項目を参照している |
| `The schema of step <step> does not declare the property <name>` | `schema` の `properties` にない項目を参照している |
| `The schema must have type: object` | ai ステップの `schema` が `type: object` ではない |
| `Invalid input` | `env` の値が、文字列、数、真偽値ではない |
| `Must start with a letter or _ and contain only letters, digits, or _` | 環境変数の名前が決まりに合わない |
| `Must be a path relative to the project root`、`Must not leave the project root` | `dotenv` のパスが決まりに合わない |
| `The environment of the workflow can reference only workflow.inputs.<name>` | ワークフローの `env` で、`workflow.inputs` 以外を参照している |
| `Invalid expression: <式>. <理由>`、`Unterminated expression: <式>`                                         | 式の書き方が正しくない                                     |

実行したときのエラー:

| メッセージ                            | 原因                                     |
| ------------------------------------- | ---------------------------------------- |
| `Script exited with code <code>`      | スクリプトが 0 以外の終了ステータスで終わった |
| `Script timed out after <ms> ms`      | スクリプトが `timeout` を過ぎた          |
| `AI step timed out after <ms> ms`     | ai ステップが `timeout` を過ぎた         |
| `outputs.<name>: Unknown reference: <式>` | `outputs` が参照した `result.data` の項目が、AI の結果になかった |
| `Invalid options of AI provider <provider>: <理由>` | `with` の式を評価した値が、プロバイダーの決まりに合わない |
| `Failed to read the dotenv file <path>: <理由>` | `dotenv` のファイルを読めなかった。プロジェクトのルートの外を指しているときも、このエラーになる |
| `The input ended before the answer was entered` | `terminal` で答える前に、ターミナルの入力が終わった |
| `... bytes, which exceeds the limit of 524288 bytes` | ステップが受け取る値か出す値が、512 KiB を超えた |
