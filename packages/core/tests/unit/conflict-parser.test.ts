import { describe, expect, test } from 'vitest'
import {
  buildConflictPlan,
  classifyConflict,
  looksBinary,
  parseConflictHunks,
  parseRenameMap,
  parseUnmergedIndex,
  scanConflicts,
  type Stage,
} from '../../src/domain/conflict-parser'
import { GitOpError, type ConflictSide } from '../../src/types'

// Every sample below came from real git output - see the scenarios built in tests/helpers/fixtures.ts
const LS_FILES_U = `100644 5e9a9cdccecb5757623b288b5ae4e235ea4afab1 2\tadded.txt
100644 8fe58f057108f3793366630cb3741eb8d3b1764a 3\tadded.txt
100644 8352675d67aed6625ece79af41c27fdb4ee2e867 1\tbin.dat
100644 22df047c1229be92dde4724fe3747a41dd91d61b 2\tbin.dat
100644 c5793f98784f13b7d87422d8fa5b096867553a45 3\tbin.dat
100644 b8cb000a15a7fc5e44750b59e867c859c6050a92 1\tboth.txt
100644 f466b688f9be221416ab4621222ae5b34a8cba1e 2\tboth.txt
100644 8e7ac0893dc1c950b23cdc2ecd74b17aeea7f7f5 3\tboth.txt
100644 abaddc0b9edd523c69166a2c9f3a9e31a4c873e3 1\tdelmod.txt
100644 0e86bfbd547e3c2c199f24e1926c8f68ed508691 2\tdelmod.txt
100644 2680cfddbd9fa03c059ac60d2bec5e59a1c34281 1\tmoddel.txt
100644 2d0fce8770f693c75e11649771ee60a254123980 3\tmoddel.txt`

const RENAME_LS_FILES_U = `100644 3b04f2e266b771610bd8c140a4e393ec773df801 1\torig.txt
100644 3b04f2e266b771610bd8c140a4e393ec773df801 2\tour-name.txt
100644 3b04f2e266b771610bd8c140a4e393ec773df801 3\ttheir-name.txt`

const DIFF3 = `l1
<<<<<<< HEAD
OUR2
||||||| 931cf72
l2
=======
THEIR2
>>>>>>> theirs
l3
l4
<<<<<<< HEAD
OUR5
||||||| 931cf72
l5
=======
THEIR5
>>>>>>> theirs
`

const NO_RENAMES = { ours: new Map<string, string>(), theirs: new Map<string, string>() }

describe('parseUnmergedIndex', () => {
  test('groups stages by path', () => {
    const entries = parseUnmergedIndex(LS_FILES_U)
    expect(entries.map((e) => e.path))
      .toEqual(['added.txt', 'bin.dat', 'both.txt', 'delmod.txt', 'moddel.txt'])
    expect([...entries[0]!.stages.keys()].sort()).toEqual([2, 3])
    expect([...entries[2]!.stages.keys()].sort()).toEqual([1, 2, 3])
    expect(entries[2]!.stages.get(2)!.oid).toBe('f466b688f9be221416ab4621222ae5b34a8cba1e')
    expect(entries[2]!.stages.get(2)!.mode).toBe('100644')
  })

  test('empty input returns an empty array', () => {
    expect(parseUnmergedIndex('')).toEqual([])
  })

  test('an unparseable line throws instead of being skipped silently', () => {
    expect(() => parseUnmergedIndex('garbage line')).toThrow(GitOpError)
  })

  test('paths containing spaces', () => {
    const e = parseUnmergedIndex(
      `100644 ${'a'.repeat(40)} 2\tdocs/my file.md`,
    )
    expect(e[0]!.path).toBe('docs/my file.md')
  })
})

describe('classifyConflict', () => {
  const side: ConflictSide = { oid: 'x', mode: '100644' }
  const mk = (...stages: Stage[]) => new Map(stages.map((s) => [s, side]))

  test('1+2+3 → both_modified', () => expect(classifyConflict(mk(1, 2, 3))).toBe('both_modified'))
  test('2+3 → both_added', () => expect(classifyConflict(mk(2, 3))).toBe('both_added'))
  test('1+2 → deleted_by_them', () => expect(classifyConflict(mk(1, 2))).toBe('deleted_by_them'))
  test('1+3 → deleted_by_us', () => expect(classifyConflict(mk(1, 3))).toBe('deleted_by_us'))
  test('a single-stage combination throws - rename grouping should have handled it', () => {
    expect(() => classifyConflict(mk(1))).toThrow(GitOpError)
    expect(() => classifyConflict(mk(2))).toThrow(GitOpError)
  })
})

