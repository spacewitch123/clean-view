import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../types'
import { cleanName } from './clean-name'

type Engine = EngineInterface
type Checklist = CleanViewChecklist
type Task = CleanViewTask
type Timer = { cancel: () => void }

const PLUGIN = 'clean-view'
const PLAN_TOOL = `mcp__${PLUGIN}__plan_steps`
const REPORT_TOOL = `mcp__${PLUGIN}__report_progress`

const METER_CELLS = 10
const TICK_MS = 250
const COLLAPSE_MS = 5000
const FAILS_BEFORE_STUCK = 3

// Tools Claude may use before it has a plan: the ways it makes one, finds
// plan_steps, or asks the person something.
const ALLOWED_BEFORE_PLAN = new Set([
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  PLAN_TOOL,
  REPORT_TOOL,
])

const PLACEHOLDER_STEPS = ['Understand your request', 'Plan the steps']
const PLACEHOLDER_TITLE = 'Working on your request'

const SAID_NO = /doesn't want to proceed|was rejected|user (has )?(denied|rejected|declined)|permission (was )?denied/i

const MESSAGES = {
  approve: 'Claude needs your OK to continue',
  question: 'Claude has a question for you',
  reply: 'Claude is waiting for your reply',
  saidNo: 'you said no to a step, so Claude paused',
  failing: 'a step keeps failing, Claude is trying another way',
  refusal: "Claude couldn't help with that request",
  rateLimit: 'you hit your usage limit, try again a little later',
  busy: "Claude's servers are busy, try again in a minute",
  tooLong: 'type /compact and try again',
  network: 'the internet connection dropped',
  auth: 'type /login',
  other: 'something went wrong talking to Claude, try again',
} as const

const GUIDE = `# Clean View is on

The person sees a simple checklist of your work instead of tool calls, so keep it accurate and friendly.

- For every request, even a quick question, call \`${PLAN_TOOL}\` first with 2 to 8 short steps in order (load it with ToolSearch if it is deferred). If this session has TodoWrite or TaskCreate you may use your to-do list as the plan instead.
- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- Call \`${REPORT_TOOL}\` with the step name and a percent as real progress happens, and with 100 the moment a step finishes.`

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

// Module timers: a reload drops them, and the next state change starts them again.
let ticker: Timer | null = null
let lastApiError: { error: string; details: string } | null = null

// ---------- checklist rules (pure) ----------

function makeTask(id: string, name: unknown): Task {
  return { id, name: cleanName(name), status: 'upcoming', percent: 0, hasReported: false }
}

function activateFirstUpcoming(tasks: Task[], from = 0): Task[] {
  if (tasks.some(t => t.status === 'active')) {
    return tasks
  }

  const index = tasks.findIndex((t, i) => i >= from && t.status === 'upcoming')

  return tasks.map((t, i) => (i === index ? { ...t, status: 'active', percent: 0, hasReported: false } : t))
}

function settle(c: Checklist): Checklist {
  if (c.phase === 'done' || c.phase === 'stopped') {
    return c
  }

  return { ...c, phase: c.needsYouReason ? 'needs-you' : c.stuckReason ? 'stuck' : 'working' }
}

function isRunning(c: Checklist | null): c is Checklist {
  return c !== null && c.finishedAt === null && c.phase !== 'done' && c.phase !== 'stopped'
}

function newJob(jobId: string, now: number): Checklist {
  return {
    jobId,
    title: PLACEHOLDER_TITLE,
    phase: 'working',
    tasks: activateFirstUpcoming(PLACEHOLDER_STEPS.map((name, i) => makeTask(`placeholder-${i}`, name))),
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
    hasPlan: false,
    failStreak: 0,
  }
}

export function applyPlan(c: Checklist, steps: readonly unknown[]): Checklist {
  const tasks = steps.slice(0, 8).map((name, i) => makeTask(`step-${i}`, name))

  return { ...c, tasks: activateFirstUpcoming(tasks), hasPlan: true }
}

