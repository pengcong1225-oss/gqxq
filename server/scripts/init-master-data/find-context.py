import sys, io, os, openpyxl
SRC = [r"D:\知识库仓库\doctorWho\项目文档\住新服务平台\燃水燃气\诉求数据\2025年0101-1231水气全量诉求(含自办自结).xlsx",
       r"D:\知识库仓库\doctorWho\项目文档\住新服务平台\燃水燃气\诉求数据\2026年0101-1112水气全量诉求(含自办自结).xlsx"]
needle = sys.argv[1]
maxn = int(sys.argv[2]) if len(sys.argv) > 2 else 20
out = []
for p in SRC:
    wb = openpyxl.load_workbook(p, data_only=True)
    ws = wb.worksheets[0]
    it = ws.iter_rows(min_row=3, values_only=True)
    header = [str(c).strip() if c is not None else "" for c in next(it)]
    idx = {h: i for i, h in enumerate(header)}
    for row in it:
        if row is None:
            continue
        for col in ["事发地", "诉求标题", "诉求内容"]:
            if col not in idx:
                continue
            v = row[idx[col]]
            if v is None:
                continue
            s = str(v)
            i = s.find(needle)
            if i >= 0:
                out.append("%s | %s | ...%s..." % (os.path.basename(p)[:6], col, s[max(0, i-40):i+len(needle)+40]))
                break
        if len(out) >= maxn:
            break
    wb.close()
    if len(out) >= maxn:
        break
open(os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../.dev-logs/import-2025-2026/masterdata/_context.txt")), "w", encoding="utf-8").write("\n".join(out))
print("hits", len(out))
