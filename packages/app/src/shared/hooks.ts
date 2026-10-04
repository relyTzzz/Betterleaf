import type { HookInput, ScheduleTarget } from './types.js';

/**
 * Hook helpers both processes need. Plain functions with no Node in them, so
 * the renderer can import values from here, which it cannot from `main/`.
 */

/**
 * Clear of the Nanoleaf API's 16021 and of the simulator's 16021/16022, so a
 * development machine running both does not collide with itself.
 */
export const DEFAULT_HOOK_PORT = 16100;

const MAX_SLUG = 48;

/**
 * What can go in an address without escaping: lowercase letters, digits and
 * single dashes. "Claude: waiting!" becomes `claude-waiting`.
 *
 * Accents are folded rather than dropped, so "Café" is `cafe` and not `caf`.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG)
    .replace(/^-+|-+$/g, '');
}

export function hookBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function hookUrl(port: number, slug: string): string {
  return `${hookBase(port)}/hooks/${slug}`;
}

/**
 * The three hooks that follow a Claude Code session, in priority order.
 *
 * Waiting is on top because it is the one that needs you: with two sessions
 * open, one waiting on a permission must not be painted over by the other
 * finishing. Working outranks done for the same reason — something is still
 * happening.
 */
export const CLAUDE_CODE_HOOKS = [
  {
    role: 'waiting',
    name: 'Claude Code: waiting on you',
    slug: 'claude-waiting',
    color: { hue: 32, saturation: 100 },
  },
  {
    role: 'working',
    name: 'Claude Code: working',
    slug: 'claude-working',
    color: { hue: 220, saturation: 90 },
  },
  {
    role: 'done',
    name: 'Claude Code: done',
    slug: 'claude-done',
    color: { hue: 130, saturation: 75 },
  },
] as const;

export type ClaudeRole = (typeof CLAUDE_CODE_HOOKS)[number]['role'];

export function claudeCodeHookInputs(target: ScheduleTarget): HookInput[] {
  return CLAUDE_CODE_HOOKS.map((preset) => ({
    name: preset.name,
    slug: preset.slug,
    enabled: true,
    target,
    action: { power: true, color: { ...preset.color } },
  }));
}

/**
 * The `hooks` block for Claude Code's settings.json.
 *
 * Which Claude Code event means which state:
 *
 * - **working** on UserPromptSubmit, and on PostToolUse/PostToolUseFailure.
 *   The tool events are what end a wait: after you approve a permission or
 *   answer a question, the next thing Claude Code reports is the tool finishing.
 *   They fire after every tool call, which costs nothing — a repeat of the
 *   state already showing leaves the lights alone.
 * - **waiting** on PermissionRequest, and on PreToolUse for AskUserQuestion,
 *   which waits on you just as much without asking for a permission.
 * - **done** on Stop, which fires when Claude finishes responding. Not
 *   PostToolUse: that fires mid-task, between one tool and the next.
 * - SessionEnd **releases** the session, so a closed one stops counting.
 *
 * `http` hooks rather than `curl` commands: Claude Code posts the event itself,
 * session id included, with no process started per event. Two seconds is a
 * ceiling, not an estimate — Betterleaf answers before touching the lights, so
 * a slow light can never hold a session up.
 */
export function claudeCodeSettings(port: number, slugs: Record<ClaudeRole, string>): string {
  const base = hookBase(port);
  const call = (path: string, matcher?: string) => [
    {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'http', url: `${base}${path}`, timeout: 2 }],
    },
  ];
  const fire = (role: ClaudeRole) => `/hooks/${slugs[role]}`;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: call(fire('working')),
        PreToolUse: call(fire('waiting'), 'AskUserQuestion'),
        PermissionRequest: call(fire('waiting')),
        PostToolUse: call(fire('working')),
        PostToolUseFailure: call(fire('working')),
        Stop: call(fire('done')),
        SessionEnd: call('/release'),
      },
    },
    null,
    2,
  );
}
