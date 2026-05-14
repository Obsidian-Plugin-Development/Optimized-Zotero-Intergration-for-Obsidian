import { IfColorRule, PropertyItem } from '../types';
import { getZoteroMappings } from './helpers';

/**
 * 从 libraryCatalog 字段中提取影响因子数值。
 * 支持格式："IF: 12.3"、"IF 1.9"、"IF:5"、纯数字 "12.3" 等。
 */
export function extractImpactFactor(libraryCatalog?: string): number | null {
  if (!libraryCatalog) return null;

  const match = libraryCatalog.match(/IF[:\s]*(\d+\.?\d*)/i);
  if (match) {
    return parseFloat(match[1]);
  }

  // 尝试直接解析纯数字
  const numeric = parseFloat(libraryCatalog.trim());
  if (!isNaN(numeric)) {
    return numeric;
  }

  return null;
}

/**
 * 将 IF 数值与用户配置的规则数组进行匹配。
 * 遍历规则，返回首条 min <= ifValue <= max 的规则。
 * max 为 null 表示正无穷。
 */
export function matchIfRule(
  ifValue: number | null,
  rules: IfColorRule[]
): IfColorRule | null {
  if (ifValue === null || !rules.length) return null;

  for (const rule of rules) {
    if (ifValue >= rule.min && (rule.max === null || ifValue <= rule.max)) {
      return rule;
    }
  }

  return null;
}

/**
 * 创建一条默认 IF 颜色规则。
 * className 基于索引自动生成。
 */
export function createIfRule(index: number): IfColorRule {
  return {
    id: `if-rule-${Date.now()}`,
    min: 0,
    max: null,
    bgColor: '#4CAF50',
    textColor: '#FFFFFF',
    borderColor: '#388E3C',
    className: `if-dynamic-${index}`,
  };
}

// ═══════════════════════════════════════════════
// 模块一：极简 JS 状态注入（MutationObserver）
// 唯一职责：读取数值 → 给 .metadata-property 打类名标签
// 绝不创建、修改、删除任何 DOM 节点
// ═══════════════════════════════════════════════

let ifObserver: MutationObserver | null = null;
let ifObserverKey = '影响因子';
let ifObserverRules: IfColorRule[] = [];
let ifInputListenerInstalled = false;
let isProcessing = false;
let ifPollInterval: ReturnType<typeof setInterval> | null = null;
const ifLastValue = new WeakMap<HTMLElement, number | null>();
const ifInputsOverridden = new WeakSet<HTMLInputElement>();

function makeIfSelector(): string {
  return '.metadata-property[data-property-key="' + ifObserverKey + '"]';
}

/**
 * 处理单个 IF 属性行：读值 → 匹配规则 → 打类名。
 * 仅操作 classList，不触碰任何 DOM 结构。
 */
/** 覆盖 number input 的 value setter，程序化赋值时立即触发处理 */
function overrideInputValue(input: HTMLInputElement, prop: HTMLElement): void {
  if (ifInputsOverridden.has(input)) return;
  ifInputsOverridden.add(input);
  const nativeDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  Object.defineProperty(input, 'value', {
    get: nativeDesc.get!,
    set: function(v) {
      nativeDesc.set!.call(this, v);
      if (prop.isConnected) processIfProperty(prop);
    },
    configurable: true,
    enumerable: true,
  });
}

function processIfProperty(prop: HTMLElement): void {
  if (!prop.isConnected) return;
  if (isProcessing) return;
  isProcessing = true;

  try {
    // 1. 读取数值（必须选 value 容器内的 number input，避开 key 内的 text input）
    const input = prop.querySelector('.metadata-property-value input[type="number"]');
    let numValue: number | null = null;
    if (input) {
      const raw = (input as HTMLInputElement).value;
      if (raw) numValue = parseFloat(raw);
    }

    // 值未变化则跳过，避免闪烁
    if (ifLastValue.get(prop) === numValue) {
      isProcessing = false;
      return;
    }

    // 2. 清除旧类名
    for (const rule of ifObserverRules) {
      prop.classList.remove(rule.className);
    }
    prop.classList.remove('is-integer-if');

    if (numValue === null || isNaN(numValue)) {
      ifLastValue.set(prop, null);
      return;
    }

    // 3. 颜色规则匹配 → 打颜色类名
    const matched = matchIfRule(numValue, ifObserverRules);
    if (matched) {
      prop.classList.add(matched.className);
    }

    // 4. 整数标定 → is-integer-if
    const isInt = Number.isInteger(numValue);
    if (isInt) {
      prop.classList.add('is-integer-if');
    }

    ifLastValue.set(prop, numValue);
  } finally {
    isProcessing = false;
  }
}

