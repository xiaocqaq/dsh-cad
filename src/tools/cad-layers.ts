import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LayerInfo } from '../protocol.ts'
import type { ToolDeps } from './cad-status.ts'

/** `cad_list_layers` — layer inventory with entity counts. */
export function createListLayersTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_list_layers',
    description:
      '列出当前图纸的全部图层,含颜色、线型、开关/冻结/锁定状态及每个图层的图元数量。' +
      '新建图层或判断某图层是否锁定之前,先调用本工具确认。',
    parameters: {
      onlyPopulated: {
        type: 'boolean',
        description: '为 true 时只返回含有图元的图层',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', description: '返回的图层数量' },
          layers: {
            type: 'array',
            description: '图层清单',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                color: { type: 'integer' },
                linetype: { type: 'string' },
                on: { type: 'boolean' },
                frozen: { type: 'boolean' },
                locked: { type: 'boolean' },
                entityCount: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const layers = value.layers ?? []
        if (!layers.length) {
          return [{ type: 'text', text: '图纸中没有图层。' }]
        }
        const rows = (layers as LayerInfo[]).map(l => {
          const flags = [
            l.on ? null : '关闭',
            l.frozen ? '冻结' : null,
            l.locked ? '锁定' : null,
          ].filter(Boolean).join(',')
          return `- ${l.name} | 颜色 ${l.color} | 线型 ${l.linetype || '-'} | 图元 ${l.entityCount}${flags ? ` | ${flags}` : ''}`
        })
        return [{ type: 'text', text: `共 ${layers.length} 个图层:\n${rows.join('\n')}` }]
      },
    },
    async execute(args) {
      const res = await deps.cad.raw({ op: 'listLayers' })
      if (!res.ok) return { count: 0, layers: [] as LayerInfo[] }
      const data = res.data as { layers?: LayerInfo[] }
      const all = data.layers ?? []
      const layers = args.onlyPopulated ? all.filter(l => l.entityCount > 0) : all
      return { count: layers.length, layers }
    },
  })
}
