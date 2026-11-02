import { describe, test, expect } from 'vitest'
import { attachmentLine, splitAttachment, withAttachment, sheetFileProblem, templateCsv, TEMPLATE_HEADER, MAX_SHEET_BYTES } from '../styleImport.js'

const ID = 'imp_0123456789abcdef'

describe('the attached-sheet line in a chat message', () => {
  test('goes in front of what was typed and comes back out of it', () => {
    const sent = withAttachment('Under the Cocoblu SS26 order', { id: ID, filename: 'replen.xlsx' })
    expect(sent).toBe(`[Attached style sheet: "replen.xlsx" (upload id ${ID})]\nUnder the Cocoblu SS26 order`)
    expect(splitAttachment(sent)).toEqual({ attachment: { filename: 'replen.xlsx', id: ID }, text: 'Under the Cocoblu SS26 order' })
  })

  test('with nothing typed, asks to create the styles', () => {
    expect(splitAttachment(withAttachment('', { id: ID, filename: 'a.csv' })).text).toBe('Please create these styles.')
  })

  test('a message with no attachment is left alone', () => {
    expect(withAttachment('hello', null)).toBe('hello')
    expect(splitAttachment('hello')).toEqual({ attachment: null, text: 'hello' })
  })

  test('quotes, brackets and line breaks in a file name cannot break the line', () => {
    const line = attachmentLine({ id: ID, filename: 'a"b]c(d)\ne.xlsx' })
    expect(line).not.toMatch(/\n/)
    expect(splitAttachment(`${line}\nok`).attachment).toEqual({ filename: 'a_b_c_d__e.xlsx', id: ID })
  })

  test('only a real upload id is recognised', () => {
    expect(splitAttachment('[Attached style sheet: "a.xlsx" (upload id ../x)]\nhi').attachment).toBeNull()
  })
})

describe('choosing a file', () => {
  test.each([
    [{ name: 'a.xlsx', size: 10 }, ''],
    [{ name: 'A.CSV', size: 10 }, ''],
    [{ name: 'a.pdf', size: 10 }, 'Choose an Excel (.xlsx) or CSV (.csv) file.'],
    [{ name: 'a.xls', size: 10 }, 'Choose an Excel (.xlsx) or CSV (.csv) file.'],
    [{ name: 'a.xlsx', size: MAX_SHEET_BYTES + 1 }, 'That file is over 8MB.'],
    [{ name: 'a.xlsx', size: 0 }, 'That file is empty.'],
    [null, 'Choose a file.'],
  ])('%j -> %j', (file, expected) => expect(sheetFileProblem(file)).toBe(expected))
})

describe('the template', () => {
  test('is a header and one example row of the same width, with the mandatory columns first', () => {
    const [head, example] = templateCsv().trim().split('\n')
    expect(head.split(',')).toEqual(TEMPLATE_HEADER)
    expect(TEMPLATE_HEADER.slice(0, 7)).toEqual(['Brand', 'Style No', 'Description', 'Image', 'Amazon link', 'Fabric', 'Stage'])
    // The example has a comma-free, quote-free body except the description, which is quoted only if it needs it.
    expect(example.startsWith('FYLTR,FYLSS26WD-4002,')).toBe(true)
  })

  test('has no factory or price column', () => {
    expect(TEMPLATE_HEADER.join(' ')).not.toMatch(/factory|cost|price|asp/i)
  })
})