/** input 事件监听（捕获阶段，感知用户编辑数值） */
function onIfInput(e: Event): void {
  const target = e.target as HTMLElement;
  if (!target.matches('input')) return;
  const prop = target.closest<HTMLElement>(makeIfSelector());
  if (prop) processIfProperty(prop);
}

/** 启动 MutationObserver：仅监听 childList，发现新属性行即处理 */
function setupIfObserver(): void {
  teardownIfObserver();

  // 初始扫描 + 延迟重试（属性面板可能晚于插件加载）
  function scan(): void {
    document.querySelectorAll<HTMLElement>(makeIfSelector()).forEach(
      (prop) => {
        const inp = prop.querySelector<HTMLInputElement>('.metadata-property-value input[type="number"]');
        if (inp) overrideInputValue(inp, prop);
        processIfProperty(prop);
      }
    );
  }
  scan();
  setTimeout(scan, 500);
  setTimeout(scan, 1500);
  setTimeout(scan, 3000);

  // 每1秒轮询兜底（MutationObserver 可能漏掉 input.value 属性变化）
  ifPollInterval = setInterval(function () { document.querySelectorAll(makeIfSelector()).forEach(function (p) { processIfProperty(p); }); }, 30);

  (window as any).__zoteroRescanIf = scan;
  ifObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(makeIfSelector())) {
          const inp = node.querySelector<HTMLInputElement>('.metadata-property-value input[type="number"]');
          if (inp) overrideInputValue(inp, node);
          processIfProperty(node);
        }
        // 检测新增的 number input（Obsidian 可能只替换 input 而非整个属性行）
        if (node.matches('input[type="number"]')) {
          const prop = node.closest<HTMLElement>(makeIfSelector());
          if (prop) { overrideInputValue(node as HTMLInputElement, prop); processIfProperty(prop); }
        }
        node.querySelectorAll<HTMLElement>(makeIfSelector()).forEach(
          (p) => {
            const inp2 = p.querySelector<HTMLInputElement>('.metadata-property-value input[type="number"]');
            if (inp2) overrideInputValue(inp2, p);
            processIfProperty(p);
          }
        );
      }
    }
  });

  ifObserver.observe(document.body, { childList: true, subtree: true });

  // 全局 input 监听（仅安装一次）
  if (!ifInputListenerInstalled) {
    document.addEventListener('input', onIfInput, true);
    ifInputListenerInstalled = true;
  }
}

function teardownIfObserver(): void {
  if (ifPollInterval) { clearInterval(ifPollInterval); ifPollInterval = null; }
  if (ifObserver) {
    ifObserver.disconnect();
    ifObserver = null;
  }
}

// ═══════════════════════════════════════════════
// 模块二 + 模块三：CSS 注入引擎
// 严格隔离 Key/Value，CSS ::after 小数幽灵
// ═══════════════════════════════════════════════

