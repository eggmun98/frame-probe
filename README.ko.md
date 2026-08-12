# frame-probe

애니메이션 웹 앱이 **왜** 프레임을 떨구는지 찾는 도구. "떨어진다"가 아니라 "왜"를 본다.

Chrome을 DevTools Protocol로 직접 몰아서 같은 동작을 결정적으로 재현하고, 프레임 타이밍과
렌더러 내부 호출 횟수를 프레임 단위로 기록한다. DevTools Performance 패널에서 저장한
트레이스도 읽는다 — 로컬에서 재현이 안 되는 문제용이다.

**의존성 0.** Node 22 이상 (내장 `WebSocket` 사용).

[English README](./README.md)

---

## DevTools 직접 열면 안 되나

한 번은 그렇게 하는 게 맞다. 문제는 **두 버전을 비교할 때** 시작된다.

- 동작이 매번 똑같지 않아서, 내 변경과 무관한 이유로 수치가 움직인다.
- 콘솔을 여는 것만으로 수치가 바뀐다. 앱이 객체를 로깅하면 DevTools가 그걸 직렬화하고, 그 비용이 측정에 섞인다.
- 평균 FPS는 문제를 감춘다. 60 → 58fps는 대개 "모든 프레임이 느려진 것"이 아니라 **한두 개의 아주 긴 프레임**이다. 어느 프레임인지, 그때 무슨 일이 있었는지를 알아야 한다.

frame-probe는 동작을 고정하고, 모든 프레임을 기록하고, 렌더러가 실제로 뭘 했는지 센다.

---

## 설치

```bash
git clone <이 저장소> && cd frame-probe
node -v   # v22 이상
```

빌드도 설치도 없다.

동작 확인은 같이 들어 있는 데모로 한다. 매 동작 400ms 지점에서 일부러 멈추는 페이지다.

```bash
node examples/demo/serve.mjs &
node bin/frame-probe.mjs run examples/demo/demo.config.mjs
node bin/frame-probe.mjs report demo-run.json
```

```
  iter |   fps | worst  | >25ms | lag over budget
     2 |  59.0 |   50.0ms |     1 |            59ms
     3 |  59.5 |   33.9ms |     1 |            43ms

=== long frames (>25ms) by offset from iteration start ===
  +   400ms  ## (2)      <- 심어둔 지연을 정확히 짚는다
```

---

## 사용법

### 일단 그냥 봐본다

설정도 준비도 없다. 페이지를 열고, 조작하는 동안 기록하고, 리포트를 뽑는다.

```bash
frame-probe watch --url=http://localhost:3000 --seconds=20 --throttle=4
```

**버스트인지 상시 초과인지**부터 가리는 용도다. 이걸 먼저 알아야 이후 투자 방향이 정해진다.

### 그다음 재현 가능하게 만든다

두 버전을 비교하려면 동작이 매번 똑같아야 한다. 설정 파일을 만든다.

```bash
frame-probe init
```

세 가지만 고치면 된다. **앱이 어디 있나**, **어떻게 그 동작을 시키나**, **언제 끝난 줄 아나**.

```js
// my.config.mjs
export default {
  url: 'http://127.0.0.1:3000/',
  iterations: 6,
  cpuThrottling: 4,

  async ready(page)    { await page.waitFor(`document.querySelector('canvas')`); },
  async action(page)   { await page.click('#start'); },
  async waitDone(page) { await page.waitFor(`document.body.dataset.state === 'idle'`); },
};
```

```bash
frame-probe run my.config.mjs --out=before.json
# ... 수정 ...
frame-probe run my.config.mjs --out=after.json
frame-probe report after.json
```

### 명령

| | |
|---|---|
| `frame-probe watch --url=…` | **여기부터.** 설정 없이 조작하는 동안 기록 |
| `frame-probe init` | 설정 파일 스캐폴딩 |
| `frame-probe run <config.mjs>` | 앱을 자동으로 몰아서 기록, JSON 저장 |
| `frame-probe report <run.json>` | 요약, 긴 프레임 히스토그램, 객체 생성 분포 |
| `frame-probe trace <trace.json>` | DevTools 트레이스 분석 |

플래그: `--out=`, `--throttle=`, `--iterations=`, `--label=`, `--long=`, `--marks=`, `--url=`.

---

## 무엇을 기록하나

**프레임마다** 시각, 간격, 누적 카운터를 남긴다. "그 프레임에 무슨 일이 있었나"를 추측이 아니라 조회로 답한다.

**CPU 스로틀** — `Emulation.setCPUThrottlingRate`. DevTools UI는 6×가 최대지만 CDP로는 아무 배율이나 된다.

**WebGL 호출 횟수** — 드로우콜, `texSubImage2D`(텍스처 업로드), `bufferSubData`.
앱이 컨텍스트를 얻기 전에 프로토타입을 감싼다. **횟수는 하드웨어와 무관해서 기기가 달라도 비교가 성립한다.**

**Long Animation Frame** — 지원되면 스크립트 귀속까지.

