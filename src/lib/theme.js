/**
 * Hoverleser color palette, shared by the hover popup (content.js) and the
 * settings page (popup.html).
 *
 * The manifests load this file before content.js, which puts the palette on
 * its popup with hoverleserTheme.css('#popup'). popup.html loads it in <head>
 * with data-apply="page", which puts the palette on the page itself.
 * Stylesheets use the colors as var(--name).
 */
'use strict';

// A top-level var: content scripts listed together in a manifest share their
// global declarations, while a property set on globalThis is not visible to
// the next script in Firefox's content-script sandbox.
var hoverleserTheme = (() => {
  const colors = {
    // Neutrals, darkest first
    'gray-0': '#141414',
    'gray-1': '#171717',
    'gray-2': '#1c1c1c',
    'gray-3': '#202020',
    'gray-4': '#262626',
    'gray-5': '#2a2a2a',
    'gray-6': '#2e2e2e',
    'gray-7': '#333',
    'gray-8': '#3a3a3a',
    'gray-9': '#444',
    'gray-10': '#555',
    'gray-11': '#666',
    'gray-12': '#777',
    'gray-13': '#888',
    'gray-14': '#999',
    'gray-15': '#aaa',
    'gray-16': '#bbb',
    'gray-17': '#dcdcdc',
    'gray-18': '#eee',
    // Accent and states
    'accent': '#5a8a6a',
    'accent-text': '#7ed8a4',
    'accent-text-hover': '#a8e8bc',
    'accent-fill': '#2a3f2e',
    'accent-fill-hover': '#334d38',
    'accent-fill-on': '#2d5a3d',
    'accent-fill-faint': '#232b25',
    'accent-line': '#3a5a44',
    'gloss': '#a8d880',
    'link': '#7aa7d8',
    'inferred': '#b8a05a',
    'ok': '#4ade80',
    'warn': '#facc15',
    'danger': '#f87171',
    'danger-line': '#5a2a2a',
    // Gender badges: text and background
    'gender-m': '#82b4e0',
    'gender-m-bg': '#1e2e3d',
    'gender-f': '#e8a0bc',
    'gender-f-bg': '#3a1a28',
    'gender-n': '#88d8a0',
    'gender-n-bg': '#1a2a1a',
    // Shadows and the hovered-word highlight
    'shadow-strong': 'color-mix(in srgb, #000 70%, transparent)',
    'shadow-card': 'color-mix(in srgb, #000 60%, transparent)',
    'shadow-soft': 'color-mix(in srgb, #000 40%, transparent)',
    'word-highlight': 'color-mix(in srgb, #c8c8c8 10%, transparent)',
  };

  /** The palette as CSS custom properties on `selector`. */
  const css = selector =>
    `${selector} {\n${Object.entries(colors).map(([name, value]) => `  --${name}: ${value};`).join('\n')}\n}`;

  return { colors, css };
})();

if (document.currentScript?.dataset.apply === 'page') {
  const style = document.createElement('style');
  style.textContent = hoverleserTheme.css(':root');
  document.head.append(style);
}