describe('buildConflictPlan', () => {
  test('the five same-path conflicts each get their own type', () => {
    const plans = buildConflictPlan(parseUnmergedIndex(LS_FILES_U), NO_RENAMES)
    const byPath = Object.fromEntries(plans.map((p) => [p.path, p.type]))
    expect(byPath).toEqual({
      'added.txt': 'both_added',
      'bin.dat': 'both_modified',
      'both.txt': 'both_modified',
      'delmod.txt': 'deleted_by_them',
      'moddel.txt': 'deleted_by_us',
    })
  })

  test('the three single-stage entries of a rename/rename merge into one', () => {
    const plans = buildConflictPlan(parseUnmergedIndex(RENAME_LS_FILES_U), {
      ours: new Map([['orig.txt', 'our-name.txt']]),
      theirs: new Map([['orig.txt', 'their-name.txt']]),
    })
    expect(plans).toHaveLength(1)
    expect(plans[0]!.type).toBe('rename')
    expect(plans[0]!.path).toBe('orig.txt')
    expect(plans[0]!.ourPath).toBe('our-name.txt')
    expect(plans[0]!.theirPath).toBe('their-name.txt')
    expect(plans[0]!.ours!.oid).toBe('3b04f2e266b771610bd8c140a4e393ec773df801')
  })

  test('without a rename map a single-stage entry is still reported as a rename rather than throwing', () => {
    const plans = buildConflictPlan(parseUnmergedIndex(RENAME_LS_FILES_U), NO_RENAMES)
    expect(plans).toHaveLength(3)
    expect(plans.every((p) => p.type === 'rename')).toBe(true)
  })

  test('renames and ordinary conflicts do not interfere when mixed', () => {
    const plans = buildConflictPlan(
      parseUnmergedIndex(`${RENAME_LS_FILES_U}\n${LS_FILES_U}`),
      { ours: new Map([['orig.txt', 'our-name.txt']]), theirs: new Map([['orig.txt', 'their-name.txt']]) },
    )
    expect(plans.filter((p) => p.type === 'rename')).toHaveLength(1)
    expect(plans).toHaveLength(6)
  })
})

describe('parseRenameMap', () => {
  test('only R entries are taken', () => {
    const m = parseRenameMap('R100\torig.txt\tnew.txt\nM\tother.txt\nA\tadded.txt')
    expect([...m]).toEqual([['orig.txt', 'new.txt']])
  })
  test('R followed by a similarity score', () => {
    expect(parseRenameMap('R087\ta\tb').get('a')).toBe('b')
  })
  test('empty input', () => expect(parseRenameMap('').size).toBe(0))
})

describe('scanConflicts / parseConflictHunks', () => {
  test('parses two diff3 hunks', () => {
    const hunks = parseConflictHunks(DIFF3)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({
      index: 0, ourLines: ['OUR2'], theirLines: ['THEIR2'], baseLines: ['l2'],
      startLine: 1, endLine: 7,
    })
    expect(hunks[1]).toMatchObject({
      index: 1, ourLines: ['OUR5'], theirLines: ['THEIR5'], baseLines: ['l5'],
    })
  })

  test('baseLines is absent when the content is not diff3 and has no base section', () => {
    const hunks = parseConflictHunks('a\n<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> b\n')
    expect(hunks[0]!.baseLines).toBeUndefined()
    expect(hunks[0]!.ourLines).toEqual(['O'])
  })

  test('an empty ours section, where our side emptied it', () => {
    const hunks = parseConflictHunks('<<<<<<< HEAD\n=======\nT\n>>>>>>> b\n')
    expect(hunks[0]!.ourLines).toEqual([])
    expect(hunks[0]!.theirLines).toEqual(['T'])
  })

  test('returns an empty array when there are no conflict markers', () => {
    expect(parseConflictHunks('just\nplain\ntext\n')).toEqual([])
  })

  test('unclosed markers throw rather than producing a half-parsed result', () => {
    expect(() => parseConflictHunks('<<<<<<< HEAD\nO\n=======\nT\n')).toThrow(GitOpError)
  })

  test('>>>>>>> before ======= throws', () => {
    expect(() => parseConflictHunks('<<<<<<< HEAD\nO\n>>>>>>> b\n')).toThrow(GitOpError)
  })

  test('a similar run of other than seven characters in the body is not mistaken for a marker', () => {
    const text = '<<<<<<<<< not a marker\n======== not either\n'
    expect(parseConflictHunks(text)).toEqual([])
  })

  test('CRLF line endings: \\r stays in the content and markers are still recognized', () => {
    const hunks = parseConflictHunks('<<<<<<< HEAD\r\nO\r\n=======\r\nT\r\n>>>>>>> b\r\n')
    // The marker line carries a trailing \r; the regex wants a space or end of line after <<<<<<<, so '<<<<<<< HEAD\r' matches
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.ourLines).toEqual(['O\r'])
  })

  test('segments keep the order of the text sections', () => {
    const segs = scanConflicts(DIFF3)
    expect(segs.map((s) => s.kind)).toEqual(['text', 'hunk', 'text', 'hunk', 'text'])
  })
})

describe('looksBinary', () => {
  test('content with a NUL counts as binary', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
  })
  test('plain text is not binary', () => {
    expect(looksBinary(Buffer.from('hello world\n'))).toBe(false)
  })
  test('an empty buffer is not binary', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })
  test('only the first 8000 bytes are checked', () => {
    const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])
    expect(looksBinary(buf)).toBe(false)
  })
})
