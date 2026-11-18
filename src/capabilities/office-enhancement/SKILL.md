---
name: office-enhancement-skill
description: Perform validated local PDF, Word, Excel, and PowerPoint enhancements and use DSH native Office export, render, and formula recalculation workflows without WPS.
---

# Office 增强

当用户要求处理本机 Word、Excel、PowerPoint 或 PDF 文件时使用本技能。先调用 `load_workspace_dependencies` 获取 DSH 返回的 `python` 与 `pythonPackages`。所有 Python 命令都必须使用该解释器；不要改用系统 Python、在线 `pip install`、WPS 或未声明的 shell 片段。

本技能复用 DSH `0.2.1-rc.2` 内置的 `python-docx 1.2.0`、`openpyxl 3.1.5`、`python-pptx 1.0.2`、`pandas 3.0.1` 和随能力安装的 `pypdf 7.1.0`。这里要求的是能力中心核心 `v0.2.2` 或更高，不是 DSH 本身 `v0.2.2`。旧能力中心核心应先更新并重启，否则目录会因缺少固定自动检查而按设计拒绝加载。

## 安全约束

- 输入文件只读。输出必须是全新的本地路径；脚本会拒绝覆盖任何已存在文件、符号链接，以及模板、数据 JSON、图片等输入路径。
- 不猜测缺失文件、页码、工作表、列名、占位符或图片路径。冲突和歧义必须报告给用户。
- 不上传文件，不执行文档内的宏或嵌入脚本，不调用 WPS。
- 对加密 PDF、宏工作簿、损坏文件或不受支持的复杂 OOXML 特性明确报告限制。
- 操作完成后打开或重新读取输出，核对页数、行列、幻灯片数、占位符残留和文件格式。

固定脚本位于本技能 `scripts/office_tools.py`。下面的路径以已安装技能目录 `$OFFICE_SKILL` 表示；命令只调用该脚本的固定子命令。Windows 桌面必须使用 PowerShell 写法；所有含空格的解释器和技能路径都要加引号。

## PDF

```powershell
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pdf merge --output out.pdf a.pdf b.pdf
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pdf split --input in.pdf --output-dir pages/
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pdf extract-pages --input in.pdf --output picked.pdf --pages 1,3-5
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pdf rotate --input in.pdf --output rotated.pdf --pages 1,3 --degrees 90
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pdf extract-text --input in.pdf --output text.txt
```

```sh
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" pdf merge --output out.pdf a.pdf b.pdf
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" pdf split --input in.pdf --output-dir pages/
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" pdf extract-pages --input in.pdf --output picked.pdf --pages 1,3-5
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" pdf rotate --input in.pdf --output rotated.pdf --pages 1,3 --degrees 90
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" pdf extract-text --input in.pdf --output text.txt
```

页码从 1 开始，范围闭区间。PDF 文本提取只提取文字层；不承诺 OCR。扫描件应明确说明需要单独 OCR，本技能首版不提供 OCR 依赖。

## Word

模板占位符格式为 `{{key}}`，数据文件是 UTF-8 JSON 对象。填充覆盖正文、表格、页眉和页脚中的普通段落 run，包括被拆分到多个 run 的占位符。

```powershell
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" docx fill --template template.docx --output filled.docx --data values.json
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" docx replace --input in.docx --output replaced.docx --find OLD --replacement NEW
```

```sh
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" docx fill --template template.docx --output filled.docx --data values.json
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" docx replace --input in.docx --output replaced.docx --find OLD --replacement NEW
```

填充结果中的 `replacements`、`unusedKeys`、`unresolvedPlaceholders` 和 `status` 必须原样核对。零替换直接失败；未替换占位符会使状态显示为 `partial`，不能声称模板已完整填充。复杂域、修订记录、内容控件和排版保真需要另行验证。需要 PDF 时优先使用下面的 DSH 原生导出技能。

## Excel

`--mode values` 只读取公式缓存值并写成普通值；公式没有缓存时会成为空值，不会在 Python 中计算。`--mode formulas` 只保留实际公式单元格，并把普通字符串 `=...` 继续作为文本；不会刷新缓存。combine 和 dedupe 会移动行，公式模式必须显式增加 `--allow-formula-shift`，并在输出后检查或修正相对引用。compare 报告把实际公式序列化为普通文本，避免报告自身执行公式。

```powershell
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" excel combine --output combined.xlsx --mode values a.xlsx b.xlsx
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" excel combine --output formulas.xlsx --mode formulas --allow-formula-shift a.xlsx b.xlsx
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" excel compare-by-key --left old.xlsx --right new.xlsx --output diff.xlsx --keys id --mode formulas
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" excel dedupe --input in.xlsx --output deduped.xlsx --keys id --mode values
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" excel split-sheets --input in.xlsx --output-dir sheets/ --mode formulas
```

```sh
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" excel combine --output combined.xlsx --mode values a.xlsx b.xlsx
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" excel compare-by-key --left old.xlsx --right new.xlsx --output diff.xlsx --keys id --mode values
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" excel dedupe --input in.xlsx --output deduped.xlsx --keys id --mode values
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" excel split-sheets --input in.xlsx --output-dir sheets/ --mode formulas
```

需要公式最终值或缓存时，先完成公式模式编辑，再使用 DSH 原生重算流程；不要让 `openpyxl` 或 `pandas` 假装完成重算。

## PowerPoint

文本占位符使用 `{{key}}`。图片占位符在形状文本中写 `{{logo}}`，数据 JSON 中对应值为 `{"image":"/local/image.png"}`。

```powershell
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pptx fill --template template.pptx --output filled.pptx --data values.json
```

```sh
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" pptx fill --template template.pptx --output filled.pptx --data values.json
```

脚本在现有幻灯片上替换文字和图片，不重建整套演示文稿，通常可保留该幻灯片上的其他可编辑对象。零替换直接失败；`unresolvedPlaceholders` 非空时状态为 `partial`。动画、SmartArt、复杂组和母版逻辑仍需在目标 Office 环境中检查。

## DSH 原生导出、渲染与重算

文件操作完成后，按任务加载对应的 DSH 内置技能，而不是用本技能的 Python 脚本替代：

- 导出 PDF：使用 `office-export-pdf`，将生成的 Office 文件交给 DSH 已配置的转换引擎。
- 页面或工作表范围渲染：使用 `office-render` 生成图片，并确认真实视觉结果；只有当前模型支持图像时才能直接检查图片。
- Excel 公式重算：使用 `office-recalculate`，完成后重新读取目标单元格并报告真实计算结果。
- Word/Excel/PPT 常规编辑与验证可继续使用 `office-docx`、`office-xlsx`、`office-pptx` 的内置说明和 DSH 运行时。

使用 DSH 返回的 Node、Python 和转换引擎路径；调用失败时保留真实错误，不退回 WPS，也不声称未执行的渲染或重算已完成。
