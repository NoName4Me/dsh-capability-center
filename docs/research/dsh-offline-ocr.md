# DSH 能力中心离线 OCR 调研

核对日期为 2026-11-20。建议用 **Tesseract.js（WebAssembly）做 DSH 本地插件**，先交付简体中文和英文印刷体的图片识别，再接扫描 PDF。引擎、语言模型和运行依赖随同一个 TGZ 分发，在本机 CPU 上识别。已在 macOS 禁网环境验证单包安装与识别，Win10 和 Win7 的 DSH 集成及识别质量需要实机验收。

## 两套目标终端

| 终端 | DSH | 首轮实机目标 |
| --- | --- | --- |
| Windows 10 x64 | `deepseek-harness-0.2.1-rc.2` | 建立图片识别、插件生命周期和 PDF 渲染基线 |
| Windows 7 x64 | `deepseek-harness-0.2.1-rc.5-win7` | 尽早用同一制品跑通 Node worker、WASM、中文路径和 PDF 渲染，记录系统补丁及 CPU |

两版源码均锁定 Node.js `24.21.0`，都提供随包 LibreOffice Kit CLI 的 PDF 渲染路径。WASM 方案复用 DSH 的 Node，省去单独分发 Windows OCR 原生 EXE/DLL 的依赖闭包。Win7 仍取决于该版本 DSH 实际运行时的 worker 和 WASM 能力。 [目标环境](../../DESIGN.md#内网终端环境) · [两版运行时与内置工具](dsh-builtin-capabilities.md)

## 引擎选型

| 方案 | 取舍 |
| --- | --- |
| Tesseract.js 7 + `tessdata_fast` 简中、英文 | 首选验证。Node worker 能从本地路径加载模型，输出文本、坐标和引擎置信度。引擎与模型使用固定版本，由同一插件交付。 [本地安装](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/local-installation.md) · [API](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/api.md) · [语言模型及许可证](https://github.com/tesseract-ocr/tessdata_fast) |
| 原生 Tesseract 5 | Win10 性能对照或回退候选。官方有 CLI、文本与 TSV 输出文档，较新的 Windows 安装程序由第三方提供。上游目前列出的 Windows 支持范围从 Win10 起。 [Windows 制品](https://tesseract-ocr.github.io/tessdoc/Downloads) · [支持系统](https://tesseract-ocr.github.io/tessdoc/supported-operating-systems.html) · [CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html) |
| Windows 系统 OCR | `Windows.Media.Ocr` 从 Windows 10 提供。微软对桌面应用要求运行进程具有包标识，离线终端还需预置对应的 OCR 语言功能包。可作 Win10 对照。 [OCR API](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine?view=winrt-19041) · [包标识要求](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr?view=winrt-26100#remarks) · [语言功能包](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/features-on-demand-language-fod?view=windows-10#ocr) |
| PP-OCRv5 mobile（CPU） | 中文质量备选。PaddlePaddle 3.0.0 的 Windows x64 / Python 3.12 wheel 单独就有 97.1 MB，且默认 Windows CPU 安装包要求 AVX。现有能力中心只接收纯 Python wheel，单制品上限为 32 MiB。试点需独立预置运行时、检测及识别模型，并核对所选 PaddleX 版本的模型源探测行为。Win7 上的 DSH PythonVista 仍需验证能否加载整套原生依赖。 [Windows CPU 安装](https://github.com/PaddlePaddle/docs/blob/release/3.0/docs/install/pip/windows-pip.md) · [Windows wheel](https://pypi.org/project/paddlepaddle/3.0.0/#paddlepaddle-3.0.0-cp312-cp312-win_amd64.whl) · [本地模型参数](https://www.paddleocr.ai/v3.0.3/en/version3.x/pipeline_usage/OCR.html#421-specify-the-local-model-path-through-parameters) · [PaddleX 探测逻辑示例](https://github.com/PaddlePaddle/PaddleX/blob/v3.2.0/paddlex/inference/utils/official_models.py#L514-L543) · [Python 安装约束](../../PRODUCT.md) |

## 本轮原型实测

- 在 macOS arm64、Node `24.22.1` 上验证 `tesseract.js@7.0.0`、`tesseract.js-core@7.0.0` 和 `tessdata_fast` 标签 `4.1.0` 的 `chi_sim`、`eng`。模型使用本地绝对路径，以未压缩文件加载并关闭模型缓存。两个模型共约 6.28 MiB。通过 macOS sandbox 禁止进程联网。
- 将 npm 传递依赖、模型、测试脚本和夹具用 `npm pack` 打为一个 TGZ，约 **21.55 MiB**，解包约 **55.63 MiB**。pnpm `10.34.7` 在空 store 中禁网安装成功，分别覆盖显式 `--offline` 和普通本地 TGZ 安装。原型压缩包实测低于目录单制品 **32 MiB** 上限。技能 ZIP 另有 **48 MiB** 解包总量限制和 **2 MiB** 技能单文件限制。仍需验证 DSH 包管理器加载正式插件的结果。 [制品上限](../../src/engine/lib/manifest.js) · [ZIP 限制](../../src/engine/lib/archive.js) · [技能安装器](../../src/engine/lib/installers.js) · [DSH 本地包安装核查](dsh-rc2-capability-center.md)
- 同一张 1400 × 280 的合成印刷体图片分别保存为 PNG、JPEG，路径含中文及空格。两次均识别出「离线文字识别 OCR 2026」和「Invoice 12345」，并验证了 7 个词级结果的坐标与置信度。该版本的 JS TSV 实测没有表头，适配时应使用结构化 `blocks` 或按实际列解析。样本只覆盖清晰图片的最小链路，本轮未在目标 Windows、DSH 插件宿主、真实扫描 PDF 或业务数据上运行。

## 实施顺序

1. **图片首版。** 在能力中心上架「离线文字识别」插件，复用 Draw.io 的本地 TGZ、DSH 插件注册和回滚路径。面向会话注册 OCR 工具，接收 DSH 已授权访问的工作区文件，首版支持 PNG/JPEG、简中及英文印刷体。输出 UTF-8 文本和结构化 JSON，保留页码、阅读顺序、像素坐标及引擎原始置信度。先做单 worker、逐页限流，限制输入文件体积、解码像素、运行时间和返回内容大小。取消、超时或卸载时终止 worker 并清理临时文件。 [现有工具注册](../../src/capabilities/capability-center-drawio/plugin.js) · [安装、检查与回滚](../../DESIGN.md#更新与检查)
2. **扫描 PDF。** 优先复用 Office 增强的 pypdf 文本提取逻辑，增加逐页返回和原始页码。两套 DSH 随包的 LibreOffice Kit 可按页渲染，扫描页经渲染后复用图片识别。页眉、页码或已有 OCR 层都可能令提取结果非空，所以保留按页强制 OCR，防止漏掉混合页中的图像文字。JSON 标明每页来源为文本层或 OCR，文本层的 OCR 置信度留空。先确认插件能稳定发现两版宿主的渲染入口和 pypdf。依赖缺失时仍可执行图片 OCR，并在 PDF 入口给出具体错误。复杂表格还原、手写体、可搜索 PDF 延后。 [现有文本提取](../../src/capabilities/office-enhancement/scripts/office_tools.py) · [pypdf 文本提取边界](https://pypdf.readthedocs.io/en/stable/user/extract-text.html) · [Win10 渲染技能](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-office/assets/office-render/SKILL.md) · [Win7 渲染技能](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/skill/skill-office/assets/office-render/SKILL.md)
3. **分发和诊断。** 构建端锁定 npm 依赖和模型来源，用包内路径解析 worker、WASM 和模型，记录版本、SHA-256 及第三方许可证。用现有内网只读目录和离线制品链路分发，终端运行时直接读取包内数据，缺文件即报错。在插件运行态检查之外，复用现有 `named-tool-readonly-call` 增加固定图自检，验证双语识别结果和坐标。模型工作流与 OCR 引擎的联网边界分别验收，DSH 会话是否可离线取决于配置的模型，用户文件与识别结果是否会进入模型请求取决于调用入口。若需要整条链路完全断网，同一识别模块应提供可直接在本机执行的入口。 [分发设计](../../DESIGN.md#发布与分发) · [现有只读检查](../../src/engine/service.js)

## 上架前验收

- 两套终端分别从干净 DSH profile、空 pnpm store 安装。同一制品完成安装、识别、升级、卸载及重新安装，记录实际宿主、Node、pnpm 版本和停网条件。安装可以使用内网目录服务，首次和后续识别在阻断出站访问时验收。
- 使用脱敏的业务材料建立人工转录基准，覆盖中英混排截图、常规扫描、低清、歪斜及多栏页面。对比字符错误率、阅读顺序、冷启动和每页 P50/P95 耗时、峰值内存、包体；按目标终端的实际数据确定上线阈值。只有在同样本上比较引擎，才能判断换引擎是否值得。
- PDF 另测文本层页、纯扫描页、混合文档、单页同时含文字与截图，以及指定页强制识别。测试中文路径、坏图、密码 PDF、超限、取消和临时文件清理。
- 仅发布通过实机验证的环境和格式。Win7 若在 worker、WASM 或性能环节失败，记录失败条件并评估兼容方案。PDF 若受某版渲染入口阻塞，可先验收图片能力。
