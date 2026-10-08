import type { Page } from '@playwright/test';

/**
 * Finds buttons, links and fields that a person could not click because something else sits on top of them.
 * Each control is scrolled into view and the element that actually receives a click at its centre is checked.
 */
export async function findObscured(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const bad: string[] = [];
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
    const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, select, summary, input:not([type=hidden]):not([type=file]), textarea, [role=button]'));
    for (const el of controls) {
      if ((el as HTMLButtonElement).disabled || el.closest('fieldset:disabled') || el.closest('[hidden]') || el.closest('.sr-only')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
      let r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((res) => requestAnimationFrame(() => res(null)));
      r = el.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      if (!top) {
        bad.push(`${describe(el)} "${(el.textContent || '').trim().slice(0, 30)}" has nothing at its centre`);
        continue;
      }
      const ok = top === el || el.contains(top) || top.contains(el) || !!top.closest('label')?.contains(el) || (el instanceof HTMLInputElement && top.closest('label') === el.closest('label'));
      if (!ok) bad.push(`${describe(el)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" is covered by ${describe(top)}`);
    }
    window.scrollTo(0, 0);
    return bad;
  });
}
