# Oh My TeX

**在 LaTeX 源码中，原位可视化编辑公式。**

[![VS Code](https://img.shields.io/badge/VS_Code-1.100%2B-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../LICENSE)
[![MathLive](https://img.shields.io/badge/powered_by-MathLive-blue)](https://github.com/arnog/mathlive)

[English](../README.md) · 简体中文

[GitHub 项目](https://github.com/MuteLoc0/oh-my-tex) · [版本发布](https://github.com/MuteLoc0/oh-my-tex/releases) · [问题反馈](https://github.com/MuteLoc0/oh-my-tex/issues)

Oh My TeX 是一个 VS Code 插件，让 LaTeX 正文源码与可编辑的公式显示在同一页。正文继续按 LaTeX 源码书写，点击公式后，通过 [MathLive](https://github.com/arnog/mathlive) 直接编辑分式、上下标、矩阵等数学结构。

该插件使用[CodeMirror 6](https://github.com/codemirror/dev)新增了一个公式可视化编辑器，`.tex` 文档始终是唯一的数据来源。未编辑的公式不会被重写；可视编辑时，插件尽量保留已有的 LaTeX 写法和格式。配合 [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop)，还可以编译、查看 PDF，并通过 SyncTeX 在源码与 PDF 之间定位。

## 演示

> GIF 演示即将补充。

<!-- 
![公式原位可视编辑](../images/demos/visual-editing.gif)
![命令补全与宏参数编辑](../images/demos/macros-and-completion.gif)
![切换源码并定位 PDF](../images/demos/source-and-pdf.gif)
-->

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用方法](#使用方法)
- [快捷键与命令](#快捷键与命令)
- [配置](#配置)
- [兼容性与已知限制](#兼容性与已知限制)
- [开发](#开发)
- [基于的开源项目与致谢](#基于的开源项目与致谢)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 功能

- **公式原位编辑。** 行内、独立公式及常见的 `equation`、`align`、`gather`、`multline` 环境直接显示为公式，进入后即可可视编辑。
- **项目宏支持。** 从根文档及其 `\input` / `\include` 文件中发现 `\newcommand`、`\DeclareMathOperator`、`\def` 等定义。支持的宏参数可在浮层中编辑，包括可选参数与嵌套参数。
- **补全与模板。** 整合 MathLive 命令、项目宏、自定义片段及可用的 VS Code / LaTeX Workshop 补全。
- **跟随 VS Code 外观。** 使用当前主题与编辑器字体配置。安装 Workshop 时读取其 TextMate 语法为 LaTeX 源码着色，否则使用基础高亮。
- **PDF 工作流。** 通过 LaTeX Workshop，在可视编辑器内发起编译、查看 PDF 与正向 SyncTeX 定位。

## 安装

### 环境要求

- Oh My TeX 要求 **VS Code 1.100 或更高版本**。LaTeX Workshop 可能要求更新的版本，请参考其[安装说明](https://github.com/James-Yu/LaTeX-Workshop/wiki/Install)。
- 推荐安装 **LaTeX Workshop**，获得更完整的补全与源码着色；SyncTeX 命令需要它。
- 编译 PDF 需要已为 Workshop 配置好的 **TeX 发行版**。仅可视编辑公式时，无需安装 TeX。

## 使用方法

### 1. 打开可视编辑器

打开一个 `.tex` 文件，在编辑器标签页右键菜单中选择 **Reopen Editor With… → Oh My TeX（重新打开编辑器的方式）**。也可以通过命令面板执行 **Oh My TeX: Open Visual Editor / Toggle Source Mode**进入插件的可视编辑器。



快捷键为 macOS 的 `Cmd+Option+Shift+M`，或 Windows / Linux 的 `Ctrl+Alt+Shift+M`。进入可视编辑器后，再次执行同一命令，会在整页可视模式与源码模式之间切换。

### 2. 写正文、编辑公式

正文和文档命令继续按 LaTeX 源码书写。点击渲染后的公式，或用方向键移入公式，即可可视编辑。

在活动公式中按 **Esc** 可以显示该公式的源码；如果补全列表或宏参数浮层已打开，Esc 会先关闭它们。需要在当前位置打开 VS Code 原生源码编辑器时，执行 **Oh My TeX: Open Native Source at Cursor**。

### 3. 使用补全、编辑宏参数

输入命令前缀，或按 **Ctrl+Space** 请求补全。用 **↑ / ↓** 选择候选，按 **Tab** 接受。默认情况下，Enter 保持正常编辑行为；将 `oh-my-tex.completion.acceptOnEnter` 设为 `true` 后，也可用 Enter 接受候选。

对于有多个参数的命令，用 **Tab / Shift+Tab** 在参数之间移动。在已激活的公式中，点击渲染后的宏或其工具栏按钮，打开参数编辑浮层；也可以把光标放在宏后，按 **Alt+Enter**，macOS 对应 **Option+Enter**。在参数浮层中，Tab / Shift+Tab 切换参数，Enter 或 Esc 结束参数编辑。写回源码时仍保留原宏调用。

### 4. 编译并定位 PDF

**Oh My TeX: Build with LaTeX Workshop**、**Oh My TeX: View PDF with LaTeX Workshop**、**Oh My TeX: SyncTeX from Cursor**等操作在当前版本可能会激活原生文本编辑器，体验较差。如有后续版本，会考虑优化。

### 5. 使用多文件项目

在 VS Code 中打开项目文件夹。对于被引用的章节文件，推荐用相对于该章节的路径声明根文档：

```tex
% !TeX root = ../main.tex
```

也可以执行 **Oh My TeX: Choose Root Document** 手动选择。魔法注释优先于已保存的手动选择；两者都没有时，插件也会查找工作区内唯一引用当前文件的根文档。

如果 Workshop 显示了其他项目的 PDF，执行 **Oh My TeX: Sync Workshop Root and View PDF**，显式刷新 Workshop 的根文档上下文并打开 PDF。

## 快捷键与命令

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 打开可视编辑器 / 切换整页源码模式 | `Cmd+Option+Shift+M` | `Ctrl+Alt+Shift+M` |
| 使用 LaTeX Workshop 编译 | `Cmd+Option+B` | `Ctrl+Alt+B` |
| 使用 LaTeX Workshop 查看 PDF | `Cmd+Option+V` | `Ctrl+Alt+V` |
| 从光标发起正向 SyncTeX | `Cmd+Option+J` | `Ctrl+Alt+J` |
| 查找 / 替换（`Find in Visual Editor`） | `Cmd+F` | `Ctrl+F` |
| 保存 | `Cmd+S` | `Ctrl+S` |
| 撤销 / 重做 | `Cmd+Z` / `Cmd+Shift+Z` | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 请求补全 | `Ctrl+Space` | `Ctrl+Space` |
| 编辑光标处的宏参数 | `Option+Enter` | `Alt+Enter` |

macOS 的 Option 即 Alt。系统可能把 Ctrl+Space 分配给输入法切换；遇到冲突时，可通过输入命令前缀触发补全，或调整系统快捷键。

除了表中的操作，还有 **Open Native Source at Cursor**、**Choose Root Document** 和 **Sync Workshop Root and View PDF**。
## 配置

在 VS Code 设置中搜索 **Oh My TeX**，或在工作区的 `.vscode/settings.json` 中添加配置：

```json
{
  "oh-my-tex.completion.acceptOnEnter": false,
  "oh-my-tex.macros": {
    "\\R": "\\mathbb{R}"
  },
  "oh-my-tex.renderMacros": {
    "\\slashed": { "args": 1, "def": "\\cancel{#1}" }
  },
  "oh-my-tex.templates": [
    {
      "prefix": "\\sumn",
      "label": "从 n 到 N 求和",
      "body": "\\sum_{${1:n=1}}^{${2:N}} $0",
      "context": "math"
    }
  ],
  "oh-my-tex.math.inlineShortcutOverrides": {
    "alpha": "\\alpha"
  }
}
```

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `oh-my-tex.completion.acceptOnEnter` | `false` | 允许 Enter 接受补全；Tab 始终可以接受。 |
| `oh-my-tex.macros` | `{}` | 额外的编辑器宏；发现的项目定义优先。 |
| `oh-my-tex.renderMacros` | `{}` | 仅覆盖显示，优先于项目宏、兼容映射与内置定义；不新增补全项，也不修改源码。 |
| `oh-my-tex.templates` | `[]` | 使用 VS Code 片段语法的补全模板；上下文可选 `math`、`prose`、`both`。 |
| `oh-my-tex.math.inlineShortcuts` | `true` | 启用 `<=`、`>=`、`!=`、`->` 等符号输入快捷替换。 |
| `oh-my-tex.math.inlineShortcutOverrides` | `{}` | 添加或覆盖输入快捷替换；空字符串可以禁用某个默认项。 |
| `oh-my-tex.math.completionAllowPatterns` | `[]` | 用正则表达式源字符串允许额外的公式补全候选。 |
| `oh-my-tex.workshop.nativeEditorColumn` | `"beside"` | 在旁边打开原生源码，也可设为 `"same"` 使用同一编辑器组。 |
| `oh-my-tex.workshop.returnToVisualEditor` | `true` | 正向 SyncTeX 后将焦点返回可视编辑器。 |
| `oh-my-tex.workshop.primeRoot` | `true` | Workshop 操作前激活根文档的原生源码编辑器。 |

编辑器宏影响可视渲染与补全，不会替 TeX 编译器定义命令；文档中仍需保留相应定义和宏包。部分显示映射只是近似，例如上面用 `\cancel` 模拟 `\slashed` 的配置。

需要保存后自动编译时，可设置 `"latex-workshop.latex.autoBuild.run": "onSave"`。Oh My TeX 使用现有的 Workshop 编译配方，不会自动修改它们。

## 兼容性与已知限制

- 可视编辑器渲染数学公式，正文仍显示为 LaTeX 源码。页面布局、编号、引用、图片及宏包的最终排版效果，请以编译后的 PDF 为准。
- 支持常见定界符（`$…$`、`$$…$$`、`\(…\)`、`\[…\]`）与已支持的数学环境。`alignat`、`eqnarray`，含注释、`\verb` 或动态 TeX 代码的公式，以及其他不支持的结构会保留为源码编辑。
- 未知或不支持的命令可能显示为保留源码的小标签。项目宏发现采用静态分析，无法覆盖任意 TeX 展开行为或所有宏包定义。
- 已编辑公式的写回可能从 token 修改退回到外围分组或整个公式体。如果解析或序列化结果不足以安全替换公式体，插件会拒绝该次修改、显示原因，并切换到源码编辑。因此，编辑后的格式保留属于尽力而为。
- SyncTeX 目前体验较差。
- 公式处于活动状态时修改主题颜色，可能导致公式字段重建并结束当前编辑会话。
## 开发

使用 **Node.js 24 与 npm**。克隆仓库后执行：

```sh
npm ci
npm run build
code --extensionDevelopmentPath="$PWD" examples/main.tex
```

在扩展开发宿主窗口中执行 **Oh My TeX: Open Visual Editor / Toggle Source Mode**。调试 Webview 时，执行 **Developer: Open Webview Developer Tools**。开发期间可以运行 `npm run watch`，重新构建后重新加载开发窗口。

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建宿主与 Webview，复制数学字体与 Oniguruma WASM，并检查 bundle 激活。 |
| `npm run watch` | 文件变化时重新构建。 |
| `npm run check-types` | 检查核心、宿主与 Webview 的 TypeScript 类型。 |
| `npm run test:unit` | 运行核心与同步逻辑单元测试。 |
| `npm run test:browser` | 使用模拟宿主，在 Chromium 中测试真实 Webview bundle；首次运行前用 `npx playwright install chromium` 安装浏览器。 |
| `npm test` | 构建并运行 VS Code 集成测试；涉及 Workshop / TeX 的用例需要在测试环境中提供相应工具。 |
| `npm run vsix` | 构建并打包可安装的插件。 |

完整脚本见 [`package.json`](../package.json)，示例文档见 [`examples/`](../examples/)。`src/core` 放置解析与写回等纯逻辑，`src/host` 负责 VS Code 集成，`src/webview` 实现可视编辑器。

## 基于的开源项目与致谢

Oh My TeX 基于以下开源项目构建：

| 项目 | 在 Oh My TeX 中的作用 |
| --- | --- |
| [MathLive](https://github.com/arnog/mathlive) | 可视数学字段、公式渲染与数学编辑；当前项目固定使用 **0.110.0**。 |
| [CodeMirror 6](https://github.com/codemirror/dev) | Webview 中的源码编辑器、选区、搜索与公式装饰。 |
| [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) | 可选安装的协作插件，提供补全、TextMate 语法、编译、PDF 查看与 SyncTeX。 |
| [vscode-textmate](https://github.com/microsoft/vscode-textmate) | LaTeX 源码的 TextMate 分词与高亮。 |
| [vscode-oniguruma](https://github.com/microsoft/vscode-oniguruma) | TextMate 使用的 WebAssembly 正则引擎。 |
| [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) | 读取带注释的 JSON 主题数据。 |

浏览器回归测试还使用了 LaTeX Workshop 语法样本，其上游为 [vscode-latex-basics](https://github.com/jlelong/vscode-latex-basics)，以及 [Ayu](https://github.com/ayu-theme/vscode-ayu) 主题样本。版本、来源与许可证声明见[测试样本说明](../test/fixtures/textmate/README.md)。这些样本仅用于测试；运行时读取用户安装的 Workshop 与主题。

感谢上述项目的维护者与贡献者。第三方组件保留各自的许可证。

## 参与贡献

欢迎在 [MuteLoc0/oh-my-tex](https://github.com/MuteLoc0/oh-my-tex) 提交问题与 Pull Request。[报告问题](https://github.com/MuteLoc0/oh-my-tex/issues)时，请提供最小 `.tex` 示例、预期与实际行为、操作系统和插件版本，以及是否安装了 LaTeX Workshop。

## 许可证

[MIT](../LICENSE) © 2026 MuteLoc0。