export function injectIfStyles(
  rules: IfColorRule[],
  propertyKey: string = '影响因子'
): void {
  const styleId = 'zotero-if-dynamic-styles';
  let styleEl = document.head.querySelector<HTMLStyleElement>('#' + styleId);

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }

  const pkey = propertyKey;
  const parts: string[] = [];

  // 隐藏 cssclasses 属性行
  parts.push('.metadata-property[data-property-key="cssclasses"] { display: none !important; }');

  // 隐藏 number input 的上下箭头，避免额外宽度
  parts.push('.metadata-property[data-property-key="' + pkey + '"] input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none !important; margin: 0 !important; }');
  parts.push('.metadata-property[data-property-key="' + pkey + '"] input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none !important; margin: 0 !important; }');
  parts.push('.metadata-property[data-property-key="' + pkey + '"] input[type="number"] { -moz-appearance: textfield !important; }');

  // 全局：整数 .0 幽灵注入（不依赖颜色类）
  parts.push(
    '.metadata-property.is-integer-if[data-property-key="' + pkey + '"] .metadata-property-value::after {' +
    'content: ".0" !important;' +
    'display: inline !important; margin: 0 !important; padding: 0 !important;' +
    'font-weight: bold !important; font-size: inherit !important; font-family: inherit !important; font-variant-numeric: tabular-nums !important;' +
    'color: inherit !important;' +
    'line-height: 1 !important; font-size: inherit !important; font-family: inherit !important;' +
    '}'
  );

  // 每条颜色规则：模式 A（类在祖先）+ 模式 B（类在自身）
  for (const rule of rules) {
    const cls = rule.className;
    const bg = rule.bgColor;
    const tc = rule.textColor;

    // ── 模式 A：颜色类在祖先元素上 ──
    const ancestor = '.' + cls + ' ';

    // A1. Key 隔离
    parts.push(
      ancestor + '.metadata-property[data-property-key="' + pkey + '"] .metadata-property-key {' +
      'background-color: transparent !important;' +
      'font-weight: var(--font-normal) !important;' +
      'color: var(--text-muted) !important;' +
      '}'
    );
    // A2. Value 容器 pill
    parts.push(
      ancestor + '.metadata-property[data-property-key="' + pkey + '"] .metadata-property-value {' +
      'background-color: ' + bg + ' !important;' +
      'color: ' + tc + ' !important;' +
      'border-radius: 12px !important;' +
      'display: inline-flex !important; flex-direction: row !important; gap: 0 !important; column-gap: 0 !important; row-gap: 0 !important;' +
      'align-items: center !important;' +
      'justify-content: center !important;' +
      'width: max-content !important;' +
      'height: 24px !important;' +
      'padding: 0 10px !important;' +
      'flex-grow: 0 !important; align-self: center !important;' +
      '}'
    );
    // A3. Input 透明
    parts.push(
      ancestor + '.metadata-property[data-property-key="' + pkey + '"] input[type="number"] {' +
      'background-color: transparent !important;' +
      'border: none !important;' +
      'box-shadow: none !important;' +
      'color: inherit !important;' +
      'font-weight: bold !important; font-size: inherit !important; font-family: inherit !important; font-variant-numeric: tabular-nums !important;' +
      'padding: 0 !important;' +
      'margin: 0 !important;' +
      'text-align: center !important;' +
      'field-sizing: content !important;' +
      'min-width: 1ch !important;' +
      '}'
    );
    // A4. ::after 小数幽灵
    parts.push(
      ancestor + '.metadata-property.is-integer-if[data-property-key="' + pkey + '"] .metadata-property-value::after {' +
      'content: ".0" !important;' +
      'display: inline !important; margin: 0 !important; padding: 0 !important;' +
      'font-weight: bold !important; font-size: inherit !important; font-family: inherit !important; font-variant-numeric: tabular-nums !important;' +
      'color: inherit !important;' +
      'line-height: 1 !important; font-size: inherit !important; font-family: inherit !important;' +
      '}'
    );

    // ── 模式 B：颜色类直接在 .metadata-property 上（JS 注入，Properties 面板可靠路径）──
    const self = '.metadata-property[data-property-key="' + pkey + '"].' + cls;

    // B1. Key 隔离
    parts.push(
      self + ' .metadata-property-key {' +
      'background-color: transparent !important;' +
      'font-weight: var(--font-normal) !important;' +
      'color: var(--text-muted) !important;' +
      '}'
    );
    // B2. Value 容器 pill
    parts.push(
      self + ' .metadata-property-value {' +
      'background-color: ' + bg + ' !important;' +
      'color: ' + tc + ' !important;' +
      'border-radius: 12px !important;' +
      'display: inline-flex !important; flex-direction: row !important; gap: 0 !important; column-gap: 0 !important; row-gap: 0 !important;' +
      'align-items: center !important;' +
      'justify-content: center !important;' +
      'width: max-content !important;' +
      'height: 24px !important;' +
      'padding: 0 10px !important;' +
      'flex-grow: 0 !important; align-self: center !important;' +
      '}'
    );
    // B3. Input 透明
    parts.push(
      self + ' input[type="number"] {' +
      'background-color: transparent !important;' +
      'border: none !important;' +
      'box-shadow: none !important;' +
      'color: inherit !important;' +
      'font-weight: bold !important; font-size: inherit !important; font-family: inherit !important; font-variant-numeric: tabular-nums !important;' +
      'padding: 0 !important;' +
      'margin: 0 !important;' +
      'text-align: center !important;' +
      'field-sizing: content !important;' +
      'min-width: 1ch !important;' +
      '}'
    );
    // B4. ::after 小数幽灵
    parts.push(
      self + '.is-integer-if .metadata-property-value::after {' +
      'content: ".0" !important;' +
      'display: inline !important; margin: 0 !important; padding: 0 !important;' +
      'font-weight: bold !important; font-size: inherit !important; font-family: inherit !important; font-variant-numeric: tabular-nums !important;' +
      'color: inherit !important;' +
      'line-height: 1 !important; font-size: inherit !important; font-family: inherit !important;' +
      '}'
    );
  }

  styleEl.textContent = parts.join('\n');

  // 启动 JS 类名注入
  ifObserverKey = propertyKey;
  ifObserverRules = rules;
  setupIfObserver();
}

