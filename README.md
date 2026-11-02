# DeepSeek Sidebar · DeepSeek 侧边栏助手

在浏览器右侧边栏直接使用 **DeepSeek 官方网页版**（`chat.deepseek.com`），
不切换标签页、不离开当前页面；另外支持在任意网页上**划词翻译**。

基于 Manifest V3 + `chrome.sidePanel` + 全屏 iframe，把 DeepSeek 官方页面装进侧边栏，
并针对官方的嵌入限制做了必要处理。

---

## 为什么不能直接用一个 `<iframe>`

把官方页面塞进 `<iframe>` 是最直觉的做法，但 DeepSeek 不允许：

```http
$ curl -I https://chat.deepseek.com/
content-security-policy: frame-ancestors 'none'
```

`frame-ancestors 'none'` 会**禁止任何页面**（包括 `chrome-extension://` 页面）把它放进框架，
浏览器只会显示一句 "refused to connect"。好消息是：

- 没有 `X-Frame-Options`
- 页面脚本里**没有** framebusting（`window.top !== window.self` 之类的跳出逻辑）
- 静态资源 CDN 的 CORS 白名单是 `https://chat.deepseek.com`，
  而 iframe 自身的 origin 正是它，所以 `crossorigin` 的 JS/CSS 照常加载

也就是说：**只要移除那一个响应头，官方页面就能正常嵌入。**

本扩展用 `declarativeNetRequest` 静态规则实现（见 `rules/frame.json`），
并且**只作用于 `sub_frame`**：

```json
{
  "condition": {
    "requestDomains": ["deepseek.com"],
    "resourceTypes": ["sub_frame"]
  }
}
```

副作用被限制到最小：你在普通标签页访问 DeepSeek 时，`frame-ancestors` 依旧生效、
CSP 依旧完整；只有「被扩展放进侧边栏的那一层子框架」会移除该头。
（`script-src` 等其余指令不受影响 —— 实际上 `remove` 会移除整个 CSP 头，
扩展内没有注入任何远程脚本，页面自身脚本仍由 SRI 完整性校验保护。）

---

## 安装（开发者模式）

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录 `deepseek-sidebar`
4. 点击工具栏中的 DeepSeek 图标 → 右侧边栏打开
5. （首次安装会自动打开设置页，可查看「运行状态」四项检测是否全部为绿）

要求 **Chrome / Edge 116+**（`chrome.sidePanel` 与 `openPanelOnActionClick`，Chrome 116 起支持）。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 侧边栏官网 | 全屏 iframe 加载 `chat.deepseek.com`，与网页版完全一致 |
| 划词翻译 | 选中文字 → 浮出「译」按钮 → 点击 → 浮窗显示译文（详见下一节） |
| 图标即开 | 点击工具栏图标直接展开侧边栏（`setPanelBehavior`） |
| 右键菜单 | 任意页面右键 → 「在 DeepSeek 侧边栏中打开」/「在独立窗口中打开」 |
| 悬浮工具条 | 右下角半透明按钮组：重新加载 / 新标签页打开 / 独立窗口 / 设置；可在设置中隐藏 |
| 加载页 | DeepSeek 蓝色主题的加载动画（支持深浅色）；若页面已开始渲染则 4 秒内让位，不遮挡可交互内容 |
| 失败兜底 | 22 秒仍未加载完成时显示恢复面板，可一键重试或改用标签页/独立窗口 |
| 设置页 | 首页地址、工具条开关、翻译引擎与目标语言、五项运行状态自检 |
| 状态自检 | 嵌入规则、站点权限、翻译引擎、`sidePanel` 可用性、浏览器版本 |

---

## 划词翻译

在任何网页上选中文字（拖选、双击选词、Shift+方向键都支持），选区旁会出现一个「译」按钮，
点击后在原地弹出译文浮窗，可一键复制、重试或跳到设置。

**只有点按钮时才会发出请求** —— 单纯选中文字不会触发任何网络访问。

### 翻译引擎

