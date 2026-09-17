/**
 * 构建期注入的全局常量声明（由 vite.config.ts 的 `define` 提供）。
 *
 * 只声明构建期烧进来的值；不要在运行时给它们赋值。
 */

/** 本次构建的日期（YYYY-MM-DD），供 F6 关于页的「构建日期」展示 */
declare const __TRANSORA_BUILD_DATE__: string
