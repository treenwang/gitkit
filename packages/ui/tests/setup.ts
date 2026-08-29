import { GlobalRegistrator } from '@happy-dom/global-registrator'

// 幂等：从仓库根目录跑（root bunfig 也会 preload）与在包内跑都只注册一次
if (typeof globalThis.document === 'undefined') {
  GlobalRegistrator.register()
}

// 默认注入 shadcn 主题变量，使开发期缺失警告不在无关测试中刷屏。
// 专门验证该警告的测试会自行移除它。
document.documentElement.style.setProperty('--background', '0 0% 100%')