export function removeIfStyles(): void {
  const styleEl = document.head.querySelector<HTMLStyleElement>(
    '#zotero-if-dynamic-styles'
  );
  if (styleEl) styleEl.remove();
  teardownIfObserver();
}

// ═══════════════════════════════════════════════
// 以下为标题跑马灯模块（未改动）
// ═══════════════════════════════════════════════

const TRACK_SELECTOR = '.zt-marquee-track';

let marqueeObserver: MutationObserver | null = null;
let marqueeRafId: number | null = null;
let marqueePollInterval: ReturnType<typeof setInterval> | null = null;
let marqueeDurationSec = 15;
let currentMarqueeKey = '标题';
const marqueeAnimations = new Map<HTMLElement, number>();
let marqueeIdCounter = 0;

// ── 动画引擎 ──

function startMarqueeAnimation(track: HTMLElement): void {
  stopMarqueeAnimation(track);

  let position = 0;
  let lastTime = performance.now();
  let animationId: number;

  function animate() {
    const now = performance.now();
    const delta = (now - lastTime) / 1000;
    lastTime = now;

    const halfWidth = track.scrollWidth / 2;
    const pxPerSecond = halfWidth / Math.max(marqueeDurationSec / 2, 0.5);
    position -= pxPerSecond * delta;
    if (position <= -halfWidth) position += halfWidth;
    if (position > 0) position -= halfWidth;

    track.style.transform = 'translateX(' + position + 'px)';
    animationId = requestAnimationFrame(animate);
  }

  animationId = requestAnimationFrame(animate);
  marqueeAnimations.set(track, animationId);
}

function stopMarqueeAnimation(track: HTMLElement): void {
  const id = marqueeAnimations.get(track);
  if (id !== undefined) {
    cancelAnimationFrame(id);
    marqueeAnimations.delete(track);
  }
}

function stopAllMarqueeAnimations(): void {
  marqueeAnimations.forEach((id) => cancelAnimationFrame(id));
  marqueeAnimations.clear();
}

// ── clip 管理 ──

function removeSingleClip(clip: Element): void {
  const track = clip.querySelector<HTMLElement>(TRACK_SELECTOR);
  if (track) stopMarqueeAnimation(track);
  clip.remove();
}

function removeAllClips(): void {
  document.querySelectorAll('.zt-marquee-clip').forEach((clip) => {
    removeSingleClip(clip);
  });
}

function getOpaqueBg(el: HTMLElement): string {
  let cur: HTMLElement | null = el;
  while (cur) {
    const c = getComputedStyle(cur).backgroundColor;
    const transparent = c === 'transparent' || c === 'rgba(0, 0, 0, 0)' ||
      /^rgba\(\d+,\s*\d+,\s*\d+,\s*0(?:\.0+)?\)$/i.test(c);
    if (c && !transparent) return c;
    cur = cur.parentElement;
  }
  return 'var(--background-primary)';
}

