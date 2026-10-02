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
          bridge: {
            type: 'object',
            additionalProperties: false,
            description:
              '桥接进程诊断(仅 COM 后端):运行中的子进程实际加载的脚本路径与版本。' +
              '插件升级后若此版本仍是旧的,说明桥接进程尚未重启。',
            properties: {
              script: { type: 'string', description: '桥接脚本的绝对路径' },
              loadedAt: {
                type: 'string',
                description: '运行中进程载入的脚本版本(脚本文件修改时间,ISO 8601);未运行时为空',
              },
              running: { type: 'boolean', description: '桥接子进程是否存活' },
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
        const b = value.bridge
        if (b?.script) {
          lines.push(
            `桥接脚本: ${b.script}`,
            `桥接版本: ${b.loadedAt || '(未运行)'}${b.running ? '' : ' [进程未运行]'}`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      // Diagnostics are available even when the backend is down — that is
      // exactly when knowing which script failed to start matters.
      const diag = deps.cad.describeBackend()
      const bridge = {
        script: String(diag.bridgeScript ?? ''),
        loadedAt: diag.bridgeLoadedAt ? String(diag.bridgeLoadedAt) : '',
        running: Boolean(diag.bridgeRunning),
      }
      const res = await deps.cad.raw({ op: 'status' })
      if (!res.ok) {
        return {
          backend: deps.cad.backend,
          connected: false,
          unitsPerMeter: deps.unitsPerMeter,
          bridge,
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
        bridge,
      }
    },
  })
}
