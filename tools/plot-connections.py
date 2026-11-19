"""把連線數實驗的取樣畫成 SVG 折線圖（不需要 matplotlib）
用法：python3 tools/plot-connections.py loadtest/results connections.svg
"""
import json, sys, pathlib

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
W, H, L, R, T, B = 900, 440, 70, 30, 60, 70
YMAX = 170

def series(group):
    vals = [int(x) for x in (src / f"{group}-threads.txt").read_text().split() if x.strip().isdigit()]
    # 切掉壓測前後的閒置取樣（登入階段、還原階段），只留壓測期間
    busy = [i for i, v in enumerate(vals) if v >= 20]
    return vals[busy[0]:busy[-1] + 1] if busy else vals

def report(group):
    s = json.loads((src / f"{group}-summary.json").read_text())["metrics"]
    return s["http_req_failed"]["value"] * 100, s["http_req_duration"]["p(95)"]

def path(vals):
    n = max(len(vals) - 1, 1)
    pts = [(L + (W - L - R) * i / n, T + (H - T - B) * (1 - v / YMAX)) for i, v in enumerate(vals)]
    return " ".join(f"{'M' if i == 0 else 'L'}{x:.1f},{y:.1f}" for i, (x, y) in enumerate(pts))

def y(v):
    return T + (H - T - B) * (1 - v / YMAX)

a, b = series("A"), series("B")
(fa, pa), (fb, pb) = report("A"), report("B")
grid = "".join(f'<line x1="{L}" x2="{W-R}" y1="{y(v)}" y2="{y(v)}" stroke="#e4e7ec"/><text x="{L-8}" y="{y(v)+4}" text-anchor="end" font-size="12" fill="#667085">{v}</text>' for v in range(0, YMAX + 1, 25))
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="-apple-system, 'PingFang TC', sans-serif">
<rect width="{W}" height="{H}" fill="#ffffff"/>
<text x="{L}" y="28" font-size="18" font-weight="600" fill="#1d2330">MySQL 連線數（壓測 40 秒，每個請求佔用連線 200 ms）</text>
<text x="{L}" y="{H-B+8}" font-size="11" fill="#667085">壓測開始</text><text x="{W-R}" y="{H-B+8}" text-anchor="end" font-size="11" fill="#667085">壓測結束</text>
{grid}
<line x1="{L}" x2="{W-R}" y1="{y(150)}" y2="{y(150)}" stroke="#dc2626" stroke-dasharray="6 4" stroke-width="1.5"/>
<text x="{W-R}" y="{y(150)-6}" text-anchor="end" font-size="12" fill="#dc2626">MySQL 上限 150</text>
<line x1="{L}" x2="{W-R}" y1="{y(130)}" y2="{y(130)}" stroke="#16a34a" stroke-dasharray="6 4" stroke-width="1.5"/>
<text x="{W-R}" y="{y(130)+16}" text-anchor="end" font-size="12" fill="#16a34a">預算 130（上限 − 保留 20）</text>
<path d="{path(a)}" fill="none" stroke="#dc2626" stroke-width="2.5"/>
<path d="{path(b)}" fill="none" stroke="#2563eb" stroke-width="2.5"/>
<rect x="{L+10}" y="{H-B+18}" width="14" height="4" fill="#dc2626"/><text x="{L+30}" y="{H-B+24}" font-size="13" fill="#1d2330">A 沒有預算（8 × 20 = 160）：失敗率 {fa:.1f}%、P95 {pa:.0f} ms</text>
<rect x="{L+10}" y="{H-B+38}" width="14" height="4" fill="#2563eb"/><text x="{L+30}" y="{H-B+44}" font-size="13" fill="#1d2330">B 照預算（5 × 20 = 100）：失敗率 {fb:.1f}%、P95 {pb:.0f} ms</text>
</svg>'''
out.write_text(svg)
print(f"wrote {out}")
