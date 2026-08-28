# 贡献指南

感谢关注 Bittune！本文说明如何搭建开发环境、提交变更和参与设计讨论。

## 开发环境

- Node.js >= 22.19.0

```bash
npm install
npm run check     # TypeScript 类型检查
npm test          # 全部测试
npm run bittune   # 本地启动
```

构建发行物：

```bash
npm run package:agent
npm run test:gpu-acceptance   # 需要真实 Linux GPU 主机
```

## 提交规范

- Commit message 使用 Conventional Commits（现有历史即范本）：`feat(scope): ...`、`fix(scope): ...`、`docs: ...`、`chore: ...`。
- 一个 PR 聚焦一件事；行为变更必须伴随对应测试，且同步更新受影响的"当前实现"契约文档。

## 文档纪律

- 行为变更需要附带对应的测试，并在 PR 说明里写清影响范围；
- 仓库正文统一使用 **Bittune** 作为产品名。

## 设计讨论

涉及长期架构边界的改动（领域契约、Tool 面、Provider 边界）请先在 Discussions 提交 RFC 形式的提案。开发前请先阅读 [ROADMAP](ROADMAP.md)，确认方向一致——优先推进路线图上已排期的阶段，避免与之冲突的重复实现。

## 安全问题

发现安全问题请勿提公开 Issue，按 [SECURITY.md](SECURITY.md) 披露。
