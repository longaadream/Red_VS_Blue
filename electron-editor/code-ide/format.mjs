import { format } from 'prettier/standalone'
import babel from 'prettier/plugins/babel'
import estree from 'prettier/plugins/estree'
import { parse } from '@babel/parser'

export const MAX_CODE_LENGTH = 200000
export const CODE_FIELDS = ['code', 'skillCode', 'effectCode', 'previewCode']

// Parsing/printing only. No eval, Function constructor or dynamic script import.
export async function inspectCode(source, field) {
  if (!CODE_FIELDS.includes(field) || typeof source !== 'string' || source.length > MAX_CODE_LENGTH) {
    return { error: '代码字段无效，或超过 200,000 字符。', line: 1, column: 1 }
  }
  if (!source.trim()) return { formatted: source }
  const expression = field === 'effectCode'
  let lineOffset = field === 'skillCode' || expression ? 1 : 0
  try {
    const contextSource = expression ? '(\n' + source + '\n)'
      : field === 'skillCode' ? 'function __rvb_rule(context) {\n' + source + '\n}' : source
    parse(contextSource, { sourceType: 'script' })
    lineOffset = expression ? 1 : 0
    let formatted = await format(expression ? 'const __rvb_effect =\n' + source : source, {
      parser: 'babel', plugins: [babel, estree], tabWidth: 2, useTabs: false,
      semi: true, singleQuote: false, printWidth: 100, endOfLine: 'lf',
      embeddedLanguageFormatting: 'off',
    })
    if (expression) {
      // Remove the declaration terminator by its AST position, including when comments follow it.
      const declaration = parse(formatted, { sourceType: 'script' }).program.body[0]
      if (declaration.type !== 'VariableDeclaration') throw new Error('无法安全移除格式化包装')
      if (formatted[declaration.end - 1] === ';') formatted = formatted.slice(0, declaration.end - 1) + formatted.slice(declaration.end)
      formatted = formatted.replace(/^const __rvb_effect\s*=\s*/, '')
      parse('(\n' + formatted + '\n)', { sourceType: 'script' })
    }
    return { formatted }
  } catch (error) {
    return {
      error: String(error.message).split('\n')[0].replace(/ \(\d+:\d+\)$/, ''),
      line: Math.max(1, (error.loc?.start?.line || error.loc?.line || 1) - lineOffset),
      column: error.loc?.start?.column || (error.loc?.column ?? 0) + 1,
    }
  }
}
