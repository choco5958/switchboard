#!/bin/sh
c() { curl -s --unix-socket $CLAUDE_IDE_SOCKET -H 'content-type: application/json' -X "$1" "http://bridge$2" ${3:+-d "$3"} >/dev/null; }
c POST /sessions '{"id":"s-act","cwd":"/x/actuarial-compiler"}'
c POST /sessions/usage '{"sessionId":"s-act","usage":{"model":"Opus 5.5","rateLimits":[{"kind":"five_hour","percentUsed":39},{"kind":"seven_day","percentUsed":81}],"cost":{"totalUsd":2235.7}}}'
c POST /tasks '{"sessionId":"s-act","title":"메인 시나리오 E2E 회귀","now":"시나리오1 엔젤 주계약 E2E와 가이드북","why":"엔젤 주계약과 독립특약 26종 두 메인 시나리오를 E2E 회귀로 정의하고 가이드북까지","what":"메인 시나리오 E2E 회귀","result":"PR #366 머지해도 됨","artifact":"PR #344","tests":"통과 304, 실패 0","branch":"fix/dyins50-shell-seed-v2"}'
c POST /nodes '{"sessionId":"s-act","taskTitle":"메인 시나리오 E2E 회귀","nodes":[{"key":"plan","title":"시나리오 지도와 시험 케이스 기획","kind":"시험","stage":"요구"},{"key":"decide","title":"사용자 결정","kind":"확인","owner":"사용자","stage":"설계","after":["plan"]},{"key":"s1","title":"시나리오1 엔젤 주계약 E2E","stage":"작업","after":["decide"]},{"key":"s2","title":"시나리오2 독립특약 26종 E2E","stage":"작업","after":["decide"]},{"key":"rv","title":"PR 독립 검토","kind":"검토","owner":"검토자","stage":"작업","after":["s1","s2"]},{"key":"reg","title":"회귀 돌리기와 결과 화면","stage":"완료","after":["rv"]}]}'
st() { c POST /nodes/status "{\"sessionId\":\"s-act\",\"taskTitle\":\"메인 시나리오 E2E 회귀\",\"key\":\"$1\",\"status\":\"$2\"${3:+,\"note\":\"$3\"}}"; }
st plan 끝; st decide 끝 Q1397; st s1 지금; st s1 끝 "PR #364"; st rv 지금; st rv 끝 "지적 4건"; st s1 지금 "지적 반영"; st s2 지금
c POST /agents '{"sessionId":"s-act","agents":[{"id":"a1","description":"[메인 시나리오 E2E 회귀::s1] 시나리오1 지적 반영","status":"running"},{"id":"a2","description":"[메인 시나리오 E2E 회귀::s2] 시나리오2 독립특약","status":"running"},{"id":"a3","description":"[메인 시나리오 E2E 회귀::rv] PR #364 독립 검토","status":"completed"}]}'
c POST /tasks '{"sessionId":"s-act","title":"금감원 무인 자동화","now":"PR마다 독립 검토","stage":"작업"}'
c POST /tasks '{"sessionId":"s-act","title":"빈 앱 E2E Run","now":"대기","stage":"설계","status":"대기"}'
c POST /tasks '{"sessionId":"s-act","title":"끝난 정리 작업","stage":"완료"}'
c POST /questions '{"sessionId":"s-act","taskTitle":"메인 시나리오 E2E 회귀","turnId":"rrvmwu0-turn","question":"만기환급형을 v2 환급형 코드에 넣을까","body":"꿈나무우리아이에는 만기환급형이 있는데 v2 코드에는 없음","options":[{"key":"a","label":"v2 코드에 더하고 제안본을 정본으로"},{"key":"b","label":"정본에서 뺌"}],"recommend":"a","reason":"실제 상품에 있는 환급형"}'
c POST /questions '{"sessionId":"s-act","taskTitle":"금감원 무인 자동화","question":"재시도 상한을 3회로 할까","options":[{"key":"a","label":"3회"},{"key":"b","label":"5회"}]}'
