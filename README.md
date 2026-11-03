# Shorts Limiter (쇼츠 리미터)

유튜브 쇼츠 시청을 **고정 윈도우(T분마다 N개)** 로 제한하고, **내가 많이 본 것(무의식적 노출)과 오래 본 것(실제 관심)** 을 보여주는 오픈소스 유저스크립트입니다.

- 실행 환경: [Violentmonkey](https://violentmonkey.github.io/) (MIT, 권장) / Tampermonkey
- 분석: Python + pandas + matplotlib
- 라이선스: MIT

## 👉 바로 설치

1. 크롬에 [Violentmonkey](https://chromewebstore.google.com/detail/jinjaccalgkegednnccohejagnlnfdag) 설치 → 확장 프로그램 세부정보에서 **"사용자 스크립트 허용"** 켜기
2. **[쇼츠 리미터 설치하기](https://raw.githubusercontent.com/knaae/shorts-limiter/main/src/shorts-limiter.user.js)** 클릭 → Violentmonkey 설치 화면에서 **설치**

자세한 안내: [docs/INSTALL.md](docs/INSTALL.md)

## 구조

```
shorts-limiter/
├── src/shorts-limiter.user.js     # 유저스크립트 (제한·기록·내보내기)
├── analysis/
│   ├── analyze_logs.py            # 로그 분석 → 차트 + report.md
│   ├── simulate_logs.py           # 가상 로그 생성, 고정/슬라이딩 비교
│   ├── requirements.txt
│   └── sample_logs/               # 가상 로그 예시
├── docs/
│   ├── INSTALL.md                 # 테스터용 설치 안내
│   └── SIMULATION.md              # 기능 시뮬레이션 체크리스트
└── .github/ISSUE_TEMPLATE/        # 피드백·버그 제보 양식
```

## 사용자 리포트 (v1.1.0~)

| 위치 | 내용 |
|---|---|
| **📈 내 시청 리포트** (메뉴) | 오늘·최근 7일·전체 / 본 쇼츠 수, 총 시청 시간, 스킵률, 차단 수 / 많이 본 것 vs 오래 본 것 Top 5 / 시간대별 시청 |
| **차단 화면** | 이번 30분 동안 많이 본 것·오래 본 것 요약 + 리포트 바로가기 |

- **많이 본 것** = 횟수 순. 알고리즘이 자주 보여줘서 무의식적으로 넘긴 것
- **오래 본 것** = 평균 시청 시간 순(3개 이상). 실제로 멈춰서 본 것
- 주제는 제목의 해시태그, 없으면 채널

## 규칙

| 항목 | 값 |
|---|---|
| 방식 | 고정 윈도우 (로컬 시각 기준 정각·30분에 초기화) |
| 기본값 | 30분마다 20개 |
| 카운트 | 쇼츠에 들어가는 순간 1개 (1초 만에 넘겨도 1개, 재시청도 1개) |
| 차단 | 한도 초과 시 전체 화면 차단 + 남은 시간 카운트다운, 구간이 바뀌면 자동 해제 |
| 기록 | 영상 ID, 제목, 채널, 진입·이탈 시각, 체류 시간(탭이 보이던 시간만), 차단 여부 |
| 개인정보 | 브라우저에만 저장, 외부 전송 없음, 익명 ID(`user-xxxx`) 자동 발급 |

값은 `src/shorts-limiter.user.js` 상단 `CONFIG`에서 바꿀 수 있습니다.

## 설치

테스터용 안내는 [docs/INSTALL.md](docs/INSTALL.md) 를 보세요. 요약하면:

1. Violentmonkey 설치 → 확장 프로그램 세부정보에서 **"사용자 스크립트 허용"** 켜기
2. [설치 링크](https://raw.githubusercontent.com/knaae/shorts-limiter/main/src/shorts-limiter.user.js) 열기 → 설치

`@updateURL` 이 설정되어 있어서, `@version` 을 올려 push하면 테스터 브라우저에 자동 업데이트됩니다.

## 분석

```bash
cd analysis
pip install -r requirements.txt
python analyze_logs.py ../logs/ --out ../report_v1    # 여러 테스터 로그를 폴더째
```

사용자별로 관심 해시태그 순위, 시청 시간 분포, 시간대별 시청량, 구간별 시청 수 차트와 `report.md` 가 생성됩니다.

**관심도 점수** = 평균 시청 시간(초) × log2(1 + 시청 횟수), 3회 미만은 제외(`--min-count`).

## 데이터 시뮬레이션

```bash
python simulate_logs.py --persona gamer --days 7 --out sample_logs/sim_gamer.json
python simulate_logs.py --persona gamer --days 14 --compare   # 고정 vs 슬라이딩 윈도우
```

## 알려진 한계 (v1.0.0)

- 유튜브 화면 구조가 바뀌면 제목·채널을 못 읽을 수 있음 (제한은 주소 기반이라 영향 없음)
- 고정 윈도우 특성상 구간 경계에서 짧은 시간에 최대 2N개까지 볼 수 있음
- `youtube.com/watch?v=` 주소로 연 쇼츠는 카운트되지 않음
- PC 웹 전용 (모바일 앱 해당 없음)

## 피드백

[Issues](../../issues) 에 "피드백" 또는 "버그 제보" 양식으로 남겨주세요.