**결정적 재현** — 네트워크를 스텁해서 매 회차를 완전히 동일하게 만든다.

```js
stubs: [
  { pattern: '/api/action$', response: () => ({ ok: true, value: 42 }) },
  { pattern: '/api/slow$',   response: {}, delayMs: 3000 },  // 로딩 경로 검증용
],
```

편의 기능이 아니라 **비교가 성립하는 근거**다. 서버가 매번 다른 걸 돌려주면
수치가 움직인 게 내 수정 때문인지 응답이 달라서인지 가릴 수 없다.

### 이미 있는 픽스처를 그대로 쓴다

미리 만들어둔 서버 응답이 어딘가 이미 있을 것이다 — 스토리북 스토리 데이터, MSW 핸들러,
테스트 픽스처, VCR 카세트. Node에서 읽어서 스텁으로 내려주면 된다.

```js
import fs from 'node:fs';
const fixtures = JSON.parse(fs.readFileSync('./src/stories/data/scenarios.json', 'utf8'));
const scenario = fixtures.find((f) => f.id === Number(process.env.SCENARIO ?? 1));

export default {
  stubs: [{ pattern: '/api/action$', response: () => ({ result: scenario.events }) }],
};
```

id 하나만 바꾸면 원하는 상황을 골라 태울 수 있고, 앱은 완전히 오프라인으로 돈다.

**편한 픽스처만 쓰지 말고 비싼 쪽을 태워라.** 이 도구가 나온 조사에서 한참 동안
"아무 일도 안 일어나는" 픽스처로만 쟀다. 최악의 churn — 초당 수백 개 객체 재생성 — 은
결과 연출이 있는 픽스처에서만 나타났고, 아무도 그걸 재보지 않았다.

### PixiJS 애드온

번들러는 Pixi를 `window`에 안 올려서 밖에서 패치할 게 없다. 트릭은 이렇다 —
**앱이 이미 로드한 모듈 URL을 그대로 다시 `import()`** 한다. ESM은 URL당 싱글턴이라
앱이 쓰는 바로 그 클래스가 돌아온다.

```js
pixi: { urlPattern: 'pixi' },
```

`addChild` / `destroy` / `sortChildren` 횟수와 함께, **씬 그래프에 추가된 객체의
생성자 이름**을 남긴다. 이 마지막 하나가 "뭔가 churn이 있다"를
"`BitmapText`가 초당 200개씩 재생성된다 — 리스트 키에 텍스트 자체가 들어가 있어서"로 바꿔준다.

Vite dev, 네이티브 ESM, import map에서 동작한다. 완전히 번들된 프로덕션 빌드는
재import할 모듈 URL이 없으니 트레이스 방식을 쓴다.

---

## 동작을 어떻게 시키고, 언제 끝난 줄 아나

앱마다 다른 유일한 부분이고, 설정에 훅이 있는 이유가 이것이다. 잘 버티는 순서로:

**1. 테스트 전용 DOM 오버레이.** 앱이 캔버스나 WebGL로 그린다면, 플래그(`?e2e=true`)로만
뜨는 작은 DOM 오버레이에 버튼과 상태 속성을 노출하는 게 압도적으로 낫다.

```js
async action(page)   { await page.click('[data-testid=start]'); },
async waitDone(page) { await page.waitFor(`document.body.dataset.state === 'idle'`); },
```

레이아웃이나 해상도가 바뀌어도 안 깨지고, e2e 테스트에도 어차피 필요한 물건이다.
**없으면 우회하는 것보다 만드는 게 대개 이득이다.**

**2. 앱 상태를 직접 읽는다.** Pixi 애드온과 같은 싱글턴 트릭이다. 상태 모듈을 재import해서 읽는다.

```js
async waitDone(page) {
  await page.waitFor(`(async () => {
    const url = performance.getEntriesByType('resource').map(r => r.name).find(n => /appState/.test(n));
    const m = await import(url);
    return m.state.phase === 'idle';
  })()`);
}
```

함정: dev 서버는 캐시 버스팅 쿼리를 붙인다. 앱이 `/src/state.js?t=1699…`로 로드했는데
`/src/state.js`를 import하면 **다른 모듈 인스턴스**가 잡히고, 값이 영원히 안 변한다.
반드시 `performance.getEntriesByType('resource')`에서 실제 URL을 찾아 쓸 것.

**3. 네트워크 마크.** `probe.markRequests`를 켜두면 요청 타이밍이 이미 프레임 시계에 올라와
있으므로, 동작을 시작시키는 요청이 **추가 작업 없이** 신뢰할 수 있는 시작 경계가 된다.
끝은 다른 수단이 필요하다.

**4. 정적화 감지.** "N프레임 동안 씬 그래프 변경 0"을 완료로 본다. 러프하지만 앱에서
아무것도 안 받아도 된다.

**5. 키보드 트리거 + 고정 대기.** 동작은 하지만 유휴 시간이 평균에 섞인다. 써야 한다면
유휴 시간이 왜곡하지 못하는 지표만 결론에 쓴다 — 평균 FPS 말고 긴 프레임 개수 같은 것.

