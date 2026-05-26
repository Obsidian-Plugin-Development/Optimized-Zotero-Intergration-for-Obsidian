import { MarkdownView, Notice, setIcon, TFile } from 'obsidian';
import { getItemJSONFromCiteKeys } from './jsonRPC';
import type ZoteroConnector from '../main';
import { t } from '../locale/i18n';
import type { TriggerCondition } from '../types';
import { isBibOutOfSync, markBibDirty, markBibClean, onBibDirtyChange, setLastRefHash, clearLastRefHash, getLastRefHash, computeRefSectionHash, getBibliographyHeading } from '../citation/bibliographyWriter';
import { isMetadataOutOfSync, checkMetadataDirty, markMetadataSynced, resetMetadataState, metadataSyncHashCache } from '../citation/metadataSyncDetector';

import { getActiveEditorView } from '../citation/cm6LivePreview';
import { isZoteroUnreachable, onZoteroStateChange } from './zoteroClient';
/**
 * v5.0.1 磁吸悬浮同步球（Draggable Floating Action Button）
 *
 * 挂载点：活跃 MarkdownView.containerEl（随侧边栏自适应）
 * 定位：position: absolute（相对于 containerEl）
 *
 * 生命周期：
 * - 监听 file-open 事件，检查当前笔记 YAML 是否包含 triggerFeatureKey
 * - 如果命中 → 挂载到 view.containerEl；否则销毁 DOM
 * - active-leaf-change 事件兜底，检测 DOM 被重新渲染后重连
 *
 * 交互：
 * - 拖拽 + 松手自动吸附到最近编辑器边缘（CSS transition 动画）
 * - 点击弹出命令菜单（单选直接执行，多选弹出毛玻璃菜单）
 * - 位置记忆：吸附/拖拽后自动保存到 localStorage，跨会话恢复
 */

const POS_STORAGE_KEY = 'sync-floating-button-pos';

/** v6.5.0: 预编译引注签名正则 — 严格匹配 [@key] 或 [@key1; @key2] */
const CITEKEY_SIG_RE = /\[@([^\]]+)\]/g;

/** v6.6.1: HUD 调试日志开关 — 生产环境保持 false */
const DEBUG_HUD = false;

interface SavedPosition {
  left: string;   // 'auto' | 'Npx'
  right: string;  // 'auto' | 'Npx'
  top: string;    // 'Npx'
}

export class SyncFloatingButton {
  private plugin: ZoteroConnector;
  private button: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  // 弹出菜单状态
  private menu: HTMLElement | null = null;
  private menuCleanup: (() => void) | null = null;

  // 拖拽状态
  private dragging = false;
  private hasMoved = false;
  private startMouseX = 0;
  private startMouseY = 0;
  private startLocalLeft = 0;
  private startLocalTop = 0;
  private containerEl: HTMLElement | null = null;
  private wrapper: HTMLElement | null = null;
  private isProgressing = false;

  // v6.3.0-alpha.1: 生命周期元素
  private progressText: HTMLElement | null = null;
  private checkIcon: HTMLElement | null = null;
  private iconWrap: HTMLElement | null = null;
  private successTimer: ReturnType<typeof setTimeout> | null = null;

  // v6.4.0: SVG 环形进度条元素
  private ringTrack: SVGCircleElement | null = null;
  private ringFill: SVGCircleElement | null = null;
  private static readonly RING_RADIUS = 21;
  private static readonly RING_CIRCUMFERENCE = 2 * Math.PI * 21;

  // v6.3.1: 视觉进度补间引擎
  private visualProgress = 0;
  private targetProgress = 0;
  private tweenRafId: ReturnType<typeof requestAnimationFrame> | null = null;
  private tweenStartTime = 0;
  private tweenLastTime = 0;
  private pendingSuccess = false;
  // v6.6.5: Zotero 状态监听取消订阅
  private zoteroStateUnsub: (() => void) | null = null;
  private static readonly MIN_ANIMATION_MS = 800;
  private static readonly ANIMATION_SPEED = 200; // 百分比/秒

  // 静态实例引用 — 允许命令面板/外部访问 HUD
  static instance: SyncFloatingButton | null = null;

  // 阈值：移动超过此像素数才算拖拽
  private readonly DRAG_THRESHOLD = 3;

  // 吸附边距
  private readonly SNAP_MARGIN = 8;

  // v5.2 自动同步防抖 (static 跨实例共享)
  // 同时记录已执行同步的命令快照，用户修改「执行同步内容」勾选后重开文件可立即生效
  private static autoSyncDebounceMap = new Map<string, { time: number; commands: string[] }>();
  /** v6.5.0: 文档引注签名缓存 — 纯本地扫描，零延迟拦截 */
  private static citekeySignatureCache = new Map<string, string>();
  /** v6.5.0: 参考文献区块哈希缓存 — 检测手动删改 */
  private static referencesHashCache = new Map<string, string>();
  private static readonly AUTO_SYNC_DEBOUNCE_MS = 3 * 60 * 1000; // 3 分钟
  // 飞行中 tracker：防止同一文件并发执行两次同步
  private static inFlightSet = new Set<string>();
  // v6.5.0: diff 飞行锁 — 防止同一文件并发执行 silentDiffCheck
  private static diffInFlightSet = new Set<string>();
  // v6.5.0: Window focus 防抖定时器
  private focusDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(plugin: ZoteroConnector) {
    this.plugin = plugin;
    SyncFloatingButton.instance = this;
    this.registerListeners();
  }

  // ── v6.3.1 生命周期 + 视觉补间引擎 ──

  /** 阶段1: 启动加载 — 显示进度环 + 数字淡入 + 图标淡出 + 启动补间循环 */
  showProgress() {
    if (this.isProgressing) return;
    this.isProgressing = true;
    if (this.successTimer) { clearTimeout(this.successTimer); this.successTimer = null; }
    if (this.tweenRafId) { cancelAnimationFrame(this.tweenRafId); this.tweenRafId = null; }
    const w = this.wrapper;
    if (!w) return;
    w.removeClass("is-idle");
    w.removeClass("has-updates-ring"); // 进度环接管，清除警告环
    w.addClass("is-progressing");
    w.addClass("is-loading");
    w.removeClass("is-success");
    this.visualProgress = 0;
    this.targetProgress = 0;
    this.pendingSuccess = false;
    this.tweenStartTime = performance.now();
    this.tweenLastTime = this.tweenStartTime;
    w.style.removeProperty("--sync-progress");
    if (this.ringTrack) {
      this.ringTrack.style.strokeDasharray = String(SyncFloatingButton.RING_CIRCUMFERENCE);
      this.ringTrack.style.strokeDashoffset = '0';
    }
    if (this.ringFill) {
      this.ringFill.style.strokeDasharray = String(SyncFloatingButton.RING_CIRCUMFERENCE);
      this.ringFill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
    }
    if (this.progressText) this.progressText.textContent = '0%';
    this.startTween();
  }

  /** 阶段2: 设置真实进度目标 — 补间引擎自动追赶 */
  setProgress(pct: number) {
    if (!this.isProgressing) return;
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    this.targetProgress = clamped;
    if (clamped >= 100) {
      this.pendingSuccess = true;
    }
    // 如果补间循环意外停止，重启它
    if (!this.tweenRafId) {
      this.startTween();
    }
  }

