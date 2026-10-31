import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APPROVAL_POLL_MS, waitApproval, type ApprovalWait, type PollReply } from '../hooks/approval.ts'

const HOOK_BUDGET_MS = 10_000

// A bridge that answers each long poll after the wait it was asked for, on a clock the test
// owns; `slept` is what the hook would have spent of its own budget.
function world(answers: (at: number, waitMs: number) => PollReply, until = 6 * 3600_000) {
  let clock = 0
  const w = { polls: [] as number[], slept: 0, abandoned: 0, reconnects: 0, isAborted: false }
  const wait: ApprovalWait = {
    until,
    now: async () => clock,
    poll: async waitMs => {
      w.polls.push(waitMs)
      const reply = answers(clock, waitMs)
      if (reply.status === 200 && reply.json.status === 'pending') clock += waitMs
      return reply
    },
    aborted: () => w.isAborted,
    reconnect: async () => {
      w.reconnects += 1
      return true
    },
    sleep: async ms => {
      w.slept += ms
      clock += ms
    },
    abandon: async () => {
      w.abandoned += 1
    },
  }
  return { w, wait, time: () => clock }
}

const pending: PollReply = { ok: true, status: 200, json: { status: 'pending', waitMs: APPROVAL_POLL_MS } }

test('an answer a minute later still counts: the wait spends none of the hook budget', async () => {
  const { w, wait, time } = world(at => (at >= 60_000 ? { ok: true, status: 200, json: { status: 'allow', waitMs: APPROVAL_POLL_MS } } : pending))
  assert.equal((await waitApproval(wait)).answer, 'allow')
  assert.ok(time() > HOOK_BUDGET_MS)
  assert.equal(w.slept, 0)
  assert.ok(w.polls.every(ms => ms === APPROVAL_POLL_MS))
  assert.equal(w.abandoned, 0)
})

test('a deny comes back as a deny; terminal and expired go to the terminal without an abandon', async () => {
  assert.equal((await waitApproval(world(() => ({ ok: true, status: 200, json: { status: 'deny', waitMs: 1 } })).wait)).answer, 'deny')
  for (const status of ['terminal', 'expired']) {
    const { w, wait } = world(() => ({ ok: true, status: 200, json: { status, waitMs: 1 } }))
    assert.equal((await waitApproval(wait)).answer, 'ask')
    assert.equal(w.abandoned, 0)
  }
})

test('when the wait is over the bridge hears the ask is abandoned, and the last poll is cut to the time left', async () => {
  const { w, wait, time } = world(() => pending, 50_000)
  assert.equal((await waitApproval(wait)).answer, 'ask')
  assert.equal(time(), 50_000)
  assert.deepEqual(w.polls, [20_000, 20_000, 10_000])
  assert.equal(w.abandoned, 1)
})

test('an interrupted call stops waiting and abandons the ask', async () => {
  const { w, wait } = world(() => {
    w.isAborted = true
    return pending
  })
  assert.equal((await waitApproval(wait)).answer, 'ask')
  assert.equal(w.polls.length, 1)
  assert.equal(w.abandoned, 1)
})

test('a bridge out of reach is started again; one that stays away ends the wait', async () => {
  let down = 2
  const back = world(() => (down-- > 0 ? { ok: false, status: 0, json: {} } : { ok: true, status: 200, json: { status: 'allow', waitMs: 1 } }))
  assert.equal((await waitApproval(back.wait)).answer, 'allow')
  assert.equal(back.w.reconnects, 2)
  // Each failed poll halves the next, in case the host cuts a fetch held this long.
  assert.deepEqual(back.w.polls, [20_000, 10_000, 5_000])

  const gone = world(() => ({ ok: false, status: 0, json: {} }))
  gone.wait.reconnect = async () => false
  assert.equal((await waitApproval(gone.wait)).answer, 'ask')
  assert.equal(gone.w.polls.length, 1)
  assert.equal(gone.w.abandoned, 1)

  const rejecting = world(() => pending)
  rejecting.wait.poll = () => Promise.reject(new Error('ECONNREFUSED'))
  assert.equal((await waitApproval(rejecting.wait)).answer, 'ask')
  assert.equal(rejecting.w.reconnects, 4)
  assert.equal(rejecting.w.abandoned, 1)
})

test('an ask the bridge no longer has (404) ends the wait', async () => {
  const { w, wait } = world(() => ({ ok: false, status: 404, json: { error: 'not found' } }))
  assert.equal((await waitApproval(wait)).answer, 'ask')
  assert.equal(w.polls.length, 1)
})

test('a bridge from before long polls is polled each second, as before', async () => {
  let n = 0
  const { w, wait } = world(() => (++n < 4 ? { ok: true, status: 200, json: { status: 'pending' } } : { ok: true, status: 200, json: { status: 'allow' } }))
  assert.equal((await waitApproval(wait)).answer, 'allow')
  assert.equal(w.slept, 3000)
})

test('a deny brings what the person wrote with it; an allow never carries a note', async () => {
  const deny = await waitApproval(world(() => ({ ok: true, status: 200, json: { status: 'deny', note: '  build 폴더는 지우지 말고 dist만 지우세요 ', waitMs: 1 } })).wait)
  assert.deepEqual(deny, { answer: 'deny', note: 'build 폴더는 지우지 말고 dist만 지우세요' })
  assert.deepEqual(await waitApproval(world(() => ({ ok: true, status: 200, json: { status: 'deny', waitMs: 1 } })).wait), { answer: 'deny', note: '' })
  assert.deepEqual(await waitApproval(world(() => ({ ok: true, status: 200, json: { status: 'allow', note: 'x', waitMs: 1 } })).wait), { answer: 'allow', note: '' })
})
