"""
가상 시청 로그 생성기 (데이터 시뮬레이션용)

유저스크립트(shorts-limiter.user.js)가 내보내는 것과 같은 JSON 형식으로
가상의 쇼츠 시청 로그를 만듭니다. 용도는 두 가지예요.

  1) analyze_logs.py 가 제대로 동작하는지 실사용 전에 검증
  2) 고정 윈도우 vs 슬라이딩 윈도우 비교 (--compare)

사용 예:
  python simulate_logs.py --persona gamer --days 7 --out sim_gamer.json
  python simulate_logs.py --persona cook --days 7 --out sim_cook.json
  python simulate_logs.py --persona gamer --days 14 --compare
"""

import argparse
import json
import math
import random
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))

# ───────────────────────── 가상 콘텐츠 ─────────────────────────
TOPICS = {
    "게임": {
        "titles": ["{x} 이 장면 실화냐", "{x} 고인물 플레이", "{x} 초보 vs 고수"],
        "x": ["롤", "발로란트", "마크", "배그"],
        "channels": ["겜튜브", "하이라이트맛집", "고인물TV"],
    },
    "요리": {
        "titles": ["자취생 5분 {x}", "{x} 황금 레시피", "편의점 재료로 {x}"],
        "x": ["김치볶음밥", "파스타", "계란말이", "떡볶이"],
        "channels": ["오늘뭐먹지", "자취요리왕", "1분식당"],
    },
    "운동": {
        "titles": ["하루 5분 {x}", "{x} 자세 교정", "{x} 30일 챌린지"],
        "x": ["홈트", "스쿼트", "플랭크", "러닝"],
        "channels": ["헬린이일기", "홈트코치", "런데이"],
    },
    "공부": {
        "titles": ["{x} 1분 정리", "시험 전 꼭 보는 {x}", "{x} 꿀팁"],
        "x": ["영단어", "자료구조", "토익", "파이썬"],
        "channels": ["1분과외", "공대생노트", "스터디윗미"],
    },
    "고양이": {
        "titles": ["{x} 고양이 반응", "집사 몰래 {x}", "{x}하는 냥이"],
        "x": ["간식 본", "택배 상자", "목욕", "꾹꾹이"],
        "channels": ["냥냥일기", "치즈네", "고양이는액체"],
    },
    "코미디": {
        "titles": ["{x} 공감 100%", "{x} 상황극", "현실 {x}"],
        "x": ["대학생", "자취생", "알바생", "조별과제"],
        "channels": ["웃참실패", "공감극장", "숏코미디"],
    },
    "뉴스": {
        "titles": ["오늘의 {x} 1분 요약", "{x} 핵심만", "{x} 이슈 정리"],
        "x": ["경제", "IT", "사회", "스포츠"],
        "channels": ["1분뉴스", "이슈콕", "데일리브리핑"],
    },
}

# 페르소나: 관심 주제 가중치, 주로 보는 시간대
PERSONAS = {
    "gamer": {
        "interests": {"게임": 3, "코미디": 2, "고양이": 1},
        "hours": {13: 1, 18: 1, 21: 2, 22: 3, 23: 4, 0: 3, 1: 2},
    },
    "cook": {
        "interests": {"요리": 3, "운동": 2, "공부": 1},
        "hours": {8: 1, 12: 3, 13: 2, 19: 2, 20: 2, 22: 1},
    },
    "student": {
        "interests": {"공부": 2, "코미디": 2, "뉴스": 1, "고양이": 1},
        "hours": {10: 1, 15: 2, 17: 1, 21: 2, 23: 3, 0: 2},
    },
}


# ───────────────────────── 제한기 (유저스크립트와 같은 규칙) ─────────────────────────
class Limiter:
    def __init__(self, mode, window_min, max_videos):
        self.mode = mode
        self.window_ms = window_min * 60 * 1000
        self.max = max_videos
        self.views = []  # 허용된 시청의 진입 시각(ms)

    def window_start(self, t_ms):
        # 로컬(KST) 기준으로 구간 정렬 → 유저스크립트의 windowStartOf 와 동일
        offset = 9 * 3600 * 1000
        return math.floor((t_ms + offset) / self.window_ms) * self.window_ms - offset

    def check(self, t_ms):
        """(허용 여부, 이미 본 개수, 다시 열리는 시각) 반환"""
        if self.mode == "fixed":
            ws = self.window_start(t_ms)
            used = sum(1 for v in self.views if v >= ws)
            return used < self.max, used, ws + self.window_ms
        # sliding: 지금부터 거꾸로 T분
        recent = [v for v in self.views if v > t_ms - self.window_ms]
        used = len(recent)
        if used < self.max:
            return True, used, t_ms
        reopen = sorted(recent)[used - self.max] + self.window_ms
        return False, used, reopen

    def record(self, t_ms):
        self.views.append(t_ms)


# ───────────────────────── 시뮬레이션 ─────────────────────────
def pick_topic(rng, interests):
    names = list(TOPICS)
    weights = [1 + 2 * interests.get(n, 0) for n in names]  # 추천 알고리즘이 관심사를 더 자주 보여줌
    return rng.choices(names, weights)[0]


def watch_seconds(rng, interested):
    skip_p = 0.15 if interested else 0.55
    if rng.random() < skip_p:
        return rng.uniform(0.5, 3.0)  # 스킵
    mean = 25 if interested else 8
    sec = rng.lognormvariate(math.log(mean), 0.5)
    return min(max(sec, 3.0), 90.0)  # 반복 재생 포함 최대 90초


