"""
쇼츠 시청 로그 분석기

유저스크립트에서 내보낸 JSON(또는 simulate_logs.py 결과)을 읽어서
사용자별 시청 패턴과 관심사를 분석하고, 차트(PNG)와 리포트(report.md)를 만듭니다.

사용 예:
  python analyze_logs.py shorts_log_me_20261105_2310.json
  python analyze_logs.py logs/            # 폴더 안의 JSON 전부 (지인 로그 합치기)
  python analyze_logs.py a.json b.json --out report_v1

관심도 점수 = 평균 시청 시간(초) × log2(1 + 시청 횟수)
  → 오래 볼수록, 그리고 여러 번 볼수록 높아짐. 한두 번 우연히 오래 본 주제가
    1위로 튀지 않도록 최소 시청 횟수(--min-count, 기본 3)를 둡니다.
"""

import argparse
import json
import math
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib import font_manager
from matplotlib.ticker import MaxNLocator

SKIP_SEC = 3          # 이 시간 안에 넘기면 '스킵'
OUTLIER_SEC = 600     # 10분 넘게 한 영상에 머문 건 자리를 비운 것으로 보고 체류 통계에서 제외
GENERIC_TAGS = {"shorts", "short", "쇼츠", "fyp", "추천", "youtubeshorts"}

# 차트 색 (단일 계열 + 강조 1색, 나머지는 텍스트·축 잉크)
C_MAIN = "#2a78d6"
C_ACCENT = "#eb6834"
C_TEXT = "#0b0b0b"
C_TEXT2 = "#52514e"
C_GRID = "#e4e3df"
C_SURFACE = "#fcfcfb"


# ───────────────────────── 준비 ─────────────────────────
def setup_style():
    candidates = ["Malgun Gothic", "AppleGothic", "NanumGothic", "Noto Sans CJK KR", "Noto Sans KR"]
    installed = {f.name for f in font_manager.fontManager.ttflist}
    for name in candidates:
        if name in installed:
            plt.rcParams["font.family"] = name
            break
    else:
        print("※ 한글 폰트를 찾지 못했습니다. 차트의 한글이 깨질 수 있어요 (나눔고딕 설치 권장).")
    plt.rcParams.update({
        "axes.unicode_minus": False,
        "figure.facecolor": C_SURFACE,
        "axes.facecolor": C_SURFACE,
        "axes.edgecolor": C_GRID,
        "axes.labelcolor": C_TEXT2,
        "axes.titlecolor": C_TEXT,
        "axes.titlesize": 13,
        "axes.titleweight": "bold",
        "axes.spines.top": False,
        "axes.spines.right": False,
        "xtick.color": C_TEXT2,
        "ytick.color": C_TEXT2,
        "grid.color": C_GRID,
        "grid.linewidth": 0.8,
        "savefig.dpi": 150,
        "savefig.bbox": "tight",
    })


def load_logs(paths):
    files = []
    for p in map(Path, paths):
        files += sorted(p.glob("*.json")) if p.is_dir() else [p]
    rows = []
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        logs = data["logs"] if isinstance(data, dict) else data
        for row in logs:
            row["sourceFile"] = f.name
        rows += logs
    if not rows:
        raise SystemExit("읽을 로그가 없습니다.")
    df = pd.DataFrame(rows)
    df["userTag"] = df.get("userTag", "me").fillna("me")
    df["blocked"] = df["blocked"].fillna(False).astype(bool)
    df["entered"] = pd.to_datetime(df["enteredAt"], unit="ms", utc=True).dt.tz_convert("Asia/Seoul")
    df["visibleSec"] = pd.to_numeric(df["visibleMs"], errors="coerce") / 1000
    df["title"] = df["title"].fillna("")
    df["channel"] = df["channel"].fillna("").replace("", "(알 수 없음)")
    # 같은 기록이 여러 파일에 중복으로 들어간 경우 제거 (같은 사람이 여러 번 내보낸 경우)
    df = df.drop_duplicates(subset=["userTag", "id"]).sort_values("enteredAt")
    return df, files


def extract_tags(title):
    tags = [t.lower() for t in re.findall(r"#([0-9A-Za-z_가-힣]+)", title)]
    return [t for t in tags if t not in GENERIC_TAGS]


# ───────────────────────── 지표 ─────────────────────────
def max_rolling(ms_list, window_ms):
    best, j = 0, 0
    for i in range(len(ms_list)):
        while ms_list[i] - ms_list[j] >= window_ms:
            j += 1
        best = max(best, i - j + 1)
    return best


