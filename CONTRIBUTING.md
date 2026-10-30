# 贡献指南

## 目前不接受代码贡献

RemixClip 的架构还在快速演进，**当前不接受外部代码贡献**。这不是对代码质量的判断，而是维护成本问题：

- 核心边界尚未定型：素材库路由、扩展身份校验、端口常量、数据库 schema 都还在调整，PR 很容易“合入即过期”；
- 没有稳定的扩展点：内部模块之间靠约定协作，没有为第三方预留接口，任何改动都可能连带影响 daemon、web、desktop 与扩展四处；
- 单人维护：无法承担 review、兼容性与长期维护的承诺。

因此，以下内容会被礼貌关闭，不做合并：

- Pull Request（包括功能、重构、依赖升级、目录调整）；
- 要求合并 fork 分支的请求；
- 大规模格式化或风格统一的 PR。

## 欢迎的反馈

- **Bug 报告**：附复现步骤、操作系统、Node 版本，以及 `pnpm tools-dev logs daemon` 的相关片段；
- **文档纠错**：指出具体文件与行，说明哪里与代码不一致；
- **使用问题**：直接在 Issue 里提问；
- **安全问题**：请勿开公开 Issue，通过仓库主页的联系方式私下报告。

## 许可证

本项目以 [Apache License 2.0](LICENSE) 授权，架构参考自同样采用 Apache-2.0 的 [Open Design](https://github.com/Amateur0x1/open-design)；归属与派生说明见 [NOTICE](NOTICE)。在开放外部贡献之前，本条规定不适用于任何未提交的代码。

## 什么时候会开放

等下列事项落地、架构稳定下来之后，这里会补上完整流程（分支模型、commit 规范、测试要求、签署要求）：

1. `routes/library.ts` 按职责拆分；
2. 扩展身份改为固定扩展 ID 白名单；
3. 端口与数据目录常量收敛到单一来源；
4. 数据库引入迁移机制；
5. daemon 的 run 与 library 补上单元测试。

---

## English summary

Code contributions are **not accepted** at the moment: the architecture is still moving, there are no stable extension points, and the project is maintained by a single person. Pull requests will be closed with thanks. Bug reports, documentation corrections, and usage questions are welcome in Issues; please report security issues privately. The project is licensed under Apache-2.0 and its architecture follows [Open Design](https://github.com/Amateur0x1/open-design) (also Apache-2.0); see [NOTICE](NOTICE) for attribution.
