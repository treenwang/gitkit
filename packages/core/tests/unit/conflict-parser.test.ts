import { describe, expect, test } from 'bun:test'
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

// 以下样本均来自真实 git 输出（见 tests/helpers/fixtures.ts 造出的场景）
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
  test('按路径归并 stage', () => {
    const entries = parseUnmergedIndex(LS_FILES_U)
    expect(entries.map((e) => e.path))
      .toEqual(['added.txt', 'bin.dat', 'both.txt', 'delmod.txt', 'moddel.txt'])
    expect([...entries[0]!.stages.keys()].sort()).toEqual([2, 3])
    expect([...entries[2]!.stages.keys()].sort()).toEqual([1, 2, 3])
    expect(entries[2]!.stages.get(2)!.oid).toBe('f466b688f9be221416ab4621222ae5b34a8cba1e')
    expect(entries[2]!.stages.get(2)!.mode).toBe('100644')
  })

  test('空输入返回空数组', () => {
    expect(parseUnmergedIndex('')).toEqual([])
  })

  test('无法解析的行抛错而不静默跳过', () => {
    expect(() => parseUnmergedIndex('garbage line')).toThrow(GitOpError)
  })

  test('路径含空格', () => {
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
  test('单 stage 组合抛错（应由 rename 归组处理）', () => {
    expect(() => classifyConflict(mk(1))).toThrow(GitOpError)
    expect(() => classifyConflict(mk(2))).toThrow(GitOpError)
  })
})

describe('buildConflictPlan', () => {
  test('五种同路径冲突各归其类', () => {
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

  test('rename/rename 的三条单 stage 记录被归并为一条', () => {
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

  test('缺少 rename 映射时单 stage 条目仍上报为 rename，不抛错', () => {
    const plans = buildConflictPlan(parseUnmergedIndex(RENAME_LS_FILES_U), NO_RENAMES)
    expect(plans).toHaveLength(3)
    expect(plans.every((p) => p.type === 'rename')).toBe(true)
  })

  test('rename 与普通冲突混合时互不干扰', () => {
    const plans = buildConflictPlan(
      parseUnmergedIndex(`${RENAME_LS_FILES_U}\n${LS_FILES_U}`),
      { ours: new Map([['orig.txt', 'our-name.txt']]), theirs: new Map([['orig.txt', 'their-name.txt']]) },
    )
    expect(plans.filter((p) => p.type === 'rename')).toHaveLength(1)
    expect(plans).toHaveLength(6)
  })
})

describe('parseRenameMap', () => {
  test('只取 R 状态', () => {
    const m = parseRenameMap('R100\torig.txt\tnew.txt\nM\tother.txt\nA\tadded.txt')
    expect([...m]).toEqual([['orig.txt', 'new.txt']])
  })
  test('R 后带相似度数字', () => {
    expect(parseRenameMap('R087\ta\tb').get('a')).toBe('b')
  })
  test('空输入', () => expect(parseRenameMap('').size).toBe(0))
})

describe('scanConflicts / parseConflictHunks', () => {
  test('解析 diff3 的两个 hunk', () => {
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

  test('非 diff3（无 base 段）时 baseLines 缺省', () => {
    const hunks = parseConflictHunks('a\n<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> b\n')
    expect(hunks[0]!.baseLines).toBeUndefined()
    expect(hunks[0]!.ourLines).toEqual(['O'])
  })

  test('空的 ours 段（我方删空）', () => {
    const hunks = parseConflictHunks('<<<<<<< HEAD\n=======\nT\n>>>>>>> b\n')
    expect(hunks[0]!.ourLines).toEqual([])
    expect(hunks[0]!.theirLines).toEqual(['T'])
  })

  test('无冲突标记时返回空数组', () => {
    expect(parseConflictHunks('just\nplain\ntext\n')).toEqual([])
  })

  test('未闭合的标记抛错而不产出半解析结果', () => {
    expect(() => parseConflictHunks('<<<<<<< HEAD\nO\n=======\nT\n')).toThrow(GitOpError)
  })

  test('在 ======= 之前遇到 >>>>>>> 抛错', () => {
    expect(() => parseConflictHunks('<<<<<<< HEAD\nO\n>>>>>>> b\n')).toThrow(GitOpError)
  })

  test('正文中长度不为 7 的相似串不被误认为标记', () => {
    const text = '<<<<<<<<< not a marker\n======== not either\n'
    expect(parseConflictHunks(text)).toEqual([])
  })

  test('CRLF 行尾：\\r 留在内容里，标记仍可识别', () => {
    const hunks = parseConflictHunks('<<<<<<< HEAD\r\nO\r\n=======\r\nT\r\n>>>>>>> b\r\n')
    // 标记行带 \r 后缀，正则要求 <<<<<<< 后是空格或行尾，故 '<<<<<<< HEAD\r' 命中
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.ourLines).toEqual(['O\r'])
  })

  test('segments 保留文本段顺序', () => {
    const segs = scanConflicts(DIFF3)
    expect(segs.map((s) => s.kind)).toEqual(['text', 'hunk', 'text', 'hunk', 'text'])
  })
})

describe('looksBinary', () => {
  test('含 NUL 判定为二进制', () => {
    expect(looksBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
  })
  test('纯文本不是二进制', () => {
    expect(looksBinary(Buffer.from('hello world\n'))).toBe(false)
  })
  test('空 buffer 不是二进制', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })
  test('只检查前 8000 字节', () => {
    const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])
    expect(looksBinary(buf)).toBe(false)
  })
})