**캔버스 좌표 클릭은 하지 마라.** 레이아웃이나 해상도가 바뀌면 조용히 깨진다.

---

## 결과 읽는 법

### 히스토그램부터 본다

```
=== long frames (>25ms) by offset from iteration start ===
  +   400ms  ############ (12)
```
**한 곳에 몰림** — 버스트다. 그 시점에 뭔가 특정한 일이 일어난다. 찾아가면 된다.

```
  +   400ms  ############ (12)
  +   600ms  ################ (16)
  +   800ms  ############ (12)
  +  1000ms  ############### (15)
```
**고르게 퍼짐** — 상시 예산 초과다. 고칠 단일 지점이 없고, 전체 작업량을 줄여야 한다.
둘 중 어느 쪽인지 아는 것만으로 며칠을 아낀다.

### 타이밍보다 카운터를 믿어라

실행 시간은 내 코드와 무관한 이유로 흔들린다. 이 도구가 나온 조사에서 실제로 겪은 일:

- **같은 코드**가 dev 서버 프로세스가 다르다는 이유로 **44.7ms**와 **253.4ms**로 나왔다.
- **같은 빌드**를 두 번 돌렸더니 **554ms**와 **608ms**였다.

카운터는 안 흔들린다. "그 수정이 GPU 텍스처 업로드를 줄였나"는 한 줄로 끝났다 —
`texSubImage2D`가 회차당 **26.2 → 26.3**, 즉 안 줄었다. 그 전까지 타이밍 비교는
20% 개선처럼 보였고, 그건 노이즈였다.

### 타이밍을 비교해야 한다면 A/B/A

*수정 후* → *수정 전* → *수정 후* 순으로 돌린다.
두 번의 "수정 후"가 "수정 전"을 사이에 두면 그 변경은 **노이즈 이하**다.

### 최적화 전에 상한부터 재라

어떤 서브시스템을 튜닝하기 전에, **아예 없애면 얼마나 빨라지는지**부터 묻는다.

```js
disable: { urlPattern: 'my-anim-lib', className: 'Skeleton', method: 'update' },
```

그 조사에서 스켈레탈 애니메이션 갱신을 **전부** 끈 결과가 46.7 → 47.8fps였다.
이 한 번의 실행이 유망해 보이던 방향 하나를 통째로 닫았다.

---

## 남의 기기에서 뜬 트레이스

재현이 안 되는 경우가 있다. 재현되는 사람에게 DevTools Performance 패널로 10초만
기록해서 (**Save profile** → `.json`) 받으면 된다.

```bash
frame-probe trace their-trace.json --url='/api/action'
```

드롭 프레임 수, 긴 작업 히스토그램, 트레이스에 내장된 CPU 프로파일의 자기시간 귀속이 나온다.
난독화된 프로덕션 번들도 **청크 라인 번호로 모듈이 갈려서** 어느 라이브러리가 시간을 쓰는지는 대개 보인다.

**출력의 `cpuThrottling`을 먼저 확인하라.** 15×로 기록된 트레이스는 그 노트북보다 15배 느린
기기에 대한 정보다. 실제로 불평이 나오는 기기와 전혀 다를 수 있다.

---

## 함정 — 실제로 당한 것들

**콘솔 관련 CDP 트래픽이 측정을 오염시킨다.** 페이지가 객체를 로깅하는데 런타임 도메인이
켜져 있으면 직렬화 비용이 수치에 섞인다. frame-probe는 켜지 않는다.

**계측기 자신이 공짜가 아니다.** 초기 버전은 호출자를 알아내려고 래퍼 안에서
`new Error().stack`을 캡처했다. 그 결과 감싼 함수가 프로파일 1위처럼 보였다. 아니었다.
스택 캡처는 기본으로 꺼둔다.

**소스 수정 후 첫 실행은 버린다.** dev 서버의 변환 비용이 섞인다.

**중요한 경로를 실제로 태워라.** 싼 경로만 재면 진짜 문제를 놓친다. 원래 조사에서
한동안의 측정이 결과 연출이 없는 경로만 쓰고 있었는데, 정작 최악의 churn은 거기 있었다.

**부하의 양이 아니라 종류를 맞춰라.** CPU 스로틀은 메인스레드 JS만 늦춘다.
GPU 한계, 텍스처 대역폭, 그리고 **화면 주사율**은 전혀 흉내내지 못한다.
120Hz 기기의 프레임 예산은 16.7ms가 아니라 **8.3ms**다. 60fps를 여유롭게 내는 앱이
60으로 고정된 앱보다 거기서 더 나빠 보일 수 있다. CPU 스로틀을 아무리 걸어도 이건 안 보인다.

**최적화 전에 어떤 기기인지 물어라.** 최근 플래그십 폰은 데스크톱급이다.
"low-tier mobile" 같은 이름의 프리셋은 수년 전 하드웨어를 모델링한 값이다.

---

## 라이선스

MIT