  /** 补间引擎：requestAnimationFrame 循环，平滑追赶 targetProgress */
  private startTween() {
    if (this.tweenRafId) return;
    const tick = (now: number) => {
      const elapsed = now - this.tweenStartTime;
      const dt = Math.min((now - this.tweenLastTime) / 1000, 0.1);
      this.tweenLastTime = now;

      // 最小动画生命周期：根据已用时间计算必须达到的进度下限
      const minReach = Math.min(100, (elapsed / SyncFloatingButton.MIN_ANIMATION_MS) * 100);
      // 追赶目标：取真实进度和最小进度的较大值
      const goal = Math.max(this.targetProgress, minReach);

      // 每帧平滑追赶
      const maxStep = SyncFloatingButton.ANIMATION_SPEED * dt;
      const diff = goal - this.visualProgress;
      if (diff > 0.5) {
        this.visualProgress += Math.min(maxStep, diff);
      } else {
        this.visualProgress = goal;
      }

      const displayPct = Math.round(this.visualProgress);
      const offset = SyncFloatingButton.RING_CIRCUMFERENCE * (1 - displayPct / 100);
      if (this.ringFill) {
        this.ringFill.style.strokeDashoffset = String(offset);
      }
      if (this.progressText) this.progressText.textContent = `${displayPct}%`;

      // 检查是否完成：视觉进度到 100 且底层已标记完成
      if (this.visualProgress >= 99.5 && this.pendingSuccess) {
        this.visualProgress = 100;
        if (this.ringFill) this.ringFill.style.strokeDashoffset = '0';
        if (this.progressText) this.progressText.textContent = '100%';
        this.tweenRafId = null;
        this.triggerSuccess();
        return;
      }

      this.tweenRafId = requestAnimationFrame(tick);
    };
    this.tweenRafId = requestAnimationFrame(tick);
  }

  /** 阶段3: 完成庆祝 — 数字淡出 + 绿色对勾淡入（仅由补间引擎在 visual=100 时调用） */
  private triggerSuccess() {
    const w = this.wrapper;
    if (!w) return;
    w.removeClass("is-loading");
    w.addClass("is-success");
    // 阶段4: 1.4s 后自动复原
    this.successTimer = setTimeout(() => this.resetToIdle(), 1400);
  }

  /** 阶段4: 自动复原 — 对勾淡出 + 进度环淡出 + 图标恢复 */
  private resetToIdle() {
    if (this.tweenRafId) { cancelAnimationFrame(this.tweenRafId); this.tweenRafId = null; }
    this.isProgressing = false;
    this.pendingSuccess = false;
    const w = this.wrapper;
    if (!w) return;
    w.removeClass("is-progressing");
    w.removeClass("is-loading");
    w.removeClass("is-success");
    w.addClass("is-idle");
    if (this.ringFill) {
      this.ringFill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
    }
    this.successTimer = null;
    this.updateBibStatusIcon(); // 根据当前脏状态决定是否显示警告环
  }

  /** 中止进度（错误/取消时调用，直接回到 idle） */
  hideProgress() {
    if (this.tweenRafId) { cancelAnimationFrame(this.tweenRafId); this.tweenRafId = null; }
    if (this.successTimer) { clearTimeout(this.successTimer); this.successTimer = null; }
    if (!this.isProgressing) return;
    this.isProgressing = false;
    this.pendingSuccess = false;
    const w = this.wrapper;
    if (!w) return;
    w.removeClass("is-progressing");
    w.removeClass("is-loading");
    w.removeClass("is-success");
    w.addClass("is-idle");
    if (this.ringFill) {
      this.ringFill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
    }
  }

  // ── 容器引用 ──

  private getViewContainer(): HTMLElement | null {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.containerEl ?? null;
  }

  // ── 位置记忆 ──

