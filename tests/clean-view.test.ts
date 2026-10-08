import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { cleanName } from '../hooks/clean-name'

const PLAN = 'mcp__clean-view__plan_steps'
const REPORT = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'clean-view',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

// The world beneath the plugin: what a session's engine would answer.
function world(on: On) {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__clean-view__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Build the landing page',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskCreate') {
      return { result: { task: { id: '1', subject: e.subject } } }
    }
    return { result: { ok: true } }
  })

  return clock
}

async function startJob($: Engine, text = 'Build my landing page') {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text, turnId: `turn-${text.length}` })
}

async function texts(ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('|')
}

test('1. names are cleaned to plain words', () => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('Update apps/web/pages/index.tsx for the new hero')).toBe('Update for the new hero')
  const long = cleanName('add a very long step name that goes on and on and on past forty characters for sure ok')
  expect(long.length <= 40).toBe(true)
  expect(long.endsWith('…')).toBe(true)
  expect(cleanName('   `npm run build`  ')).toBe('Working on it')
})

test('2. a to-do list and a 60% report draw done, active, next and up next rows', async ($, on) => {
  world(on)
  await startJob($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 60 } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const drawn = await texts(ui)
    expect(drawn).toMatch(/✓ \|Read your brand notes/)
    expect(drawn).toMatch(/▶ \|Build the pricing section/)
    expect(drawn).toMatch(/██████░░░░\|  60%/)
    expect(drawn).toMatch(/Add the contact form.*  Next/)
    expect(drawn).toMatch(/Polish the footer.*  Up next/)
    expect(await ui.find({ key: 'clean-view-toggle' })).toBeDefined()
    await ui.unmount()
  }
})

test('3. a permission prompt shows Needs you', async ($, on) => {
  world(on)
  await startJob($)
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] } as never)
  await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const drawn = await texts(ui)
    expect(drawn).toMatch(/Needs you/)
    expect(drawn).toMatch(/Claude needs your OK to continue/)
    expect(drawn).toMatch(/‖ /)
    await ui.unmount()
  }
})

test('4. /simple off hides the band and brings tool rows back', async ($, on) => {
  world(on)
  await startJob($)
  await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] } as never)
  const answer = await $.command.run({ command: 'simple', args: 'off' } as never)
  expect(answer.text).toMatch(/off/)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const drawn = await texts(ui)
    expect(drawn).not.toMatch(/Read your brand notes/)
    expect((await ui.find({ key: 'clean-view-toggle' }))?.text).toMatch(/OFF/)
    await ui.unmount()
  }

  const back = await $.command.run({ command: 'simple', args: '' } as never)
  expect(back.text).toMatch(/on/)
})

test('5. report_progress at 100 checks off step one and starts step two', async ($, on) => {
  world(on)
  await startJob($)
  const planned = await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Polish the footer'] } as never)
  expect(planned.text ?? JSON.stringify(planned.result)).toMatch(/Planned 3 steps/)
  const reported = await $.tool.call({ tool: REPORT, task: 'Read your brand notes', percent: 140 } as never)
  expect(reported.text ?? JSON.stringify(reported.result)).toMatch(/100%/)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const drawn = await texts(ui)
  expect(drawn).toMatch(/✓ \|Read your brand notes/)
  expect(drawn).toMatch(/▶ \|Build the pricing section.*Working/)
  expect(drawn).toMatch(/Polish the footer.*  Next/)
  await ui.unmount()
})

test('6. tools are denied before a plan and allowed after', async ($, on) => {
  world(on)
  await startJob($)
  const before = await $.tool.call({ tool: 'Bash', command: 'ls', description: 'list' } as never)
  expect(before.isError ?? before.deny !== undefined).toBe(true)
  expect(before.text ?? before.deny).toMatch(/plan_steps/)

  const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:x', max_results: 1 })
  expect(search.isError ?? false).toBe(false)

  await $.tool.call({ tool: PLAN, steps: ['Look around', 'Tidy up'] } as never)
  const after = await $.tool.call({ tool: 'Bash', command: 'ls', description: 'list' } as never)
  expect(after.isError ?? false).toBe(false)
})

test('a finished job says All done and shrinks after 5 seconds', async ($, on) => {
  const clock = world(on)
  await startJob($)
  await $.tool.call({ tool: PLAN, steps: ['Look around', 'Tidy up'] } as never)
  await $.tool.call({ tool: REPORT, task: 'Tidy up', percent: 100 } as never)
  await clock.advance(134_000)
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await texts(ui)).toMatch(/✓ All done · .* · took 2m 14s/)
  await clock.advance(5_000)
  expect(await texts(ui)).not.toMatch(/Tidy up/)
  await ui.unmount()
})

test('tool rows are hidden while Clean View is on', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const row = {
    plugin: 'clean-view',
    component: 'ToolUse',
    props: { tool_use_id: 'x', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
  } as const

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row, surface })
    expect(JSON.stringify(await ui.drawn())).toMatch(/"display":"none"/)
    await ui.unmount()
  }
})