| 引擎 | 是否需要配置 | 说明 |
| --- | --- | --- |
| DeepSeek 官方 API（推荐） | 需要 API Key | 走 `api.deepseek.com`，提示词专门为翻译调过，质量最好，按量计费 |
| 免费公共接口 | 无需配置 | 走 MyMemory 公共接口，单次上限约 500 字符，**会把选中文本发给第三方**，默认关闭 |

API Key 存在 `chrome.storage.local`（**不参与同步**，不会上传到 Google 账号），
只用于向 `api.deepseek.com` 发起请求。

### 为什么不用「已登录的网页版会话」

这是最自然的想法，但实测行不通。DeepSeek 网页版的对话接口有两道门：

```js
// main.d1d163b7e4.js
Authorization: "Bearer " + userToken          // token 在 localStorage，不在 Cookie 里
POST /api/v0/chat/create_pow_challenge        // 必须先解一个 PoW 挑战
   { target_path: "/api/v0/chat/completion" }
```

也就是说光有登录态不够，还得先算出一个 **工作量证明** 才能调用 `/api/v0/chat/completion`。
那是官方的反滥用机制，本扩展不会去实现绕过它的解题器 —— 所以翻译走的是官方 API（你自愿提供 Key），
或明确标注、需要手动开启的第三方免费接口。

### 实现要点

- 浮窗放在 **Shadow DOM** 里，页面 CSS 影响不到它，它也不会污染页面样式
- 样式通过 `adoptedStyleSheets` 注入，而不是 `<style>` 标签 —— 后者会被页面的
  `style-src` CSP 拦掉，在有严格 CSP 的站点上会直接消失
- 在 `all_frames` 下运行，选区在 iframe 里时，浮窗就渲染在那个 iframe 里，坐标始终正确
- 结果按「引擎+目标语言+原文」缓存，重复选中同一段文字是瞬时的

---

## 目录结构

```
deepseek-sidebar/
├── manifest.json          # MV3 清单
├── background.js          # Service worker：面板行为、右键菜单、消息总线、翻译引擎
├── sidepanel.html/.css/.js# 侧边栏：iframe + 加载页 + 失败兜底 + 工具条
├── options.html/.css/.js  # 设置页与自检
├── content/
│   └── selection.js       # 划词翻译：选区检测 + 按钮 + Shadow DOM 浮窗
├── rules/
│   └── frame.json         # declarativeNetRequest：移除子框架的嵌入限制
├── icons/                 # 16/32/48/128 图标 + 矢量 logo
└── dev/                   # 开发脚本（不参与扩展运行，可删）
    ├── verify.js          # 静态校验：JSON / JS 语法 / 资源引用 / DNR 规则 / 图标尺寸
    ├── e2e-test.js        # 端到端：无头 Chromium 真加载扩展并断言页面真的渲染
    └── pack.js            # 生成可分发的 zip
```

## 自动化验证

两个脚本都只在开发时使用，扩展运行时不会加载它们。

```bash
node dev/verify.js      # 静态检查，无需浏览器
node dev/e2e-test.js    # 端到端，需要一个 Chromium 内核浏览器
```

`e2e-test.js` 会以无头模式启动 Edge/Chrome、加载本扩展、打开 `sidepanel.html`，
再通过 CDP 连到**内嵌的 DeepSeek 子框架**里读取真实 DOM；随后起一个本地网页，
真的去选中一段中文、点按钮、等译文出现。实测结果（Edge 156）：

```
PASS  DNR ruleset registered            [["ds_frame_headers"]]
PASS  frame loaded real DeepSeek origin [https://chat.deepseek.com]
PASS  not a chrome error page           [https://chat.deepseek.com/sign_in]
PASS  nested login frames allowed       [2 iframe target(s)]
PASS  content script injected on the page
PASS  selecting text shows the 译 button
PASS  no request is sent until the button is clicked
PASS  popover shows the translation     [It's a nice day, let's go for a walk in the park.]
PASS  invalid API key surfaces a clear error
PASS  upstream still sends frame-ancestors (rule is what unblocks it)
...
22 assertions passed
```