function attachMarqueeToElement(titleProp: HTMLElement): void {
  try {
    const valueEl = titleProp.querySelector<HTMLElement>('.metadata-property-value');
    if (!valueEl || !valueEl.isConnected) return;

    const propRect = titleProp.getBoundingClientRect();
    const valueRect = valueEl.getBoundingClientRect();
    if (valueRect.width === 0 && valueRect.height === 0) return;

    const left = valueRect.left - propRect.left;
    const top = valueRect.top - propRect.top;

    const children = Array.from(valueEl.children) as HTMLElement[];
    const iconEl = titleProp.querySelector('.metadata-property-icon');
    let html = '';
    for (const child of children) {
      if (child === iconEl || !child.isConnected) continue;
      html += child.outerHTML || child.textContent || '';
    }
    html = html.trim();
    const text = children.reduce((s, c) => s + (c.textContent || ''), '').trim();
    if (!html || !text) return;

    let propId = titleProp.getAttribute('data-marquee-id');
    if (!propId) {
      propId = 'marquee-' + (++marqueeIdCounter);
      titleProp.setAttribute('data-marquee-id', propId);
    }

    const clip = document.createElement('span');
    clip.className = 'zt-marquee-clip';
    clip.setAttribute('data-prop-id', propId);
    clip.style.backgroundColor = getOpaqueBg(valueEl);
    clip.style.position = 'absolute';
    clip.style.left = left + 'px';
    clip.style.top = top + 'px';
    clip.style.width = valueRect.width + 'px';
    clip.style.height = valueRect.height + 'px';

    const track = document.createElement('span');
    track.className = 'zt-marquee-track';
    track.setAttribute('data-text', text);

    const c1 = document.createElement('span');
    c1.className = 'zt-marquee-copy';
    c1.innerHTML = html;
    const c2 = document.createElement('span');
    c2.className = 'zt-marquee-copy';
    c2.innerHTML = html;

    track.appendChild(c1);
    track.appendChild(c2);
    clip.appendChild(track);
    titleProp.appendChild(clip);
    titleProp.setAttribute('data-marquee-text', text);
    startMarqueeAnimation(track);
  } catch (err) {
    console.error('[zt-marquee] attachMarqueeToElement failed:', err);
  }
}

// ── 更新策略 ──

const TITLE_QUERY = () => '.metadata-property[data-property-key="' + currentMarqueeKey + '"]';

function applyMarqueeToAll(): void {
  if (marqueeObserver) marqueeObserver.disconnect();
  removeAllClips();
  document.querySelectorAll<HTMLElement>(
    TITLE_QUERY()
  ).forEach((prop) => {
    try {
      const valueEl = prop.querySelector<HTMLElement>('.metadata-property-value');
      if (!valueEl) return;
      if (valueEl.getBoundingClientRect().width === 0) return;
      attachMarqueeToElement(prop);
    } catch (err) { /* ignore */ }
  });
  if (marqueeObserver) {
    marqueeObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'], characterData: true,
    });
  }
}

function syncMarqueeState(): void {
  if (marqueeObserver) marqueeObserver.disconnect();

  document.querySelectorAll('.zt-marquee-clip').forEach((clip) => {
    const propId = clip.getAttribute('data-prop-id');
    if (!propId) { removeSingleClip(clip); return; }
    const prop = document.querySelector(TITLE_QUERY() + '[data-marquee-id="' + propId + '"]');
    if (!prop) { removeSingleClip(clip); return; }
    const valueEl = prop.querySelector('.metadata-property-value');
    if (!valueEl) { removeSingleClip(clip); return; }
    if (valueEl.getBoundingClientRect().width === 0) { removeSingleClip(clip); return; }
  });

  document.querySelectorAll<HTMLElement>(
    TITLE_QUERY()
  ).forEach((prop) => {
    try {
      const valueEl = prop.querySelector<HTMLElement>('.metadata-property-value');
      if (!valueEl) return;
      if (valueEl.getBoundingClientRect().width === 0) return;

      const propId = prop.getAttribute('data-marquee-id');
      const children = Array.from(valueEl.children);
      const curText = children.reduce(function(s, c) { return s + (c.textContent || ''); }, '').trim();
      const oldText = prop.getAttribute('data-marquee-text');

      if (oldText !== curText) {
        if (propId) {
          const oldClip = prop.querySelector('.zt-marquee-clip[data-prop-id="' + propId + '"]');
          if (oldClip) { removeSingleClip(oldClip); prop.removeAttribute('data-marquee-id'); }
        }
        attachMarqueeToElement(prop);
      }
    } catch (err) { /* ignore */ }
  });

  if (marqueeObserver) {
    marqueeObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'], characterData: true,
    });
  }
}

