import type { Page } from '@playwright/test';

/**
 * Finds buttons, links and fields that a person could not click because something else sits on top of them.
 * Each control is scrolled into view (instantly) and the element that actually receives a click at its centre is checked.
 * Path handles are skipped: two of them can legitimately sit on the same spot.
 */
export async function findObscured(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const bad: string[] = [];
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto'; // the phone layout scrolls smoothly, which would make us measure mid-scroll
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return `[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`;
    };
    const controls = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, select, summary, input:not([type=hidden]):not([type=file]), textarea, [role=button]'));
    for (const el of controls) {
      if (el.classList.contains('handle')) continue;
      if ((el as HTMLButtonElement).disabled || el.closest('fieldset:disabled') || el.closest('[hidden]') || el.closest('.sr-only')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
      if (el.getBoundingClientRect().width === 0 || el.getBoundingClientRect().height === 0) continue;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(null))));
      const r = el.getBoundingClientRect();
      const name = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30);
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        bad.push(`${describe(el)} "${name}" ${box(el)} could not be scrolled into view (viewport ${window.innerWidth}x${window.innerHeight}, scrollY ${Math.round(window.scrollY)})`);
        continue;
      }
      const top = document.elementFromPoint(x, y);
      if (!top) {
        bad.push(`${describe(el)} "${name}" ${box(el)} has nothing at its centre`);
        continue;
      }
      const ok = top === el || el.contains(top) || top.contains(el) || (el instanceof HTMLInputElement && top.closest('label') === el.closest('label'));
      if (!ok) bad.push(`${describe(el)} "${name}" ${box(el)} is covered by ${describe(top)} ${box(top)} (viewport ${window.innerWidth}x${window.innerHeight}, scrollY ${Math.round(window.scrollY)})`);
    }
    root.style.scrollBehavior = previous;
    window.scrollTo(0, 0);
    return bad;
  });
}
