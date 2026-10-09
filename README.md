# cn.mcd7.neglectdream.anime-glass

二次元风格的 [NarraFork](https://github.com/NarraFork/NarraFork) 主题插件：樱花壁纸铺满整个界面，侧边栏、顶栏、底栏与各容器面板变成半透明磨砂玻璃，**配色跟随壁纸自动变化**。

- 🖼️ **壁纸**：浅色 = 白天樱花天空，深色 = 月夜樱花天空，跟随系统配色
- 🧊 **磨砂玻璃**：半透明面板 + 内部高光边缘 + 柔和阴影
- 🎨 **动态配色**：从壁纸提取主色调，浅色方案偏白、深色方案偏黑
- 📁 **换图不用重新打包**：把图片丢进文件夹即可

| | |
| --- | --- |
| pluginId | `cn.mcd7.neglectdream.anime-glass` |
| 主题 | `sakura-glass`（静态）、`sakura-glass-live`（动图） |
| 作者 | NeglectDream |
| 宿主能力 | `ui.theme`、`ui.panel` |
| 许可证 | MIT（含 BSD-3-Clause 的 vendored 组件） |

## 展示图

<img width="2559" height="1355" alt="image" src="https://github.com/user-attachments/assets/d17dca8f-9cbc-43bc-851b-ece1213654ad" />
<img width="2559" height="1345" alt="image" src="https://github.com/user-attachments/assets/537575d2-e0e4-42b5-80f7-5d1535ffaec6" />
<img width="1920" height="1018" alt="QQ20261009-212812-HD" src="https://github.com/user-attachments/assets/1fb83185-a91f-470a-b718-fa4ece756649" />
<img width="1920" height="1008" alt="QQ20261009-212846-HD" src="https://github.com/user-attachments/assets/eeaa841b-ff13-4c3b-9a2f-3d391d07cc1d" />

## 安装

**安装和启用是两步，都要做。**

1. **安装**（管理员）：在「插件管理」中导入 `cn.mcd7.neglectdream.anime-glass-<version>.nfplugin`
2. **启用主题**（每个用户）：**设置 → 外观 → 插件主题**，选中 `AnimeGlass`
   <img width="2163" height="1052" alt="image" src="https://github.com/user-attachments/assets/28930add-2245-4296-984c-c00c0c675536" />

只做第一步界面不会有任何变化。

## 换壁纸

插件首次运行时会把自己带的默认壁纸放进这个文件夹，用你的图片替换同名文件即可：

```
~/.narrafork/plugins/data/cn.mcd7.neglectdream.anime-glass/wallpapers/
```

| 文件名 | 用途 | 对应主题 |
| --- | --- | --- |
| `day.png`（也可 `.jpg` / `.webp`） | 浅色壁纸 | AnimeGlass |
| `night.png`（也可 `.jpg` / `.webp`） | 深色壁纸 | AnimeGlass |
| `day.gif` / `night.gif` | 动图壁纸 | AnimeGlass Live |

- 支持 **PNG / JPEG / WebP / GIF**，单文件上限 **10 MiB**，超过不会加载。
- 格式按文件内容判断，不看扩展名；不符的文件会被跳过并在日志中说明。
- 换完几秒内自动生效，**不需要刷新浏览器**。
- 「壁纸管理」面板：**设置 → 插件 → 点本插件 → 「设置视图」**。

## 配色跟随壁纸

后端解码壁纸、提取主色调，据此派生两套方案的面板色：

| | 取自 | 派生结果 |
| --- | --- | --- |
| 浅色方案 | `day.*` 的色相 | 压到接近白，带一点壁纸色相 |
| 深色方案 | `night.*` 的色相 | 压到接近黑，带一点壁纸色相 |

只有**色相和饱和度**来自壁纸，亮度按方案固定，以保证文字对比度。

> **只有配色需要重载插件。** 壁纸几秒内就会更新，但颜色要等宿主重新编译主题 CSS——到插件管理里**禁用再启用**一次即可（或重启 NarraFork）。

## 已知限制

- **没有真正的背景模糊。** 主题 token 白名单里没有 `backdrop-filter`，这里实现的是半透明磨砂玻璃，面板背后的内容不会被实时虚化。
- **不支持视频壁纸。** 主题资源白名单只允许位图与 WOFF2。
- **壁纸不能用 SVG。**

## 自定义

**换壁纸**：见上文。图片建议 16:9、≥1920 宽，保持低对比柔和——浅色方案配明亮图、深色方案配深暗图，反过来会让文字失效。

**调颜色**：改 `manifest.json` 里对应方案的 `body` / `gradients` / `textColors`。后端会在下次扫描时根据壁纸重新生成这些值，想固定下来就停用 `server/index.js` 里的 `retintFromWallpapers()`。

**换回程序生成的占位图**：

```bash
node tools/generate-wallpaper.mjs           # → assets/day.png   1920x1080（浅色）
node tools/generate-wallpaper.mjs --night   # → assets/night.png 1920x1080（深色）
node tools/generate-frame.mjs               # → assets/glass-frame.png     64x64
```

脚本输出 PNG，需要同步改 `manifest.json` 的 `image`，或把文件另存为 `.jpg`。

## 开发

```bash
node tools/inspect-wallpaper.mjs [file…]    # 检查壁纸尺寸与文字对比度（WCAG AA）
node tools/build-themes.mjs                 # 从静态主题派生动图主题变体
node tools/pack.mjs                         # 打包为 .nfplugin
```

```
manifest.json               插件清单（主题 + 面板 + 后端声明）
server/                     后端：壁纸落盘、取色、RPC
ui/                         设置面板
assets/day.jpg              浅色壁纸
assets/night.jpg            深色壁纸
tools/                      素材生成、壁纸检查、打包脚本
vendor/jpeg-js/             vendored 解码器（BSD-3-Clause，仅 decoder）
sbom.spdx.json              SBOM
```

`assets/day-live.gif` 与 `night-live.gif` 不在包里，由后端在用户提供 GIF 时写入。

## 许可证

本插件源码采用 **MIT**。

`vendor/jpeg-js/` 采用 **BSD-3-Clause**（Copyright (c) 2014, Eugene Ware），仅打包 decoder 并保留其原始 LICENSE。详见 `sbom.spdx.json`。
