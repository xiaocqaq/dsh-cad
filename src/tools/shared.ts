import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { CadErr } from '../protocol.ts'
import { UnitConverter } from '../unit.ts'

/**
 * Shared JSON-Schema fragments.
 *
 * The Harness schema DSL marks requiredness per property with `required: true`
 * and has no `required` array on object nodes, so these follow that shape.
 */

/** A point in metres, as the model supplies it. */
export const pointSchema = {
  type: 'object',
  additionalProperties: false,
  description: '平面坐标,单位为米',
  properties: {
    x: { type: 'number', required: true, description: 'X 坐标(米)' },
    y: { type: 'number', required: true, description: 'Y 坐标(米)' },
  },
} as const

export const layerSchema = {
  type: 'string',
  description: '图层名。不存在时后端会自动创建该图层',
} as const

export const colorSchema = {
  type: 'integer',
  description: 'AutoCAD 颜色索引(ACI)。256 表示 ByLayer 随层色',
} as const

/** Render a structured failure as model-facing text plus a recovery hint. */
export function renderError(op: string, error: CadErr['error']): ContentBlock[] {
  const lines = [`${op} 失败: ${error.message}`]
  if (error.details) lines.push(`详情: ${error.details}`)
  switch (error.code) {
    case 'BACKEND_UNAVAILABLE':
    case 'NOT_CONNECTED':
      lines.push('提示: 请确认 AutoCAD 已启动、已打开图形,然后重试 cad_status。')
      break
    case 'NO_DOCUMENT':
      lines.push('提示: 请先在 AutoCAD 中打开或新建一个图形。')
      break
    case 'NOT_FOUND':
      lines.push('提示: 请先用 cad_query_entities 定位图元,确认 handle 是否正确。')
      break
    case 'TIMEOUT':
      lines.push('提示: AutoCAD 可能正忙(例如弹出了对话框),请稍后重试。')
      break
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render warnings so the model always surfaces them instead of hiding them. */
export function warningBlock(warnings: readonly string[]): ContentBlock[] {
  if (!warnings.length) return []
  return [{ type: 'text', text: `注意事项:\n${warnings.map(w => `- ${w}`).join('\n')}` }]
}

export function fmt(n: number | undefined, digits = 4): string {
  if (n === undefined) return '—'
  return String(UnitConverter.round(n, digits))
}