export function applyReport(c: Checklist, task: unknown, percent: unknown): Checklist {
  const name = cleanName(task)
  const amount = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
  let tasks = c.hasPlan ? c.tasks.slice() : []
  let index = tasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase())

  if (index < 0) {
    tasks.push(makeTask(`step-${c.jobId}-${tasks.length}-${name}`, name))
    index = tasks.length - 1
  }

  tasks = tasks.map((t, i) => {
    if (i < index) {
      return { ...t, status: 'done', percent: 100 }
    }

    if (i > index && t.status === 'active') {
      return { ...t, status: 'upcoming' }
    }

    return t
  })

  const target = tasks[index] as Task

  if (amount >= 100) {
    tasks[index] = { ...target, status: 'done', percent: 100, hasReported: true }
    tasks = activateFirstUpcoming(tasks, index + 1)
  } else {
    tasks[index] = { ...target, status: 'active', percent: amount, hasReported: true }
  }

  return { ...c, tasks, hasPlan: true }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

function applyTodos(c: Checklist, todos: readonly Todo[]): Checklist {
  const tasks = todos.map((todo, i): Task => {
    const name = cleanName(todo.content)
    const before = c.tasks.find(t => t.name === name)

    if (todo.status === 'completed') {
      return { id: `todo-${i}`, name, status: 'done', percent: 100, hasReported: true }
    }

    if (todo.status === 'in_progress') {
      return {
        id: `todo-${i}`,
        name,
        status: 'active',
        percent: before?.status === 'active' ? before.percent : 0,
        hasReported: before?.status === 'active' ? before.hasReported : false,
      }
    }

    return { id: `todo-${i}`, name, status: 'upcoming', percent: 0, hasReported: false }
  })

  return { ...c, tasks: activateFirstUpcoming(tasks), hasPlan: true }
}

function applyTaskCreate(c: Checklist, id: string, subject: string): Checklist {
  const tasks = c.hasPlan ? c.tasks.slice() : []
  tasks.push(makeTask(`task-${id}`, subject))

  return { ...c, tasks, hasPlan: true }
}

function applyTaskUpdate(c: Checklist, id: string, status: string | undefined, subject: string | undefined): Checklist {
  const key = `task-${id}`

  if (status === 'deleted') {
    return { ...c, tasks: c.tasks.filter(t => t.id !== key) }
  }

  const tasks = c.tasks.map((t): Task => {
    if (t.id !== key) {
      return t
    }

    const named = subject ? { ...t, name: cleanName(subject) } : t

    if (status === 'completed') {
      return { ...named, status: 'done', percent: 100 }
    }

    if (status === 'in_progress') {
      return { ...named, status: 'active' }
    }

    if (status === 'pending') {
      return { ...named, status: 'upcoming', percent: 0 }
    }

    return named
  })

  return { ...c, tasks }
}

function describeApiError(error: string, details: string): string {
  const text = `${error} ${details}`.toLowerCase()

  if (/rate_limit|billing|usage limit|429/.test(text)) {
    return MESSAGES.rateLimit
  }

  if (/overloaded|529|server_error|50[0-9]/.test(text)) {
    return MESSAGES.busy
  }

  if (/too long|context|max_output|token/.test(text)) {
    return MESSAGES.tooLong
  }

  if (/auth|oauth|login|401|403|credential|account_on_hold|verification/.test(text)) {
    return MESSAGES.auth
  }

  if (/network|connect|econn|enotfound|socket|fetch failed|timed? ?out|offline/.test(text)) {
    return MESSAGES.network
  }

  return MESSAGES.other
}

// ---------- drawing helpers (pure) ----------

function fit(text: string, width: number): string {
  if (width <= 0) {
    return ''
  }

  if (text.length > width) {
    return `${text.slice(0, Math.max(0, width - 1))}…`
  }

  return text.padEnd(width)
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function meter(percent: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, percent)) / 10)

  return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled)
}

function sweep(frame: number): string {
  const span = METER_CELLS + 3
  const head = frame % span

  return Array.from({ length: METER_CELLS }, (_, i) => (i <= head && i > head - 4 ? '█' : '░')).join('')
}

// ---------- engine glue ----------

