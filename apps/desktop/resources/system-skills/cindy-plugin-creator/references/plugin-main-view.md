## 4.20 一级主视图(mainView 能力)

插件需要一个从 Cindy 一级侧边栏进入的完整页面时，直接声明 `mainView`：

```json
{
  "schemaVersion": 3,
  "minCindyVersion": "1.2.3",
  "mainView": {
    "title": "工作台",
    "icon": "puzzle",
    "html": "main-view.html"
  }
}
```

- `mainView.html` 必须是包内安全相对路径且文件真实存在；`title` 可省略，省略时
  回退插件 `name`。声明过基础 title 后，locale 文件可用
  `"mainView": { "title": "Workspace" }` 翻译；没有基础 title 时不要声明该翻译；
- `mainView.icon` 可省略，省略时使用 `puzzle`。它只控制主视图的侧边栏入口，不会
  替代或修改根级 `icon` 品牌图片。可用值与 Cindy 系统图标名完全一致：
  `puzzle`、`globe`、`code`、`folder`、`database`、`chart-column`、
  `image`、`message-circle`、`calendar-days`；不接受别名、任意图标名或图片路径；
- `mainView` 与 `panel` 是两种独立 UI 贡献项。可以让两者指向同一 HTML，但必须分别
  声明；主视图不接受 position、宽度或 systemButtons；
- 插件批准并启用后，入口默认显示。用户可以在插件详情关闭“显示在侧边栏”；这只隐藏
  导航入口，不停用插件，也不关闭 tool、network、panel 或后台能力；
- 主视图与 panel 共用同一 Ghost WebView 沙箱：零 Node、零通用 preload、每插件专属
  partition、CSP 和导航守门不变。`mainView` 本身不附赠联网、文件、凭证或其它能力；
- 页面需要电子脑逻辑时仍先 `fetch('/wake')`，通信和媒体协议与 §5 完全相同。插件停用、
  卸载或失去批准后，Host 会卸载页面并退出该路由。
