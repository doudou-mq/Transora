/**
 * 内联 SVG 图标。
 *
 * 全部用内联 SVG 而不是引用扩展内的图片文件 —— 这样无需声明
 * `web_accessible_resources`，少一分被宿主页面探测的面。
 */

export const ICONS = {
  translate:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path d="M4 6h9M8.5 6v1.6c0 3.2-2.1 5.9-4.5 7.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M6.2 10.4c1 1.9 2.9 3.4 5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M12.5 19.5l3.4-8.2 3.4 8.2M13.9 16.6h4.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>',
  close:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  copy:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<rect x="6" y="6" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M10 3.5H3.8A1.3 1.3 0 002.5 4.8V11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  settings:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  sidebar:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<rect x="2" y="2.8" width="12" height="10.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M10 2.8v10.4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  restore:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M3 8a5 5 0 105-5H5.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<path d="M3 2.6V6h3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  compare:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<rect x="2" y="3" width="5" height="10" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<rect x="9" y="3" width="5" height="10" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  history:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M2 8s2.3-3.6 6-3.6S14 8 14 8s-2.3 3.6-6 3.6S2 8 2 8z" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M3 13L13 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  page:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M4 2.4h5l3 3v8.2H4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<path d="M6 8.2h4M6 10.6h4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M3.4 8.4l3 3L12.6 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  alert:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M8 4.8v4M8 10.9v.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  sliders:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M2.6 5.4h5.2M11.4 5.4h2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="9.6" cy="5.4" r="1.7" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M2.6 10.6h2M8.2 10.6h5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="6.4" cy="10.6" r="1.7" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '</svg>',
  info:
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M8 7.4v4.2M8 5.1v.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '</svg>',
} as const