function syncClock($: Engine, c: Checklist | null, isEnabled = true): void {
  const isLive = isEnabled && c !== null && (c.phase === 'working' || c.phase === 'needs-you')

  if (isLive && ticker === null) {
    ticker = $.clock.every(TICK_MS, () => {
      void update($, tickAtom, n => (n ?? 0) + 1)
    })
  }

  if (!isLive && ticker !== null) {
    ticker.cancel()
    ticker = null
  }
}

async function edit($: Engine, change: (c: Checklist | null) => Checklist | null): Promise<Checklist | null> {
  let changed: Checklist | null = null
  await update($, checklistAtom, c => {
    changed = change(c ?? null)
    return changed
  })
  syncClock($, changed)

  return changed
}

async function setEnabled($: Engine, value: boolean | 'toggle'): Promise<boolean> {
  let isOn = true
  await update($, enabledAtom, was => {
    isOn = value === 'toggle' ? !was : value
    return isOn
  })

  if (!isOn) {
    await update($, checklistAtom, () => null)
    syncClock($, null, false)
  }

  return isOn
}

async function nameJob($: Engine, jobId: string, text: string): Promise<void> {
  const ask = {
    model: 'haiku',
    maxTokens: 30,
    system: 'You name jobs for a progress checklist read by non-technical people.',
    prompt: `Here is a request someone sent:\n\n${text.slice(0, 2000)}\n\nReply with only a 2 to 6 word name for this job in plain English. Start with a verb. No quotes, no punctuation, no file names or code.`,
  }
  let answer = await $.model.complete({ ...ask, effort: 'low' }).catch(() => $.model.complete(ask))

  if (!answer.isAnswered) {
    return
  }

  const words = answer.text.replace(/["'.!]/g, ' ').trim().split(/\s+/).slice(0, 6).join(' ')

  if (words.split(' ').length < 2) {
    return
  }

  await edit($, c => (c !== null && c.jobId === jobId ? { ...c, title: cleanName(words) } : c))
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.tool.register({
      name: 'plan_steps',
      description:
        'Clean View: lay out every step of the job up front, 2 to 8 short plain-English names in order (under 40 characters, starting with a verb, no file names, paths, commands or code). Call this first for every request. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Clean View: report progress on the current step by its plan name. Send 100 the moment a step finishes; the next step then starts by itself.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          percent: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (no argument flips it)',
      argumentHint: '[on|off]',
      immediate: true,
    })

    // Every launch starts calm: a choice made with the button or /simple lasts the session.
    await update($, enabledAtom, () => true)

    return started
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Use /simple on, /simple off, or /simple on its own to flip it.' }
    }

    const isOn = await setEnabled($, arg === '' ? 'toggle' : arg === 'on')

    return {
      text: isOn
        ? 'Clean View is on. Technical details are hidden and a simple checklist shows the plan.'
        : 'Clean View is off. Everything Claude does is shown again.',
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!(await read($, enabledAtom))) {
      return composed
    }

    return { sections: [...composed.sections, { id: `${PLUGIN}:steps`, text: GUIDE, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()

    if (text !== '' && !text.startsWith('/') && (await read($, enabledAtom))) {
      const current = await read($, checklistAtom)

      if (isRunning(current)) {
        await edit($, c => (c === null ? c : settle({ ...c, needsYouReason: null, stuckReason: null })))
      } else {
        const jobId = e.turnId
        const now = await $.clock.now()
        await edit($, () => newJob(jobId, now))
        $.clock.after(1, () => {
          void nameJob($, jobId, text).catch(() => undefined)
        })
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>

    if (tool === PLAN_TOOL) {
      const steps = Array.isArray(input.steps) ? input.steps : []
      const now = await $.clock.now()
      const planned = await edit($, c => applyPlan(isRunning(c) ? c : newJob(String(e.tool_use_id), now), steps))
      const count = planned?.tasks.length ?? 0

      return { result: `Planned ${count} steps. The first one has started.` }
    }

    if (tool === REPORT_TOOL) {
      const amount = Math.max(0, Math.min(100, Math.round(Number(input.percent) || 0)))
      await edit($, c => (isRunning(c) ? applyReport(c, input.task, amount) : c))

      return { result: `Progress noted: ${amount}%.` }
    }

    const isMain = e.agentId === undefined

    if (!isMain || !(await read($, enabledAtom))) {
      return next(e)
    }

    const before = await read($, checklistAtom)

    if (isRunning(before) && !before.hasPlan && !ALLOWED_BEFORE_PLAN.has(tool)) {
      return {
        deny: `Clean View: call ${PLAN_TOOL} first to lay out the steps of this job in plain English, then try again.`,
      }
    }

    const isQuestion = tool === 'AskUserQuestion'

    if (isRunning(before)) {
      await edit($, c =>
        isRunning(c) ? settle({ ...c, needsYouReason: isQuestion ? MESSAGES.question : null }) : c,
      )
    }

    const ran = await next(e)

    if (!isRunning(await read($, checklistAtom))) {
      return ran
    }

    const hasFailed = ran.deny !== undefined || ran.isError === true
    const failure = ran.deny ?? (ran.isError ? String(ran.text ?? '') : '')

    await edit($, c => {
      if (!isRunning(c)) {
        return c
      }

      let changed: Checklist = { ...c, needsYouReason: null }

      if (hasFailed) {
        const failStreak = c.failStreak + 1
        const stuckReason = SAID_NO.test(failure)
          ? MESSAGES.saidNo
          : failStreak >= FAILS_BEFORE_STUCK
            ? MESSAGES.failing
            : c.stuckReason

        return settle({ ...changed, failStreak, stuckReason })
      }

      changed = { ...changed, failStreak: 0, stuckReason: null }

      if (e.tool === 'TodoWrite') {
        changed = applyTodos(changed, e.todos)
      } else if (e.tool === 'TaskCreate') {
        const created = (ran.result as { task?: { id?: unknown } } | undefined)?.task?.id
        changed = applyTaskCreate(changed, String(created ?? e.tool_use_id), e.subject)
      } else if (e.tool === 'TaskUpdate') {
        changed = applyTaskUpdate(changed, e.taskId, e.status, e.subject)
      }

      return settle(changed)
    })

    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const reason = /permission/.test(e.notification_type)
      ? MESSAGES.approve
      : /elicitation|question/.test(e.notification_type)
        ? MESSAGES.question
        : null

    if (reason !== null && (await read($, enabledAtom))) {
      await edit($, c => (isRunning(c) ? settle({ ...c, needsYouReason: reason }) : c))
    }

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastApiError = { error: String(e.error), details: String(e.error_details ?? '') }
    const reason = describeApiError(lastApiError.error, lastApiError.details)

    // Reached after turn.complete already marked the job stuck: sharpen its reason.
    await edit($, c => (c !== null && c.phase === 'stuck' && c.finishedAt !== null ? { ...c, stuckReason: reason } : c))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || !(await read($, enabledAtom)) || !isRunning(await read($, checklistAtom))) {
      return next(e)
    }

    const now = await $.clock.now()
    const apiError = lastApiError
    lastApiError = null

    const finished = await edit($, c => {
      if (!isRunning(c)) {
        return c
      }

      const end = { ...c, needsYouReason: null, finishedAt: now }

      if (e.reason === 'aborted') {
        return { ...end, phase: 'stopped' }
      }

      if (e.reason === 'refusal') {
        return { ...end, phase: 'stuck', stuckReason: MESSAGES.refusal }
      }

      if (e.reason === 'error') {
        const reason = describeApiError(apiError?.error ?? '', apiError?.details ?? e.answer)
        return { ...end, phase: 'stuck', stuckReason: reason }
      }

      if (c.hasPlan && c.tasks.some(t => t.status !== 'done')) {
        return { ...c, needsYouReason: MESSAGES.reply, phase: 'needs-you' }
      }

      const tasks = c.tasks.map((t): Task => ({ ...t, status: 'done', percent: 100 }))

      return { ...end, tasks, stuckReason: null, phase: 'done' }
    })

    if (finished?.phase === 'done') {
      const jobId = finished.jobId
      $.clock.after(COLLAPSE_MS, () => {
        void edit($, c => (c !== null && c.jobId === jobId && c.phase === 'done' ? { ...c, isCollapsed: true } : c))
      })
    }

    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) {
      return next(e)
    }

    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, hint: '' } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey) {
      return below
    }

    // Share the band: whatever other mods drew sits under the checklist.
    const withBelow = (tree: RenderElement): RenderElement =>
      below.type === 'engine' ? (
        tree
      ) : (
        <Box flexDirection="column">
          {tree}
          {below}
        </Box>
      )

    const isEnabled = await read($, enabledAtom)
    const c = isEnabled ? await read($, checklistAtom) : null
    const frame = await read($, tickAtom)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    const columns = Math.max(24, e.props.bodyColumns)
    const buttonLabel = isEnabled ? '● Clean View: ON' : '○ Clean View: OFF'
    const headerWidth = Math.max(4, columns - buttonLabel.length - 5)
    const nameWidth = Math.max(4, Math.min(40, columns - 24))

    const toggle = async () => {
      const isOn = await setEnabled($, 'toggle')
      $.ui.toast(isOn ? 'Clean View is on: technical details are hidden' : 'Clean View is off: showing everything')
    }

    const button = <Button key="clean-view-toggle" label={buttonLabel} onPress={toggle} />

    const header = (() => {
      if (c === null) {
        return <Text dimColor>{fit(isEnabled ? 'Ready when you are' : '', headerWidth)}</Text>
      }

      const title = cleanName(c.title)

      if (c.phase === 'done') {
        const took = formatTime((c.finishedAt ?? now) - c.startedAt)
        return <Text color="success">{fit(`✓ All done · ${title} · took ${took}`, headerWidth)}</Text>
      }

      if (c.phase === 'stopped') {
        return <Text dimColor>{fit(`■ Stopped · ${title} · you pressed Esc`, headerWidth)}</Text>
      }

      if (c.phase === 'needs-you') {
        return (
          <Box>
            <Text bold inverse color="warning">
              {' Needs you '}
            </Text>
            <Text>{fit(` ${c.needsYouReason ?? ''}`, Math.max(1, headerWidth - 11))}</Text>
          </Box>
        )
      }

      if (c.phase === 'stuck') {
        return <Text color="warning">{fit(`⚠ Stuck: ${c.stuckReason ?? ''}`, headerWidth)}</Text>
      }

      return <Text bold>{fit(`${title} · ${formatTime(now - c.startedAt)}`, headerWidth)}</Text>
    })()

    const headerRow = (
      <Box flexDirection="row" justifyContent="space-between">
        {header}
        {button}
      </Box>
    )

    if (c === null || c.isCollapsed) {
      return withBelow(<Box flexDirection="column">{headerRow}</Box>)
    }

    const firstUpcoming = c.tasks.findIndex(t => t.status === 'upcoming')
    const rows = c.tasks.map((t, i) => {
      const name = fit(t.name, nameWidth)

      if (t.status === 'done') {
        return (
          <Box flexDirection="row">
            <Text color="success">{'✓ '}</Text>
            <Text dimColor>{`${name} `}</Text>
            <Text color="success">{meter(100)}</Text>
            <Text dimColor>{'  Done'}</Text>
          </Box>
        )
      }

      if (t.status === 'active') {
        const mark = c.phase === 'needs-you' ? '‖ ' : '▶ '
        const bar = t.hasReported ? meter(t.percent) : sweep(frame)
        const label = t.hasReported ? `${t.percent}%` : 'Working'
        return (
          <Box flexDirection="row">
            <Text color="claude">{mark}</Text>
            <Text bold>{`${name} `}</Text>
            <Text color="claude">{bar}</Text>
            <Text>{`  ${label}`}</Text>
          </Box>
        )
      }

      return (
        <Box flexDirection="row">
          <Text dimColor>{'○ '}</Text>
          <Text dimColor>{`${name} `}</Text>
          <Text dimColor>{meter(0)}</Text>
          <Text dimColor>{i === firstUpcoming ? '  Next' : '  Up next'}</Text>
        </Box>
      )
    })

    return withBelow(
      <Box flexDirection="column">
        {headerRow}
        {rows}
      </Box>,
    )
  })
}
