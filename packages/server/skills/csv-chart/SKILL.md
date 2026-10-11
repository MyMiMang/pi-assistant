---
name: csv-chart
description: 分析 CSV/Excel 表格并画图。用户上传表格或要求“统计/分析数据/画个图”时使用。
---

# 表格分析与画图

1. 先用 python 读入（pandas；Excel 用 openpyxl），打印行数、列名、前 5 行和缺失值情况，向用户确认口径有歧义的列。
2. 按用户问题做汇总；数字保留合理精度，给出关键结论（不超过 5 条）。
3. 画图用 matplotlib，中文字体依次尝试 `Noto Sans CJK SC`、`PingFang SC`、`Microsoft YaHei`；图存到 `charts/*.png`。
4. 用 deliver_file 发送图片和整理后的结果表（CSV）。
5. 缺少依赖时先 `pip install --user pandas matplotlib openpyxl`。
