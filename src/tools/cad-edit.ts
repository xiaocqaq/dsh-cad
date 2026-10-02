import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  DeleteRequest,
  ModifyRequest,
  Point,
  TransformRequest,
} from '../protocol.ts'
import { colorSchema, layerSchema, pointSchema } from './shared.ts'
import { mutationOutput, toResult } from './mutation.ts'
import type { ToolDeps } from './cad-status.ts'

/** `cad_modify` — change one entity's properties, preserving the rest. */
export function createModifyTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_modify',
    description:
      '修改单个图元的属性(图层/颜色/线型/文字/字高/旋转角/半径)。' +
      '只修改明确给出的字段,其余属性保持不变。' +
      'handle 必须来自 cad_query_entities 的检索结果,不要凭猜测填写。',
    parameters: {
      handle: { type: 'string', required: true, description: '目标图元句柄' },
      set: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: '要修改的字段(只需给出要改的项)',
        properties: {
          layer: { ...layerSchema, description: '新图层' },
          color: { ...colorSchema, description: '新颜色' },
          linetype: { type: 'string', description: '新线型,如 CENTER、DASHED' },
          text: { type: 'string', description: '新文字内容' },
          height: { type: 'number', description: '新字高(米)' },
          rotation: { type: 'number', description: '新旋转角(度)' },
          radius: { type: 'number', description: '新半径(米)' },
        },
      },
    },
    output: mutationOutput(),
    async execute(args) {
      const u = deps.cad.units
      const set: ModifyRequest['set'] = {}
      if (args.set.layer !== undefined) set.layer = args.set.layer
      if (args.set.color !== undefined) set.color = args.set.color
      if (args.set.linetype !== undefined) set.linetype = args.set.linetype
      if (args.set.text !== undefined) set.text = args.set.text
      if (args.set.height !== undefined) set.height = u.toDrawing(args.set.height)
      if (args.set.rotation !== undefined) set.rotation = args.set.rotation
      if (args.set.radius !== undefined) set.radius = u.toDrawing(args.set.radius)

      const request: ModifyRequest = { op: 'modify', handle: args.handle, set }
      return toResult(await deps.cad.raw(request), '修改图元属性')
    },
  })
}

/**
 * `cad_transform` — move/rotate/scale a set of entities together.
 *
 * This is the tool for the "局部联动" case the Codex-for-CAD evaluation flagged
 * as unreliable: applying one offset to every related handle keeps their
 * relative spacing intact by construction.
 */
export function createTransformTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_transform',
    description:
      '对一组图元执行统一的平移/旋转/缩放,保持它们之间的相对关系不变。' +
      '典型用途是"某段边线外侧偏移 500mm,同时该段的尺寸线、文字、符号一起偏移"。' +
      'handles 必须来自 cad_query_entities 的检索结果。' +
      'rotate/scale 必须提供 center 基准点。copy=true 时复制而不移动原图元。' +
      '注意: 变换通过重写图元的几何属性实现,适用于直线/圆/圆弧/文字/点/块参照;' +
      '其他类型(如填充、标注对象)会返回警告并跳过,不会静默失败。',
    parameters: {
      handles: {
        type: 'array',
        required: true,
        description: '目标图元句柄列表',
        items: { type: 'string', description: '图元句柄' },
      },
      mode: {
        type: 'string',
        required: true,
        enum: ['move', 'rotate', 'scale'],
        description: '变换类型',
      },
      value: {
        type: 'number',
        required: true,
        description: 'move: X 偏移(米);rotate: 角度(度);scale: 缩放系数',
      },
      valueY: { type: 'number', description: 'move: Y 偏移(米),默认为 0' },
      center: { ...pointSchema, description: 'rotate/scale 的基准点(米)' },
      copy: { type: 'boolean', description: '为 true 时复制副本,原图元保持不动' },
    },
    output: mutationOutput(),
    async execute(args) {
      const u = deps.cad.units
      const request: TransformRequest = {
        op: 'transform',
        handles: args.handles as string[],
        mode: args.mode,
        value: args.mode === 'move' ? u.toDrawing(args.value) : args.value,
        valueY: args.valueY === undefined ? undefined : u.toDrawing(args.valueY),
        center: args.center ? u.pointToDrawing(args.center) : undefined,
        copy: args.copy,
      }
      const label = { move: '平移', rotate: '旋转', scale: '缩放' }[args.mode]
      return toResult(await deps.cad.raw(request), `批量${label}图元`)
    },
  })
}

/** `cad_delete` — erase entities by handle. */
export function createDeleteTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_delete',
    description:
      '按句柄删除图元。此操作在 AutoCAD 中可用一次 Ctrl+Z 撤销。' +
      '删除前务必先用 cad_query_entities 确认句柄,并向用户说明将删除哪些对象。',
    parameters: {
      handles: {
        type: 'array',
        required: true,
        description: '待删除图元的句柄列表',
        items: { type: 'string', description: '图元句柄' },
      },
    },
    output: mutationOutput(),
    async execute(args) {
      const request: DeleteRequest = { op: 'delete', handles: args.handles as string[] }
      return toResult(await deps.cad.raw(request), '删除图元')
    },
  })
}
