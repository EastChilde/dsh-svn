/**
 * 极小的 XML 解析器，只服务 svn --xml 的输出。
 *
 * 不引第三方依赖：宿主运行时不保证装了解析库，而 svn 的 XML 结构简单
 * （元素、属性、文本、CDATA、注释），这里 100 行足够，且能保证实体、
 * 多行属性、自闭合标签都处理正确。
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

export function decodeEntities(text) {
  return String(text == null ? '' : text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch (err) {
        return match
      }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match
  })
}

/** 找标签结束的 '>'，跳过引号里的内容（属性值里可能出现 '>'）。 */
function findTagEnd(source, from) {
  let quote = ''
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return -1
}

function parseAttributes(raw, target) {
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(raw))) {
    target[match[1]] = decodeEntities(match[3] !== undefined ? match[3] : match[4])
  }
}

/**
 * 解析为 { name:'#document', attrs:{}, children:[], text:'' } 的树。
 * 文本会累积到所属元素的 text 里（不做 trim，保留提交信息里的换行）。
 */
export function parseXml(input) {
  const source = String(input == null ? '' : input)
  const document = { name: '#document', attrs: {}, children: [], text: '' }
  const stack = [document]
  const current = () => stack[stack.length - 1]

  const appendText = (value) => {
    if (!value) return
    current().text += decodeEntities(value)
  }

  let i = 0
  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      appendText(source.slice(i))
      break
    }
    if (lt > i) appendText(source.slice(i, lt))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      appendText(source.slice(lt + 9, end < 0 ? source.length : end))
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2)
      i = end < 0 ? source.length : end + 1
      continue
    }

    const gt = findTagEnd(source, lt + 1)
    if (gt < 0) break
    const raw = source.slice(lt + 1, gt)
    const closing = raw.startsWith('/')
    const selfClosing = !closing && raw.endsWith('/')
    const body = raw.replace(/^\//, '').replace(/\/\s*$/, '')
    const space = body.search(/\s/)
    const name = (space < 0 ? body : body.slice(0, space)).trim()

    if (closing) {
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === name) {
          stack.length = k
          break
        }
      }
      i = gt + 1
      continue
    }

    const node = { name, attrs: {}, children: [], text: '' }
    if (space >= 0) parseAttributes(body.slice(space), node.attrs)
    current().children.push(node)
    if (!selfClosing) stack.push(node)
    i = gt + 1
  }

  return document
}

export function child(node, name) {
  if (!node || !Array.isArray(node.children)) return null
  for (const item of node.children) {
    if (item.name === name) return item
  }
  return null
}

/** 文档根元素（parseXml 返回的 #document 的第一个元素子节点）。 */
export function docRoot(document) {
  if (!document || !Array.isArray(document.children)) return null
  return document.children[0] || null
}

export function children(node, name) {
  if (!node || !Array.isArray(node.children)) return []
  return name ? node.children.filter((item) => item.name === name) : node.children
}

export function text(node) {
  return node && typeof node.text === 'string' ? node.text : ''
}

export function attr(node, name, fallback = '') {
  if (!node || !node.attrs) return fallback
  const value = node.attrs[name]
  return value === undefined ? fallback : value
}
