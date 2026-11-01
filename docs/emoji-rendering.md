# Emoji 实际渲染检测

`emojiStyle` 在浏览器中实际绘制 `😀 🍎 🚀 ❤️ 👩‍💻 🏳️‍🌈`，读取 Canvas 像素，记录彩色像素、字形及组合渲染对照。完整扫描、单项复检和插件运行器使用同一实现。

字体识别对照成功加载的本机 Apple Color Emoji、Segoe UI Emoji、Noto Color Emoji、Twemoji Mozilla。至少四组有效样本全部逐像素匹配且只有一个参考字体匹配，才显示该字体；不下载字体，不以 User-Agent 代替渲染结果。User-Agent 只用于说明测得字体是否符合该系统的常见默认设置。

参考字体后使用内置合成缺字字体，覆盖样本字符及 VS16 变体。参考字体缺少字形时会落到已知方块，避免系统 Emoji 回退造成假匹配。该字体不用于默认样本，不加入页面样式；检测结束后删除临时 FontFace。可通过 `python3 scripts/build-emoji-fallback.py` 重新生成，无额外依赖。

详情中的图片来自本次 Canvas 绘制；样本和像素对照留在本机。无法访问像素、重复读回不稳定或本机字体受限时保留具体原因；无法识别字体不等于无法绘制 Emoji。组合判定比较 ZWJ 序列与移除 ZWJ 后的像素和宽度，只覆盖列出的两组样本。

此项为观察信息，排除在风险分、验证分分母和异常统计之外。Apple、Windows 或 Android 字体均不直接加分；与系统常见默认字体不同只提示核查自定义字体，不证明设备伪装或账号风险。旧的 UA 推断加分也不会重新进入评分。

验证入口：`npm run test:emoji`、`npm run test:repair`、`node --test scripts/check-gateway-model.cjs`。跨系统字体匹配仍应在相应的 Windows、Android 或 Linux 浏览器上实测；本机 Mac 的通过不能替代其他系统验证。

2026-11-01 本机 Chromium 实测：6/6 组彩色样本匹配 Apple Color Emoji，2/2 组 ZWJ 合并渲染得到确认。仅改变系统声明仍识别 Apple；阻止像素读取时无法判定；将参考字体替换为缺少 Emoji 字形的 Arial 时，各参考均为 0/6 匹配。生产页面单项复检及 1200px、390px 窗口检查通过。
