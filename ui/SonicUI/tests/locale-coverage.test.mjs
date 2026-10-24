/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript test file */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const root = path.resolve('src/renderer/src')
const localePath = path.join(root, 'i18n.tsx')
const localeSource = fs.readFileSync(localePath, 'utf8')
const localeAst = ts.createSourceFile(
  localePath,
  localeSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
const dictionaries = new Set(['messages', 'literalUrdu', 'literalUrduMore'])
const localeKeys = new Set()

function collectObjectKeys(node) {
  if (!ts.isObjectLiteralExpression(node)) return
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      localeKeys.add(name.text)
  }
}

function findDictionaries(node) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    dictionaries.has(node.name.text)
  ) {
    if (
      node.name.text === 'messages' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const locale of node.initializer.properties) {
        if (ts.isPropertyAssignment(locale) && ts.isObjectLiteralExpression(locale.initializer))
          collectObjectKeys(locale.initializer)
      }
    } else if (node.initializer && ts.isObjectLiteralExpression(node.initializer))
      collectObjectKeys(node.initializer)
  }
  ts.forEachChild(node, findDictionaries)
}
findDictionaries(localeAst)

const sourceFiles = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(tsx|ts)$/.test(entry.name) && file !== localePath) sourceFiles.push(file)
  }
}
walk(root)
const missing = []
function findTranslations(node, file, source) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 't'
  ) {
    const argument = node.arguments[0]
    if (argument && ts.isStringLiteral(argument) && !localeKeys.has(argument.text)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      missing.push(
        path.relative(process.cwd(), file) + ':' + line + ': ' + JSON.stringify(argument.text)
      )
    }
  }
  ts.forEachChild(node, (child) => findTranslations(child, file, source))
}
for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8')
  const ast = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  findTranslations(ast, file, ast)
}

test('every literal t() key has a locale dictionary entry or Urdu fallback', () => {
  assert.deepEqual(missing, [], 'Missing locale dictionary entries:\n' + missing.join('\n'))
})
