/**
 * v6.0 MarkdownPostProcessor — Reading Mode 引注渲染
 *
 * 遍历渲染后的 DOM text node，将 [@citekey] 替换为格式化行内引注编号。
 * 跳过 <code>、<pre> 内部的文本节点。
 */
import type { CitationEngine } from './citationEngine';

/**
 * 判断节点是否处于代码块/行内代码内。
 */
function isInsideCode(node: Node): boolean {
	let current: Node | null = node;
	while (current) {
		if (current instanceof HTMLElement) {
			const tag = current.tagName.toLowerCase();
			if (tag === 'code' || tag === 'pre' || tag === 'tt') {
				return true;
			}
		}
		current = current.parentNode;
	}
	return false;
}

/**
 * 创建 Reading Mode 引注后处理器。
 * 用法：plugin.registerMarkdownPostProcessor(createCitationPostProcessor(engine))
 */
export function createCitationPostProcessor(
	engine: CitationEngine,
	enabled: () => boolean,
): (el: HTMLElement) => void {
	return (el: HTMLElement) => {
		if (!enabled()) return;

		// v6.1：进入 Reading Mode 时重新扫描全文，确保序号准确
		const fullText = (el as HTMLElement).textContent || '';
		if (fullText.length > 0) {
			engine.refreshGlobalCitationMap(fullText);
		}

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const replacements: Array<{ node: Text; fragment: DocumentFragment }> = [];
		let textNode: Text | null;

		while ((textNode = walker.nextNode() as Text)) {
			if (isInsideCode(textNode)) continue;

			const text = textNode.textContent || '';
			const pattern = /\[@([^\]]+)\]/g;
			let match: RegExpExecArray | null;
			let lastIndex = 0;
			const fragment = document.createDocumentFragment();
			let hasMatch = false;

			pattern.lastIndex = 0;
			while ((match = pattern.exec(text)) !== null) {
				hasMatch = true;

				// 保留匹配前的文本
				if (match.index > lastIndex) {
					fragment.appendChild(
						document.createTextNode(text.slice(lastIndex, match.index)),
					);
				}

				const rawKeys = match[1]
					.split(';')
					.map((s) => s.trim().replace(/^@/, ''))
					.filter(Boolean);

				const numbers: number[] = [];
				for (const k of rawKeys) {
					const num = engine.getNumber(k);
					if (num > 0) {
						numbers.push(num);
					}
				}

				const span = document.createElement('span');
				span.addClass('custom-citation-inline');
				if (numbers.length > 0) {
					const unique = [...new Set(numbers)].sort((a, b) => a - b);
					span.setText(`[${unique.join(',')}]`);
				} else {
					span.setText('[?]');
					span.style.opacity = '0.5';
				}
				span.setAttribute('data-citation-keys', rawKeys.join(','));

				fragment.appendChild(span);
				lastIndex = match.index + match[0].length;
			}

			if (!hasMatch) continue;

			// 追加剩余文本
			if (lastIndex < text.length) {
				fragment.appendChild(
					document.createTextNode(text.slice(lastIndex)),
				);
			}

			replacements.push({ node: textNode, fragment });
		}

		// 执行替换
		for (const { node, fragment } of replacements) {
			node.parentNode?.replaceChild(fragment, node);
		}

		// 异步解析未缓存的 citekey
		const allKeys = new Set<string>();
		el.querySelectorAll('.custom-citation-inline[data-citation-keys]').forEach((span) => {
			const keys = span.getAttribute('data-citation-keys') || '';
			keys.split(',').filter(Boolean).forEach((k) => allKeys.add(k));
		});

		if (allKeys.size > 0) {
			engine.resolveCiteKeys([...allKeys]).then(() => {
				// 刷新所有 ? 占位符为实际编号
				el.querySelectorAll('.custom-citation-inline').forEach((span) => {
					const keys =
						(span.getAttribute('data-citation-keys') || '')
							.split(',')
							.filter(Boolean);
					const numbers: number[] = [];
					for (const k of keys) {
						const num = engine.getNumber(k);
						if (num > 0) {
							numbers.push(num);
						}
					}
					if (numbers.length > 0) {
						const unique = [...new Set(numbers)].sort((a, b) => a - b);
						(span as HTMLElement).setText(`[${unique.join(',')}]`);
						(span as HTMLElement).style.opacity = '';
					}
				});
			});
		}
	};
}
