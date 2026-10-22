// What the TaskStop answer of the engine means (issue #122). The answers are the ones the design study of #49 saw live
// (S2): a record on success, a string `Error: ...` with `isError` on a failure, `{ deny }` from a hook.
import { expect, test } from 'claude-code/testing'
import { stopResultOf } from '../core/lib/tasks'

test('a TaskStop record is a stop', () => {
  const out = {
    result: { message: 'Successfully stopped task: b1 (sleep 300)', task_id: 'b1', task_type: 'local_bash' },
    text: '{"message":"Successfully stopped task: b1 (sleep 300)"}',
  }
  expect(stopResultOf(out, 'b1')).toEqual({ stopped: true })
})

test('an Error string with isError is the reason, without the Error: prefix', () => {
  const out = {
    result: 'Error: No task found with ID: nope',
    text: '<tool_use_error>x</tool_use_error>',
    isError: true,
  }
  expect(stopResultOf(out, 'nope')).toEqual({ stopped: false, reason: 'No task found with ID: nope' })
  const dead = { result: 'Error: Task t1 is not running (status: killed)', isError: true }
  expect(stopResultOf(dead, 't1')).toEqual({ stopped: false, reason: 'Task t1 is not running (status: killed)' })
})

test('with isError and no string result, the text stands in, without its tool_use_error tags', () => {
  const out = {
    result: { oops: true },
    text: '<tool_use_error>No task found with ID: 9</tool_use_error>',
    isError: true,
  }
  expect(stopResultOf(out, '9')).toEqual({ stopped: false, reason: 'No task found with ID: 9' })
})

test('a deny is the reason', () => {
  expect(stopResultOf({ deny: 'a hook refused TaskStop' }, 'b1')).toEqual({
    stopped: false,
    reason: 'a hook refused TaskStop',
  })
})

test('an error with no words says TaskStop failed, and a long reason is cut to one short line', () => {
  expect(stopResultOf({ isError: true }, 'b1')).toEqual({ stopped: false, reason: 'TaskStop failed' })
  const long = stopResultOf({ result: `Error: first\n${'x'.repeat(500)}`, isError: true }, 'b1')
  expect(long).toEqual({ stopped: false, reason: 'first' })
  const wide = stopResultOf({ result: `Error: ${'y'.repeat(500)}`, isError: true }, 'b1')
  expect(wide.stopped === false && wide.reason.length).toBe(200)
  expect(wide.stopped === false && wide.reason.endsWith('…')).toBe(true)
})

test('an answer that does not confirm a stop is not a stop: no answer, an empty one, a bare string, a record with no task_id', () => {
  const unconfirmed = { stopped: false, reason: 'TaskStop did not confirm the stop' }
  expect(stopResultOf(undefined, 'b1')).toEqual({ stopped: false, reason: 'TaskStop gave no answer' })
  expect(stopResultOf({}, 'b1')).toEqual(unconfirmed)
  expect(stopResultOf({ result: 'ok' }, 'b1')).toEqual(unconfirmed)
  expect(stopResultOf({ result: { message: 'Successfully stopped task' } }, 'b1')).toEqual(unconfirmed)
  expect(stopResultOf({ result: { task_id: 7 } }, '7')).toEqual(unconfirmed)
  expect(stopResultOf({ result: { task_id: '' } }, '')).toEqual(unconfirmed)
  expect(stopResultOf({ text: '{"message":"Successfully stopped task: b1"}' }, 'b1')).toEqual(unconfirmed)
})

// The call names the task it stops, and so must the answer: another plugin's hook can answer a call with a record of its own,
// and the row of the requested task must not read killed for it.
test('an answer that names another task is not a stop of the requested one, and echoes nothing of it', () => {
  const other = { result: { message: 'Successfully stopped task: b2', task_id: 'b2', task_type: 'local_bash' } }
  expect(stopResultOf(other, 'b1')).toEqual({ stopped: false, reason: 'TaskStop named another task' })
  expect(stopResultOf(other, 'b2')).toEqual({ stopped: true })
})
