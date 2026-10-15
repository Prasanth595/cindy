# 设置侧栏滚动边界

Issue #5623。这是已在 macOS 开发版验证过的布局事实，不是新的视觉规范。Windows 未实机。

## 目标

设置页左侧的「设置」标题和搜索框保持可见。只有菜单列表滚动，滚动条只覆盖菜单列表。搜索结果仍和菜单同时显示，不替换菜单。

## 位置

- apps/desktop/src/renderer/components/settings/SettingsView.tsx：侧栏 aside 使用 overflow-hidden，标题行 shrink-0。
- SettingsSidebarNav.tsx：搜索槽最高占标题下方剩余高度的一半；nav role=tablist 是唯一菜单滚动容器，菜单项 shrink-0。
- SettingsSearchBox.tsx：输入框不收缩，结果列表在自身内部滚动。

## 已验证

2026-10-15，worktree .cindy-worktrees/issue-5623，基线 ed15f066，隔离开发版 Cindy-dev2-issue5623，区域 cn，跳过登录。窗口可缩到的最小尺寸是 800x600。

- 600px 高时菜单 scrollHeight 644、可视 400，滚到末项「关于」后标题仍在 y=75、搜索框仍在 y=128，侧栏本身不滚动。
- 滚完菜单后搜索「模型」得到 12 条且结果区自己滚动；搜索「插件」得到 3 条；无结果文案为「没有找到设置，试试其他关键词」。
- 方向键移动当前结果，Enter 打开对应分区，Escape 清空搜索。点击「插件」后右侧显示插件页。
- 右侧列 overflow-y 为 hidden，左侧菜单滚动时它的 scrollTop 保持 0。
- 组件测试：改前 SettingsSidebarNav 2 项通过；改后侧栏、Escape 相关共 21 项通过。

## 风险

- 未在 Windows 10 上验证滚动条宽度和最小窗口。
- 菜单项如果去掉 shrink-0，矮窗口里会被压扁而不是滚动。这是这次实机里看到的失败方式。
- 未跑整包 typecheck。