def summarize(udf):
    watched = udf[~udf["blocked"]]
    valid = watched[watched["visibleSec"].notna() & (watched["visibleSec"] <= OUTLIER_SEC)]
    window_min = int(udf["windowMinutes"].dropna().iloc[0]) if udf["windowMinutes"].notna().any() else 30
    max_videos = int(udf["maxVideos"].dropna().iloc[0]) if udf["maxVideos"].notna().any() else 20
    per_window = watched.groupby("windowStart").size()
    return {
        "기간": f"{udf['entered'].min():%m/%d %H:%M} ~ {udf['entered'].max():%m/%d %H:%M}",
        "설정": f"{window_min}분마다 {max_videos}개",
        "시청 영상 수": len(watched),
        "차단된 시도": int(udf["blocked"].sum()),
        "한도에 도달한 구간": f"{int((per_window >= max_videos).sum())} / {len(per_window)}",
        "평균 시청 시간(초)": round(valid["visibleSec"].mean(), 1) if len(valid) else None,
        "중앙값 시청 시간(초)": round(valid["visibleSec"].median(), 1) if len(valid) else None,
        f"스킵률({SKIP_SEC}초 미만)": f"{(valid['visibleSec'] < SKIP_SEC).mean() * 100:.1f}%" if len(valid) else None,
        f"임의 {window_min}분 최대 시청": max_rolling(watched["enteredAt"].tolist(), window_min * 60000),
        "_window_min": window_min,
        "_max_videos": max_videos,
    }


def interest_table(udf, key, min_count):
    watched = udf[~udf["blocked"] & udf["visibleSec"].notna() & (udf["visibleSec"] <= OUTLIER_SEC)].copy()
    if key == "tag":
        watched["tag"] = watched["title"].map(extract_tags)
        watched = watched.explode("tag").dropna(subset=["tag"])
    g = watched.groupby(key)["visibleSec"].agg(횟수="count", 평균초="mean", 총초="sum")
    g = g[g["횟수"] >= min_count]
    g["관심도"] = g["평균초"] * (1 + g["횟수"]).map(math.log2)
    return g.sort_values("관심도", ascending=False).round(1)


# ───────────────────────── 차트 ─────────────────────────
def save(fig, path):
    fig.savefig(path)
    plt.close(fig)
    return path.name


def chart_interest(tbl, title, path, top=8):
    t = tbl.head(top).iloc[::-1]
    fig, ax = plt.subplots(figsize=(7, 0.45 * len(t) + 1.2))
    bars = ax.barh(t.index.astype(str), t["관심도"], color=C_MAIN, height=0.6)
    for b, (_, r) in zip(bars, t.iterrows()):
        ax.text(b.get_width(), b.get_y() + b.get_height() / 2,
                f"  {r['관심도']:.0f}  (평균 {r['평균초']:.0f}초 · {int(r['횟수'])}회)",
                va="center", fontsize=9, color=C_TEXT2)
    ax.set_title(title, loc="left")
    ax.set_xlabel("관심도 점수 = 평균 시청 초 × log2(1+횟수)")
    ax.xaxis.grid(True)
    ax.set_axisbelow(True)
    ax.set_xlim(0, t["관심도"].max() * 1.45)
    return save(fig, path)


def chart_dwell(udf, path):
    v = udf.loc[~udf["blocked"], "visibleSec"].dropna()
    v = v[v <= 120]
    fig, ax = plt.subplots(figsize=(7, 3.4))
    ax.hist(v, bins=range(0, 121, 3), color=C_MAIN, edgecolor=C_SURFACE, linewidth=1)
    ax.axvline(SKIP_SEC, color=C_ACCENT, linewidth=2)
    ax.text(SKIP_SEC + 1.5, ax.get_ylim()[1] * 0.9, f"{SKIP_SEC}초 미만 = 스킵", color=C_TEXT2, fontsize=9)
    ax.set_title("영상별 시청 시간 분포", loc="left")
    ax.set_xlabel("시청 시간 (초, 탭이 보이던 시간만)")
    ax.set_ylabel("영상 수")
    ax.yaxis.grid(True)
    ax.set_axisbelow(True)
    return save(fig, path)


def chart_hourly(udf, path):
    counts = udf[~udf["blocked"]]["entered"].dt.hour.value_counts().reindex(range(24), fill_value=0)
    fig, ax = plt.subplots(figsize=(7, 3.2))
    ax.bar(counts.index, counts.values, color=C_MAIN, width=0.7)
    ax.set_title("시간대별 시청량", loc="left")
    ax.set_xlabel("시각 (시)")
    ax.set_ylabel("영상 수")
    ax.set_xticks(range(0, 24, 2))
    ax.yaxis.grid(True)
    ax.set_axisbelow(True)
    return save(fig, path)


