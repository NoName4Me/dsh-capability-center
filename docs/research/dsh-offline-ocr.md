# DSH 能力中心离线 OCR 调研

核对日期：2026-11-18。基于 DSH rc.2 仓库记录、能力中心源码和识别引擎官方文档，尚待 Windows 实机和真实样本验证。

## 首版能力

上架「图片与扫描 PDF 文字识别」，覆盖简体中文和英文印刷体。输入 PNG、JPG 或指定 PDF 页，输出按页纯文本和可供其他技能消费的 JSON。JSON 保留页码、阅读顺序、文本块坐标及引擎原始置信度（引擎提供时）。低置信度标记用于定位复核，阈值用真实样本确定。

PDF 逐页优先用已有 pypdf 脚本读取文本层，扫描页用 DSH 内置渲染路径转图后识别。提供指定页强制 OCR 的选项，覆盖同一页既有可选文字、又有需要识别的图片的情况。可搜索 PDF 作为独立输出验证，复杂表格还原、手写体和业务字段提取留到后续。 [DSH 内置办公能力核查](dsh-builtin-office-rc2.md)

## 引擎与分发

| 候选 | 核对结果 | 验证重点 |
| --- | --- | --- |
| Tesseract 5 | 支持 Windows 安装、简中和英文语言数据、多语言组合。可输出文本、带坐标与置信度的 TSV，以及包含文字层的 PDF。PDF 输入需先渲染成图片。 | 作为离线试点基线，检查中英混排、旋转扫描、低清晰度和阅读顺序。 |
| PP-OCRv5 mobile | 官方文档说明支持 Windows、CPU 推理和指定本地模型目录，移动版识别模型覆盖简中、繁中和英文等。 | 使用相同样本比较字符错误率和耗时，并记录模型加运行时的完整体积。 |

[Tesseract 安装与语言数据](https://tesseract-ocr.github.io/tessdoc/Installation) · [Tesseract CLI 输出格式](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html) · [Tesseract 输入格式](https://tesseract-ocr.github.io/tessdoc/InputFormats.html) · [PP-OCRv5 部署说明](https://paddlepaddle.github.io/PaddleOCR/main/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html) · [PaddleOCR 通用 OCR 参数](https://paddlepaddle.github.io/PaddleOCR/main/en/version3.x/pipeline_usage/OCR.html)

能力中心 Python 安装器只接收纯 Python wheel，目录单制品上限为 32 MiB，技能 ZIP 解包上限为 48 MiB、单文件上限为 12 MiB。可先在试点机预置固定版本的引擎和语言数据，由能力中心分发 OCR 技能。若要求一键离线安装，再验证把引擎和数据一起交付的插件制品及其安装、更新和卸载行为。技能发现检查只验证注册，OCR 试点应加一张固定测试图的识别检查。 [产品约束](../../PRODUCT.md) · [制品校验](../../src/engine/lib/manifest.js) · [ZIP 限额](../../src/engine/lib/archive.js) · [安装检查](../../src/engine/service.js)

## 试点验收

在目标 Win10/11 机器断网运行，测试有文本层的 PDF、夹有扫描页的 PDF、中英混排、歪斜和低清图片。记录字符错误率、阅读顺序问题、每页耗时和完整制品体积。存量 Win7 若仍需覆盖，按实际 DSH、引擎及依赖版本单独验收。
