import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CadErr } from '../protocol.ts'
import { renderError, warningBlock } from './shared.ts'

/** Canonical shape returned by every mutating CAD tool. */
export interface MutationResult {
  ok: boolean
  count: number
  handles: string[]
  warnings: string[]
  summary: string
  error?: CadErr['error']
}

/**
 * Build the shared output contract for a mutating tool.
 *
 * This is a function rather than a shared constant because `defineTool` infers
 * its return type from a `const` schema literal; a value exported from another
 * module widens `type` to `string` and the tool stops type-checking.
 */
export function mutationOutput(): {
  schema: {
    type: 'object'
    additionalProperties: false
    properties: {
      ok: { type: 'boolean'; description: string }
      count: { type: 'integer'; description: string }
      handles: { type: 'array'; description: string; items: { type: 'string' } }
      warnings: { type: 'array'; description: string; items: { type: 'string' } }
      summary: { type: 'string'; description: string }
      error: { type: 'json'; description: string }
    }
  }
  render: (args: unknown, value: MutationResult) => ContentBlock[]
} {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', description: '本次操作是否成功' },
        count: { type: 'integer', description: '实际创建/修改的图元数量' },
        handles: {
          type: 'array',
          description: '新生成或受影响图元的句柄,后续修改请使用这些句柄',
          items: { type: 'string' },
        },
        warnings: {
          type: 'array',
          description: '被跳过的对象或需要人工确认的事项',
          items: { type: 'string' },
        },
        summary: { type: 'string', description: '一句话结果说明' },
        error: { type: 'json', description: '失败时的结构化错误' },
      },
    },
    render: (_args, value) => {
      if (!value.ok) {
        return renderError(
          value.summary,
          value.error ?? { code: 'BACKEND_ERROR', message: '未知错误' },
        )
      }
      const head = `${value.summary}:成功 ${value.count} 个图元`
      const handles = value.handles.length ? `\n句柄: ${value.handles.join(', ')}` : ''
      return [{ type: 'text', text: head + handles }, ...warningBlock(value.warnings)]
    },
  }
}

/** Normalise a backend response into the shared mutation result. */
export function toResult(
  res: { ok: true; handles?: string[]; warnings?: string[] } | { ok: false; error: CadErr['error'] },
  summary: string,
): MutationResult {
  if (!res.ok) {
    return { ok: false, count: 0, handles: [], warnings: [], summary, error: res.error }
  }
  return {
    ok: true,
    count: res.handles?.length ?? 0,
    handles: res.handles ?? [],
    warnings: res.warnings ?? [],
    summary,
  }
}
