---
name: report-format
description: Format structured checks and findings as a concise, reviewable Chinese report.
---

# 报告格式

当用户要求把检查结果、验证记录、故障排查或交付信息整理成中文报告时使用本技能。

输出顺序：

1. 一级标题使用报告主题；
2. 先写一行“结论”，说明当前可确认的结果；
3. 使用“发现”列出来源、证据和影响；
4. 使用“未验证”单独保留运行环境缺口；
5. 最后给出下一步，避免把推测写成事实。

规则：

- 不隐瞒失败项或部分失败；
- 区分“源码确认”“自动化测试”“真机未测试”；
- 不加入未提供的数字、版本或运行结论；
- 不执行远程下载。

需要示例时运行 `scripts/report.py --input-json '<JSON>'`。脚本只读取参数中的本地 JSON 并输出 Markdown。