def chart_windows(udf, s, path):
    """구간별 시청 수 분포: 한도(N)에 얼마나 자주 닿는지"""
    per_window = udf[~udf["blocked"]].groupby("windowStart").size()
    n = s["_max_videos"]
    counts = per_window.value_counts().reindex(range(1, n + 1), fill_value=0)
    colors = [C_ACCENT if k >= n else C_MAIN for k in counts.index]
    fig, ax = plt.subplots(figsize=(7, 3.2))
    ax.bar(counts.index, counts.values, color=colors, width=0.7)
    ax.set_title(f"{s['_window_min']}분 구간별 시청 수 (주황 = 한도 {n}개 도달)", loc="left")
    ax.set_xlabel("한 구간에서 본 영상 수")
    ax.set_ylabel("구간 수")
    ax.xaxis.set_major_locator(MaxNLocator(integer=True))
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    ax.yaxis.grid(True)
    ax.set_axisbelow(True)
    return save(fig, path)


# ───────────────────────── 리포트 ─────────────────────────
def md_table(df, index_name):
    cols = [index_name] + list(df.columns)
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for idx, row in df.iterrows():
        cells = [str(idx)] + [f"{v:g}" if isinstance(v, float) else str(v) for v in row]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main():
    p = argparse.ArgumentParser(description="쇼츠 시청 로그 분석기")
    p.add_argument("inputs", nargs="+", help="JSON 파일 또는 폴더")
    p.add_argument("--out", default="report", help="결과 폴더 (기본: report)")
    p.add_argument("--min-count", type=int, default=3, help="관심도 순위에 넣을 최소 시청 횟수")
    a = p.parse_args()

    setup_style()
    df, files = load_logs(a.inputs)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    md = ["# 쇼츠 시청 로그 분석 리포트", "",
          f"- 입력 파일: {', '.join(f.name for f in files)}",
          f"- 사용자 수: {df['userTag'].nunique()}명, 전체 기록 {len(df)}건", ""]

    summaries = {}
    for user, udf in df.groupby("userTag"):
        s = summarize(udf)
        summaries[user] = s
        md += [f"## 사용자: {user}", ""]
        md += ["| 항목 | 값 |", "|---|---|"]
        md += [f"| {k} | {v} |" for k, v in s.items() if not k.startswith("_")]
        md.append("")

        tags = interest_table(udf, "tag", a.min_count)
        chans = interest_table(udf, "channel", a.min_count)
        charts = []
        if len(tags):
            charts.append(chart_interest(tags, f"관심 해시태그 Top {min(8, len(tags))} · {user}", out / f"{user}_interest_tags.png"))
            md += ["### 관심 해시태그", "", md_table(tags.head(10), "해시태그"), ""]
        else:
            md += ["### 관심 해시태그", "", f"(최소 {a.min_count}회 이상 본 해시태그가 없습니다)", ""]
        if len(chans):
            md += ["### 관심 채널", "", md_table(chans.head(10), "채널"), ""]
        charts.append(chart_dwell(udf, out / f"{user}_dwell.png"))
        charts.append(chart_hourly(udf, out / f"{user}_hourly.png"))
        charts.append(chart_windows(udf, s, out / f"{user}_windows.png"))
        md += ["### 차트", ""] + [f"![{c}]({c})" for c in charts] + [""]

    if len(summaries) > 1:
        md += ["## 사용자 비교", "", "| 사용자 | 시청 수 | 차단 시도 | 평균 시청(초) | 스킵률 | 한도 도달 구간 |", "|---|---|---|---|---|---|"]
        for u, s in summaries.items():
            skip = next(v for k, v in s.items() if k.startswith("스킵률"))
            md.append(f"| {u} | {s['시청 영상 수']} | {s['차단된 시도']} | {s['평균 시청 시간(초)']} | {skip} | {s['한도에 도달한 구간']} |")
        md.append("")

    (out / "report.md").write_text("\n".join(md), encoding="utf-8")
    print(f"완료: {out / 'report.md'} (사용자 {len(summaries)}명, 차트 {len(list(out.glob('*.png')))}개)")
    for u, s in summaries.items():
        print(f"  - {u}: 시청 {s['시청 영상 수']}개, 차단 시도 {s['차단된 시도']}건, 평균 {s['평균 시청 시간(초)']}초")


if __name__ == "__main__":
    main()