def simulate(persona_name, days, seed, mode, window_min, max_videos, start_date):
    rng = random.Random(seed)
    persona = PERSONAS[persona_name]
    limiter = Limiter(mode, window_min, max_videos)
    logs = []

    hours = list(persona["hours"])
    hour_w = list(persona["hours"].values())

    for d in range(days):
        day = start_date + timedelta(days=d)
        n_sessions = rng.randint(2, 5)
        starts = sorted(
            day.replace(hour=rng.choices(hours, hour_w)[0], minute=rng.randint(0, 59),
                        second=rng.randint(0, 59))
            for _ in range(n_sessions)
        )
        for s in starts:
            t = int(s.timestamp() * 1000)
            desire = rng.randint(10, 60)   # 이번 세션에 보고 싶은 영상 수
            patience = rng.uniform(0, 15)  # 차단 시 기다릴 수 있는 시간(분)
            while desire > 0:
                ok, used, reopen = limiter.check(t)
                topic = pick_topic(rng, persona["interests"])
                info = TOPICS[topic]
                title = rng.choice(info["titles"]).format(x=rng.choice(info["x"])) + f" #{topic} #shorts"
                vid = "".join(rng.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-", k=11))
                ws = limiter.window_start(t) if mode == "fixed" else t - limiter.window_ms
                entry = {
                    "id": f"{t}-{rng.randint(0, 10**6)}",
                    "userTag": persona_name,
                    "videoId": vid,
                    "title": title,
                    "channel": rng.choice(info["channels"]),
                    "enteredAt": t,
                    "leftAt": None,
                    "dwellMs": None,
                    "visibleMs": None,
                    "windowStart": ws,
                    "windowMinutes": window_min,
                    "maxVideos": max_videos,
                    "countBefore": used,
                    "scriptVersion": f"sim-{mode}",
                    "blocked": not ok,
                }
                if not ok:
                    logs.append(entry)
                    wait_min = (reopen - t) / 60000
                    if wait_min <= patience:
                        t = reopen + rng.randint(1000, 20000)  # 열리자마자 다시 봄
                        continue
                    break  # 포기하고 세션 종료
                sec = watch_seconds(rng, topic in persona["interests"])
                dwell = int(sec * 1000)
                # 가끔 탭을 내려둠 (보이는 시간 < 머문 시간)
                visible = dwell if rng.random() > 0.05 else int(dwell * rng.uniform(0.2, 0.8))
                entry.update(leftAt=t + dwell, dwellMs=dwell, visibleMs=visible)
                logs.append(entry)
                limiter.record(t)
                t += dwell + rng.randint(300, 1500)
                desire -= 1
    return logs


def max_rolling(views_ms, window_ms):
    """임의의 T분 구간에서 본 최대 영상 수 (투 포인터)"""
    best, j = 0, 0
    for i in range(len(views_ms)):
        while views_ms[i] - views_ms[j] >= window_ms:
            j += 1
        best = max(best, i - j + 1)
    return best


def summarize(logs, window_min):
    watched = sorted(l["enteredAt"] for l in logs if not l["blocked"])
    blocked = sum(1 for l in logs if l["blocked"])
    return {
        "시청 수": len(watched),
        "차단 시도": blocked,
        "임의 T분 최대 시청": max_rolling(watched, window_min * 60 * 1000),
    }


def main():
    p = argparse.ArgumentParser(description="가상 쇼츠 시청 로그 생성기")
    p.add_argument("--persona", choices=PERSONAS, default="gamer")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--mode", choices=["fixed", "sliding"], default="fixed")
    p.add_argument("--window", type=int, default=30, help="T (분)")
    p.add_argument("--max", type=int, default=20, help="N (개)")
    p.add_argument("--start", default="2026-11-02", help="시작 날짜 YYYY-MM-DD")
    p.add_argument("--out", default=None, help="저장할 JSON 경로")
    p.add_argument("--compare", action="store_true", help="고정/슬라이딩 윈도우 비교 출력")
    a = p.parse_args()

    start = datetime.strptime(a.start, "%Y-%m-%d").replace(tzinfo=KST)

    if a.compare:
        print(f"[비교] persona={a.persona}, {a.days}일, {a.window}분마다 {a.max}개, seed={a.seed}")
        print(f"{'방식':<10}{'시청 수':>8}{'차단 시도':>10}{'임의 T분 최대 시청':>18}")
        for mode in ("fixed", "sliding"):
            s = summarize(simulate(a.persona, a.days, a.seed, mode, a.window, a.max, start), a.window)
            print(f"{mode:<10}{s['시청 수']:>8}{s['차단 시도']:>10}{s['임의 T분 최대 시청']:>18}")
        print(f"※ 한도 N={a.max}. 고정 윈도우는 구간 경계에서 최대 2N개까지 몰아볼 수 있음")
        return

    logs = simulate(a.persona, a.days, a.seed, a.mode, a.window, a.max, start)
    payload = {
        "meta": {
            "scriptVersion": f"sim-{a.mode}",
            "userTag": a.persona,
            "exportedAt": datetime.now(KST).isoformat(),
            "windowMinutes": a.window,
            "maxVideos": a.max,
            "simulated": True,
            "seed": a.seed,
        },
        "logs": logs,
    }
    out = a.out or f"sim_{a.persona}_{a.mode}.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    s = summarize(logs, a.window)
    print(f"저장: {out}  (시청 {s['시청 수']}개, 차단 시도 {s['차단 시도']}건, 임의 {a.window}분 최대 {s['임의 T분 최대 시청']}개)")


if __name__ == "__main__":
    main()
