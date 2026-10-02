import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OpenRequest, SaveAsRequest } from '../protocol.ts'
import { renderError } from './shared.ts'
import { mutationOutput, toResult } from './mutation.ts'
import type { ToolDeps } from './cad-status.ts'

/** `cad_open` — open a DWG and make it the active drawing. */
export function createOpenTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_open',
    description:
      '在 AutoCAD 中打开指定的 DWG/DXF 文件并设为当前活动图形。' +
      '路径必须是本机绝对路径。修改前建议先另存副本(cad_save_as),避免覆盖原始图纸。',
    parameters: {
      path: { type: 'string', required: true, description: 'DWG/DXF 文件的绝对路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '是否成功打开' },
          name: { type: 'string', description: '图形文件名' },
          path: { type: 'string', description: '完整路径' },
          modelSpaceCount: { type: 'integer', description: '模型空间图元数量' },
          error: { type: 'json', description: '失败时的结构化错误' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) {
          const err = value.error as { code?: never; message?: string } | undefined
          return renderError('打开图形', {
            code: 'BACKEND_ERROR',
            message: err?.message ?? '未知错误',
          })
        }
        return [{
          type: 'text',
          text: `已打开 ${value.name}\n路径: ${value.path}\n模型空间图元数: ${value.modelSpaceCount}`,
        }]
      },
    },
    async execute(args) {
      const request: OpenRequest = { op: 'open', path: args.path }
      const res = await deps.cad.raw(request)
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
        }
      }
      const data = res.data as { name?: string; path?: string; modelSpaceCount?: number }
      return {
        ok: true,
        name: String(data.name ?? ''),
        path: String(data.path ?? args.path),
        modelSpaceCount: Number(data.modelSpaceCount ?? 0),
      }
    },
  })
}

/** `cad_save_as` — save to a new path, leaving the original untouched. */
export function createSaveAsTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_save_as',
    description:
      '将当前图形另存为指定的 DWG 文件(不改变原文件)。' +
      '改图任务的标准收尾动作:先用本工具输出新图纸,再向用户说明改动内容。',
    parameters: {
      path: { type: 'string', required: true, description: '目标 DWG 文件绝对路径' },
    },
    output: mutationOutput(),
    async execute(args) {
      const request: SaveAsRequest = { op: 'saveAs', path: args.path }
      const res = await deps.cad.raw(request)
      if (!res.ok) {
        return { ok: false, count: 0, handles: [], warnings: [], summary: '另存图形', error: res.error }
      }
      const data = res.data as { path?: string }
      return {
        ok: true,
        count: 1,
        handles: [],
        warnings: [],
        summary: `已另存为 ${data.path ?? args.path}`,
      }
    },
  })
}

export { toResult }
