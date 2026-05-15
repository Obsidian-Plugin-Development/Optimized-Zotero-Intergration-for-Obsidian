import { MarkdownView, Notice, setIcon, TFile } from 'obsidian';
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

  // 阈值：移动超过此像素数才算拖拽
  private readonly DRAG_THRESHOLD = 3;

  // 吸附边距
  private readonly SNAP_MARGIN = 8;

  // v5.2 自动同步防抖 (static 跨实例共享)
  // 同时记录已执行同步的命令快照，用户修改「执行同步内容」勾选后重开文件可立即生效
  private static autoSyncDebounceMap = new Map<string, { time: number; commands: string[] }>();
  private static readonly AUTO_SYNC_DEBOUNCE_MS = 3 * 60 * 1000; // 3 分钟
  // 飞行中 tracker：防止同一文件并发执行两次同步
  private static inFlightSet = new Set<string>();

  constructor(plugin: ZoteroConnector) {
    this.plugin = plugin;
    this.registerListeners();
  }

  // ── 容器引用 ──

  private getViewContainer(): HTMLElement | null {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.containerEl ?? null;
  }

  // ── 位置记忆 ──

  private savePosition() {
    const btn = this.button;
    if (!btn) return;
    const pos: SavedPosition = {
      left: btn.style.left || 'auto',
      right: btn.style.right || 'auto',
      top: btn.style.top || '50px',
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

    SyncFloatingButton.inFlightSet.add(file.path);
    try {
      await this.plugin.runSilentAutoSync(citeKey, 1, file.path);
      // 仅在成功完成后设置防抖时间戳与命令快照，失败不阻塞重试
      SyncFloatingButton.autoSyncDebounceMap.set(file.path, {
        time: Date.now(),
        commands: [...targets],
      });
      new Notice(t('notice.autoSyncCompleted'), 3000);
    } catch (e) {
      console.error('[AutoSync]', e);
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
    if (this.button && this.button.parentElement !== container) {
      this.cleanup?.();
      this.button.remove();
      this.button = null;
      this.cleanup = null;
      this.containerEl = null;
    }

    // 按钮已从 DOM 断开（被 Obsidian 重渲染移除）→ 清理状态
    if (this.button && !this.button.isConnected) {
      this.cleanup?.();
      this.button = null;
      this.cleanup = null;
      this.containerEl = null;
    }

    if (this.button) return;

    this.containerEl = container;

    const btn = container.createDiv('sync-floating-button');
    // Obsidian 原生 Lucide 图标，自动适配亮暗主题
    setIcon(btn, 'file-text');

    // 基础样式
    btn.style.cssText = this.buildBaseStyle();

    // 恢复记忆位置
    const saved = this.loadPosition();
    if (saved) {
      if (saved.left !== 'auto') btn.style.left = saved.left;
      if (saved.right !== 'auto') btn.style.right = saved.right;
      btn.style.top = saved.top;
      btn.style.bottom = 'auto';
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
    const btn = this.button;
    if (!btn) return;
    if (isBibOutOfSync) {
      setIcon(btn, 'file-pen');
    } else {
      setIcon(btn, 'file-text');
    }
  }

  private destroy() {
    this.closeMenu();
    if (this.button) {
      this.cleanup?.();
      // 销毁前保存位置
      this.savePosition();
      this.button.remove();
      this.button = null;
      this.cleanup = null;
      this.containerEl = null;
    }
  }

  // ── 样式 ──

  private buildBaseStyle(): string {
    return [
      'position: absolute',
      'right: 30px',
      'bottom: 50px',
      'z-index: 99',
      'width: 44px',
      'height: 44px',
      'border-radius: 12px',
      'background: var(--background-secondary)',
      'border: 1px solid var(--background-modifier-border)',
      'box-shadow: var(--shadow-l)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'cursor: grab',
      'user-select: none',
      'color: var(--icon-color)',
      'transition: box-shadow 0.2s ease, transform 0.15s ease, border-radius 0.15s ease',
    ].join(';');
  }

  // ── 垂直边界修正 ──

  private clampVerticalPosition() {
    const btn = this.button;
    if (!btn || !this.containerEl) return;

    const containerRect = this.containerEl.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const localTop = btnRect.top - containerRect.top;
    const maxTop = containerRect.height - btn.offsetHeight;

    if (localTop < 0) {
      btn.style.top = '0px';
      btn.style.bottom = 'auto';
    } else if (localTop > maxTop) {
      btn.style.top = `${maxTop}px`;
      btn.style.bottom = 'auto';
    }
  }

  // ── 拖拽逻辑（局部坐标系：相对于 containerEl）──

  private bindDrag() {
    const btn = this.button!;

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
      const btnRect = btn.getBoundingClientRect();

      this.startLocalLeft = btnRect.left - containerRect.left;
      this.startLocalTop = btnRect.top - containerRect.top;

      // 切换为 left/top 驱动
      btn.style.left = `${this.startLocalLeft}px`;
      btn.style.top = `${this.startLocalTop}px`;
      btn.style.right = 'auto';
      btn.style.bottom = 'auto';

      // 拖拽中样式
      btn.style.transition = 'none';
      btn.style.cursor = 'grabbing';
      btn.style.boxShadow = 'var(--shadow-xl)';
      btn.style.transform = 'scale(1.08)';
      btn.style.borderRadius = '14px';
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

      const maxLeft = containerRect.width - btn.offsetWidth;
      const maxTop = containerRect.height - btn.offsetHeight;

      btn.style.left = `${Math.max(0, Math.min(newLocalLeft, maxLeft))}px`;
      btn.style.top = `${Math.max(0, Math.min(newLocalTop, maxTop))}px`;
    };

    const onMouseUp = () => {
      if (!this.dragging) return;
      this.dragging = false;

      btn.style.cursor = 'grab';
      btn.style.boxShadow = 'var(--shadow-l)';
      btn.style.transform = 'scale(1)';
      btn.style.borderRadius = '12px';

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

  // ── 边缘吸附（相对于 containerEl 的左右边缘）──

  private snapToEdge() {
    const btn = this.button;
    if (!btn) return;

    const container = this.containerEl;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();

    const btnCenterX = btnRect.left - containerRect.left + btnRect.width / 2;
    const distToLeft = btnCenterX;
    const distToRight = containerRect.width - btnCenterX;

    btn.style.transition = 'left 0.3s cubic-bezier(0.25, 0.8, 0.25, 1.2), right 0.3s cubic-bezier(0.25, 0.8, 0.25, 1.2)';

    if (distToLeft < distToRight) {
      btn.style.left = `${this.SNAP_MARGIN}px`;
      btn.style.right = 'auto';
    } else {
      btn.style.left = 'auto';
      btn.style.right = `${this.SNAP_MARGIN}px`;
    }

    // 垂直边界修正
    this.clampVerticalPosition();

    setTimeout(() => {
      if (btn) btn.style.transition = 'box-shadow 0.2s ease, transform 0.15s ease, border-radius 0.15s ease';
    }, 350);
  }

  // ── 点击触发 ──

  private handleClick() {
    if (this.menu) {
      this.closeMenu();
      return;
    }

    // v6.0: 基于 syncTargets 构建菜单
    const targets = this.plugin.settings.syncTargets || ['metadata'];
    const menuCommands: string[] = [];

    if (targets.includes('metadata') || targets.includes('annotations')) {
      menuCommands.push('zdc-smart-sync');
    }
    menuCommands.push('zdc-import-literature');
    menuCommands.push('zdc-insert-inline-citation');
    // v7.1: 始终显示更新参考文献选项
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
      'zdc-smart-sync': 'command.smartSync',
      'zdc-import-literature': 'command.importLiterature',
      'zdc-insert-inline-citation': 'command.insertInlineCitation',
      'update-bibliography': 'command.updateBibliography',
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
      'border-radius: 12px',
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

    try {
      await this.plugin.runSilentAutoSync(citeKey, 1, file.path);
      new Notice(t('notice.autoSyncCompleted'), 3000);
    } catch (e) {
      console.error('[SmartSync]', e);
      new Notice(t('notice.autoSyncFailed'), 3000);
    }
  }

  private extractCiteKeyFromFile(file: TFile): string | null {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const citeKey = cache?.frontmatter?.citekey || cache?.frontmatter?.citationKey;
    if (citeKey) return citeKey;

    return file.basename;
  }
}
