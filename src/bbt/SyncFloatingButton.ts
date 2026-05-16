import { MarkdownView, Notice, setIcon, TFile } from 'obsidian';
import { getItemJSONFromCiteKeys } from './jsonRPC';
import { getCiteKeyFromAny } from './cayw';
import type ZoteroConnector from '../main';
import { t } from '../locale/i18n';
import type { TriggerCondition } from '../types';
import { isBibOutOfSync, onBibDirtyChange } from '../citation/bibliographyWriter';

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
  private static metadataHashCache = new Map<string, string>();
  private static readonly AUTO_SYNC_DEBOUNCE_MS = 3 * 60 * 1000; // 3 分钟
  // 飞行中 tracker：防止同一文件并发执行两次同步
  private static inFlightSet = new Set<string>();

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
    if (this.ringFill) this.ringFill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
    this.successTimer = null;
    this.updateBibStatusIcon();
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
    if (this.ringFill) this.ringFill.style.strokeDashoffset = String(SyncFloatingButton.RING_CIRCUMFERENCE);
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

  // ── 事件监听 ──

  private registerListeners() {
    // 文件切换
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file && this.isLiteratureNote(file)) {
          this.mount();
        } else {
          this.destroy();
        }
        // v5.4: 自动同步使用独立触发条件，与悬浮球显示分离
        if (file && this.plugin.settings.autoSyncOnOpen &&
            this.matchesTrigger(file, this.plugin.settings.autoSyncTriggers)) {
          this.tryAutoSync(file);
        }
      })
    );

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
    this.plugin.registerEvent(
      this.plugin.emitter.on('bibClean', () => this.updateBibStatusIcon())
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
   * v5.2 开卷自动同步引擎。
   * 满足条件（防抖通过 + citeKey 存在 + 命令勾选）后静默执行同步。
   */
  private async tryAutoSync(file: TFile) {
    const now = Date.now();
    const lastSync = SyncFloatingButton.autoSyncDebounceMap.get(file.path);

    // 防抖：3 分钟内同文件不重复触发，除非「同步目标」勾选发生了变化
    if (lastSync && (now - lastSync.time) < SyncFloatingButton.AUTO_SYNC_DEBOUNCE_MS) {
      const currentCmds = this.plugin.settings.syncTargets || ['metadata'];
      const lastCmds = lastSync.commands || [];
      if (currentCmds.slice().sort().join(',') === lastCmds.slice().sort().join(',')) {
        return;
      }
      // 同步目标变了，允许重新同步
    }

    // 飞行中保护：同一文件已有同步在执行中
    if (SyncFloatingButton.inFlightSet.has(file.path)) {
      return;
    }

    const citeKey = this.extractCiteKeyFromFile(file);
    if (!citeKey) return;

    // 仅静默处理 metadata / annotations，其他目标不参与自动同步
    const targets = this.plugin.settings.syncTargets || ['metadata'];
    if (!targets.includes('metadata') && !targets.includes('annotations')) {
      return;
    }

    // ★ v6.3.0: 差分检测 — 仅当 Zotero 数据真正变化时才触发同步
    const currentHash = await this.computeMetadataHash(citeKey);
    if (currentHash) {
      const storedHash = SyncFloatingButton.metadataHashCache.get(file.path);
      if (storedHash === currentHash) {
        // 数据未变化，跳过同步
        SyncFloatingButton.autoSyncDebounceMap.set(file.path, {
          time: Date.now(),
          commands: [...targets],
        });
        return;
      }
    }

    // ★ v6.3.0-alpha.1: HUD 全生命周期进度
    this.showProgress();
    this.setProgress(5);

    SyncFloatingButton.inFlightSet.add(file.path);
    try {
      this.setProgress(25);
      await this.plugin.runSilentAutoSync(citeKey, 1, file.path);
      this.setProgress(85);
      SyncFloatingButton.autoSyncDebounceMap.set(file.path, {
        time: Date.now(),
        commands: [...targets],
      });
      // 缓存新哈希值
      if (currentHash) {
        SyncFloatingButton.metadataHashCache.set(file.path, currentHash);
      }
      this.setProgress(100);
      // 补间引擎在 visual=100 时自动触发 triggerSuccess()
    } catch (e) {
      console.error('[AutoSync]', e);
      this.hideProgress();
      new Notice(t('notice.autoSyncFailed'), 3000);
    } finally {
      SyncFloatingButton.inFlightSet.delete(file.path);
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

    // v6.3.0: 进度环 wrapper
    const wrapper = container.createDiv('sync-floating-wrapper');
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

    // 恢复后做一次垂直边界修正
    requestAnimationFrame(() => this.clampVerticalPosition());
  }

  /** v7.1: 根据 isBibOutOfSync 切换图标 — 脏 file-pen / 干净 file-text */
  private updateBibStatusIcon() {
    const wrap = this.iconWrap;
    if (!wrap) return;
    if (isBibOutOfSync) {
      setIcon(wrap, 'file-pen');
    } else {
      setIcon(wrap, 'file-text');
    }
  }

  private destroy() {
    this.closeMenu();
    if (this.tweenRafId) { cancelAnimationFrame(this.tweenRafId); this.tweenRafId = null; }
    if (this.successTimer) { clearTimeout(this.successTimer); this.successTimer = null; }
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
    }
  }

  // ── 样式 ──

  private buildBaseStyle(): string {
    return [
      'width: 50px',
      'height: 50px',
      'border-radius: 50%',
      'background: var(--background-secondary)',
      'border: 1px solid var(--background-modifier-border)',
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
      'border: 1px solid var(--background-modifier-border)',
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

    for (const cmdId of commands) {
      const item = menu.createDiv('sync-floating-menu-item');
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

  /** v6.0: 根据 syncTargets 对当前文件执行智能同步 */
  private async runSmartSync(file: TFile) {
    const citeKey = this.extractCiteKeyFromFile(file);
    if (!citeKey) return;

    this.showProgress();
    this.setProgress(5);
    SyncFloatingButton.inFlightSet.add(file.path);
    try {
      this.setProgress(25);
      await this.plugin.runSilentAutoSync(citeKey, 1, file.path);
      this.setProgress(85);
      const currentHash = await this.computeMetadataHash(citeKey);
      if (currentHash) {
        SyncFloatingButton.metadataHashCache.set(file.path, currentHash);
      }
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
  private async computeMetadataHash(citeKey: string): Promise<string | null> {
    try {
      const database = { database: this.plugin.settings.database, port: this.plugin.settings.port };
      const citeKeyObj = await getCiteKeyFromAny(citeKey, database);
      if (!citeKeyObj) return null;
      const items = await getItemJSONFromCiteKeys([citeKeyObj], database, citeKeyObj.library, true);
      if (!items || !items.length) return null;
      const item = items[0];
      const fields = [
        item.title ?? "",
        item.abstract ?? "",
        item.DOI ?? "",
        item.URL ?? "",
        item.date ?? "",
        item.issued?.["date-parts"]?.flat()?.join("-") ?? "",
        JSON.stringify(item.author ?? []),
        JSON.stringify(item.editor ?? []),
        item.version ?? "",
        item.status ?? "",
      ];
      const joined = fields.join("|");
      let hash = 0;
      for (let i = 0; i < joined.length; i++) {
        const chr = joined.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
      }
      return String(hash);
    } catch {
      return null;
    }
  }

  private extractCiteKeyFromFile(file: TFile): string | null {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const citeKey = cache?.frontmatter?.citekey || cache?.frontmatter?.citationKey;
    if (citeKey) return citeKey;

    return file.basename;
  }
}
