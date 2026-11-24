import { describe, test, expect } from 'vitest'
import { bomSections, checkAt, bomProgress, editorRows, blankRow, editorPayload } from '../bom.js'

const bom = { items: [
  { id: 'a', section: 'Fabric', name: 'Shell', description: '', perPiece: '1.6 m', forOrder: '1,360 m', hasImage: true, checks: [{ mfrId: 'f1', byName: 'Ravi', at: '2026-11-24' }] },
  { id: 'b', section: 'Fabric', name: 'Lining', description: '', perPiece: '', forOrder: '', hasImage: false, checks: [] },
  { id: 'c', section: 'Trims', name: 'Zip', description: 'No. 5', perPiece: '1 pcs', forOrder: '830 pcs', hasImage: false, checks: [{ mfrId: 'f2', byName: 'Asha', at: '2026-11-24' }] },
] }

describe('the bill of materials checklist', () => {
  test('items sit under their section headings, in the order written', () => {
    expect(bomSections(bom).map(s => [s.section, s.items.map(i => i.id)])).toEqual([['Fabric', ['a', 'b']], ['Trims', ['c']]])
    expect(bomSections(null)).toEqual([])
  })
  test('a tick belongs to a factory; progress counts that factory only', () => {
    expect(checkAt(bom.items[0], 'f1').byName).toBe('Ravi')
    expect(checkAt(bom.items[0], 'f2')).toBe(null)
    expect(bomProgress(bom, 'f1')).toEqual({ done: 1, total: 3 })
    expect(bomProgress(null, 'f1')).toEqual({ done: 0, total: 0 })
  })
  test('the editor sends a picture only when it changed, and drops rows with no name', () => {
    const rows = editorRows(bom)
    rows[1].image = null; rows[2].image = 'data:image/jpeg;base64,AAAA'
    const sent = editorPayload([...rows, blankRow('Trims'), { ...blankRow('Packing'), name: ' Polybag ' }])
    expect(sent.map(r => [r.id, r.name, 'image' in r ? r.image : 'kept'])).toEqual([['a', 'Shell', 'kept'], ['b', 'Lining', null], ['c', 'Zip', 'data:image/jpeg;base64,AAAA'], [undefined, 'Polybag', 'kept']])
  })
})
