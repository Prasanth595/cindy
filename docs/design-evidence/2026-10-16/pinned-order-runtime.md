# PR #5712：置顶项目排序的完整应用证据

- 验证日期：2026-10-16。
- 测试源码：`554356238b4f3bbb2ecfbd44f921f218162e957f`；本次后续提交仅更新证据文档，不改变产品实现。
- 环境：Global，macOS 26.6.2（25G83，arm64），Electron 41.10.3 / Chromium 146.0.7680.216，1280 × 1000 页面视口。
- 使用独立数据目录、未登录模式和合成项目/任务；没有操作正式应用数据或发送模型消息。
- 设计依据：[DESIGN.md](../../design-rules/DESIGN.md) §10、§14；媒体外置遵循 [design-governance.md](../../design-rules/design-governance.md) §6。

## 方法与结果

在每个显示模式及主题下，将三个置顶项目初始化为 A/B/C，从项目 C 的非按钮标题区域拖到 A 前。通过 Chromium CDP 驱动原生拖放，同时记录原生起拖、Sortable 事件、保存顺序与实际可见顺序。每项随后停止并重新启动测试应用，确认源码、隔离数据目录和数据归属不变，主进程 PID 改变，再检查恢复后的保存与可见顺序。卡片按从左到右、从上到下读序。

| 模式 | 主题 | 实际列数 | 拖后保存 / 界面 | 进程重启后保存 / 界面 |
| --- | --- | --- | --- | --- |
| 文字 | Light | 1 | CAB / CAB | CAB / CAB |
| 列表 | Light | 1 | CAB / CAB | CAB / CAB |
| 卡片 | Light | 2 | CAB / CAB | CAB / CAB |
| 文字 | Dark | 1 | CAB / CAB | CAB / CAB |
| 列表 | Dark | 1 | CAB / CAB | CAB / CAB |
| 卡片 | Dark | 2 | CAB / CAB | CAB / CAB |

六项均实际开始原生拖动。已逐张目检六项重启截图，三项目及其子任务保持对应，Light/Dark 和双列布局与记录一致。此次没有新增颜色、组件或布局；不把这次目检描述为整个应用的设计规范审核。

## 公开录屏

- [验收摘要、Light 文字与双列卡片](https://github.com/makecindy/cindy/pull/5712#issuecomment-6215556163)。
- [Light 列表](https://github.com/makecindy/cindy/pull/5712#issuecomment-6215557317)。
- [Dark 文字与双列卡片](https://github.com/makecindy/cindy/pull/5712#issuecomment-6215558512)。
- [Dark 列表](https://github.com/makecindy/cindy/pull/5712#issuecomment-6215559684)。

评论提供内嵌真实录屏的自包含 HTML 代码块，复制保存为 `.html` 即可离线打开；不是 GitHub 附件上传。按评论长度分组，不将媒体写入 Git。录屏保留采集时间轴，只裁剪置顶区域，末帧额外停留一秒；不补画界面或动作。六段首末帧均已核对三个项目完整可见，并验证离线播放至结束、无外网请求。录屏不包含重启过程；重启结论来自独立启动记录、PID 变化及恢复后截图，原始材料本地留存。

## 版本对照与边界

v0.1.109 tag `0b779c8210fa4b9363fb1db8b8d7e5fab46019d4` 与冻结 main `53b2c99854ddea4ead1868e3477e830f66f20800` 的置顶项目文字模式，均命中项目标题但无法开始原生拖动。两个基线运行于 Electron 42.11.12 / Chromium 148.0.7778.280，与本 PR 的运行时不同；这不是同一运行时只切换 CSS 的严格 A/B。

两版的置顶任务文字、列表、双列卡片排序与重启保留均通过，详见 [#6227 对照摘要及 tag 录屏](https://github.com/makecindy/cindy/issues/6227#issuecomment-6215555113)和 [main 录屏](https://github.com/makecindy/cindy/issues/6227#issuecomment-6215488928)。任务与项目结论分开，不据此宣称 #6227 已解决。

本次是源码开发构建，不是官方安装包。未验证 Windows、远控、操作系统鼠标全链路、卡片 1/3 列或与最新 main 合并后的集成结果。测试数据准备不代表已覆盖所有置顶/取消置顶入口。既有组件回归范围见[原证据索引](../2026-10-10/pinned-project-order.md)；本轮证据不替代 CI、设计批准或维护者审查。