划词翻译那几条是真跑出来的：本地页面里 `今天天气很好，我们一起去公园散步吧。`
经免费引擎翻译后，浮窗内容是 `It's a nice day, let's go for a walk in the park.`；
换成无效 API Key 时，浮窗显示 `DeepSeek API Key 无效或已过期，请在设置中更新。`
（说明请求确实按 Bearer 头打到了 `api.deepseek.com`，401 也被正确映射）。

侧边栏那部分，`rendered head` 抓到的就是真实渲染出的登录界面文字：

```
+86 发送验证码 注册登录即代表已阅读并同意我们的 用户协议 与 隐私政策 …
密码登录 使用 Apple 账号登录 微信扫码登录
```

这同时证明了一件事：如果只是简单地写一句 `<iframe src="https://chat.deepseek.com/">`，
这里拿到的会是 `refused to connect`；真正让它生效的是 `rules/frame.json`。

---

## 排错

**侧边栏白屏或提示 "refused to connect"**
打开设置页 → 看「运行状态」第一项「嵌入规则」是否为绿。
若为红：到 `chrome://extensions` 点本扩展的刷新按钮重新加载。

**修改了 `rules/frame.json` 不生效**
静态规则集只在扩展加载/更新时读取，必须重新加载扩展。

**侧边栏里要重新登录**
侧边栏与普通标签页共享同一套 `deepseek.com` Cookie，通常无需重复登录。
若无痕模式下两者隔离，属浏览器行为。

**太窄导致排版拥挤**
拖动侧边栏左侧边缘即可加宽（Chrome 会记住每个窗口的宽度）。
也可以用工具条里的「在独立窗口打开」，获得一个 480×860 的独立窗口。

**选中文字没有出现「译」按钮**
先看设置页里「启用划词翻译」是否打开。另外 `chrome://` 开头页面、Chrome 应用商店、
PDF 内嵌查看器和部分 `file://` 页面不允许注入内容脚本，这些地方不会有按钮。

**浮窗提示「还没有配置翻译引擎」**
在设置页填一个 DeepSeek API Key，或勾选「未配置 Key 时使用免费翻译接口」并保存。

**免费接口报「单次上限约 500 字符」**
这是该公共接口的限制，长段落在设置里配置 API Key 后即可翻译。

**是否会看到或上传我的对话内容？**
不会。扩展不注入任何脚本到 DeepSeek 页面、不读取 iframe 内容
（跨域 iframe 本身也无法读取），不做任何网络代理。

---

## 许可证

本仓库的**源代码**以 [MIT License](LICENSE) 发布，可自由使用、修改、分发。

例外：`icons/` 下的图标与 "DeepSeek" 名称、标识归杭州深度求索人工智能基础技术研究有限公司所有，
**不在 MIT 授权范围内**，仅为标识「本扩展加载的是 DeepSeek 官方页面」而使用。
如果你要基于本项目发布衍生作品，请替换为你自己的图标与名称。

本项目与深度求索公司无隶属关系，未获其背书。

---

## AI 辅助声明

本项目在 **AI 编程助手**辅助下完成：代码、样式、测试脚本与文档初稿由 AI 生成，
作者负责提出需求、确定技术取舍并验收。

需要说明的是，README 中引用的实测数据——`frame-ancestors 'none'` 响应头、
DNR 规则实际生效、划词翻译浮窗的真实输出、`22 assertions passed`——都来自运行时真实抓取，
不是模型臆测的结果；`dev/verify.js` 与 `dev/e2e-test.js` 都可以自行复跑核对。

由于存在 AI 生成成分，代码可能仍有未被测试覆盖的边界情况。使用前建议通读源码，
尤其是这两处会实际影响浏览器的部分：

- `content/selection.js` —— 内容脚本，会注入到所有 http(s) 页面
- `rules/frame.json` —— 会修改 `deepseek.com` 子框架的响应头

对外分发时请同时遵循 MIT 许可证与「许可证」一节的商标说明。
