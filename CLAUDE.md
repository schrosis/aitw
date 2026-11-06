# aitw

aitw は、AI、人間、スクリプトのステップを Temporal Workflow で実行するワークフロー基盤です。

## コマンド

- `pnpm check`: ビルド、型検査、Lint、整形確認、テストをすべて実行する
- `pnpm build`: すべてのパッケージをビルドする
- `pnpm typecheck`: パッケージ、テスト、設定ファイルを型検査する
- `pnpm lint`: type-aware Lint を実行する
- `pnpm format`: ファイルを整形する
- `pnpm test`: テストを実行する。`@aitw/cli` のテストにはビルド結果が必要

## アーキテクチャ

- `@aitw/core`: 中間表現の型と Port を持つ。Temporal に依存しない
- `@aitw/definition`: 定義オブジェクトの検証、中間表現への Build、YAML の読み込みを担当する
- `@aitw/engine`: Workflow、Activity、Worker を持つ。`@aitw/core` のみに依存し、`@aitw/definition` と具体的な Adapter に依存しない
- `@aitw/adapter-*`: Port の実装。実装ごとに個別パッケージとし、名前は `adapter-<種類>-<実装>` とする
- `aitw`: CLI。Adapter の組み立てを担当する

## 規約

- Adapter のインターフェースは Port と呼ぶ
- Workflow のコードは `packages/engine/src/workflows` に置き、Node API と副作用を持ち込まない
- 副作用は Activity で実行する
- コミットメッセージは Conventional Commits に従う

## レビューの基準

- 実行不能、データ破壊、セキュリティ、Workflow の決定性に関する問題を優先する
- 整形や好みの問題は指摘しない
- 問題と影響を具体的に示す
