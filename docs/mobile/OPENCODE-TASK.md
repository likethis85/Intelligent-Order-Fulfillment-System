# OpenCode 执行任务

请按 mobile-design.html 的六屏设计和 TODO.md 的 T01–T09，实施现有 React / TypeScript 直播货盘应用的移动端 UI 适配。你操作的是无凭证、无真实业务数据的临时副本；Codex 会审核你的修改，再合入实际项目。

只允许修改 src/App.tsx、src/index.css、src/sections/*.tsx、src/components/ui/dialog.tsx、src/components/ui/select.tsx、src/hooks/use-mobile.ts。不要修改任何配置、package.json、锁文件、服务端、接口地址、业务计算、规则默认值或存储逻辑。不要增加依赖。不要读访问副本外的文件。不要创建第二套业务实现。

保留现有品牌配色：#FAFAF7 米白背景、#FFFFFF 卡片、#1C1B18 主按钮和文字、#E8E6E0 边框。桌面端 >=1200px 保持现状；平板 768–1199px 顶部导航可换行；手机 <768px 使用紧凑顶栏和现有 NAV 五项固定底部导航，添加 aria-label 与 aria-current。底部安全区 env(safe-area-inset-bottom)，内容留出对应空隙；页面切换滚动到顶。

优先给布局增加语义类名、在 index.css 的 media query 内局部响应式覆盖，或使用 Tailwind 的 sm/md/lg 断点。不要全局隐藏水平溢出来掩盖错误。禁止在移动 CSS 中让任意所有 flex 容器换行；对指定的页面头、工具栏、卡片、模式切换、抽屉定向处理。对 min-width 和固定宽度造成的溢出，从父子布局层面解决。

TraysPage 很大且原文件有 NUL 字符；按文本读取，只针对布局加类名或断点。必须保留原 FIELDS 字段、单元格编辑、图片管理、面料/翻单 iframe、导出、协同及回写。列表卡片在手机用纵向排版，权限信息仍显示；创建表单手机全宽。编辑页标题、日期、操作工具栏换行，表格外包装 max-width:100%、overflow-x:auto，左侧字段列 sticky:left:0 且有背景；提供仅手机显示的左右滑动提示。触屏需显示原仅 group-hover 可见的注脚和删除按钮，但保留 hover 模式桌面样式。抽屉 w-[440px]、w-[380px] 与多图弹窗 w-[520px] 手机要不超过视口。面料和翻单 iframe 弹窗手机用动态视口高度，头尾换行且内容可滚动；iframe 源地址不变。

SequencePage 手机策略单列、头部纵向、工具栏换行、列表坑位布局成网格或卡片：序号/时间在顶部、图和商品信息在中间、阶段和上移/下移/返场/删除在底部。仅桌面拖拽可作为补充，手机必须保留已有上下移按钮并增大可点击范围。横向线轴保持局部滚动。不要复制列表业务逻辑。

ProfilePage 模式条只在自身横向滚动、按钮不压缩，平台选择可换行。主播固定 w-44 侧栏在手机成为横向选项条，其余区域 min-width:0。兴趣/对比/年龄图等网格手机一列，文字可换行。

WeatherPage 外边距手机 16px，节气标题标签换行，指标保持双列（320px 若有需要可一列），canvas 和图表卡片父级 min-width:0，城市选项自然换行。

ConfigPage 仅适配 UI。外边距手机 16px，各规则头/保存按钮换行，数字表单与标签不撑宽页面，极窄屏双列表单降为单列。切勿修改初始规则值和默认值。

BoardPage 虽然未在 NAV 展示，仍按原有功能适配：grid-cols-[1fr_340px] 在手机/平板改为一列，商品卡网格响应式，筛选条换行且标签宽度缩小，创建货盘表单适配。

手机主要按钮与 select 至少 44px 点击高度，编辑 input/textarea/select 用 16px 字体以避免 iOS 自动放大（checkbox/radio 除外）。对话框 max-height:calc(100dvh - 32px)，内部滚动，关闭按钮可达。确保 print 模式不显示移动导航。

请实际修改文件直到 T01–T09 完成；最终列出改动的文件、完成的任务和仍需 Codex 浏览器验证的点。不要声称已经完成无法执行的编译或浏览器验收。