  private savePosition() {
    const wrapper = this.wrapper;
    if (!wrapper) return;
    const pos: SavedPosition = {
      left: wrapper.style.left || 'auto',
      right: wrapper.style.right || 'auto',
      top: wrapper.style.top || '50px',
    };
    try {
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(pos));
    } catch { /* localStorage 不可用 */ }
  }

  private loadPosition(): SavedPosition | null {
    try {
      const raw = localStorage.getItem(POS_STORAGE_KEY);
      if (raw) return JSON.parse(raw) as SavedPosition;
    } catch { /* ignore */ }
    return null;
  }

  // ── v6.5.0 强制状态机物理重置 ──

  /**
   * 文件切换第一步：同步强制清零，杜绝跨文件状态污染。
   *
   * 重置顺序：
   *   1. 模块级脏标志 → false
   *   2. HUD DOM 所有状态类名 → 剥离，回归 .is-idle
   *   3. SVG 环 → 隐藏
   *   4. 进行中计时器 → 取消
   *   5. 图标 → file-text
   *   6. tooltip → 清除
   */
  private forceResetState(filePath?: string) {
    DEBUG_HUD && console.log("[HUD State Debug] ========== forceResetState() 被调用 ==========");
    DEBUG_HUD && console.log("[HUD State Debug] 当前活跃文件:", filePath || this.plugin.app.workspace.getActiveFile()?.path || "无");
    DEBUG_HUD && console.log("[HUD State Debug] 重置前 - isMetadataOutOfSync:", isMetadataOutOfSync, "isBibOutOfSync:", isBibOutOfSync);

    // v6.5.1: 清除待处理的 focus 检测，防止旧文件的检测污染新文件
    if (this.focusDebounceTimer) {
      clearTimeout(this.focusDebounceTimer);
      this.focusDebounceTimer = null;
      DEBUG_HUD && console.log("[HUD State Debug] 已清除 focus 防抖定时器");
    }

    // v6.6.1: 不再清除 _signatureCache — 保留基线让 cm6LivePreview 在 EditorView 重建后
    // 能立即通过签名 diff 恢复正确的脏状态。旧签名导致的所有引注删除误报已有
    // cm6LivePreview.compute() 中的 currentSignature === "" → markBibClean(true) 兜底。

    // 1. 元数据脏标志归零（bib 脏标志保留，由 cm6LivePreview / silentDiffCheck 根据实际文件内容重新判定）
    resetMetadataState(this.plugin.emitter);
    // v6.6.1: 不再无条件 markBibClean(true)，避免标签页切换时丢失参考文献脏状态。
    // 正确状态由后续 cm6LivePreview.compute() / checkRefSectionIntegrity() 和
    // silentDiffCheck() 根据 _refHashCache 基线比对确定。

    // 2. 停止所有进行中计时器
    if (this.tweenRafId) { cancelAnimationFrame(this.tweenRafId); this.tweenRafId = null; }
    if (this.successTimer) { clearTimeout(this.successTimer); this.successTimer = null; }
    this.isProgressing = false;
    this.pendingSuccess = false;

    // 3. DOM 状态类名全部剥离，强制回归闲置态
    const w = this.wrapper;
    if (w) {
      w.removeClass('has-updates-ring');
      w.removeClass('is-progressing');
      w.removeClass('is-loading');
      w.removeClass('is-success');
      w.addClass('is-idle');
      w.removeAttribute('data-tooltip');
    }

    // 4. SVG 环归零隐藏
    if (this.ringFill) {
      this.ringFill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
    }

    // 5. 图标回归默认
    if (this.iconWrap) setIcon(this.iconWrap, 'file-text');
  }

  // ── 事件监听 ──

  private registerListeners() {
    // 文件切换 — 开卷时机：metadata脏→自动同步, 引注脏→仅视觉
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        DEBUG_HUD && console.log("[HUD State Debug] ========== file-open 事件触发 ==========");
        DEBUG_HUD && console.log("[HUD State Debug] 目标文件路径:", file?.path || "null");
        DEBUG_HUD && console.log("[HUD State Debug] 是否为文献笔记:", file ? this.isLiteratureNote(file) : false);

        if (file && this.isLiteratureNote(file)) {
          this.forceResetState(file.path); // 先物理清零 + 清除签名缓存，杜绝跨文件状态污染
          this.mount();
          // v6.6.1: 同步 refHash 检查 — mount() 后立刻根据 _refHashCache 基线比对，
          // 在 silentDiffCheck 异步完成前就设置正确的 bib 脏/净状态，消除标签页切换时的闪烁。
          // 与 silentDiffCheck 不同的是，这里使用 _refHashCache（来自 bibliographyWriter）
          // 而非 referencesHashCache（来自 SyncFloatingButton），两条基线互补保证不遗漏。
          // ★ 从 MarkdownView 获取 EditorView，避免 getActiveEditorView() 返回旧文件的编辑器
          try {
            const mdView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
            const editorView = (mdView as any)?.editor?.cm?.cm;
            if (editorView) {
              const docText = editorView.state.doc.toString();
              const currentRefHash = computeRefSectionHash(docText);
              const cachedRefHash = getLastRefHash(file.path);
              DEBUG_HUD && console.log("[HUD SyncCheck] 同步 refHash 检查: cachedRefHash =", cachedRefHash, "currentRefHash =", currentRefHash);
              if (cachedRefHash !== null && currentRefHash !== cachedRefHash) {
                DEBUG_HUD && console.log("[HUD SyncCheck] 不匹配 → markBibDirty()");
                markBibDirty();
              } else if (cachedRefHash === null && currentRefHash !== null) {
                DEBUG_HUD && console.log("[HUD SyncCheck] 无基线，建立新基线");
                setLastRefHash(file.path, currentRefHash);
              } else {
                DEBUG_HUD && console.log("[HUD SyncCheck] 匹配，无需操作");
              }
            } else {
              DEBUG_HUD && console.log("[HUD SyncCheck] 无法获取 EditorView，跳过同步检查");
            }
          } catch (e) {
            DEBUG_HUD && console.log("[HUD SyncCheck] 异常:", e);
          }
          this.silentDiffCheck(file, 'file-open');
        } else {
          this.destroy();
        }
      })
    );

    // v6.5.0: Window Focus — 全分支绝不自动同步，纯视觉提示
    this.plugin.registerDomEvent(window, 'focus', () => {
      if (this.focusDebounceTimer) clearTimeout(this.focusDebounceTimer);
      this.focusDebounceTimer = setTimeout(() => {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (activeFile && this.isLiteratureNote(activeFile)) {
          this.silentDiffCheck(activeFile, 'focus');
        }
      }, 1000);
    });

    // 布局/视图刷新兜底：检测按钮是否被 DOM 重渲染干掉
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', () => {
        const file = this.plugin.app.workspace.getActiveFile();
        if (file && this.isLiteratureNote(file)) {
          this.mount();
        }
      })
    );

    // v7.1: 参考文献 dirty/clean 状态 → 图标切换
    this.plugin.registerEvent(
      this.plugin.emitter.on('bibDirty', () => this.updateBibStatusIcon())
    );
    // v6.6.1: 冗余保障 — onBibDirtyChange 回调绕过事件系统直接更新图标
    onBibDirtyChange(() => this.updateBibStatusIcon());
    this.plugin.registerEvent(
      this.plugin.emitter.on('bibClean', async (freshContent?: string) => {
        DEBUG_HUD && console.log("[HUD State Debug] ========== bibClean 事件触发 ==========");
        this.updateBibStatusIcon();
        // v6.5.4: 参考文献更新后同步刷新缓存，使用传递的最新文档内容避免从磁盘读取旧内容
        const file = this.plugin.app.workspace.getActiveFile();
        if (file) {
          DEBUG_HUD && console.log("[HUD State Debug] bibClean: 准备刷新缓存，文件:", file.path);
          await this.refreshCitationCachesAfterSync(file, freshContent);
          DEBUG_HUD && console.log("[HUD State Debug] bibClean: 缓存刷新完成");
        } else {
          DEBUG_HUD && console.log("[HUD State Debug] bibClean: 无活跃文件，跳过缓存刷新");
        }
      })
    );

    // v6.5.0: 条目属性 dirty/clean 状态 → 图标切换
    this.plugin.registerEvent(
      this.plugin.emitter.on('metadataDirty', () => this.updateBibStatusIcon())
    );
    this.plugin.registerEvent(
      this.plugin.emitter.on('metadataClean', () => this.updateBibStatusIcon())
    );

    // v6.0.0-alpha.5: metadataCache 变更时重新检查挂载（新文件 frontmatter 解析就绪后）
    this.plugin.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file) => {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (activeFile && activeFile.path === file.path && this.isLiteratureNote(activeFile as TFile)) {
          this.mount();
        }
      })
    );

    // 窗口大小改变时修正垂直位置
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('resize', () => {
        this.clampVerticalPosition();
      })
    );

    // v6.6.5: Zotero 不可达状态 → 悬浮球图标缓慢闪烁
    this.zoteroStateUnsub = onZoteroStateChange((unreachable) => {
      this.applyZoteroUnreachableBlink(unreachable);
    });
  }

  /**
   * v5.4: 通用触发条件匹配器。
   * 只要文件 frontmatter 满足 triggers 中任一条件即返回 true。
   * value 为空字符串时仅检查 key 是否存在（不匹配具体值）。
   * 若 triggers 为空/未定义，回退为默认条件 [{ key: '文献标题', value: '' }]。
   */
  private matchesTrigger(file: TFile, triggers: TriggerCondition[] | undefined): boolean {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) return false;

    const defaults: TriggerCondition[] = [{ key: '文献标题', value: '' }];
    const conditions = triggers?.length ? triggers : defaults;

    return conditions.some((cond) => {
      if (!(cond.key in fm)) return false;
      if (!cond.value) return true;
      return String(fm[cond.key] ?? '') === cond.value;
    });
  }

  private isLiteratureNote(file: TFile): boolean {
    return this.matchesTrigger(file, this.plugin.settings.floatingButtonTriggers);
  }

  /**
   * v6.5.0 静默差分检查 — file-open / window-focus 时机的统一入口。
   *
   * 维护两个细分脏状态：
   *   isMetadataOutOfSync — Zotero条目属性 vs 基线（同源比对）
   *   isBibOutOfSync       — 文档引注签名 vs 缓存基线
   *
   * 时机路由：
   *   file-open + metadata脏 → 自动同步（全动画闭环：紫环→绿环→复原）
   *   file-open + 引注脏    → 仅视觉警告，绝不自动写入正文
   *   focus + 任意脏        → 纯视觉提示，绝不自动同步
   */
  private async silentDiffCheck(file: TFile, trigger: 'file-open' | 'focus') {
    DEBUG_HUD && console.log("[HUD State Debug] ========== silentDiffCheck() 开始执行 ==========");
    DEBUG_HUD && console.log("[HUD State Debug] 检测文件:", file.path);
    DEBUG_HUD && console.log("[HUD State Debug] 触发来源:", trigger);
    DEBUG_HUD && DEBUG_HUD && console.log("[HUD State Debug] 当前活跃文件:", this.plugin.app.workspace.getActiveFile()?.path || "无");

    // v6.5.1: 防止旧文件的检测结果污染新文件
    const currentFile = this.plugin.app.workspace.getActiveFile();
    if (currentFile?.path !== file.path) {
      DEBUG_HUD && console.log("[HUD State Debug] 文件已切换，取消检测 - 目标:", file.path, "当前:", currentFile?.path);
      return;
    }

    // v6.5.0: 互斥锁 — 防止同一文件并发 diff 导致假阳性
    if (SyncFloatingButton.diffInFlightSet.has(file.path)) {
      DEBUG_HUD && console.log("[HUD State Debug] 互斥锁阻止 - 该文件正在检测中");
      return;
    }
    SyncFloatingButton.diffInFlightSet.add(file.path);
    try {
      const citeKey = this.extractCiteKeyFromFile(file);
      if (!citeKey) {
        DEBUG_HUD && console.log("[HUD State Debug] 未找到 citeKey，提前返回");
        return;
      }

      // ── 引注检测：正文citekey vs 参考文献区块三层严格对账 ──
	      let citationDirty = false;
	      DEBUG_HUD && console.log("[HUD State Debug] ========== 开始引注检测 ==========");
	      try {
        // ★ v6.6.1: 直接使用 vault.read() 读取文件内容，不使用 getActiveEditorView()。
        // getActiveEditorView() 返回的 _activeView 由 CM6 ViewPlugin toDOM() 设置，
        // 多窗格场景下可能指向非目标文件的编辑器，导致读到错误内容。
        const docContent = await this.plugin.app.vault.read(file);
        // v6.5.1: 异步操作后检查文件是否已切换
        if (this.plugin.app.workspace.getActiveFile()?.path !== file.path) {
          DEBUG_HUD && console.log("[HUD State Debug] 文件已切换（读取文件后），取消引注检测");
          return;
        }

        const bodyKeys = await this.extractBodyCiteKeys(file, docContent);

	        // v6.5.1: 异步操作后检查文件是否已切换
	        if (this.plugin.app.workspace.getActiveFile()?.path !== file.path) {
	          DEBUG_HUD && console.log("[HUD State Debug] 文件已切换（提取引注后），取消引注检测");
	          return;
	        }

	        const bodySig = bodyKeys.join('|');
	        DEBUG_HUD && console.log("[HUD State Debug] 引注检测 - bodyKeys数量:", bodyKeys.length, "bodySig:", bodySig);
	        const refCount = await this.countReferenceEntries(file, docContent);

        // v6.5.1: 异步操作后检查文件是否已切换
        if (this.plugin.app.workspace.getActiveFile()?.path !== file.path) {
          DEBUG_HUD && console.log("[HUD State Debug] 文件已切换（计算参考文献数量后），取消引注检测");
          return;
        }
	        // ── 提前计算 refHash（提纯版）与缓存基线 ──
	        const refHash = await this.computeReferencesHash(file, docContent);
        // ★ 从持久化缓存读取上次同步后的基线（修复 storedSig/storedRefHash 未赋值 Bug）
        const storedSig = SyncFloatingButton.citekeySignatureCache.get(file.path);
        let storedRefHash = SyncFloatingButton.referencesHashCache.get(file.path);
        // v6.6.1: referencesHashCache 可能为 undefined（基线由 cm6LivePreview.compute()
        // 只写入了 _refHashCache 而未同步 referencesHashCache），回退读取 _refHashCache。
        // 若继续 fallback 到 _refHashCache，还需要检查该基线是否匹配当前内容（防止
        // "首次访问"分支误将已修改内容写入基线并 markBibClean）。
        if (storedRefHash === undefined) {
          const bibRefHash = getLastRefHash(file.path);
          DEBUG_HUD && console.log("[HUD Diff] silentDiffCheck: referencesHashCache 为空, _refHashCache 回退值 =", bibRefHash);
          if (bibRefHash !== null && bibRefHash !== undefined) {
            storedRefHash = bibRefHash;
            SyncFloatingButton.referencesHashCache.set(file.path, bibRefHash);
          }
        }
        DEBUG_HUD && console.log("[HUD Diff] 引注检测 - storedSig:", storedSig, "bodySig:", bodySig);
        // v6.5.1: 异步操作后检查文件是否已切换
        if (this.plugin.app.workspace.getActiveFile()?.path !== file.path) {
          DEBUG_HUD && console.log("[HUD State Debug] 文件已切换（计算参考文献哈希后），取消引注检测");
          return;
        }
        DEBUG_HUD && console.log("[HUD State Debug] 引注检测 - storedRefHash:", storedRefHash, "refHash:", refHash);
        DEBUG_HUD && console.log("[HUD State Debug] 引注检测 - bodyKeys.length:", bodyKeys.length, "refCount:", refCount);

        // ── 终极断言：提纯签名与提纯哈希同时匹配 → 绝对 clean ──
        DEBUG_HUD && console.log("[HUD Diff] 比较 - storedSig:", storedSig, "storedRefHash:", storedRefHash, "bodySig:", bodySig, "refHash:", refHash, "bodyKeys:", bodyKeys.length, "refCount:", refCount);
        // 无论数量是否对等，只要纯 citekey 签名不变 + 纯条目哈希不变，
        // 就证明用户未增删引注、未改参考文献，绝对禁止亮橙灯。
        if (storedSig !== undefined && storedRefHash !== undefined &&
            storedSig === bodySig && storedRefHash === refHash) {
          DEBUG_HUD && console.log("[HUD Diff] → 分支1: sig+hash匹配 → markBibClean");
          markBibClean();
        } else if (bodyKeys.length === 0 && refCount === 0) {
          // v6.5.4: 空引注空参考文献 → 无条件标记 clean + 清空基线缓存
          // 废弃 v6.5.3 竞态保护检查（isBibOutOfSync），原因：
          //   即使 cm6LivePreview 在异步间隙基于过期 _signatureCache 误调用了 markBibDirty()，
          //   本函数通过真实文件内容扫描得出的 bodyKeys=0+refCount=0 是权威结论，
          //   应覆盖任何中间状态的脏标志。若用户正在键入引注，cm6LivePreview 下一帧会重新标记。
          DEBUG_HUD && console.log("[HUD Diff] → 分支2: 空引注空参考文献 → markBibClean");
          // 先强制重置脏标志（覆盖异步间隙中被错误设置的 dirty），再标记 clean
          if (isBibOutOfSync) {
            DEBUG_HUD && console.log("[HUD State Debug] 检测到异步间隙脏标志，强制覆盖");
          }
          markBibClean();
          SyncFloatingButton.citekeySignatureCache.set(file.path, '');
          // v6.5.3: 清除 refHash 缓存，防止旧值污染
          SyncFloatingButton.referencesHashCache.delete(file.path);
          clearLastRefHash(file.path);
        } else if (bodyKeys.length !== refCount) {
          // 第1层：数量不对等 → dirty
          DEBUG_HUD && console.log("[HUD Diff] → 分支3: 数量不对等 → markBibDirty");
          markBibDirty();
          citationDirty = true;
        } else if (storedSig && storedSig !== bodySig) {
          // 第2层：citekey 签名变更 → dirty（空字符串视为无基线，不触发此分支）
          DEBUG_HUD && console.log("[HUD Diff] → 分支4: 签名变更 → markBibDirty");
          markBibDirty();
          citationDirty = true;
        } else if (storedSig === undefined && (bodyKeys.length > 0 || refCount > 0)) {
          // 首次访问：存储基线（排除无引注无参考文献的情况）。
          // ★ v6.6.1: 使用 storedSig 而非 storedRefHash 判断首次访问，
          // 因为 _refHashCache 回退可能已给 storedRefHash 赋值，导致漏过。
          // 不调用 markBibClean()——若 cm6LivePreview 已检测到修改并标记 dirty，
          // 此处的 markBibClean 会错误覆盖脏状态。
          DEBUG_HUD && console.log("[HUD Diff] → 分支5: 首次访问 → 仅存储基线");
          if (refHash) {
            SyncFloatingButton.referencesHashCache.set(file.path, refHash);
            setLastRefHash(file.path, refHash);
          }
          SyncFloatingButton.citekeySignatureCache.set(file.path, bodySig);
        } else if (storedRefHash !== refHash) {
          // 区块被修改 → dirty
          DEBUG_HUD && console.log("[HUD Diff] → 分支6: 参考文献被修改 → markBibDirty");
          markBibDirty();
          citationDirty = true;
        } else {
          DEBUG_HUD && console.log("[HUD Diff] → 分支7: 其他情况 → markBibClean");
          markBibClean();
        }
      } catch { /* 引注解析失败，跳过 */ }

      // ★ 引注检测完成 → 立即更新图标（不等网络元数据检测）
      if (citationDirty) this.updateBibStatusIcon();

      // ── 元数据检测：Zotero-now vs Zotero-then（同源比对，杜绝假阳性）──
      let metadataDirty = false;
      const currentHash = await this.computeMetadataHash(citeKey, file);
      if (currentHash) {
        const storedHash = metadataSyncHashCache.get(file.path);
        DEBUG_HUD && console.log("[HUD State Debug] 元数据检测 - storedHash:", storedHash, "currentHash:", currentHash);
        if (storedHash === undefined) {
          DEBUG_HUD && console.log("[HUD State Debug] 元数据缓存未命中，标记为已同步");
          markMetadataSynced(file.path, currentHash, this.plugin.emitter);
        } else if (storedHash !== currentHash) {
          DEBUG_HUD && console.log("[HUD State Debug] 元数据哈希不匹配，标记为脏");
          checkMetadataDirty(file.path, currentHash, this.plugin.emitter, true);
          metadataDirty = true;
        } else {
          DEBUG_HUD && console.log("[HUD State Debug] 元数据哈希匹配，标记为已同步");
          markMetadataSynced(file.path, currentHash, this.plugin.emitter);
        }
      }

      // ── 时机路由 ──
      if (trigger === 'file-open' && metadataDirty && !citationDirty) {
        // 仅元数据脏（引注clean）→ 安全自动同步，不碰正文
        await this.runSmartSync(file);
      } else if (metadataDirty || citationDirty) {
        // 引注脏 或 两者皆脏 → 绝对拦截，纯视觉挂起等待手动操作
        this.updateBibStatusIcon();
      }
    } catch (e) {
      console.error("[HUD Debug] silentDiffCheck 异常:", e);
    } finally {
      SyncFloatingButton.diffInFlightSet.delete(file.path);
    }
  }

  // ── DOM 挂载 / 销毁 ──

  private mount() {
    const container = this.getViewContainer();
    if (!container) return;

    // 按钮属于不同的容器（切换了视图）→ 销毁重建
    if (this.wrapper && this.wrapper.parentElement !== container) {
      this.cleanup?.();
      this.wrapper.remove();
      this.wrapper = null;
      this.button = null;
      this.cleanup = null;
      this.containerEl = null;
    }

    // 按钮已从 DOM 断开（被 Obsidian 重渲染移除）→ 清理状态
    if (this.wrapper && !this.wrapper.isConnected) {
      this.cleanup?.();
      this.wrapper = null;
      this.button = null;
      this.cleanup = null;
      this.containerEl = null;
    }

    if (this.button) return;

    this.containerEl = container;

    // v6.3.0: 进度环 wrapper — 默认 .is-idle 闲置态
    const wrapper = container.createDiv('sync-floating-wrapper is-idle');
    this.wrapper = wrapper;

    const btn = wrapper.createDiv('sync-floating-button');

    // 基础样式
    btn.style.cssText = this.buildBaseStyle();

    // v6.4.0: SVG 环形进度条（抗锯齿 + stroke-dashoffset 驱动）
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'sync-progress-ring');
    svg.setAttribute('viewBox', '0 0 50 50');
    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('class', 'sync-ring-track');
    track.setAttribute('cx', '25');
    track.setAttribute('cy', '25');
    track.setAttribute('r', String(SyncFloatingButton.RING_RADIUS));
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke-width', '4');
    const fill = document.createElementNS(svgNS, 'circle');
    fill.setAttribute('class', 'sync-ring-fill');
    fill.setAttribute('cx', '25');
    fill.setAttribute('cy', '25');
    fill.setAttribute('r', String(SyncFloatingButton.RING_RADIUS));
    fill.setAttribute('fill', 'none');
    fill.setAttribute('stroke-width', '4');
    fill.setAttribute('stroke-linecap', 'butt');
    fill.style.strokeDasharray = String(SyncFloatingButton.RING_CIRCUMFERENCE);
    fill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
    svg.appendChild(track);
    svg.appendChild(fill);
    btn.appendChild(svg);
    this.ringTrack = track;
    this.ringFill = fill;

    // v6.3.0-alpha.1: 生命周期子元素
    // 图标包装（用于淡入淡出）
    const iconWrap = btn.createSpan('sync-icon-wrap');
    setIcon(iconWrap, 'file-text');
    this.iconWrap = iconWrap;

    // 百分比数字
    const progressText = btn.createSpan('sync-progress-text');
    progressText.textContent = '0%';
    this.progressText = progressText;

    // 绿色对勾
    const checkIcon = btn.createSpan('sync-check-icon');
    checkIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    this.checkIcon = checkIcon;

    // 恢复记忆位置（无记忆时使用默认右下角）
    const saved = this.loadPosition();
    if (saved) {
      if (saved.left !== 'auto') wrapper.style.left = saved.left;
      if (saved.right !== 'auto') wrapper.style.right = saved.right;
      wrapper.style.top = saved.top;
      wrapper.style.bottom = 'auto';
    } else {
      wrapper.style.right = '30px';
      wrapper.style.bottom = '50px';
    }

    this.button = btn;
    this.bindDrag();

    // v7.1: 挂载时根据当前 dirty 状态设置图标
    this.updateBibStatusIcon();
    // v6.6.5: 挂载时检查 Zotero 不可达初始状态
    if (isZoteroUnreachable()) this.applyZoteroUnreachableBlink(true);

    // 恢复后做一次垂直边界修正 + 方位类名
    requestAnimationFrame(() => {
      this.clampVerticalPosition();
      this.updateEdgeClass();
    });
  }

  /**
   * v6.5.0: 双重状态图标 — 统一使用 file-pen 作为警告态。
   *   isBibOutOfSync      → file-pen + 橙色 SVG 全圈环
   *   isMetadataOutOfSync → file-pen + 橙色 SVG 全圈环
   *   两者都 dirty         → file-pen + 橙色 SVG 全圈环
   *   两者都 clean         → file-text (.is-idle 闲置态，环隐藏)
   *
   * 警告态复用 SVG 环形进度条的 <circle> 元素：
   *   stroke-dashoffset=0 全圈填充，stroke=var(--text-warning) 橙色，
   *   与加载紫环/成功绿环 stroke-width 像素级等宽（4px）。
   */
  private updateBibStatusIcon() {
    const wrap = this.iconWrap;
    DEBUG_HUD && console.log("[HUD Icon Debug] updateBibStatusIcon() 被调用, iconWrap 存在:", !!wrap, "isBibOutOfSync:", isBibOutOfSync, "isMetadataOutOfSync:", isMetadataOutOfSync);
    if (!wrap) return;
    const dirty = isBibOutOfSync || isMetadataOutOfSync;
    if (dirty) {
      DEBUG_HUD && console.log("[HUD Icon Debug] 设置图标为 file-pen (脏)");
      setIcon(wrap, 'file-pen');
      this.applyWarningRing(true);
    } else {
      DEBUG_HUD && console.log("[HUD Icon Debug] 设置图标为 file-text (净)");
      setIcon(wrap, 'file-text');
      if (!this.isProgressing) this.applyWarningRing(false);
    }
    this.updateTooltip();
  }

  /** v6.6.5: Zotero 不可达 → 悬浮球图标缓慢闪烁 */
  private applyZoteroUnreachableBlink(unreachable: boolean) {
    const w = this.wrapper;
    if (!w) return;
    if (unreachable) {
      w.addClass('zotero-unreachable');
    } else {
      w.removeClass('zotero-unreachable');
    }
  }

  /** 显示/隐藏 SVG 橙色警告环（复用进度环 <circle>，stroke-width 等宽） */
  private applyWarningRing(show: boolean) {
    const w = this.wrapper;
    if (!w) return;
    if (show) {
      w.addClass('has-updates-ring');
      if (this.ringTrack) {
        this.ringTrack.style.strokeDasharray = String(SyncFloatingButton.RING_CIRCUMFERENCE);
        this.ringTrack.style.strokeDashoffset = '0';
      }
      if (this.ringFill) {
        this.ringFill.style.strokeDasharray = String(SyncFloatingButton.RING_CIRCUMFERENCE);
        this.ringFill.style.strokeDashoffset = '0';
      }
    } else {
      w.removeClass('has-updates-ring');
      if (this.ringFill) {
        this.ringFill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
      }
    }
  }

  /** v6.5.0: 纯 CSS 零延迟 tooltip — data-tooltip 驱动 ::after 伪元素即触即发 */
  private updateTooltip() {
    const w = this.wrapper;
    if (!w) return;
    if (isBibOutOfSync && isMetadataOutOfSync) {
      w.setAttribute('data-tooltip', '文献条目与参考文献需要更新');
    } else if (isBibOutOfSync) {
      w.setAttribute('data-tooltip', '参考文献需要更新');
    } else if (isMetadataOutOfSync) {
      w.setAttribute('data-tooltip', '文献条目需要更新');
    } else {
      w.removeAttribute('data-tooltip');
    }
  }

  private destroy() {
    this.closeMenu();
    if (this.tweenRafId) { cancelAnimationFrame(this.tweenRafId); this.tweenRafId = null; }
    if (this.successTimer) { clearTimeout(this.successTimer); this.successTimer = null; }
    // v6.6.5: 清理 Zotero 状态监听
    if (this.zoteroStateUnsub) { this.zoteroStateUnsub(); this.zoteroStateUnsub = null; }
    if (this.wrapper) {
      this.cleanup?.();
      // 销毁前保存位置
      this.savePosition();
      this.wrapper.remove();
      this.wrapper = null;
      this.button = null;
      this.iconWrap = null;
      this.progressText = null;
      this.checkIcon = null;
      this.ringTrack = null;
      this.ringFill = null;
      this.cleanup = null;
      this.containerEl = null;
      // v6.5.0: 文件关闭时重置 metadata dirty 状态
      resetMetadataState(this.plugin.emitter);
    }
  }

  // ── 样式 ──

  private buildBaseStyle(): string {
    return [
      'width: 50px',
      'height: 50px',
      'border-radius: 50%',
      'background: var(--background-secondary)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'cursor: grab',
      'user-select: none',
      'color: var(--icon-color)',
    ].join(';');
  }

  // ── 垂直边界修正 ──

  private clampVerticalPosition() {
    const wrapper = this.wrapper;
    if (!wrapper || !this.containerEl) return;

    const containerRect = this.containerEl.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const localTop = wrapperRect.top - containerRect.top;
    const maxTop = containerRect.height - wrapper.offsetHeight;

    if (localTop < 0) {
      wrapper.style.top = '0px';
      wrapper.style.bottom = 'auto';
    } else if (localTop > maxTop) {
      wrapper.style.top = `${maxTop}px`;
      wrapper.style.bottom = 'auto';
    }
  }

  // ── v6.3.0 拖拽逻辑（wrapper 驱动定位，btn 承载视觉）──

  private bindDrag() {
    const btn = this.button!;
    const wrapper = this.wrapper!;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;

      e.preventDefault();
      this.dragging = true;
      this.hasMoved = false;

      this.startMouseX = e.clientX;
      this.startMouseY = e.clientY;

      const container = this.containerEl;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();

      this.startLocalLeft = wrapperRect.left - containerRect.left;
      this.startLocalTop = wrapperRect.top - containerRect.top;

      // wrapper 切换为 left/top 驱动
      wrapper.style.left = `${this.startLocalLeft}px`;
      wrapper.style.top = `${this.startLocalTop}px`;
      wrapper.style.right = 'auto';
      wrapper.style.bottom = 'auto';

      // 拖拽中视觉
      wrapper.style.transition = 'none';
      btn.style.cursor = 'grabbing';
      btn.style.boxShadow = 'var(--shadow-xl)';
      btn.style.transform = 'scale(1.08)';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.dragging) return;

      const dx = e.clientX - this.startMouseX;
      const dy = e.clientY - this.startMouseY;

      if (!this.hasMoved && (Math.abs(dx) > this.DRAG_THRESHOLD || Math.abs(dy) > this.DRAG_THRESHOLD)) {
        this.hasMoved = true;
      }

      if (!this.hasMoved) return;

      const container = this.containerEl;
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const newLocalLeft = this.startLocalLeft + dx;
      const newLocalTop = this.startLocalTop + dy;

      const maxLeft = containerRect.width - wrapper.offsetWidth;
      const maxTop = containerRect.height - wrapper.offsetHeight;

      wrapper.style.left = `${Math.max(0, Math.min(newLocalLeft, maxLeft))}px`;
      wrapper.style.top = `${Math.max(0, Math.min(newLocalTop, maxTop))}px`;
    };

    const onMouseUp = () => {
      if (!this.dragging) return;
      this.dragging = false;

      btn.style.cursor = 'grab';
      btn.style.boxShadow = 'var(--shadow-l)';
      btn.style.transform = 'scale(1)';

      if (this.hasMoved) {
        this.snapToEdge();
        this.savePosition();
      } else {
        this.handleClick();
      }
    };

    btn.addEventListener('mousedown', onMouseDown);
    activeWindow.addEventListener('mousemove', onMouseMove);
    activeWindow.addEventListener('mouseup', onMouseUp);

    this.cleanup = () => {
      btn.removeEventListener('mousedown', onMouseDown);
      activeWindow.removeEventListener('mousemove', onMouseMove);
      activeWindow.removeEventListener('mouseup', onMouseUp);
    };
  }

  // ── v6.3.0 边缘吸附（wrapper 驱动）──

  /** 根据当前坐标判断左右方位并挂载 .is-on-left / .is-on-right 类名 */
  private updateEdgeClass() {
    const wrapper = this.wrapper;
    const container = this.containerEl;
    if (!wrapper || !container) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const centerX = wrapperRect.left - containerRect.left + wrapperRect.width / 2;
    const isLeft = centerX < containerRect.width / 2;
    if (isLeft) {
      wrapper.addClass('is-on-left');
      wrapper.removeClass('is-on-right');
    } else {
      wrapper.addClass('is-on-right');
      wrapper.removeClass('is-on-left');
    }
  }

  private snapToEdge() {
    const wrapper = this.wrapper;
    if (!wrapper) return;

    const container = this.containerEl;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    const centerX = wrapperRect.left - containerRect.left + wrapperRect.width / 2;
    const distToLeft = centerX;
    const distToRight = containerRect.width - centerX;

    wrapper.style.transition = 'left 0.35s cubic-bezier(0.22, 0.61, 0.36, 1), right 0.35s cubic-bezier(0.22, 0.61, 0.36, 1), top 0.35s cubic-bezier(0.22, 0.61, 0.36, 1)';

    if (distToLeft < distToRight) {
      wrapper.style.left = `${this.SNAP_MARGIN}px`;
      wrapper.style.right = 'auto';
    } else {
      wrapper.style.left = 'auto';
      wrapper.style.right = `${this.SNAP_MARGIN}px`;
    }

    // 更新方位类名 → tooltip 自适应方向
    this.updateEdgeClass();

    // 垂直边界修正
    this.clampVerticalPosition();

    // 动画结束后清除 transition 以避免干扰后续拖拽
    setTimeout(() => {
      if (wrapper) wrapper.style.transition = '';
    }, 400);
  }

  // ── 点击触发 ──

  private handleClick() {
    if (this.menu) {
      this.closeMenu();
      return;
    }

    // v6.3.0-alpha.1: 菜单顺序 — 导入条目 / 更新条目 / 插入引注 / 更新文献
    const targets = this.plugin.settings.syncTargets || ['metadata'];
    const menuCommands: string[] = [];

    menuCommands.push('zdc-import-literature');
    if (targets.includes('metadata') || targets.includes('annotations')) {
      menuCommands.push('zdc-smart-sync');
    }
    menuCommands.push('zdc-insert-inline-citation');
    menuCommands.push('update-bibliography');

    if (menuCommands.length === 0) return;

    if (menuCommands.length === 1) {
      this.executeCommand(menuCommands[0]);
    } else {
      this.showCommandMenu(menuCommands);
    }
  }

  // ── 命令名称映射 ──

  private getCommandLabel(cmdId: string): string {
    const keyMap: Record<string, string> = {
      'zdc-import-literature': 'command.importEntries',
      'zdc-smart-sync': 'command.smartSync',
      'zdc-insert-inline-citation': 'command.insertCitation',
      'update-bibliography': 'command.updateReferences',
    };
    return t(keyMap[cmdId] || cmdId);
  }

  // ── 弹出菜单 ──

  private showCommandMenu(commands: string[]) {
    this.closeMenu();
    const btn = this.button!;

    const menu = document.body.createDiv('sync-floating-menu');
    this.menu = menu;

    menu.style.cssText = [
      'position: fixed',
      'z-index: 99998',
      'min-width: 180px',
      'background: var(--background-primary)',
      'border: none',
      'border-radius: 8px',
      'box-shadow: 0 8px 32px rgba(0,0,0,0.18)',
      'padding: 4px 0',
      'color: var(--text-normal)',
      'font-size: 14px',
      'user-select: none',
      'opacity: 0',
      'transform: scale(0.92)',
      'transition: opacity 0.15s ease, transform 0.15s ease',
    ].join(';');

    // v6.5.0: 根据脏状态决定推荐高亮
    const highlightMetadata = isMetadataOutOfSync;
    const highlightBib = isBibOutOfSync;

    for (const cmdId of commands) {
      const isRecommended =
        (cmdId === 'zdc-smart-sync' && highlightMetadata) ||
        (cmdId === 'update-bibliography' && highlightBib);

      const item = menu.createDiv(
        `sync-floating-menu-item${isRecommended ? ' is-recommended-action' : ''}`,
      );
      item.setText(this.getCommandLabel(cmdId));
      item.style.cssText = [
        'padding: 10px 18px',
        'cursor: pointer',
        'border-radius: 0',
        'transition: background 0.12s ease',
      ].join(';');

      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--background-modifier-hover)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = '';
      });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.executeCommand(cmdId);
        this.closeMenu();
      });
    }

    const btnRect = btn.getBoundingClientRect();
    const isLeftSide = btnRect.left < window.innerWidth / 2;
    const spaceAbove = btnRect.top;
    const spaceBelow = window.innerHeight - btnRect.bottom;
    const placeAbove = spaceAbove > spaceBelow;

    document.body.appendChild(menu);
    const menuRect = menu.getBoundingClientRect();

    if (isLeftSide) {
      menu.style.left = `${btnRect.left}px`;
    } else {
      menu.style.left = `${btnRect.right - menuRect.width}px`;
    }

    if (placeAbove) {
      menu.style.top = `${btnRect.top - menuRect.height - 8}px`;
    } else {
      menu.style.top = `${btnRect.bottom + 8}px`;
    }

    const menuLeft = parseFloat(menu.style.left);
    const menuTop = parseFloat(menu.style.top);
    if (menuLeft < 8) menu.style.left = '8px';
    if (menuLeft + menuRect.width > window.innerWidth - 8) {
      menu.style.left = `${window.innerWidth - menuRect.width - 8}px`;
    }
    if (menuTop < 8) menu.style.top = '8px';
    if (menuTop + menuRect.height > window.innerHeight - 8) {
      menu.style.top = `${window.innerHeight - menuRect.height - 8}px`;
    }

    requestAnimationFrame(() => {
      menu.style.opacity = '1';
      menu.style.transform = 'scale(1)';
    });

    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.contains(target) && !btn.contains(target)) {
        this.closeMenu();
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.closeMenu();
    };

    setTimeout(() => {
      document.addEventListener('click', onOutsideClick);
      document.addEventListener('keydown', onEsc);
    }, 100);

    this.menuCleanup = () => {
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onEsc);
    };
  }

  private closeMenu() {
    if (this.menu) {
      this.menuCleanup?.();
      this.menu.style.opacity = '0';
      this.menu.style.transform = 'scale(0.92)';
      setTimeout(() => {
        this.menu?.remove();
        this.menu = null;
        this.menuCleanup = null;
      }, 150);
    }
  }

  // ── 命令执行 ──

  private async executeCommand(cmdId: string) {
    // v6.0: 智能同步 — 需要当前文件
    if (cmdId === 'zdc-smart-sync') {
      const file = this.plugin.app.workspace.getActiveFile();
      if (!file) return;
      await this.runSmartSync(file);
      return;
    }

    // v7.2: 导入文献 — 不需要当前文件，直接执行命令系统
    // 其他命令（插入行内引注、更新参考文献）走命令系统
    try {
      (this.plugin.app as any).commands.executeCommandById(
        `optimized-zotero-integration:${cmdId}`
      );
    } catch {
      // 命令未注册或执行失败
    }
  }

  /**
   * v6.5.0: 同步完成后刷新引注缓存基线。
   *
   * @param preReadContent 编辑器路径传入 view.state.doc.toString()，
   *   绕过一切文件 I/O（因 view.dispatch 后 Obsidian 异步落盘有延迟，
   *   vault.read() 可能读到旧内容）。不传时回退到 vault.read()。
   */
  async refreshCitationCachesAfterSync(file: TFile, preReadContent?: string) {
    DEBUG_HUD && console.log("[HUD State Debug] refreshCitationCachesAfterSync: 开始刷新缓存");
    // v6.5.4: 只使用传入的内容或从磁盘读取，不从编辑器读取（编辑器内容可能不可靠）
    const freshContent = preReadContent ?? await this.plugin.app.vault.read(file);
    const sig = await this.computeCiteKeySignature(file, freshContent);
    SyncFloatingButton.citekeySignatureCache.set(file.path, sig);
    DEBUG_HUD && console.log("[HUD State Debug] refreshCitationCachesAfterSync: 更新 citekeySignatureCache =", sig);
    const refHash = await this.computeReferencesHash(file, freshContent);
    DEBUG_HUD && console.log("[HUD State Debug] refreshCitationCachesAfterSync: 计算 refHash =", refHash);
    // v6.5.3: 当 refHash 为 null 时删除缓存，防止旧值污染
    if (refHash) {
      SyncFloatingButton.referencesHashCache.set(file.path, refHash);
      setLastRefHash(file.path, refHash);
      DEBUG_HUD && console.log("[HUD State Debug] refreshCitationCachesAfterSync: 设置 referencesHashCache =", refHash);
    } else {
      SyncFloatingButton.referencesHashCache.delete(file.path);
      clearLastRefHash(file.path);
      DEBUG_HUD && console.log("[HUD State Debug] refreshCitationCachesAfterSync: 删除 referencesHashCache");
    }
    // v6.5.3: 不调用 markBibClean()，因为此方法已经在 bibClean 事件回调中，状态已经是 clean
    DEBUG_HUD && console.log("[HUD State Debug] refreshCitationCachesAfterSync: 缓存刷新完成，跳过 markBibClean()");
  }

  /** v6.5.0: 手动智能同步 — 无条件绕过签名拦截器，执行完整流程 */
  private async runSmartSync(file: TFile) {
    const citeKey = this.extractCiteKeyFromFile(file);
    if (!citeKey) return;

    // v6.5.0: 写入守卫 — 发起同步时立刻锁定目标文件路径，杜绝跨文件覆盖
    const targetPath = file.path;

    this.showProgress();
    this.setProgress(5);
    SyncFloatingButton.inFlightSet.add(targetPath);
    try {
      this.setProgress(25);
      await this.plugin.runSilentAutoSync(citeKey, 1, targetPath);

      // 写入守卫：若用户已切走，放弃后续状态更新，防止跨文件缓存污染
      const activePath = this.plugin.app.workspace.getActiveFile()?.path;
      if (activePath !== targetPath) {
        console.warn('[HUD Guard] 文件已切换，放弃后台状态更新，防止跨文件污染！');
        this.hideProgress();
        return;
      }

      this.setProgress(85);
      const currentHash = await this.computeMetadataHash(citeKey, file);
      if (currentHash) {
        metadataSyncHashCache.set(targetPath, currentHash);
        markMetadataSynced(targetPath, currentHash, this.plugin.emitter);
      }
      // v6.5.0: 重新扫描正文并强行覆盖缓存基线，终结假阳性
      await this.refreshCitationCachesAfterSync(file);
      this.setProgress(100);
      // 补间引擎在 visual=100 时自动触发 triggerSuccess()
    } catch (e) {
      console.error('[SmartSync]', e);
      new Notice(t('notice.autoSyncFailed'), 3000);
      this.hideProgress();
    } finally {
      SyncFloatingButton.inFlightSet.delete(file.path);
    }
  }

  /** v6.3.0: 计算 Zotero 条目元数据哈希，用于差分同步 */
  private async computeMetadataHash(
    citeKey: string,
    file?: TFile,
  ): Promise<string | null> {
    try {
      // 从文件 frontmatter 或默认值获取 libraryID
      let libraryID = 1;
      if (file) {
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fmLibrary = cache?.frontmatter?.libraryID;
        if (typeof fmLibrary === 'number') libraryID = fmLibrary;
      }
      const citeKeyObj = { key: citeKey, library: libraryID };

      const database = { database: this.plugin.settings.database, port: this.plugin.settings.port };
      const items = await getItemJSONFromCiteKeys([citeKeyObj], database, libraryID, true);
      if (!items || !items.length) return null;
      const item = items[0];
      // v6.5.0: 扩展字段 — 覆盖标题、摘要、DOI、URL、日期、作者、编辑、
      //   期刊、标签（阅读状态/优先级/类型）、文库分类、extra、版本
      const fields = [
        item.title ?? "",
        item.abstract ?? "",
        item.DOI ?? "",
        item.URL ?? "",
        item.date ?? "",
        item.issued?.["date-parts"]?.flat()?.join("-") ?? "",
        JSON.stringify(item.author ?? []),
        JSON.stringify(item.editor ?? []),
        item.publicationTitle ?? "",
        item.journalAbbreviation ?? "",
        item.version ?? "",
        item.status ?? "",
        // tags — 包含阅读状态、优先级、文献类型等关键字段
        JSON.stringify((item.tags ?? []).map((t: any) => (typeof t === 'string' ? t : (t.tag ?? t)))),
        // collections — 文库分类路径
        JSON.stringify((item.collections ?? []).map((c: any) => (typeof c === 'string' ? c : (c.fullPath ?? c.name ?? c)))),
        // extra — 包含 titleTranslation 等附加字段
        item.extra ?? "",
      ];
      const joined = fields.join("|");
      let hash = 0;
      for (let i = 0; i < joined.length; i++) {
        const chr = joined.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
      }
      return String(hash);
    } catch (e) {
      console.error("[HUD Debug] computeMetadataHash 异常:", e);
      return null;
    }
  }

  private extractCiteKeyFromFile(file: TFile): string | null {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const citeKey = cache?.frontmatter?.citekey || cache?.frontmatter?.citationKey;
    if (citeKey) return citeKey;

    return file.basename;
  }

  /** v6.5.0: 从文档正文提取去重排序后的 citekey 数组 */
  private async extractBodyCiteKeys(file: TFile, content?: string): Promise<string[]> {
    const text = content ?? await this.plugin.app.vault.cachedRead(file);
    const keys: string[] = [];
    CITEKEY_SIG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITEKEY_SIG_RE.exec(text)) !== null) {
      // 拆分多引注 [@key1; @key2]，过滤空白，去除 @ 前缀
      const rawKeys = match[1]
        .split(';')
        .map(s => s.trim().replace(/^@/, ''))
        .filter(Boolean);
	      keys.push(...rawKeys);
	    }
	    return [...new Set(keys)];
	  }

	  /** v6.5.0: 统计参考文献区块中的条目数（匹配 ^\d+\.\s 编号行）*/
	  private async countReferenceEntries(file: TFile, content?: string): Promise<number> {
	    const text = content ?? await this.plugin.app.vault.cachedRead(file);
	    const zone = this.findReferencesZone(text);
	    if (!zone) return 0;
	    const section = text.slice(zone.from, zone.to);
	    let count = 0;
    const re = /^\d+\.\s/gm;
	    while (re.exec(section) !== null) count++;
	    return count;
	  }

  /** v6.5.0: 计算参考文献区块内容哈希 — 提纯：剔除所有空格/换行/不可见字符 */
  private async computeReferencesHash(file: TFile, content?: string): Promise<string | null> {
    const text = content ?? await this.plugin.app.vault.cachedRead(file);
    const zone = this.findReferencesZone(text);
    if (!zone) return null;
    // 暴力清理：剔除一切空白与不可见字符，仅对纯文本条目计算哈希
    const section = text.slice(zone.from, zone.to).replace(/\s+/g, '');
    if (!section) return null;
    let hash = 0;
    for (let i = 0; i < section.length; i++) {
      hash = ((hash << 5) - hash) + section.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  /** v6.5.0: 定位参考文献标题在文档中的安全区 */
  private findReferencesZone(content: string): { from: number; to: number } | null {
    // ★ v6.6.1: 使用动态标题（与 bibliographyWriter 一致），不再硬编码
    const heading = getBibliographyHeading();
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const headingRe = new RegExp(`^#{1,3}\\s+${escaped}\\s*$`, 'm');
    const m = headingRe.exec(content);
    if (!m) return null;
    const headingLevel = (m[0].match(/^#+/)!)[0].length;
    const zoneStart = m.index + m[0].length;
    const rest = content.slice(zoneStart);
    // 找到下一个同级或更高级标题作为终点
    const nextRe = new RegExp(`^#{1,${headingLevel}}\\s`, 'm');
    const nextM = nextRe.exec(rest);
    const zoneEnd = nextM ? zoneStart + nextM.index : content.length;
    return { from: zoneStart, to: zoneEnd };
  }

  private async computeCiteKeySignature(file: TFile, content?: string): Promise<string> {
    const keys = await this.extractBodyCiteKeys(file, content);
    return keys.join('|');
  }
}
