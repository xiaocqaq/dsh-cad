import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CadService } from '../service.ts'
import { pointSchema } from './shared.ts'

/** Everything the tools need, injected once at plugin-apply time. */
export interface ToolDeps {
  cad: CadService
  unitsPerMeter: number
}

/** `cad_status` — connection, units and active drawing. */
export function createStatusTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_status',
    description:
      '查看 CAD 后端连接状态、当前打开的图形、图纸单位与模型空间图元数量。' +
      '开始任何 CAD 操作前,先用本工具确认已连接到正确的图纸和正确的单位比例。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string', description: '后端类型: com 或 simulation' },
          connected: { type: 'boolean', description: '是否已成功连接' },
          unitsPerMeter: { type: 'number', description: '每米对应的图纸单位数' },
          document: {
            type: 'object',
            additionalProperties: false,
            description: '当前图形信息,未连接时为空',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              unitsName: { type: 'string' },
              modelSpaceCount: { type: 'integer' },
              activeSpace: { type: 'string' },
            },
          },
          message: { type: 'string', description: '未连接或出错时的说明' },
        },
      },
      render: (_args, value) => {
        if (!value.connected) {
          return [{ type: 'text', text: `CAD 未连接(${value.backend}): ${value.message ?? '未知原因'}` }]
        }
        const d = value.document
        const lines = [
          `后端: ${value.backend}`,
          `单位比例: 1 米 = ${value.unitsPerMeter} 图纸单位`,
        ]
        if (d) {
          lines.push(
            `当前图形: ${d.name}`,
            `路径: ${d.path || '(未保存)'}`,
            `图纸单位: ${d.unitsName}`,
            `模型空间图元数: ${d.modelSpaceCount}`,
            `活动空间: ${d.activeSpace === 'paper' ? '图纸空间' : '模型空间'}`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const res = await deps.cad.raw({ op: 'status' })
      if (!res.ok) {
        return {
          backend: deps.cad.backend,
          connected: false,
          unitsPerMeter: deps.unitsPerMeter,
          message: res.error.message,
        }
      }
      const data = res.data as { backend?: string; document?: Record<string, unknown> }
      const document = data.document
        ? {
            name: String(data.document.name ?? ''),
            path: String(data.document.path ?? ''),
            unitsName: String(data.document.unitsName ?? ''),
            modelSpaceCount: Number(data.document.modelSpaceCount ?? 0),
            activeSpace: String(data.document.activeSpace ?? 'model'),
          }
        : undefined
      return {
        backend: data.backend ?? deps.cad.backend,
        connected: true,
        unitsPerMeter: deps.unitsPerMeter,
        document,
      }
    },
  })
}
