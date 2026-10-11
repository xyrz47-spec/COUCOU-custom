// A drop-down drawn by the page, in place of the system's: the same button and
// list everywhere, in the colours of the window it is in.
//
// The <select> stays where it was, out of sight, and stays the truth: code
// that reads its value, sets it, adds options to it or listens to its
// `change` works as before. This only shows it: a button with the chosen
// option's text, and a list that opens under it (or over it, when there is no
// room below). The list is put on the page's body while it is open, so no
// panel it sits in can clip it or shift it.

import { h, svg } from "./dom";
import { ICONS } from "./icons";

/** Room kept between the list and the window's edge. */
const EDGE = 8;
const GAP = 6;
const MAX_HEIGHT = 280;

let closeOpen: (() => void) | null = null;

/**
 * Draws `select` as a button and a list. Returns the element that now stands
 * for it on the page (the select is inside it). Where the page cannot be
 * drawn on (a test's stand-in for it), the select is returned as it is.
 */
export function enhanceSelect(select: HTMLSelectElement, className = "", host?: () => HTMLElement | null): HTMLElement {
  if (typeof HTMLSelectElement === "undefined" || !(select instanceof HTMLSelectElement)) return select;
  if (select.dataset.drawn && select.parentElement) return select.parentElement;
  select.dataset.drawn = "1";

  const label = h("span", { class: "cselect-label" });
  const button = h("button", { class: "cselect-button", type: "button" }, label, svg(ICONS.chevronDown, 11, { stroke: 2.4 })) as HTMLButtonElement;
  const wrap = h("div", { class: className ? `cselect ${className}` : "cselect" });
  select.parentNode?.insertBefore(wrap, select);
  wrap.append(button, select);
  if (select.style.width) wrap.style.width = select.style.width;
  if (select.title) button.title = select.title;

  const refresh = () => {
    label.textContent = select.selectedOptions[0]?.textContent ?? "";
    button.disabled = select.disabled;
  };

  // A value set from code makes no event: the button is told here.
  const own = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (own?.get && own.set) {
    const { get, set } = own;
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => get.call(select),
      set: (value: string) => {
        set.call(select, value);
        refresh();
      },
    });
  }
  // Options come and go (a list filled once it is known).
  new MutationObserver(refresh).observe(select, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "selected"],
  });
  select.addEventListener("change", refresh);
  refresh();

  let menu: HTMLElement | null = null;
  let at = -1;

  const close = () => {
    if (!menu) return;
    menu.remove();
    menu = null;
    wrap.classList.remove("open");
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    document.removeEventListener("scroll", scrolled, true);
    if (closeOpen === close) closeOpen = null;
  };
  const outside = (e: MouseEvent) => {
    const target = e.target as Node | null;
    if (target && (menu?.contains(target) || wrap.contains(target))) return;
    close();
  };
  /** The page moved under the list: it would no longer be at its button. */
  const scrolled = (e: Event) => {
    if (menu && e.target instanceof Node && menu.contains(e.target)) return;
    close();
  };

  const choose = (index: number) => {
    const option = select.options[index];
    if (!option || option.disabled) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    refresh();
    close();
    button.focus();
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const point = (index: number) => {
    if (!menu) return;
    const rows = [...menu.children] as HTMLElement[];
    at = Math.max(0, Math.min(rows.length - 1, index));
    rows.forEach((row, i) => row.classList.toggle("at", i === at));
    rows[at]?.scrollIntoView({ block: "nearest" });
  };

  const open = () => {
    if (menu || select.disabled || select.options.length === 0) return;
    closeOpen?.();
    const list = h("div", { class: "cselect-menu" });
    [...select.options].forEach((option, index) => {
      const row = h(
        "button",
        { class: index === select.selectedIndex ? "cselect-option on" : "cselect-option", type: "button", title: option.title },
        h("span", { text: option.textContent ?? "" }),
        svg(ICONS.check, 11, { stroke: 2.8 }),
      ) as HTMLButtonElement;
      row.disabled = option.disabled;
      row.addEventListener("mouseenter", () => point(index));
      row.addEventListener("click", () => choose(index));
      list.append(row);
    });
    // The colour of the page the select is on.
    const accent = getComputedStyle(wrap).getPropertyValue("--page").trim();
    if (accent) list.style.setProperty("--page", accent);
    // On the body, or in the panel the caller names (a window that only takes
    // the mouse over that panel): placed from that panel's corner then.
    const inside = host?.() ?? null;
    (inside ?? document.body).append(list);
    if (inside) list.classList.add("inside");
    menu = list;

    const box = button.getBoundingClientRect();
    const frame = inside?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const below = frame.bottom - box.bottom - GAP - EDGE;
    const above = box.top - frame.top - GAP - EDGE;
    const up = below < Math.min(160, list.scrollHeight) && above > below;
    const room = Math.max(80, Math.min(MAX_HEIGHT, up ? above : below));
    list.style.maxHeight = `${room}px`;
    list.style.minWidth = `${box.width}px`;
    const left = Math.max(frame.left + EDGE, Math.min(box.left, frame.right - list.offsetWidth - EDGE));
    list.style.left = `${left - frame.left}px`;
    if (up) {
      list.style.bottom = `${frame.bottom - box.top + GAP}px`;
      list.classList.add("up");
    } else {
      list.style.top = `${box.bottom - frame.top + GAP}px`;
    }

    wrap.classList.add("open");
    point(Math.max(0, select.selectedIndex));
    document.addEventListener("mousedown", outside, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", scrolled, true);
    closeOpen = close;
  };

  button.addEventListener("click", () => (menu ? close() : open()));
  button.addEventListener("keydown", (e) => {
    if (!menu) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        open();
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        point(at + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        point(at - 1);
        break;
      case "Home":
        e.preventDefault();
        point(0);
        break;
      case "End":
        e.preventDefault();
        point(select.options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(at);
        break;
      case "Escape":
        // The list goes; the window it is in stays.
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "Tab":
        close();
        break;
    }
  });

  return wrap;
}

/**
 * Draws every select under `root`, now and as they come: the sections redraw
 * themselves, and each new select is taken up as it is put on the page.
 */
export function drawSelects(root: HTMLElement) {
  if (typeof MutationObserver === "undefined" || typeof root.querySelectorAll !== "function") return;
  const sweep = () => {
    for (const select of root.querySelectorAll<HTMLSelectElement>("select:not([data-drawn])")) enhanceSelect(select);
  };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sweep();
    });
  }).observe(root, { childList: true, subtree: true });
  sweep();
}
