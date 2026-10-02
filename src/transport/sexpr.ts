/**
 * S-expression codec shared with the resident AutoLISP dispatcher.
 *
 * AutoLISP `(read)` is the parser on the CAD side, so the file must stay
 * ASCII: non-ASCII characters are written as `\U+XXXX`. That survives a
 * GBK or UTF-8 mis-decode of the inbox file. Newlines are `\n`, not raw
 * line breaks, so one request is still one readable form.
 */

export type Sexpr = string | number | null | Sexpr[]

export function encodeSexpr(value: Sexpr): string {
  if (value === null) return 'nil'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('sexpr 不能编码非有限数字')
    return String(value)
  }
  if (typeof value === 'string') return `"${escapeString(value)}"`
  return `(${value.map(encodeSexpr).join(' ')})`
}

/** Drop `undefined` fields so optional request properties stay absent. */
export function toSexpr(value: unknown): Sexpr {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (Array.isArray(value)) return value.map(toSexpr)
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, toSexpr(v)])
  }
  return String(value)
}

/**
 * A list of `("key" value)` pairs becomes an object. Any other list, including
 * `()`, becomes an array. That is how an empty `warnings` list stays an array
 * instead of collapsing into an empty object.
 */
export function fromSexpr(value: Sexpr): unknown {
  if (!Array.isArray(value)) return value
  if (isAlist(value)) {
    const obj: Record<string, unknown> = {}
    for (const pair of value) {
      const key = pair[0]
      const child = pair[1]
      if (typeof key !== 'string' || child === undefined) continue
      obj[key] = fromSexpr(child)
    }
    return obj
  }
  return value.map(item => fromSexpr(item))
}

export function decodeSexpr(text: string): Sexpr {
  const parser = new Parser(text)
  const value = parser.parse()
  parser.skip()
  if (!parser.eof()) throw new Error('sexpr 尾部有多余内容')
  return value
}

function isPair(item: Sexpr): item is [string, Sexpr] {
  if (!Array.isArray(item) || item.length !== 2) return false
  return typeof item[0] === 'string'
}

function isAlist(value: Sexpr[]): value is Array<[string, Sexpr]> {
  return value.length > 0 && value.every(isPair)
}

function escapeString(value: string): string {
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (cp < 32 || cp > 126) out += `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
    else out += ch
  }
  return out
}

class Parser {
  private i = 0
  private readonly text: string

  constructor(text: string) {
    this.text = text
    if (text.charCodeAt(0) === 0xfeff) this.i = 1
  }

  eof(): boolean {
    return this.i >= this.text.length
  }

  parse(): Sexpr {
    this.skip()
    const c = this.text[this.i]
    if (c === undefined) throw new Error('sexpr 意外结束')
    if (c === '(') return this.parseList()
    if (c === '"') return this.parseString()
    return this.parseAtom()
  }

  skip(): void {
    while (this.i < this.text.length) {
      const c = this.text[this.i]
      if (c === ';') {
        while (this.i < this.text.length && this.text[this.i] !== '\n') this.i += 1
        continue
      }
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
        this.i += 1
        continue
      }
      break
    }
  }

  private parseList(): Sexpr[] {
    this.i += 1
    const items: Sexpr[] = []
    for (;;) {
      this.skip()
      if (this.i >= this.text.length) throw new Error('sexpr 列表没有闭合')
      if (this.text[this.i] === ')') {
        this.i += 1
        return items
      }
      if (this.text[this.i] === '.') throw new Error('sexpr 不支持点对')
      items.push(this.parse())
    }
  }

  private parseString(): string {
    this.i += 1
    let out = ''
    while (this.i < this.text.length) {
      const c = this.text[this.i]
      if (c === '"') {
        this.i += 1
        return out
      }
      if (c !== '\\') {
        out += c
        this.i += 1
        continue
      }
      const next = this.text[this.i + 1]
      if (next === undefined) throw new Error('sexpr 字符串转义不完整')
      if (next === 'U' && this.text[this.i + 2] === '+') {
        const hex = this.text.slice(this.i + 3, this.i + 7)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error('sexpr \\U+ 转义无效')
        out += String.fromCodePoint(Number.parseInt(hex, 16))
        this.i += 7
        continue
      }
      const simple: Record<string, string> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' }
      out += simple[next] ?? next
      this.i += 2
    }
    throw new Error('sexpr 字符串没有闭合')
  }

  private parseAtom(): Sexpr {
    const start = this.i
    while (this.i < this.text.length && !' \n\r\t();'.includes(this.text[this.i] ?? '')) this.i += 1
    const tok = this.text.slice(start, this.i)
    if (tok.length === 0) throw new Error('sexpr 缺少原子')
    if (tok === 'nil') return null
    if (tok === 't' || tok === 'T') return 1
    if (/^-?\d+$/.test(tok)) return Number(tok)
    if (/^-?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(tok) || /^-?\d+[eE][+-]?\d+$/.test(tok)) {
      return Number(tok)
    }
    throw new Error(`sexpr 无法识别: ${tok}`)
  }
}
