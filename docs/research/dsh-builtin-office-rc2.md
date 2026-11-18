# DSH 0.2.1-rc.2 内置办公能力核对

核对日期：2026-11-18。目标为内网 Windows 桌面版；源码版本为 `dsh-v0.2.1-rc.2`，提交 `687f282e8625c6b8d11ff58211a90524be2e4317`。

## 结论

官方桌面版已具备 Word、Excel、PPT 常规创作/编辑技能，以及渲染、公式重算、Office 导出 PDF 的操作技能。能力中心应复用这套离线环境，补充常用操作与可靠的使用入口。PDF 通用页面操作、专门的文字/表格提取与 OCR 工作流需要另行补齐。

本轮核对源码、打包配置、依赖锁定文件及上游测试定义，没有在目标 Windows 安装包中执行实机验收，也没有运行上游 Vitest。不能把测试文件中的期望视为本轮测试通过。

## 内置技能

[提供者源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-office/src/index.ts) 注册七项：

| 技能 | 已定义用途 |
|---|---|
| `office` | 按任务选择创作或操作技能 |
| `office-docx` | DOCX 读取、新建、普通编辑、内容与结构验证 |
| `office-xlsx` | XLSX 读写、数据处理、公式与样式编辑、内容验证 |
| `office-pptx` | PPTX 读取、新建、普通编辑、图文表格和图表处理 |
| `office-render` | 文档/PDF 页面或表格范围渲染成图片、视觉检查指引 |
| `office-recalculate` | 刷新电子表格公式缓存并核对计算结果 |
| `office-export-pdf` | 将 Office 文件转换为 PDF |

这些是模型可按需加载的技能说明。提供者本身不注册每个办公动作的独立工具；模型遵循技能说明，通过脚本与命令行完成实际操作。[包说明](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-office/README.zh.md)

## 桌面默认集成与依赖

Desktop Host 启动时挂载 `desktopOffice`；该组合安装工作区依赖查询工具和 Office 技能提供者，传入已打包的 Node、技能资源和 LibreOffice Kit CLI 路径。[Host 入口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop-host/src/index.ts)、[Office 组合](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop-host/src/office.ts)

技能提供者将候选标记为 `bundled`、`dsh-office`，允许模型和用户调用；注册到全局层的技能可以与调用代理的作用域层合并读取。具体自定义代理仍受其工具组合与权限影响，不能保证纯 shell/minimal 或人为裁剪后的环境都呈现相同工具入口。[技能注册表](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts)

[主运行时锁定文件](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/scripts/primary-runtime/lock.json) 包含：

| 包 | 锁定版本 | 主要用途 |
|---|---|---|
| `python-docx` | 1.2.0 | DOCX 内容与普通格式操作 |
| `python-pptx` | 1.0.2 | PPTX 内容、形状、图表操作 |
| `openpyxl` | 3.1.5 | XLSX 读取与定点修改 |
| `pandas` | 3.0.1 | 表格数据分析与转换 |
| `XlsxWriter` | 3.2.9 | 创建新 XLSX，不负责读取已有文件 |
| `numpy` | 2.3.5 | 数值计算 |
| `Pillow` | 12.3.0 | 图片处理 |
| `lxml` | 6.1.3 | XML/文档结构处理 |

Desktop 打包流程会选择目标平台的 LibreOffice Kit 引擎并保留依赖闭包；缺少所选引擎 `prebuilds.json` 会令构建失败。通用技能文档中“缺少 sidecar 时下载”的说明不能据此解释成官方桌面包默认没有引擎。[桌面打包](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/scripts/prepare-dsh.ts)、[引擎选择与闭包](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/scripts/libreoffice-packages.mjs)

Windows/不同 CPU 应使用实际目标匹配的引擎；选择规则是优先 manifest 声明的本机平台包，否则选 WASM。最终安装文件是否完整、所需字体是否齐全，仍需在内网目标机验收。

## 各类限制与建议

- **Word**：普通段落、表格、样式修改可复用内置库。复杂域、真实修订、特殊 OOXML 特性与原生排版一致性需要专项验证；`python-docx` 本身不分页或渲染。[技能正文](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-office/assets/office-docx/SKILL.md)
- **Excel**：读取/修改公式与计算公式是不同操作。`openpyxl`/`XlsxWriter` 不计算公式；需要刷新计算结果时使用内置重算技能。宏、旧格式、加密与高级工作簿特性单独验证。[技能正文](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-office/assets/office-xlsx/SKILL.md)
- **PPT**：支持常规可编辑内容；重建已有幻灯片可能损失动画、SmartArt 等未完整支持的扩展特性。[技能正文](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-office/assets/office-pptx/SKILL.md)
- **PDF**：已有 Office 转 PDF 与 PDF 渲染路径；没有单独的 PDF 通用技能。上述 Python 锁定清单未包含 `pypdf`、`pdfplumber`、`PyMuPDF` 或专门 OCR 包。该清单不能证明整机不存在其他工具，但不能据此宣传默认拥有 PDF 合并/拆分/OCR 能力。
- **图像理解**：能渲染页面不等于当前模型能理解图像。视觉检查技能要求先确认模型支持图像；OCR 可以独立识别为文本后交给现有模型处理，但识别引擎需要另备。[渲染技能](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-office/assets/office-render/SKILL.md)

## 能力中心后续实现方向

1. 保留 PDF、Word、Excel、PPT 四类办公入口。
2. Word/Excel/PPT 复用官方技能、运行时和转换引擎；增强包提供常用任务、输入输出约定与使用示例。
3. PDF 第一阶段补充合并、拆分、抽页、旋转和文本提取；表格提取与 OCR 按依赖及实际样例单独验收。
4. 展示“DSH 已内置”的底座与需要安装的增强部分；卸载增强包不移除宿主内置组件。
5. 用户已表示 WPS 若复杂或不足可以不用，故首版不绑定 WPS。另见 [WPS 本地集成评估](wps-local-office-integration.md)。