function scheduleMarqueeApply(): void {
  if (marqueeRafId !== null) return;
  marqueeRafId = requestAnimationFrame(() => {
    marqueeRafId = null;
    syncMarqueeState();
  });
}

// ── 对外 API ──

export function injectTitleMarqueeStyles(
  enabled: boolean,
  duration: number = 15,
  propertyKey: string = '标题'
): void {
  marqueeDurationSec = duration;
  currentMarqueeKey = propertyKey;

  const styleId = 'zotero-title-marquee-styles';
  let styleEl = document.head.querySelector<HTMLStyleElement>('#' + styleId);

  if (!enabled) {
    if (marqueeObserver) { marqueeObserver.disconnect(); marqueeObserver = null; }
    if (marqueeRafId !== null) { cancelAnimationFrame(marqueeRafId); marqueeRafId = null; }
    if (marqueePollInterval) { clearInterval(marqueePollInterval); marqueePollInterval = null; }
    stopAllMarqueeAnimations();
    removeAllClips();
    if (styleEl) styleEl.remove();
    return;
  }

  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = styleId;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = '\n.metadata-property[data-property-key="' + propertyKey + '"] {\n  position: relative !important;\n}\n.zt-marquee-clip {\n  pointer-events: none; overflow: hidden; display: flex; align-items: center; z-index: 1;\n}\n.zt-marquee-track {\n  display: flex; flex-wrap: nowrap; width: max-content; will-change: transform;\n  font: inherit; color: inherit;\n}\n.zt-marquee-copy {\n  flex: 0 0 auto; box-sizing: content-box; padding-right: 2em;\n  white-space: nowrap; font: inherit; color: inherit;\n}\n.metadata-property[data-property-key="' + propertyKey + '"] .metadata-property-value {\n  pointer-events: none !important;\n}\n.metadata-property[data-property-key="' + propertyKey + '"] .metadata-property-value * {\n  pointer-events: auto !important;\n}\n';

  applyMarqueeToAll();

  if (!marqueeObserver) {
    marqueeObserver = new MutationObserver(() => scheduleMarqueeApply());
    marqueeObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'], characterData: true,
    });
  }

  if (!marqueePollInterval) {
    marqueePollInterval = setInterval(() => syncMarqueeState(), 100);
  }
}

export function removeTitleMarqueeStyles(): void {
  if (marqueeObserver) { marqueeObserver.disconnect(); marqueeObserver = null; }
  if (marqueeRafId !== null) { cancelAnimationFrame(marqueeRafId); marqueeRafId = null; }
  if (marqueePollInterval) { clearInterval(marqueePollInterval); marqueePollInterval = null; }
  stopAllMarqueeAnimations();
  removeAllClips();
  const styleEl = document.head.querySelector<HTMLStyleElement>('#zotero-title-marquee-styles');
  if (styleEl) styleEl.remove();
}

// ── 统一入口 ──

export function injectBeautifyStyles(
  propertyItems: PropertyItem[],
  ifColorRules: IfColorRule[],
  enableTitleMarquee: boolean,
  marqueeDuration: number
): void {
  const propertyMappings = getZoteroMappings(propertyItems);
  const titleMapping = propertyMappings.find(
    (m) => m.zoteroField === 'title_smart'
  );
  const ifMapping = propertyMappings.find(
    (m) => m.zoteroField === 'impact_factor_smart'
  );

  const titleKey = titleMapping?.obsidianKey || '标题';
  const ifKey = ifMapping?.obsidianKey || '影响因子';

  injectIfStyles(ifColorRules, ifKey);
  injectTitleMarqueeStyles(enableTitleMarquee, marqueeDuration, titleKey);
}

export function removeBeautifyStyles(): void {
  removeIfStyles();
  removeTitleMarqueeStyles();
}
